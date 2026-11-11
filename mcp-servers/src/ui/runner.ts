import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { chooseBrowser, type BrowserChoice } from "./chromium.js";
import { ensureUiScaffold } from "./codegen.js";

/**
 * UI 回归执行：由编排层直接调度 Playwright Test，不经过 Codex、不消耗模型。
 * 输出与引擎 save-run 兼容的结果数组（失败带 trace / 截图路径，视觉判定带复核项）。
 */
const require = createRequire(import.meta.url);

export interface UiRunOptions {
  workspace: string;
  signal?: AbortSignal;
  baseUrl: string;
  /** 只跑指定用例（用例 ID 即 spec 文件名） */
  caseIds?: string[];
  /** 凭据相关环境变量：AITEST_ROLES / AITEST_LOGIN 等，只传给子进程 */
  env?: Record<string, string>;
  headed?: boolean;
  timeoutMs?: number;
  cdpEndpoint?: string;
  viewMarkers?: Record<string, string>;
  /** stepId / kind 来自生成脚本里的 test.step（kind=step 为脚本步骤本身，api 为其中的 Playwright 调用） */
  onProgress?: (event: { caseId?: string; title: string; status: string; role?: string; stepId?: string; kind?: "step" | "api"; error?: string }) => void;
}

export interface UiCaseResult {
  case_id: string;
  status: "passed" | "failed" | "error" | "skipped";
  duration: number;
  message: string;
  evidence_paths: string[];
  failure_type?: string;
  reviews: { kind: string; description: string; evidence_paths: string[] }[];
}

export interface UiRunOutput {
  exitCode: number | null;
  reportJson: string;
  htmlReport: string;
  results: UiCaseResult[];
  /** 不属于某条用例的错误（全局登录失败、配置错误等），此时可能一条结果都没有 */
  errors: string[];
  stderr: string;
  /** 本次使用的浏览器（内嵌模式为 undefined） */
  browser?: BrowserChoice;
}

/** 打包进 Electron 时，依赖位于 app.asar.unpacked（子进程需要真实文件路径） */
const unpacked = (p: string) => p.replace(/app\.asar([\\/])/, "app.asar.unpacked$1");

function playwrightCli(): string {
  return unpacked(join(dirname(require.resolve("@playwright/test/package.json")), "cli.js"));
}

/** 让工作区里的脚本能解析到客户端自带的 @playwright/test */
function nodePath(): string {
  const pkgDir = unpacked(dirname(require.resolve("@playwright/test/package.json")));
  return [join(pkgDir, "..", ".."), process.env.NODE_PATH].filter(Boolean).join(process.platform === "win32" ? ";" : ":");
}

export async function runUiSuite(opts: UiRunOptions): Promise<UiRunOutput> {
  opts.signal?.throwIfAborted();
  const dir = ensureUiScaffold(opts.workspace);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = join(opts.workspace, "reports", `ui-${stamp}`);
  mkdirSync(outDir, { recursive: true });
  const reportJson = join(outDir, "report.json");
  const htmlReport = join(outDir, "html");
  const files = (opts.caseIds ?? []).map((id) => `${id}.spec.ts`).filter((f) => existsSync(join(dir, f)));
  if (opts.caseIds?.some(id => !/^tc_[\w-]+$/.test(id))) throw new Error("无效的 UI 用例 ID");
  if (opts.caseIds?.length && files.length !== opts.caseIds.length) throw new Error("部分用例脚本不存在，请重新生成后执行");
  if (opts.caseIds && !files.length) {
    return { exitCode: 0, reportJson, htmlReport, results: [], errors: [], stderr: "没有可执行的 UI 脚本" };
  }
  if (opts.cdpEndpoint && !opts.caseIds?.length) throw new Error("内嵌校验必须指定用例");
  // 为历史脚本接入内嵌 fixture，保留原文件与相对导入；临时副本执行完立即清理。
  const copies = opts.cdpEndpoint ? files.map(file => {
    const copy = `.aitest-${randomUUID()}-${file}`;
    writeFileSync(join(dir, copy), readFileSync(join(dir, file), "utf8").replace(/from\s+(["'])@playwright\/test\1/g, 'from "./aitest-embedded"'));
    return copy;
  }) : [];
  // 内嵌模式连接桌面端浏览器；其余情况自带浏览器缺失时退回系统 Chrome
  const browser = opts.cdpEndpoint ? undefined : chooseBrowser({ headless: !opts.headed, env: { ...process.env, ...opts.env } });
  const args = [playwrightCli(), "test", "-c", join(dir, "playwright.config.ts"), ...(copies.length ? copies : files)];
  const env = {
    ...process.env,
    ...opts.env,
    ...(browser?.executablePath ? { AITEST_CHROMIUM_PATH: browser.executablePath } : {}),
    NODE_PATH: nodePath(),
    AITEST_BASE_URL: opts.baseUrl,
    AITEST_REPORT_JSON: reportJson,
    AITEST_HTML_REPORT: htmlReport,
    AITEST_OUTPUT_DIR: join(outDir, "artifacts"),
    ...(opts.cdpEndpoint ? { AITEST_EMBEDDED: "1", AITEST_CDP_ENDPOINT: opts.cdpEndpoint, AITEST_VIEW_MARKERS: JSON.stringify(opts.viewMarkers), AITEST_WORKERS: "1" } : {}),
    // 在 Electron 主进程中调用时，process.execPath 是 Electron 本身，需以 Node 模式运行
    ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
    ...(opts.headed ? { AITEST_HEADED: "1" } : {}),
  };
  const secrets = new Set<string>();
  for (const [key, value] of Object.entries(opts.env ?? {})) {
    if (/password|token|secret/i.test(key) && value) secrets.add(value);
    if (key === "AITEST_ROLES") {
      for (const role of JSON.parse(value || "[]")) {
        for (const field of ["username", "password", "token"]) if (role[field]) secrets.add(String(role[field]));
      }
    }
  }
  let execution: { code: number | null; stderr: string };
  try { execution = await new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
    const stop = () => {
      if (!child.pid) return;
      if (process.platform === "win32") {
        const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
        killer.on("error", () => child.kill("SIGKILL"));
      } else {
        try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
      }
    };
    opts.signal?.addEventListener("abort", stop, { once: true });
    if (opts.signal?.aborted) stop();
    let err = "";
    let pending = "";
    child.stdout.on("data", (data) => {
      pending += data.toString();
      const lines = pending.split("\n");
      pending = lines.pop()!;
      for (const line of lines) if (line.startsWith("AITEST_STEP:")) {
        try {
          const event = JSON.parse(line.slice(12));
          for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
            event.title = event.title.split(secret).join("[已隐藏]");
            if (typeof event.error === "string") event.error = event.error.split(secret).join("[已隐藏]");
          }
          opts.onProgress?.(event);
        } catch { /* 不让日志影响执行 */ }
      }
    });
    child.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(stop, opts.timeoutMs ?? 30 * 60_000);
    child.on("error", (e) => { clearTimeout(timer); opts.signal?.removeEventListener("abort", stop); reject(e); });
    child.on("close", (c) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", stop);
      resolve({ code: c, stderr: err });
    });
  }); } finally { for (const file of copies) rmSync(join(dir, file), { force: true }); }
  opts.signal?.throwIfAborted();
  const { code, stderr } = execution;
  const raw = existsSync(reportJson) ? readFileSync(reportJson, "utf8") : "";
  const results = raw ? parseReport(raw, opts.workspace) : [];
  const errors = raw ? reportErrors(raw) : [];
  if (!raw && code !== 0) errors.push(`Playwright 未生成报告（退出码 ${code}）`);
  return { exitCode: code, reportJson, htmlReport, results, errors, stderr: stderr.slice(-4000), ...(browser ? { browser } : {}) };
}

/** 报告顶层错误（global-setup 失败等） */
export function reportErrors(json: string): string[] {
  const report = JSON.parse(json) as { errors?: { message?: string }[] };
  return (report.errors ?? []).map((e) => (e.message ?? "").replace(ANSI, "")).filter(Boolean);
}

// ---- Playwright JSON 报告解析 ----

interface PwAttachment { name: string; path?: string; contentType: string }
interface PwResult { status: string; duration: number; error?: { message?: string }; errors?: { message?: string }[]; attachments?: PwAttachment[] }
interface PwTest { annotations?: { type: string; description?: string }[]; results: PwResult[]; status?: string }
interface PwSpec { title: string; file: string; tests: PwTest[] }
interface PwSuite { specs?: PwSpec[]; suites?: PwSuite[] }

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g;

export function caseIdFromTitle(title: string, file: string): string {
  const m = title.match(/^(tc_[\w-]+)/) ?? file.match(/(tc_[\w-]+)\.spec\.ts$/);
  return m ? m[1] : `${file}::${title}`;
}

export function classifyUiFailure(message: string): string | undefined {
  if (/net::ERR_|ECONNREFUSED|Executable doesn't exist|browserType\.launch/.test(message)) return "environment";
  return undefined; // 交给 agent：页面改版（脚本错误）还是产品缺陷
}

export function parseReport(json: string, workspace: string): UiCaseResult[] {
  const report = JSON.parse(json) as { suites?: PwSuite[] };
  const out: UiCaseResult[] = [];
  const rel = (p: string) => relative(workspace, p);
  const walk = (suite: PwSuite) => {
    for (const spec of suite.specs ?? []) {
      for (const t of spec.tests) {
        const r = t.results[t.results.length - 1];
        if (!r) continue;
        const status = r.status === "passed" ? "passed" : r.status === "skipped" ? "skipped" : r.status === "failed" ? "failed" : "error";
        const message = [r.error?.message, ...(r.errors ?? []).map((e) => e.message)].filter(Boolean)[0]?.replace(ANSI, "") ?? "";
        const attachments = (r.attachments ?? []).filter((a) => a.path);
        const visual = attachments.filter((a) => a.name === "ai-visual-check").map((a) => rel(a.path!));
        const reviews = (t.annotations ?? [])
          .filter((a) => a.type === "ai-visual-check")
          .map((a, i) => ({ kind: "visual", description: a.description ?? "", evidence_paths: visual[i] ? [visual[i]] : visual }));
        out.push({
          case_id: caseIdFromTitle(spec.title, spec.file),
          status,
          duration: r.duration / 1000,
          message: message.slice(0, 4000),
          evidence_paths: attachments.filter((a) => a.name !== "ai-visual-check").map((a) => rel(a.path!)),
          failure_type: status === "passed" || status === "skipped" ? undefined : classifyUiFailure(message),
          reviews,
        });
      }
    }
    for (const s of suite.suites ?? []) walk(s);
  };
  for (const s of report.suites ?? []) walk(s);
  return out;
}
