import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * App 回归：Maestro 执行确定性脚本（scripts/app/<用例ID>.yaml），不经过 Codex、不消耗模型。
 * 同一份脚本在 Android 与 iOS 上运行：脚本头写 `appId: ${APP_ID}`，执行时按平台传入包名 / Bundle ID。
 * 输出与引擎 save-run 兼容的结果数组。
 */
export type Platform = "android" | "ios";

export interface AppRunOptions {
  workspace: string;
  platform: Platform;
  /** 该平台的包名（Android）或 Bundle ID（iOS） */
  appId: string;
  /** 只跑指定用例；不给则跑 scripts/app 下全部脚本 */
  caseIds?: string[];
  /** 设备 ID（adb devices / 模拟器 UDID）；连接了多台设备时必须指定 */
  device?: string;
  /** 角色账号：转成脚本变量 ROLE_<名>_USERNAME / _PASSWORD */
  roles?: { role: string; username: string; password: string }[];
  /** maestro 可执行文件，默认 PATH 上的 maestro */
  maestroBin?: string;
  timeoutMs?: number;
}

export interface AppCaseResult {
  case_id: string;
  status: "passed" | "failed" | "error" | "skipped";
  duration: number;
  message: string;
  evidence_paths: string[];
  reviews: { kind: string; description: string; evidence_paths: string[] }[];
}

export interface AppRunOutput {
  exitCode: number | null;
  junit: string;
  outDir: string;
  results: AppCaseResult[];
  /** 不属于某条用例的错误（设备未连接、Maestro 未安装等），此时可能一条结果都没有 */
  errors: string[];
  stderr: string;
}

export const APP_DIR = join("scripts", "app");

export function flowPath(workspace: string, caseId: string): { abs: string; rel: string } {
  const rel = join(APP_DIR, `${caseId}.yaml`);
  return { abs: join(workspace, rel), rel };
}

/**
 * 角色名 → 脚本变量前缀。ASCII 名直接大写（admin → ROLE_ADMIN），
 * 其它字符（如中文）转成 UTF-8 十六进制，保证稳定且是合法变量名（管理员 → ROLE_E7AEA1E79086E59198）。
 */
export function roleVar(role: string): string {
  const ascii = role.trim().replace(/[\s-]+/g, "_");
  if (/^[A-Za-z0-9_]+$/.test(ascii)) return `ROLE_${ascii.toUpperCase()}`;
  return `ROLE_${Buffer.from(role.trim(), "utf8").toString("hex").toUpperCase()}`;
}

export function roleVariables(roles: AppRunOptions["roles"] = []): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of roles) {
    out[`${roleVar(r.role)}_USERNAME`] = r.username;
    out[`${roleVar(r.role)}_PASSWORD`] = r.password;
  }
  return out;
}

const ASSERTION = /^\s*-\s*(assertVisible|assertNotVisible|assertTrue|extendedWaitUntil|copyTextFrom)\b/m;

/** 保存前检查：脚本头、appId 变量、至少一个断言 */
export function validateFlow(yaml: string): string[] {
  const errors: string[] = [];
  const [header, ...rest] = yaml.split(/^---\s*$/m);
  if (!rest.length) errors.push("缺少脚本头与步骤之间的分隔线 ---");
  if (!/^appId:\s*\$\{APP_ID\}\s*$/m.test(header)) errors.push("脚本头需要 `appId: ${APP_ID}`（不要写死包名，Android 与 iOS 共用一份脚本）");
  if (!ASSERTION.test(rest.join("\n"))) errors.push("脚本没有任何断言：每个预期结果都要落成 assertVisible / assertNotVisible 等断言");
  if (/assertWithAI|extractTextWithAI|assertNoDefectsWithAI/.test(yaml)) errors.push("不要使用 AI 断言（结果不确定）；视觉类预期请记为人工复核");
  return errors;
}

/** 让脚本名等于用例 ID，回归结果才能对应到用例 */
export function normalizeFlow(yaml: string, caseId: string): string {
  const [header, ...rest] = yaml.split(/^---\s*$/m);
  const named = /^name:/m.test(header)
    ? header.replace(/^name:.*$/m, `name: ${caseId}`)
    : header.replace(/^(appId:.*)$/m, `$1\nname: ${caseId}`);
  return [named.trimEnd() + "\n", ...rest].join("---");
}

export function maestroArgs(opts: Pick<AppRunOptions, "device" | "platform" | "appId" | "roles">, files: string[],
  junit: string, debugDir: string): string[] {
  const vars: Record<string, string> = { APP_ID: opts.appId, PLATFORM: opts.platform, ...roleVariables(opts.roles) };
  return [
    ...(opts.device ? ["--device", opts.device] : []),
    // 同时连着 Android 设备与 iOS 模拟器时，按平台挑设备（未指定设备时 Maestro 用该平台的第一台）
    "--platform", opts.platform,
    "test",
    "--format", "junit",
    "--output", junit,
    "--debug-output", debugDir,
    ...Object.entries(vars).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
    ...files,
  ];
}

const unescape = (s: string) => s
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#10;/g, "\n")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&amp;/g, "&");

const attr = (tag: string, name: string) => {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return m ? unescape(m[1]) : undefined;
};

/**
 * 解析 Maestro 的 JUnit 报告。testcase 的 name 为 flow 名（normalizeFlow 写成用例 ID）；
 * 对不上时用 file 属性的文件名（scripts/app/<用例ID>.yaml）。失败信息在 <failure> 的文本中。
 */
export function parseJunit(xml: string, caseIds: string[] = []): AppCaseResult[] {
  const results: AppCaseResult[] = [];
  const re = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g;
  for (const m of xml.matchAll(re)) {
    const tag = m[1];
    const body = m[3] ?? "";
    const name = attr(tag, "name") ?? attr(tag, "id") ?? "";
    const fileId = (attr(tag, "file") ?? "").split(/[\\/]/).pop()?.replace(/\.ya?ml$/, "") ?? "";
    const caseId = caseIds.find((id) => name === id) ?? caseIds.find((id) => fileId === id)
      ?? caseIds.find((id) => name.includes(id)) ?? (fileId || name.split(/\s/)[0]);
    let status: AppCaseResult["status"] = "passed";
    let message = "";
    const fail = /<(failure|error|skipped)\b([^>]*?)(\/>|>([\s\S]*?)<\/\1>)/.exec(body);
    if (fail) {
      status = fail[1] === "failure" ? "failed" : fail[1] === "error" ? "error" : "skipped";
      message = [attr(fail[2], "message"), fail[4] ? unescape(fail[4]).trim() : ""].filter(Boolean).join("\n");
    }
    results.push({ case_id: caseId, status, duration: Number(attr(tag, "time") ?? 0), message: message.slice(0, 4000), evidence_paths: [], reviews: [] });
  }
  return results;
}

function findScreenshots(dir: string, caseId: string, workspace: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.png$/i.test(f) && p.includes(caseId)) out.push(relative(workspace, p));
    }
  };
  walk(dir);
  return out.slice(-3);
}

export async function runAppSuite(opts: AppRunOptions): Promise<AppRunOutput> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = join(opts.workspace, "reports", `app-${opts.platform}-${stamp}`);
  mkdirSync(outDir, { recursive: true });
  const junit = join(outDir, "junit.xml");
  const debugDir = join(outDir, "debug");
  const dir = join(opts.workspace, APP_DIR);
  const all = existsSync(dir) ? readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).map((f) => f.replace(/\.ya?ml$/, "")) : [];
  const ids = (opts.caseIds ?? all).filter((id) => all.includes(id));
  if (!ids.length) return { exitCode: 0, junit, outDir, results: [], errors: ["没有可执行的 App 脚本"], stderr: "" };
  if (!opts.appId) throw new Error(`执行环境没有配置 ${opts.platform === "ios" ? "iOS Bundle ID" : "Android 包名"}`);

  const files = ids.map((id) => flowPath(opts.workspace, id).abs);
  const bin = opts.maestroBin || "maestro";
  const args = maestroArgs(opts, files, junit, debugDir);
  const { code, stderr } = await new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
    // stdin 关闭：连接多台设备时 Maestro 会交互式询问，不能让它挂起
    const child = spawn(bin, args, { cwd: opts.workspace, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let err = "";
    child.stdout.on("data", (d) => (err += String(d)));
    child.stderr.on("data", (d) => (err += String(d)));
    const timer = setTimeout(() => child.kill(), opts.timeoutMs ?? 60 * 60_000);
    child.on("error", (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(e.code === "ENOENT" ? new Error(`未找到 Maestro（${bin}），请安装后在「全局设置 → 运行环境」中配置路径`) : e);
    });
    child.on("close", (c) => {
      clearTimeout(timer);
      resolve({ code: c, stderr: err });
    });
  });
  const results = existsSync(junit) ? parseJunit(readFileSync(junit, "utf8"), ids) : [];
  for (const r of results) if (r.status !== "passed") r.evidence_paths = findScreenshots(debugDir, r.case_id, opts.workspace);
  const errors = results.length ? [] : [stderr.trim().split("\n").slice(-20).join("\n") || `Maestro 退出码 ${code}`];
  return { exitCode: code, junit, outDir, results, errors, stderr: stderr.slice(-4000) };
}
