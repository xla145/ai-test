import { PerformanceMetrics, JsonLinesTail } from "./performanceProgress.js";
import type { TaskProgressData } from "../shared/taskProgress.js";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, mkdirSync, readFileSync, realpathSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import type { DegradationResult, PerformanceMethod, PerformanceOptions, PerformanceResult, StepMetrics } from "../shared/performance.js";
import { resolvePerformancePath } from "../shared/performanceSource.js";

// ----- k6 HTTP method helpers (k6/http API names) -----
const K6_METHOD: Record<PerformanceMethod, string> = { GET: "get", POST: "post", PUT: "put", DELETE: "del" };

function escapeJsonForJs(value: unknown): string {
  // Serialise to JSON then wrap in single-quotes so it embeds safely in a JS template literal.
  return JSON.stringify(JSON.stringify(value));
}

export interface PerformancePlan {
  target: string;
  code: string;
  /** Environment variables that must be passed to the k6 process (tokens, headers). */
  env: Record<string, string>;
}

// ----- Shared helpers for k6 script generation -----

/** Build the k6 `options` object: either flat duration or ramping stages. */
function buildK6Options(options: PerformanceOptions): Record<string, unknown> {
  const thresholds: Record<string, string[]> = {
    http_req_duration: [`p(95)<${options.p95Ms}`],
    http_req_failed: [`rate<=${options.maxFailureRate}`],
  };
  const rampUp = options.rampUp ?? 0;
  const rampDown = options.rampDown ?? 0;
  if (rampUp > 0 || rampDown > 0) {
    // Ramping VUs mode: total (rampUp + steady + rampDown) validated in caller
    return {
      stages: [
        ...(rampUp > 0 ? [{ duration: `${rampUp}s`, target: options.vus }] : []),
        { duration: `${options.seconds}s`, target: options.vus },
        ...(rampDown > 0 ? [{ duration: `${rampDown}s`, target: 0 }] : []),
      ],
      maxRedirects: 0,
      thresholds,
    };
  }
  return {
    vus: options.vus,
    duration: `${options.seconds}s`,
    maxRedirects: 0,
    discardResponseBodies: true,
    thresholds,
  };
}

/** Emit the auth-header setup lines for a k6 VU function body. */
function emitAuthLines(lines: string[], options: PerformanceOptions, indent = "  "): void {
  if (options.auth !== false) {
    lines.push(`${indent}const authHeader = __ENV.AIPROBE_AUTH_HEADER || 'Authorization';`);
    lines.push(`${indent}const token = __ENV.AIPROBE_AUTH_TOKEN;`);
    lines.push(`${indent}if (token) { Object.keys(headers).filter(k => k.toLowerCase() === authHeader.toLowerCase()).forEach(k => delete headers[k]); headers[authHeader] = token; }`);
  }
}

/** Emit custom header assignments. */
function emitCustomHeaders(lines: string[], headers: Record<string, string>, indent = "  "): void {
  if (Object.keys(headers).length) {
    for (const [k, v] of Object.entries(headers)) {
      lines.push(`${indent}headers[${JSON.stringify(k)}] = ${JSON.stringify(v)};`);
    }
  }
}

/** Validate base URL and ramping duration constraints shared by both plan types. */
function validateBase(base: string, options: PerformanceOptions): URL {
  const url = new URL(base);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new Error("性能测试需要不含凭据、查询参数的 HTTP 环境地址");
  if (!Number.isInteger(options.vus) || options.vus < 1 || options.vus > 100)
    throw new Error("并发用户应为 1–100");
  if (!Number.isInteger(options.seconds) || options.seconds < 1)
    throw new Error("稳态时长应为正整数");
  const rampUp = options.rampUp ?? 0;
  const rampDown = options.rampDown ?? 0;
  if (!Number.isFinite(rampUp) || rampUp < 0 || !Number.isFinite(rampDown) || rampDown < 0)
    throw new Error("ramp-up 和 ramp-down 秒数不能为负");
  const totalSeconds = rampUp + options.seconds + rampDown;
  if (totalSeconds > 300)
    throw new Error(`总时长（ramp-up ${rampUp}s + 稳态 ${options.seconds}s + ramp-down ${rampDown}s = ${totalSeconds}s）不能超过 300 秒`);
  if (!Number.isFinite(options.p95Ms) || options.p95Ms <= 0 || !Number.isFinite(options.maxFailureRate) || options.maxFailureRate < 0 || options.maxFailureRate >= 1)
    throw new Error("请设置有效的 P95 与失败率门槛");
  return url;
}

/** Compute the timeout for the k6 child process (total duration + 30s buffer). */
function computeTimeout(options: PerformanceOptions): number {
  const rampUp = options.rampUp ?? 0;
  const rampDown = options.rampDown ?? 0;
  return (rampUp + options.seconds + rampDown + 30) * 1000;
}

// ----- Single-endpoint plan -----

/** Finder 启动的 Electron 不一定继承 shell PATH；兼容 Homebrew 两种默认前缀。 */
export function k6Executable(env: NodeJS.ProcessEnv = process.env, platform = process.platform,
  exists: (path: string) => boolean = existsSync): string {
  if (env.AITEST_K6_BIN) return env.AITEST_K6_BIN;
  if (platform === "darwin") {
    const installed = ["/opt/homebrew/bin/k6", "/usr/local/bin/k6"].find(exists);
    if (installed) return installed;
  }
  return "k6";
}

/** Only a common business envelope is interpreted; full business assertions remain in API tests. */
function emitResponseCheck(lines: string[], checkBusinessCode: boolean): void {
  lines.push(`  let businessFailed = false, responseInvalid = false;`);
  lines.push(`  let unauthorized = res.status === 401 || res.status === 403;`);
  if (checkBusinessCode) {
    lines.push(`  let parsedObject = false, parsedJson = false;`);
    lines.push(`  try {`);
    lines.push(`    const value = res.json(); parsedJson = true;`);
    lines.push(`    parsedObject = value !== null && typeof value === 'object';`);
    lines.push(`    if (value && typeof value === 'object' && !Array.isArray(value) && 'code' in value && ('msg' in value || 'message' in value)) {`);
    lines.push(`      const code = String(value.code);`);
    lines.push(`      businessFailed = code !== '0' && code !== '200';`);
    lines.push(`      unauthorized = unauthorized || code === '401' || code === '403';`);
    lines.push(`    }`);
    lines.push(`  } catch (_) { /* Mark unreadable JSON below, without persisting response data. */ }`);
    lines.push(`  const keys = Object.keys(res.headers || {});`);
    lines.push(`  const encrypted = keys.some(k => k.toLowerCase() === 'encrypt-key' && res.headers[k]);`);
    lines.push(`  const jsonResponse = keys.some(k => k.toLowerCase() === 'content-type' && String(res.headers[k]).includes('json'));`);
    lines.push(`  responseInvalid = (encrypted && !parsedObject) || (jsonResponse && !parsedJson);`);
    lines.push(`  validationErrors.add(responseInvalid ? 1 : 0);`);
  } else {
    lines.push(`  validationErrors.add(0);`);
  }
  lines.push(`  requestFailed.add(res.status < 200 || res.status >= 400 || businessFailed || responseInvalid);`);
  lines.push(`  businessErrors.add(businessFailed);`);
  lines.push(`  authErrors.add(unauthorized ? 1 : 0);`);
}

export function performancePlan(base: string, options: PerformanceOptions): PerformancePlan {
  const url = validateBase(base, options);
  const resolvedPath = resolvePerformancePath(options.path, options.pathParams);
  // 与接口测试 httpx 的 base_url 语义一致，保留环境中的 API 前缀。
  const target = new URL(url.origin + url.pathname.replace(/\/$/, "") + resolvedPath);
  if (target.origin !== url.origin) throw new Error("目标必须属于当前环境");
  for (const [key, value] of Object.entries(options.query ?? {})) {
    for (const item of Array.isArray(value) ? value : [value]) {
      if (item != null && !["string", "number", "boolean"].includes(typeof item)) throw new Error(`Query 参数 ${key} 只能是标量或标量数组`);
      target.searchParams.append(key, item == null ? "" : String(item));
    }
  }

  const method: PerformanceMethod = options.method ?? "GET";
  if (!Object.hasOwn(K6_METHOD, method)) throw new Error("不支持的性能请求方法");
  const timeout = options.timeoutSeconds ?? 10;
  if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 300) throw new Error("请求超时应在 0–300 秒之间");
  const hasBody = options.body !== undefined && options.body !== null;
  const extraHeaders = options.headers ?? {};

  const lines: string[] = [];
  lines.push(`import http from 'k6/http';`);
  lines.push(`import { sleep } from 'k6';`);
  lines.push(`import { Rate, Counter } from 'k6/metrics';`);
  lines.push(`const requestFailed = new Rate('aiprobe_request_failed');`);
  lines.push(`const businessErrors = new Rate('aiprobe_business_failed');`);
  lines.push(`const authErrors = new Counter('aiprobe_auth_failures');`);
  lines.push(`const validationErrors = new Counter('aiprobe_response_errors');`);
  const k6Options = buildK6Options(options);
  lines.push(`export const options = ${JSON.stringify({
    ...k6Options, discardResponseBodies: options.checkBusinessCode === false,
    summaryTrendStats: ["avg", "min", "max", "p(50)", "p(90)", "p(95)", "p(99)"],
    thresholds: { ...(k6Options.thresholds as Record<string, string[]>), aiprobe_request_failed: [`rate<=${options.maxFailureRate}`], aiprobe_auth_failures: ["count==0"], aiprobe_response_errors: ["count==0"] },
  })};`);
  lines.push(``);
  lines.push(`export default function () {`);
  lines.push(`  const headers = JSON.parse(__ENV.AIPROBE_HEADERS || '{}');`);
  emitAuthLines(lines, options);

  if (hasBody) {
    lines.push(`  if (!Object.keys(headers).some(k => k.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json';`);
    lines.push(`  const body = __ENV.AIPROBE_BODY;`);
  }

  const k6Fn = K6_METHOD[method];
  const params = `{headers, timeout: '${timeout}s', redirects: 0}`;
  if (method === "GET") {
    lines.push(`  const res = http.${k6Fn}(__ENV.AIPROBE_TARGET, ${params});`);
  } else if (hasBody) {
    lines.push(`  const res = http.${k6Fn}(__ENV.AIPROBE_TARGET, body, ${params});`);
  } else {
    lines.push(`  const res = http.${k6Fn}(__ENV.AIPROBE_TARGET, null, ${params});`);
  }
  emitResponseCheck(lines, options.checkBusinessCode !== false);

  lines.push(`  sleep(1);`);
  lines.push(`}`);
  lines.push(``);
  lines.push(`export function handleSummary(data) {`);
  lines.push(`  return { [__ENV.AIPROBE_SUMMARY]: JSON.stringify(data) };`);
  lines.push(`}`);
  lines.push(``);

  return { target: target.href, code: lines.join("\n"), env: {
    AIPROBE_HEADERS: JSON.stringify(extraHeaders),
    ...(hasBody ? { AIPROBE_BODY: JSON.stringify(options.body) } : {}),
  } };
}

// ----- Scenario plan (Phase 2) -----

/**
 * Generate a k6 script for a multi-step scenario (api_flow).
 * Each step runs in a k6 `group()` with custom Trend/Rate metrics so we can
 * extract per-step P95/failure-rate from the handleSummary output.
 * Variable extraction between steps uses `vars` object per VU (isolated).
 */
export function scenarioPlan(base: string, options: PerformanceOptions): PerformancePlan {
  const url = validateBase(base, options);
  const steps = options.scenarioSteps;
  if (!steps?.length) throw new Error("场景压测至少需要一个步骤");
  // Validate each step path
  for (const step of steps) {
    if (typeof step.path !== "string" || !step.path.startsWith("/"))
      throw new Error(`步骤「${step.name}」的路径必须以 / 开头`);
  }

  const extraHeaders = options.headers ?? {};
  const lines: string[] = [];

  // Imports
  lines.push(`import http from 'k6/http';`);
  lines.push(`import { group, sleep } from 'k6';`);
  lines.push(`import { Trend, Rate } from 'k6/metrics';`);
  lines.push(``);

  // Custom metrics per step
  for (let i = 0; i < steps.length; i++) {
    lines.push(`const step_${i}_dur = new Trend('step_${i}_duration', true);`);
    lines.push(`const step_${i}_fail = new Rate('step_${i}_failed');`);
  }
  lines.push(``);

  // Options
  lines.push(`export const options = ${JSON.stringify({ ...buildK6Options(options), discardResponseBodies: false })};`);
  lines.push(``);

  // Default function
  lines.push(`export default function () {`);
  lines.push(`  const headers = {};`);
  emitAuthLines(lines, options);
  emitCustomHeaders(lines, extraHeaders);
  lines.push(`  const vars = {};`);
  lines.push(``);

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const label = `${i + 1}-${step.name}`;
    const k6Fn = K6_METHOD[step.method];
    const hasBody = step.body !== undefined && step.body !== null;
    const stepHeaders = step.headers ?? {};

    lines.push(`  group(${JSON.stringify(label)}, () => {`);
    lines.push(`    const h = Object.assign({}, headers);`);

    // Per-step custom headers
    for (const [k, v] of Object.entries(stepHeaders)) {
      lines.push(`    h[${JSON.stringify(k)}] = ${JSON.stringify(v)};`);
    }

    // Build path with variable interpolation: ${var} → vars[var]
    const pathExpr = step.path.replace(/\$\{(\w+)\}/g, "' + (vars.$1 || '') + '");
    const pathStr = pathExpr.includes("' +") ? `'${pathExpr}'` : JSON.stringify(step.path);
    const fullUrl = `__ENV.AIPROBE_BASE + ${pathStr}`;

    if (hasBody) {
      lines.push(`    h['Content-Type'] = h['Content-Type'] || 'application/json';`);
      // Body may contain ${var} references; render them
      const bodyJson = JSON.stringify(step.body);
      const bodyExpr = bodyJson.replace(/\$\{(\w+)\}/g, "' + JSON.stringify(vars.$1 || '') + '");
      if (bodyExpr !== bodyJson) {
        lines.push(`    const body = '${bodyExpr}';`);
      } else {
        lines.push(`    const body = ${escapeJsonForJs(step.body)};`);
      }
    }

    // HTTP call: scenario steps always read response body for extraction
    const params = `{headers: h, timeout: '10s', redirects: 0}`;
    let call: string;
    if (step.method === "GET") {
      call = `http.${k6Fn}(${fullUrl}, ${params})`;
    } else if (hasBody) {
      call = `http.${k6Fn}(${fullUrl}, body, ${params})`;
    } else {
      call = `http.${k6Fn}(${fullUrl}, null, ${params})`;
    }
    lines.push(`    const res = ${call};`);
    lines.push(`    step_${i}_dur.add(res.timings.duration);`);
    lines.push(`    step_${i}_fail.add(res.status >= 400);`);

    // Extract variables
    if (step.extract && Object.keys(step.extract).length) {
      lines.push(`    try {`);
      lines.push(`      const b = JSON.parse(res.body);`);
      for (const [varName, dotted] of Object.entries(step.extract)) {
        // Convert dotted path like "data.orderId" to b.data.orderId
        const accessor = dotted.split(".").map(p => /^\d+$/.test(p) ? `[${p}]` : `.${p}`).join("");
        lines.push(`      vars[${JSON.stringify(varName)}] = b${accessor};`);
      }
      lines.push(`    } catch (e) { /* extraction failed — later steps may fail */ }`);
    }

    lines.push(`  });`);
    lines.push(``);
  }

  lines.push(`  sleep(1);`);
  lines.push(`}`);
  lines.push(``);
  lines.push(`export function handleSummary(data) {`);
  lines.push(`  return { [__ENV.AIPROBE_SUMMARY]: JSON.stringify(data) };`);
  lines.push(`}`);
  lines.push(``);

  return { target: url.href, code: lines.join("\n"), env: {} };
}

// ----- Baseline comparison (Phase 3) -----

export function compareWithBaseline(current: PerformanceResult, baseline: PerformanceResult): DegradationResult {
  const bp95 = baseline.p95Ms ?? 0;
  const brps = baseline.requestsPerSecond ?? 0;
  const bfail = baseline.failureRate ?? 0;
  const cp95 = current.p95Ms ?? 0;
  const crps = current.requestsPerSecond ?? 0;
  const cfail = current.failureRate ?? 0;

  const details: string[] = [];
  if (bp95 > 0 && cp95 > bp95 * 1.2) {
    details.push(`P95 延迟退化：${cp95.toFixed(1)}ms > 基线 ${bp95.toFixed(1)}ms 的 120%`);
  }
  if (brps > 0 && crps < brps * 0.8) {
    details.push(`RPS 下降：${crps.toFixed(1)} < 基线 ${brps.toFixed(1)} 的 80%`);
  }
  // Failure rate: degraded if more than 2x baseline, or > 1% when baseline was 0
  if ((bfail > 0 && cfail > bfail * 2) || (bfail === 0 && cfail > 0.01)) {
    details.push(`失败率上升：${(cfail * 100).toFixed(2)}% vs 基线 ${(bfail * 100).toFixed(2)}%`);
  }

  return {
    baselineId: baseline.id,
    baseline: { p95Ms: bp95, rps: brps, failureRate: bfail },
    current: { p95Ms: cp95, rps: crps, failureRate: cfail },
    degraded: details.length > 0,
    details,
  };
}

// ----- Report directory -----

function reportDir(workspace: string) {
  const root = realpathSync(workspace);
  const dir = join(root, "reports", "performance");
  mkdirSync(dir, { recursive: true });
  const actual = realpathSync(dir);
  const rel = relative(root, actual);
  if (rel.startsWith("..") || resolve(root, rel) !== actual) throw new Error("性能报告目录必须位于 workspace 内");
  return actual;
}

// ----- List historical results -----

/** 按稳定 ID 读取基线引用的原始执行，不受最近 100 条历史列表截断影响。 */
export function readPerformanceResult(workspace: string, id: string): PerformanceResult | null {
  if (!/^perf-[\w-]+$/.test(id)) throw new Error("性能执行 ID 无效");
  const dir = reportDir(workspace);
  const file = join(dir, `${id}.json`);
  if (!existsSync(file)) return null;
  if (dirname(realpathSync(file)) !== dir) throw new Error("性能执行记录必须位于当前项目的报告目录");
  let result: PerformanceResult;
  try { result = JSON.parse(readFileSync(file, "utf8")); }
  catch { throw new Error("性能执行记录无效或无法读取"); }
  if (!result || result.id !== id || !result.options || typeof result.options !== "object" || Array.isArray(result.options)) {
    throw new Error("性能执行记录无效");
  }
  return result;
}

export function listPerformance(workspace: string): PerformanceResult[] {
  const dir = reportDir(workspace);
  return readdirSync(dir).filter(f => /^perf-[\w-]+\.json$/.test(f)).flatMap(file => {
    try { const r = JSON.parse(readFileSync(join(dir, file), "utf8")); return r.id && r.options ? [r as PerformanceResult] : []; } catch { return []; }
  }).sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 100);
}

// ----- Parse step metrics from k6 handleSummary output -----

function parseStepMetrics(raw: Record<string, unknown>, stepCount: number): StepMetrics[] {
  const metrics = (raw as { metrics?: Record<string, Record<string, unknown>> }).metrics ?? {};
  const steps: StepMetrics[] = [];
  for (let i = 0; i < stepCount; i++) {
    const dur = metrics[`step_${i}_duration`] ?? {};
    const fail = metrics[`step_${i}_failed`] ?? {};
    const values = (dur as { values?: Record<string, number> }).values ?? dur;
    const failValues = (fail as { values?: Record<string, number> }).values ?? fail;
    const finite = (v: unknown) => typeof v === "number" && Number.isFinite(v) ? v : 0;
    steps.push({
      name: `step_${i}`, // Will be patched with actual names by caller
      requests: finite((dur as Record<string, unknown>).count ?? (values as Record<string, unknown>).count),
      p95Ms: finite((values as Record<string, unknown>)["p(95)"]),
      avgMs: finite((values as Record<string, unknown>).avg),
      failureRate: finite((failValues as Record<string, unknown>).rate ?? (failValues as Record<string, unknown>).value),
    });
  }
  return steps;
}

// ----- Execute -----

/** 请求参数在运行时注入；历史只保留脱敏快照。 */
export function redactPerformanceOptions(options: PerformanceOptions, secrets: Record<string, string> = {}): PerformanceOptions {
  const sensitive = /authorization|cookie|token|password|passwd|secret|api.?key|credential/i;
  const hidden = new Set<string>();
  const collect = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    for (const [key, item] of Object.entries(value)) {
      if (sensitive.test(key) && typeof item === "string" && item) hidden.add(item);
      collect(item);
    }
  };
  collect(options);
  if (secrets.AITEST_AUTH_TOKEN) hidden.add(secrets.AITEST_AUTH_TOKEN);
  try { for (const value of Object.values(JSON.parse(secrets.AITEST_ROLE_TOKENS || "{}"))) if (typeof value === "string" && value) hidden.add(value); } catch { /* 凭据解析由运行层处理 */ }
  return JSON.parse(JSON.stringify(options, (key, value: unknown) => {
    if (sensitive.test(key)) return "[已隐藏]";
    if (typeof value === "string") for (const secret of hidden) value = (value as string).split(secret).join("[已隐藏]");
    return value;
  })) as PerformanceOptions;
}

/** Runs a generated HTTP workload via k6. No model, no arbitrary script input. */
export async function runPerformance(
  workspace: string, env: string, base: string, options: PerformanceOptions,
  signal: AbortSignal, secrets?: Record<string, string>,
  observer?: { onProgress: (event: TaskProgressData) => void; onStep: (step: string, data?: Record<string, unknown>) => void },
): Promise<PerformanceResult> {
  observer?.onStep("generate-plan");
  const isScenario = options.scenarioSteps && options.scenarioSteps.length > 0;
  const plan = isScenario ? scenarioPlan(base, options) : performancePlan(base, options);
  signal.throwIfAborted();
  const dir = reportDir(workspace), id = `perf-${randomUUID()}`;
  const script = join(dir, `${id}.js`), summary = join(dir, `${id}.summary.json`);
  const reportPath = join(dir, `${id}.json`);
  writeFileSync(script, plan.code, { mode: 0o600 });
  const method = options.method ?? "GET";
  const result: PerformanceResult = {
    id, env, startedAt: new Date().toISOString(), finishedAt: "", options: redactPerformanceOptions(options, secrets),
    status: "error", requests: null, requestsPerSecond: null, failureRate: null,
    p50Ms: null, p90Ms: null, p95Ms: null, p99Ms: null, avgMs: null, minMs: null, maxMs: null,
    dataSentBytes: null, dataReceivedBytes: null, thresholdsPassed: false, reportPath,
  };
  // Record intent before spawn; interrupted processes leave a truthful incomplete record.
  writeFileSync(reportPath, JSON.stringify({ ...result, message: "执行尚未完整结束" }, null, 2));
  try {
    let timedOut = false;
    // Build k6 process environment: inject secrets (auth token etc.) without writing to script.
    const procEnv: Record<string, string> = {
      ...process.env as Record<string, string>,
      ...plan.env,
      AIPROBE_TARGET: plan.target,
      AIPROBE_SUMMARY: summary,
    };
    // For scenario mode, pass base URL separately (steps build their own full paths)
    if (isScenario) procEnv.AIPROBE_BASE = new URL(base).origin + (new URL(base).pathname === "/" ? "" : new URL(base).pathname).replace(/\/$/, "");

    // Inject auth credentials from the secret store
    if (options.auth !== false && secrets) {
      if (secrets.AITEST_AUTH_TOKEN) procEnv.AIPROBE_AUTH_TOKEN = secrets.AITEST_AUTH_TOKEN;
      if (secrets.AITEST_AUTH_HEADER) procEnv.AIPROBE_AUTH_HEADER = secrets.AITEST_AUTH_HEADER;
      if (options.role && secrets.AITEST_ROLE_TOKENS) {
        try {
          const tokens = JSON.parse(secrets.AITEST_ROLE_TOKENS) as Record<string, string>;
          if (tokens[options.role]) procEnv.AIPROBE_AUTH_TOKEN = tokens[options.role];
        } catch { /* ignore parse errors */ }
      }
    }

    const timeoutMs = computeTimeout(options);
    const liveDir = mkdtempSync(join(tmpdir(), "aiprobe-metrics-"));
    const jsonOut = join(liveDir, "metrics.jsonl");
    writeFileSync(jsonOut, "", { mode: 0o600 });
    const metricsWindow = new PerformanceMetrics(Date.now());
    const tail = new JsonLinesTail(jsonOut, line => metricsWindow.accept(line));
    let lastEmit = 0;
    const flush = (final = false) => {
      tail.read(final);
      if (observer && (final || Date.now() - lastEmit >= 1000)) { lastEmit = Date.now(); observer.onProgress(metricsWindow.snapshot(lastEmit)); }
    };
    const ticker = setInterval(() => flush(), 250);
    let exitCode: number | null;
    observer?.onStep("spawn");
    try { exitCode = await new Promise<number | null>((resolveExit, reject) => {
      const child = spawn(k6Executable(), ["run", "--quiet", "--no-usage-report", "--out", `json=${jsonOut}`, script], {
        cwd: workspace, env: procEnv, stdio: ["ignore", "ignore", "ignore"], shell: false,
      });
      let force: ReturnType<typeof setTimeout> | undefined;
      const stop = () => { if (force) return; child.kill("SIGINT"); force = setTimeout(() => child.kill("SIGKILL"), 3000); force.unref(); };
      const timeout = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
      const cleanup = () => { clearTimeout(timeout); if (force) clearTimeout(force); signal.removeEventListener("abort", stop); };
      signal.addEventListener("abort", stop, { once: true });
      if (signal.aborted) stop();
      child.once("error", error => { cleanup(); reject(error); });
      child.once("close", code => { cleanup(); resolveExit(code); });
    }); } finally { clearInterval(ticker); try { flush(true); } finally { rmSync(liveDir, { recursive: true, force: true }); } }
    observer?.onStep("parse-summary", { exitCode });

    // handleSummary 是唯一汇总文件写入方，兼容嵌套 values 与旧版平铺指标。
    const raw: Record<string, unknown> | undefined = existsSync(summary) ? (() => { try { return JSON.parse(readFileSync(summary, "utf8")); } catch { return undefined; } })() : undefined;
    const metrics = (raw as { metrics?: Record<string, Record<string, unknown>> })?.metrics ?? {};
    const finite = (v: unknown) => typeof v === "number" && Number.isFinite(v) ? v : null;

    // Core metrics
    const reqs = metrics.http_reqs ?? {};
    const reqValues = (reqs as { values?: Record<string, unknown> }).values ?? reqs;
    result.requests = finite(reqValues.count ?? reqs.count);
    result.requestsPerSecond = finite(reqValues.rate ?? reqs.rate);

    const fail = metrics.http_req_failed ?? {};
    const failValues = (fail as { values?: Record<string, unknown> }).values ?? fail;
    result.httpFailureRate = finite(failValues.rate ?? failValues.value ?? fail.value);
    const metricValue = (name: string, key: string) => finite(
      ((metrics[name]?.values ?? metrics[name]) as Record<string, unknown> | undefined)?.[key]);
    result.businessFailureRate = isScenario ? null : metricValue("aiprobe_business_failed", "rate");
    result.authFailures = isScenario ? null : metricValue("aiprobe_auth_failures", "count");
    result.responseValidationFailures = isScenario ? null : metricValue("aiprobe_response_errors", "count");
    result.failureRate = isScenario ? result.httpFailureRate : metricValue("aiprobe_request_failed", "rate");

    // Duration percentiles
    const dur = metrics.http_req_duration ?? {};
    const durValues = (dur as { values?: Record<string, unknown> }).values ?? dur;
    result.p50Ms = finite(durValues["p(50)"]);
    result.p90Ms = finite(durValues["p(90)"]);
    result.p95Ms = finite(durValues["p(95)"]);
    result.p99Ms = finite(durValues["p(99)"]);
    result.avgMs = finite(durValues.avg);
    result.minMs = finite(durValues.min);
    result.maxMs = finite(durValues.max);

    // Data transfer
    const sent = metrics.data_sent ?? {};
    const recv = metrics.data_received ?? {};
    const sentV = (sent as { values?: Record<string, unknown> }).values ?? sent;
    const recvV = (recv as { values?: Record<string, unknown> }).values ?? recv;
    result.dataSentBytes = finite(sentV.count ?? sent.count);
    result.dataReceivedBytes = finite(recvV.count ?? recv.count);

    // Scenario step metrics
    if (isScenario && raw && options.scenarioSteps) {
      const stepMetrics = parseStepMetrics(raw, options.scenarioSteps.length);
      // Patch names from step definitions
      for (let i = 0; i < stepMetrics.length && i < options.scenarioSteps.length; i++) {
        stepMetrics[i].name = `${i + 1}-${options.scenarioSteps[i].name}`;
      }
      result.steps = stepMetrics;
    }

    result.thresholdsPassed = result.requests !== null && result.requests > 0
      && result.failureRate !== null && result.failureRate <= options.maxFailureRate
      && result.p95Ms !== null && result.p95Ms < options.p95Ms
      && (isScenario || (result.authFailures === 0 && result.responseValidationFailures === 0));
    result.status = signal.aborted ? "stopped" : timedOut ? "error" : exitCode === 0 && result.thresholdsPassed ? "passed" : raw ? "failed" : "error";
    if ((result.authFailures ?? 0) > 0) result.message = `${result.authFailures} 次请求未授权（HTTP 或业务码 401/403），请检查环境登录态；不能作为正常业务性能通过证据`;
    else if ((result.responseValidationFailures ?? 0) > 0) result.message = `${result.responseValidationFailures} 次响应为加密数据或无效 JSON，无法完成业务校验；当前性能执行器不支持响应解密，本次不能作为通过证据`;
    else if ((result.businessFailureRate ?? 0) > 0) result.message = `业务失败率 ${(result.businessFailureRate! * 100).toFixed(2)}%；HTTP 200 不代表业务成功`;
    if (timedOut) result.message = "性能执行超过时限，已停止；本次不能作为通过证据";
    if (!raw) result.message = `k6 未生成完整汇总（${isScenario ? "场景" : method} ${options.path}）；本次不能作为通过证据`;
  } catch (error) {
    result.status = signal.aborted ? "stopped" : "error";
    result.message = (error as NodeJS.ErrnoException).code === "ENOENT"
      ? "未找到 k6，请安装 k6 并确保桌面进程 PATH 可访问"
      : "性能执行器失败或汇总无效，保留执行记录供检查";
  }
  if (result.status !== "passed") result.thresholdsPassed = false;
  result.finishedAt = new Date().toISOString();
  observer?.onStep("write-report", { status: result.status });
  writeFileSync(reportPath, JSON.stringify({
    ...result,
    scriptHash: createHash("sha256").update(plan.code).digest("hex"),
    environmentFingerprint: createHash("sha256").update(base).digest("hex"),
  }, null, 2));
  return result;
}
