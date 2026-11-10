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
  stderr: string;
}

function playwrightCli(): string {
  return join(dirname(require.resolve("@playwright/test/package.json")), "cli.js");
}

/** 让工作区里的脚本能解析到客户端自带的 @playwright/test */
function nodePath(): string {
  const pkgDir = dirname(require.resolve("@playwright/test/package.json"));
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
    return { exitCode: 0, reportJson, htmlReport, results: [], stderr: "没有可执行的 UI 脚本" };
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
  const results = existsSync(reportJson) ? parseReport(readFileSync(reportJson, "utf8"), opts.workspace) : [];
  return { exitCode: code, reportJson, htmlReport, results, stderr: stderr.slice(-4000) };
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
