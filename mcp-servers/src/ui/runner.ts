import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { ensureUiScaffold } from "./codegen.js";

/**
 * UI 回归执行：由编排层直接调度 Playwright Test，不经过 Codex、不消耗模型。
 * 输出与引擎 save-run 兼容的结果数组（失败带 trace / 截图路径，视觉判定带复核项）。
 */
const require = createRequire(import.meta.url);

export interface UiRunOptions {
  workspace: string;
  baseUrl: string;
  /** 只跑指定用例（用例 ID 即 spec 文件名） */
  caseIds?: string[];
  /** 凭据相关环境变量：AITEST_ROLES / AITEST_LOGIN 等，只传给子进程 */
  env?: Record<string, string>;
  headed?: boolean;
  timeoutMs?: number;
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
  const dir = ensureUiScaffold(opts.workspace);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = join(opts.workspace, "reports", `ui-${stamp}`);
  mkdirSync(outDir, { recursive: true });
  const reportJson = join(outDir, "report.json");
  const htmlReport = join(outDir, "html");
  const files = (opts.caseIds ?? []).map((id) => `${id}.spec.ts`).filter((f) => existsSync(join(dir, f)));
  if (opts.caseIds?.length && !files.length) {
    return { exitCode: 0, reportJson, htmlReport, results: [], errors: [], stderr: "没有可执行的 UI 脚本" };
  }
  const args = [playwrightCli(), "test", "-c", join(dir, "playwright.config.ts"), ...files];
  const env = {
    ...process.env,
    ...opts.env,
    NODE_PATH: nodePath(),
    AITEST_BASE_URL: opts.baseUrl,
    AITEST_REPORT_JSON: reportJson,
    AITEST_HTML_REPORT: htmlReport,
    AITEST_OUTPUT_DIR: join(outDir, "artifacts"),
    // 在 Electron 主进程中调用时，process.execPath 是 Electron 本身，需以 Node 模式运行
    ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
    ...(opts.headed ? { AITEST_HEADED: "1" } : {}),
  };
  const { code, stderr } = await new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    child.stdout.on("data", () => undefined);
    child.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs ?? 30 * 60_000);
    child.on("error", reject);
    child.on("close", (c) => {
      clearTimeout(timer);
      resolve({ code: c, stderr: err });
    });
  });
  const raw = existsSync(reportJson) ? readFileSync(reportJson, "utf8") : "";
  const results = raw ? parseReport(raw, opts.workspace) : [];
  const errors = raw ? reportErrors(raw) : [];
  if (!raw && code !== 0) errors.push(`Playwright 未生成报告（退出码 ${code}）`);
  return { exitCode: code, reportJson, htmlReport, results, errors, stderr: stderr.slice(-4000) };
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
