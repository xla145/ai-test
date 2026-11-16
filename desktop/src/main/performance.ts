import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { PerformanceOptions, PerformanceResult } from "../shared/performance.js";

export function performancePlan(base: string, options: PerformanceOptions) {
  const url = new URL(base);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("性能测试需要不含凭据、查询参数的 HTTP 环境地址");
  if (!Number.isInteger(options.vus) || options.vus < 1 || options.vus > 100 || !Number.isInteger(options.seconds) || options.seconds < 1 || options.seconds > 300) throw new Error("并发用户应为 1–100，时长应为 1–300 秒");
  if (!Number.isFinite(options.p95Ms) || options.p95Ms <= 0 || !Number.isFinite(options.maxFailureRate) || options.maxFailureRate < 0 || options.maxFailureRate >= 1) throw new Error("请设置有效的 P95 与失败率门槛");
  if (typeof options.path !== "string" || !options.path.startsWith("/") || options.path.startsWith("//") || options.path.includes("\\") || options.path.includes("?") || options.path.includes("#")) throw new Error("目标路径必须是环境内的绝对路径，不含查询参数");
  const target = new URL(options.path, url);
  if (target.origin !== url.origin) throw new Error("目标必须属于当前环境");
  return {
    target: target.href,
    code: `import http from 'k6/http';\nimport { sleep } from 'k6';\nexport const options = ${JSON.stringify({ vus: options.vus, duration: `${options.seconds}s`, maxRedirects: 0, discardResponseBodies: true, thresholds: { http_req_duration: [`p(95)<${options.p95Ms}`], http_req_failed: [`rate<=${options.maxFailureRate}`] } })};\nexport default function () { http.get(__ENV.AIPROBE_TARGET, {timeout: '10s', redirects: 0}); sleep(1); }\n`,
  };
}

function reportDir(workspace: string) {
  const root = realpathSync(workspace);
  const dir = join(root, "reports", "performance");
  mkdirSync(dir, { recursive: true });
  const actual = realpathSync(dir);
  const rel = relative(root, actual);
  if (rel.startsWith("..") || resolve(root, rel) !== actual) throw new Error("性能报告目录必须位于 workspace 内");
  return actual;
}

export function listPerformance(workspace: string): PerformanceResult[] {
  const dir = reportDir(workspace);
  return readdirSync(dir).filter(f => /^perf-[\w-]+\.json$/.test(f)).flatMap(file => {
    try { const r = JSON.parse(readFileSync(join(dir, file), "utf8")); return r.id && r.options ? [r as PerformanceResult] : []; } catch { return []; }
  }).sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 100);
}

/** Runs a generated read-only GET workload. No model, shell, or arbitrary script input. */
export async function runPerformance(workspace: string, env: string, base: string, options: PerformanceOptions, signal: AbortSignal): Promise<PerformanceResult> {
  const plan = performancePlan(base, options);
  signal.throwIfAborted();
  const dir = reportDir(workspace), id = `perf-${randomUUID()}`;
  const script = join(dir, `${id}.js`), summary = join(dir, `${id}.summary.json`);
  const reportPath = join(dir, `${id}.json`);
  writeFileSync(script, plan.code, { mode: 0o600 });
  const result: PerformanceResult = { id, env, startedAt: new Date().toISOString(), finishedAt: "", options: structuredClone(options), status: "error", requests: null, requestsPerSecond: null, failureRate: null, p95Ms: null, thresholdsPassed: false, reportPath };
  // Record intent before spawn; interrupted processes leave a truthful incomplete record.
  writeFileSync(reportPath, JSON.stringify({ ...result, message: "执行尚未完整结束" }, null, 2));
  try {
    let timedOut = false;
    const exitCode = await new Promise<number | null>((resolveExit, reject) => {
      const child = spawn("k6", ["run", "--quiet", "--summary-export", summary, script], { cwd: workspace, env: { ...process.env, AIPROBE_TARGET: plan.target }, stdio: ["ignore", "ignore", "ignore"], shell: false });
      let force: ReturnType<typeof setTimeout> | undefined;
      const stop = () => { child.kill("SIGINT"); force = setTimeout(() => child.kill("SIGKILL"), 3000); force.unref(); };
      const timeout = setTimeout(() => { timedOut = true; stop(); }, (options.seconds + 30) * 1000);
      const cleanup = () => { clearTimeout(timeout); if (force) clearTimeout(force); signal.removeEventListener("abort", stop); };
      signal.addEventListener("abort", stop, { once: true });
      if (signal.aborted) stop();
      child.once("error", error => { cleanup(); reject(error); });
      child.once("close", code => { cleanup(); resolveExit(code); });
    });
    const raw = existsSync(summary) ? JSON.parse(readFileSync(summary, "utf8")) : undefined;
    const metrics = raw?.metrics ?? {};
    const finite = (v: unknown) => typeof v === "number" && Number.isFinite(v) ? v : null;
    result.requests = finite(metrics.http_reqs?.count);
    result.requestsPerSecond = finite(metrics.http_reqs?.rate);
    result.failureRate = finite(metrics.http_req_failed?.value);
    result.p95Ms = finite(metrics.http_req_duration?.["p(95)"]);
    result.thresholdsPassed = result.requests !== null && result.requests > 0 && result.failureRate !== null && result.failureRate <= options.maxFailureRate && result.p95Ms !== null && result.p95Ms < options.p95Ms;
    result.status = signal.aborted ? "stopped" : timedOut ? "error" : exitCode === 0 && result.thresholdsPassed ? "passed" : raw ? "failed" : "error";
    if (timedOut) result.message = "性能执行超过时限，已停止；本次不能作为通过证据";
    if (!raw) result.message = "k6 未生成完整汇总；本次不能作为通过证据";
  } catch (error) {
    result.status = signal.aborted ? "stopped" : "error";
    result.message = (error as NodeJS.ErrnoException).code === "ENOENT" ? "未找到 k6，请安装 k6 并确保桌面进程 PATH 可访问" : "性能执行器失败或汇总无效，保留执行记录供检查";
  }
  if (result.status !== "passed") result.thresholdsPassed = false;
  result.finishedAt = new Date().toISOString();
  writeFileSync(reportPath, JSON.stringify({ ...result, scriptHash: createHash("sha256").update(plan.code).digest("hex"), environmentFingerprint: createHash("sha256").update(base).digest("hex") }, null, 2));
  return result;
}
