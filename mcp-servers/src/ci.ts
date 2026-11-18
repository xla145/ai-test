#!/usr/bin/env node
/**
 * 无界面 CI 执行器（三期：CI 集成、团队共享）。
 *
 *   aitest-ci run  --workspace <dir> --env <name> [--suite api,ui] [--base-url URL] [--out DIR]
 *   aitest-ci init --workspace <dir> --tool-repo <git url> [--provider github|gitlab] [--env name]
 *
 * run：把团队共享的 workspace（export-workspace 产物，随 git 提交）导入临时数据库，
 * 直接执行接口与 UI 脚本——不调用任何模型——输出 JUnit 与 Markdown 摘要，有失败则退出码为 1。
 * 凭据只从 CI 的密钥变量读取：AITEST_AUTH_TOKEN、AITEST_AUTH_HEADER、AITEST_ROLES（JSON）、
 * AITEST_ROLE_TOKENS（JSON，接口多账号的角色 token）。
 */
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { runEngine, type EngineOptions } from "./engine.js";
import { runUiSuite } from "./ui/runner.js";

export interface CiOptions {
  workspace: string;
  env: string;
  suites?: ("api" | "ui")[];
  baseUrl?: string;
  outDir?: string;
  python?: string;
  /** 测试注入：默认取 process.env */
  secrets?: NodeJS.ProcessEnv;
  log?: (msg: string) => void;
}

export interface CiCaseResult {
  suite: "api" | "ui";
  case_id: string;
  title: string;
  status: string;
  duration: number;
  message: string;
  failure_type?: string | null;
}

export interface CiReport {
  exitCode: number;
  project: string;
  env: string;
  baseUrl: string;
  results: CiCaseResult[];
  junit: string;
  summary: string;
  runs: Record<string, string>;
  /** 单文件 HTML 汇总报告 */
  htmlReport?: string;
}

interface Project {
  id: string;
  name: string;
  environments: Record<string, { base_url: string; login?: unknown; [k: string]: unknown }>;
}

const FAILED = new Set(["failed", "error"]);

export async function runCi(opts: CiOptions): Promise<CiReport> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const secrets = opts.secrets ?? process.env;
  const workspace = resolve(opts.workspace);
  const suites = opts.suites ?? ["api", "ui"];
  const outDir = resolve(opts.outDir ?? join(workspace, "reports", "ci"));
  mkdirSync(outDir, { recursive: true });
  const engineOpts: EngineOptions = {
    python: opts.python ?? secrets.AITEST_PYTHON ?? "python3",
    db: join(mkdtempSync(join(tmpdir(), "aitest-ci-")), "ci.sqlite"),
    // 接口多账号：角色账号密码（配合环境的接口登录）与角色 token
    env: pick(secrets, ["AITEST_AUTH_TOKEN", "AITEST_AUTH_HEADER", "AITEST_ROLES", "AITEST_ROLE_TOKENS", "AITEST_DB_PASSWORDS", "PYTHONPATH"]),
  };
  const engine = <T,>(args: string[], env?: Record<string, string>) =>
    runEngine<T>(args, { ...engineOpts, env: { ...engineOpts.env, ...env } });

  const imported = await engine<{ project_id: string }>(["import-workspace", "--workspace", workspace]);
  let project = await engine<Project>(["get-project", "--project", imported.project_id]);
  const envCfg = project.environments[opts.env];
  if (!envCfg && !opts.baseUrl) throw new Error(`workspace 中没有环境 ${opts.env}，请用 --base-url 指定被测地址`);
  const baseUrl = opts.baseUrl ?? envCfg.base_url;
  if (!envCfg || envCfg.base_url !== baseUrl) {
    project = await engine<Project>(["set-environment", "--project", project.id, "--env", opts.env,
      "--json", JSON.stringify({ ...(envCfg ?? {}), base_url: baseUrl })]);
  }
  log(`项目 ${project.name}，环境 ${opts.env}（${baseUrl}），执行：${suites.join(" + ")}。不调用模型。`);

  const cases = new Map((await engine<{ id: string; title: string }[]>(["list-cases", "--project", project.id])).map((c) => [c.id, c.title]));
  const results: CiCaseResult[] = [];
  const runs: Record<string, string> = {};

  if (suites.includes("api")) {
    if (existsSync(join(workspace, "scripts", "api", "test_api.py"))) {
      const run = await engine<{ run_id: string; total: number; passed: number }>(["run-api-suite", "--project", project.id, "--env", opts.env]);
      runs.api = run.run_id;
      const rows = await engine<CiCaseResult[]>(["list-run-results", "--run", run.run_id]);
      results.push(...rows.map((r) => ({ ...r, suite: "api" as const, title: cases.get(r.case_id) ?? r.case_id })));
      log(`接口：${run.passed}/${run.total} 通过`);
    } else {
      log("接口：没有脚本，跳过");
    }
  }

  if (suites.includes("ui")) {
    const uiDir = join(workspace, "scripts", "ui");
    const specs = existsSync(uiDir) ? readdirSync(uiDir).filter((f) => f.endsWith(".spec.ts")) : [];
    if (specs.length) {
      const dbRuntime = await engine<Record<string, string>>(["db-runtime-env", "--project", project.id, "--env", opts.env]);
      const out = await runUiSuite({
        workspace,
        baseUrl,
        env: {
          ...pick(secrets, ["AITEST_ROLES", "AITEST_CHROMIUM_PATH", "AITEST_AUTH_MAX_AGE_MIN", "PYTHONPATH"]),
          ...dbRuntime,
          AITEST_PYTHON: engineOpts.python ?? "python3",
          ...(envCfg?.login ? { AITEST_LOGIN: JSON.stringify(envCfg.login) } : {}),
        },
      });
      if (out.errors.length) throw new Error(`UI 执行失败：${out.errors.join("; ")}`);
      if (!out.results.length) throw new Error(`UI 脚本没有产出结果（退出码 ${out.exitCode}）：${out.stderr.slice(-1500)}`);
      const file = join(outDir, "ui-results.json");
      writeFileSync(file, JSON.stringify(out.results));
      const run = await engine<{ run_id: string; total: number; passed: number }>([
        "save-run", "--project", project.id, "--env", opts.env, "--results-file", file, "--framework", "playwright",
        "--html-report", out.htmlReport,
      ]);
      runs.ui = run.run_id;
      const rows = await engine<CiCaseResult[]>(["list-run-results", "--run", run.run_id]);
      results.push(...rows.map((r) => ({ ...r, suite: "ui" as const, title: cases.get(r.case_id) ?? r.case_id })));
      log(`UI：${run.passed}/${run.total} 通过（HTML 报告：${out.htmlReport}）`);
    } else {
      log("UI：没有脚本，跳过");
    }
  }

  const junit = toJunit(results);
  const summary = toSummary(project.name, opts.env, baseUrl, results);
  writeFileSync(join(outDir, "junit.xml"), junit);
  writeFileSync(join(outDir, "summary.md"), summary);
  // 单文件 HTML 汇总报告（截图内嵌），作为构建产物上传后可直接打开
  const runIds = Object.values(runs);
  let htmlReport: string | undefined;
  if (runIds.length) {
    htmlReport = (await engine<{ path: string }>([
      "export-report", ...runIds.flatMap((id) => ["--run", id]), "--out", join(outDir, "report.html"),
    ])).path;
  }
  if (secrets.GITHUB_STEP_SUMMARY) appendFileSync(secrets.GITHUB_STEP_SUMMARY, summary + "\n");
  const exitCode = results.some((r) => FAILED.has(r.status)) ? 1 : 0;
  log(`结果写入 ${outDir}（junit.xml、summary.md${htmlReport ? "、report.html" : ""}），退出码 ${exitCode}`);
  return { exitCode, project: project.name, env: opts.env, baseUrl, results, junit, summary, runs, htmlReport };
}

function pick(env: NodeJS.ProcessEnv, keys: string[]): Record<string, string> {
  return Object.fromEntries(keys.filter((k) => env[k]).map((k) => [k, env[k] as string]));
}

const xml = (s: string) =>
  s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function toJunit(results: CiCaseResult[]): string {
  const bySuite = new Map<string, CiCaseResult[]>();
  for (const r of results) bySuite.set(r.suite, [...(bySuite.get(r.suite) ?? []), r]);
  const suites = [...bySuite.entries()].map(([name, rs]) => {
    const failures = rs.filter((r) => r.status === "failed").length;
    const errors = rs.filter((r) => r.status === "error").length;
    const skipped = rs.filter((r) => r.status === "skipped").length;
    const time = rs.reduce((t, r) => t + (r.duration || 0), 0);
    const cases = rs.map((r) => {
      const head = `    <testcase classname="aitest.${name}" name="${xml(`${r.case_id} ${r.title}`)}" time="${(r.duration || 0).toFixed(3)}"`;
      if (r.status === "passed") return `${head}/>`;
      if (r.status === "skipped") return `${head}><skipped/></testcase>`;
      const tag = r.status === "error" ? "error" : "failure";
      const type = r.failure_type ? ` type="${xml(r.failure_type)}"` : "";
      return `${head}><${tag} message="${xml(r.message.split("\n")[0].slice(0, 300))}"${type}>${xml(r.message)}</${tag}></testcase>`;
    });
    return `  <testsuite name="${name}" tests="${rs.length}" failures="${failures}" errors="${errors}" skipped="${skipped}" time="${time.toFixed(3)}">\n${cases.join("\n")}\n  </testsuite>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="aitest">\n${suites.join("\n")}\n</testsuites>\n`;
}

const STATUS_LABEL: Record<string, string> = { passed: "通过", failed: "失败", error: "错误", skipped: "跳过" };
const TYPE_LABEL: Record<string, string> = { environment: "环境问题", product_bug: "疑似产品缺陷", unknown: "待归因" };

export function toSummary(project: string, env: string, baseUrl: string, results: CiCaseResult[]): string {
  const count = (st: string) => results.filter((r) => r.status === st).length;
  const failed = results.filter((r) => FAILED.has(r.status));
  const lines = [
    `## AI 测试回归：${project}`,
    "",
    `环境 \`${env}\`（${baseUrl}），共 ${results.length} 条：通过 ${count("passed")}，失败 ${count("failed") + count("error")}，跳过 ${count("skipped")}。CI 中不调用模型。`,
  ];
  if (failed.length) {
    lines.push("", "| 类型 | 用例 | 初步归因 | 信息 |", "| --- | --- | --- | --- |");
    for (const r of failed) {
      const msg = r.message.split("\n")[0].replace(/\|/g, "\\|").slice(0, 160);
      lines.push(`| ${r.suite === "ui" ? "UI" : "接口"} | ${r.case_id} ${r.title.replace(/\|/g, "\\|")} | ${TYPE_LABEL[r.failure_type ?? "unknown"] ?? r.failure_type} | ${msg} |`);
    }
    lines.push("", "「待归因」的失败请在客户端中做失败归因；页面改版类问题可走自愈流程生成脚本修改建议。");
  }
  return lines.join("\n") + "\n";
}

// --------------------------------------------------------------------------- 性能测试 CI

export interface PerfCiOptions {
  workspace: string;
  env: string;
  path?: string;
  method?: string;
  body?: string;
  scenario?: string;
  vus?: number;
  seconds?: number;
  p95?: number;
  maxFailureRate?: number;
  rampUp?: number;
  rampDown?: number;
  outDir?: string;
  python?: string;
  secrets?: NodeJS.ProcessEnv;
  log?: (msg: string) => void;
}

export interface PerfCiReport {
  exitCode: number;
  summary: string;
  junit: string;
}

/** Generate a k6 script for CI (self-contained, no desktop dependency). */
function generateK6Script(opts: {
  method: string; target: string; body?: unknown; headers?: Record<string, string>;
  vus: number; seconds: number; p95: number; maxFailureRate: number; rampUp?: number; rampDown?: number;
  scenarioSteps?: Array<{ name: string; method: string; path: string; body?: unknown; extract?: Record<string, string> }>;
  baseUrl?: string;
}): string {
  const K6_METHOD: Record<string, string> = { GET: "get", POST: "post", PUT: "put", DELETE: "del" };
  const thresholds = JSON.stringify({ http_req_duration: [`p(95)<${opts.p95}`], http_req_failed: [`rate<=${opts.maxFailureRate}`] });

  // Load model: stages or flat duration
  const useStages = opts.rampUp && opts.rampUp > 0;
  const optionsObj = useStages
    ? `{ stages: ${JSON.stringify([
        { duration: `${opts.rampUp}s`, target: opts.vus },
        { duration: `${opts.seconds}s`, target: opts.vus },
        { duration: `${opts.rampDown ?? 10}s`, target: 0 },
      ])}, maxRedirects: 0, discardResponseBodies: ${!opts.scenarioSteps?.length}, thresholds: ${thresholds} }`
    : `{ vus: ${opts.vus}, duration: '${opts.seconds}s', maxRedirects: 0, discardResponseBodies: ${!opts.scenarioSteps?.length}, thresholds: ${thresholds} }`;

  const lines: string[] = [];
  lines.push(`import http from 'k6/http';`);

  if (opts.scenarioSteps?.length) {
    // Scenario mode: multi-step with groups
    lines.push(`import { group, sleep } from 'k6';`);
    lines.push(`import { Trend, Rate } from 'k6/metrics';`);
    lines.push(``);
    opts.scenarioSteps.forEach((_, i) => {
      lines.push(`const step_${i}_dur = new Trend('step_${i}_duration');`);
      lines.push(`const step_${i}_fail = new Rate('step_${i}_failed');`);
    });
    lines.push(``);
    lines.push(`export const options = ${optionsObj};`);
    lines.push(``);
    lines.push(`export default function () {`);
    lines.push(`  const h = {};`);
    lines.push(`  const ah = __ENV.AIPROBE_AUTH_HEADER || 'Authorization';`);
    lines.push(`  if (__ENV.AIPROBE_AUTH_TOKEN) h[ah] = __ENV.AIPROBE_AUTH_TOKEN;`);
    if (opts.headers) {
      for (const [k, v] of Object.entries(opts.headers)) lines.push(`  h[${JSON.stringify(k)}] = ${JSON.stringify(v)};`);
    }
    lines.push(`  let vars = {};`);
    opts.scenarioSteps.forEach((step, i) => {
      const label = `${i + 1}-${step.name}`;
      const fn = K6_METHOD[step.method] ?? "get";
      const hasBody = step.body !== undefined && step.body !== null;
      lines.push(`  group(${JSON.stringify(label)}, () => {`);
      const reqHeaders = hasBody ? `{...h, 'Content-Type': 'application/json'}` : `h`;
      let pathExpr = `\`\${__ENV.AIPROBE_BASE}${step.path}\``;
      // Replace ${var} references with template literal vars
      pathExpr = pathExpr.replace(/\$\{(\w+)\}/g, (_, v) => `\${vars.${v}}`);
      if (hasBody) {
        let bodyStr = JSON.stringify(step.body);
        bodyStr = bodyStr.replace(/"\$\{(\w+)\}"/g, `" + vars.$1 + "`);
        lines.push(`    const res = http.${fn}(${pathExpr}, ${JSON.stringify(bodyStr)}, {headers: ${reqHeaders}, timeout: '10s'});`);
      } else if (step.method === "GET") {
        lines.push(`    const res = http.${fn}(${pathExpr}, {headers: ${reqHeaders}, timeout: '10s'});`);
      } else {
        lines.push(`    const res = http.${fn}(${pathExpr}, null, {headers: ${reqHeaders}, timeout: '10s'});`);
      }
      lines.push(`    step_${i}_dur.add(res.timings.duration);`);
      lines.push(`    step_${i}_fail.add(res.status >= 400);`);
      if (step.extract) {
        lines.push(`    try { const b = JSON.parse(res.body);`);
        for (const [name, path] of Object.entries(step.extract)) {
          const chain = path.split(".").map(p => `[${JSON.stringify(p)}]`).join("");
          lines.push(`      vars[${JSON.stringify(name)}] = b${chain};`);
        }
        lines.push(`    } catch(e) {}`);
      }
      lines.push(`  });`);
    });
    lines.push(`  sleep(1);`);
    lines.push(`}`);
  } else {
    // Single endpoint mode
    lines.push(`import { sleep } from 'k6';`);
    lines.push(``);
    lines.push(`export const options = ${optionsObj};`);
    lines.push(``);
    lines.push(`export default function () {`);
    lines.push(`  const h = {};`);
    lines.push(`  const ah = __ENV.AIPROBE_AUTH_HEADER || 'Authorization';`);
    lines.push(`  if (__ENV.AIPROBE_AUTH_TOKEN) h[ah] = __ENV.AIPROBE_AUTH_TOKEN;`);
    if (opts.headers) {
      for (const [k, v] of Object.entries(opts.headers)) lines.push(`  h[${JSON.stringify(k)}] = ${JSON.stringify(v)};`);
    }
    const fn = K6_METHOD[opts.method] ?? "get";
    if (opts.body !== undefined) {
      lines.push(`  h['Content-Type'] = h['Content-Type'] || 'application/json';`);
      lines.push(`  http.${fn}(__ENV.AIPROBE_TARGET, ${JSON.stringify(JSON.stringify(opts.body))}, {headers: h, timeout: '10s', redirects: 0});`);
    } else if (opts.method === "GET" || !opts.method) {
      lines.push(`  http.${fn}(__ENV.AIPROBE_TARGET, {headers: h, timeout: '10s', redirects: 0});`);
    } else {
      lines.push(`  http.${fn}(__ENV.AIPROBE_TARGET, null, {headers: h, timeout: '10s', redirects: 0});`);
    }
    lines.push(`  sleep(1);`);
    lines.push(`}`);
  }
  lines.push(``);
  lines.push(`export function handleSummary(data) { return { [__ENV.AIPROBE_SUMMARY]: JSON.stringify(data) }; }`);
  lines.push(``);
  return lines.join("\n");
}

function perfThresholdJunit(method: string, path: string, results: { p95Ms: number | null; failureRate: number | null; thresholdsPassed: boolean }, p95Limit: number, failLimit: number): string {
  const cases: string[] = [];
  const p95Pass = results.p95Ms !== null && results.p95Ms < p95Limit;
  const failPass = results.failureRate !== null && results.failureRate <= failLimit;
  cases.push(p95Pass
    ? `    <testcase classname="aitest.perf" name="P95 延迟 &lt; ${p95Limit}ms (${method} ${xml(path)})" time="0"/>`
    : `    <testcase classname="aitest.perf" name="P95 延迟 &lt; ${p95Limit}ms (${method} ${xml(path)})" time="0"><failure message="P95 实际 ${results.p95Ms ?? '—'}ms，超过门槛 ${p95Limit}ms"/></testcase>`);
  cases.push(failPass
    ? `    <testcase classname="aitest.perf" name="失败率 ≤ ${(failLimit * 100).toFixed(1)}% (${method} ${xml(path)})" time="0"/>`
    : `    <testcase classname="aitest.perf" name="失败率 ≤ ${(failLimit * 100).toFixed(1)}% (${method} ${xml(path)})" time="0"><failure message="失败率实际 ${results.failureRate !== null ? (results.failureRate * 100).toFixed(2) + '%' : '—'}，超过门槛"/></testcase>`);
  const failures = [!p95Pass, !failPass].filter(Boolean).length;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="aitest-perf">\n  <testsuite name="perf" tests="2" failures="${failures}">\n${cases.join("\n")}\n  </testsuite>\n</testsuites>\n`;
}

function perfSummaryMd(method: string, path: string, env: string, baseUrl: string, vus: number, seconds: number, results: {
  requests?: number | null; requestsPerSecond?: number | null; p50Ms?: number | null; p90Ms?: number | null;
  p95Ms?: number | null; p99Ms?: number | null; failureRate?: number | null; thresholdsPassed?: boolean;
}, p95Limit: number, failLimit: number): string {
  const ms = (v: number | null | undefined) => v == null ? "—" : `${v.toFixed(1)}ms`;
  const pct = (v: number | null | undefined) => v == null ? "—" : `${(v * 100).toFixed(2)}%`;
  const icon = (ok: boolean) => ok ? "✅" : "❌";
  const p95ok = results.p95Ms != null && results.p95Ms < p95Limit;
  const failok = results.failureRate != null && results.failureRate <= failLimit;
  return [
    `## 性能测试：${method} ${path}`,
    "",
    `环境 \`${env}\`（${baseUrl}），${vus} VU × ${seconds}s`,
    "",
    "| 指标 | 值 | 门槛 | 结果 |",
    "| --- | --- | --- | --- |",
    `| 请求总数 | ${results.requests ?? "—"} | | |`,
    `| RPS | ${results.requestsPerSecond?.toFixed(1) ?? "—"} | | |`,
    `| P50 | ${ms(results.p50Ms)} | | |`,
    `| P90 | ${ms(results.p90Ms)} | | |`,
    `| P95 | ${ms(results.p95Ms)} | < ${p95Limit}ms | ${icon(p95ok)} |`,
    `| P99 | ${ms(results.p99Ms)} | | |`,
    `| 失败率 | ${pct(results.failureRate)} | ≤ ${(failLimit * 100).toFixed(1)}% | ${icon(failok)} |`,
    "",
    results.thresholdsPassed ? "**结果：通过** 🎉" : "**结果：未通过** ⚠️",
    "",
  ].join("\n");
}

export async function runPerfCi(opts: PerfCiOptions): Promise<PerfCiReport> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const secrets = opts.secrets ?? process.env;
  const workspace = resolve(opts.workspace);
  const outDir = resolve(opts.outDir ?? join(workspace, "reports", "ci"));
  mkdirSync(outDir, { recursive: true });
  const engineOpts: EngineOptions = {
    python: opts.python ?? secrets.AITEST_PYTHON ?? "python3",
    db: join(mkdtempSync(join(tmpdir(), "aitest-ci-perf-")), "ci.sqlite"),
    env: pick(secrets, ["AITEST_AUTH_TOKEN", "AITEST_AUTH_HEADER", "AITEST_ROLES", "AITEST_ROLE_TOKENS", "PYTHONPATH"]),
  };
  const engine = <T,>(args: string[], env?: Record<string, string>) =>
    runEngine<T>(args, { ...engineOpts, env: { ...engineOpts.env, ...env } });

  const imported = await engine<{ project_id: string }>(["import-workspace", "--workspace", workspace]);
  const project = await engine<{ id: string; name: string; environments: Record<string, { base_url: string; api_crypto?: { headers?: Record<string, string> }; production?: boolean }> }>(
    ["get-project", "--project", imported.project_id]);
  const envCfg = project.environments[opts.env];
  if (!envCfg) throw new Error(`workspace 中没有环境 ${opts.env}`);
  if (envCfg.production) throw new Error("性能测试不允许在生产环境执行");
  const baseUrl = envCfg.base_url;

  const method = (opts.method ?? "GET").toUpperCase();
  const path = opts.path ?? "/";
  const vus = opts.vus ?? 10;
  const seconds = opts.seconds ?? 30;
  const p95 = opts.p95 ?? 500;
  const maxFailureRate = opts.maxFailureRate ?? 0.01;

  // Compile scenario steps if requested
  let scenarioSteps: Array<{ name: string; method: string; path: string; body?: unknown; extract?: Record<string, string> }> | undefined;
  if (opts.scenario) {
    const compiled = await engine<{ steps: typeof scenarioSteps }>(["perf-compile", "--case", opts.scenario]);
    scenarioSteps = compiled.steps;
    log(`场景编译：${scenarioSteps?.length ?? 0} 个步骤`);
  }

  const target = new URL(path, baseUrl).href;
  const cryptoHeaders = envCfg.api_crypto?.headers ?? {};
  const body = opts.body ? JSON.parse(opts.body) : undefined;

  const script = generateK6Script({
    method, target, body, headers: Object.keys(cryptoHeaders).length ? cryptoHeaders : undefined,
    vus, seconds, p95, maxFailureRate, rampUp: opts.rampUp, rampDown: opts.rampDown,
    scenarioSteps, baseUrl,
  });

  log(`性能测试：${scenarioSteps ? `场景 ${opts.scenario}（${scenarioSteps.length} 步）` : `${method} ${path}`}，${vus} VU × ${seconds}s`);

  // Write & run k6 script
  const id = `perf-${randomUUID()}`;
  const scriptPath = join(outDir, `${id}.js`);
  const summaryPath = join(outDir, `${id}.summary.json`);
  writeFileSync(scriptPath, script, { mode: 0o600 });

  const procEnv: Record<string, string> = {
    ...process.env as Record<string, string>,
    AIPROBE_TARGET: target,
    AIPROBE_BASE: baseUrl.replace(/\/$/, ""),
    AIPROBE_SUMMARY: summaryPath,
  };
  if (secrets.AITEST_AUTH_TOKEN) procEnv.AIPROBE_AUTH_TOKEN = secrets.AITEST_AUTH_TOKEN;
  if (secrets.AITEST_AUTH_HEADER) procEnv.AIPROBE_AUTH_HEADER = secrets.AITEST_AUTH_HEADER;

  const exitCode = await new Promise<number | null>((resolveExit, reject) => {
    const child = spawn("k6", ["run", "--quiet", "--summary-export", summaryPath, scriptPath], {
      cwd: workspace, env: procEnv, stdio: ["ignore", "inherit", "inherit"], shell: false,
    });
    const timeout = setTimeout(() => { child.kill("SIGKILL"); }, (seconds + (opts.rampUp ?? 0) + (opts.rampDown ?? 0) + 60) * 1000);
    child.once("error", (e) => { clearTimeout(timeout); reject(e); });
    child.once("close", (code) => { clearTimeout(timeout); resolveExit(code); });
  });

  // Parse results
  const finite = (v: unknown) => typeof v === "number" && Number.isFinite(v) ? v : null;
  let results = { requests: null as number | null, requestsPerSecond: null as number | null, failureRate: null as number | null,
    p50Ms: null as number | null, p90Ms: null as number | null, p95Ms: null as number | null, p99Ms: null as number | null, thresholdsPassed: false };
  if (existsSync(summaryPath)) {
    try {
      const raw = JSON.parse(readFileSync(summaryPath, "utf8"));
      const m = raw?.metrics ?? {};
      const dur = m.http_req_duration ?? {};
      results = {
        requests: finite(m.http_reqs?.count), requestsPerSecond: finite(m.http_reqs?.rate),
        failureRate: finite(m.http_req_failed?.value ?? m.http_req_failed?.rate),
        p50Ms: finite(dur["p(50)"]), p90Ms: finite(dur["p(90)"]),
        p95Ms: finite(dur["p(95)"]), p99Ms: finite(dur["p(99)"]),
        thresholdsPassed: results.requests !== null && results.p95Ms !== null && results.p95Ms < p95
          && results.failureRate !== null && results.failureRate <= maxFailureRate,
      };
      // Recompute thresholdsPassed with actual parsed values
      results.thresholdsPassed = results.requests !== null && results.requests > 0
        && results.p95Ms !== null && results.p95Ms < p95
        && results.failureRate !== null && results.failureRate <= maxFailureRate;
    } catch { /* summary parse failure — results stay null */ }
  }

  const junit = perfThresholdJunit(method, path, results, p95, maxFailureRate);
  const summary = perfSummaryMd(method, path, opts.env, baseUrl, vus, seconds, results, p95, maxFailureRate);

  writeFileSync(join(outDir, "perf-junit.xml"), junit);
  writeFileSync(join(outDir, "perf-summary.md"), summary);
  if (secrets.GITHUB_STEP_SUMMARY) appendFileSync(secrets.GITHUB_STEP_SUMMARY, summary + "\n");

  const finalExitCode = exitCode !== 0 || !results.thresholdsPassed ? 1 : 0;
  log(`结果写入 ${outDir}（perf-junit.xml、perf-summary.md），退出码 ${finalExitCode}`);
  return { exitCode: finalExitCode, summary, junit };
}

// --------------------------------------------------------------------------- 工作流模板

export function workflowTemplate(provider: "github" | "gitlab", toolRepo: string, env: string): { path: string; content: string } {
  const setup = [
    `git clone --depth 1 ${toolRepo} .aitest-tool`,
    "pip install ./.aitest-tool/engine",
    "(cd .aitest-tool && npm ci && npm run build -w mcp-servers)",
    "(cd .aitest-tool/mcp-servers && npx playwright install --with-deps chromium)",
  ];
  const run = `node .aitest-tool/mcp-servers/dist/ci.js run --workspace . --env ${env}`;
  if (provider === "gitlab") {
    return {
      path: ".gitlab-ci.yml",
      content: [
        "# 由 AIProbe 生成：每次推送执行回归（不调用模型）。",
        "# 在 CI/CD 变量中配置：AITEST_AUTH_TOKEN、AITEST_ROLES（JSON，多角色账号）、AITEST_ROLE_TOKENS（JSON，可选）、AITEST_DB_PASSWORDS（JSON，数据库密码）。",
        "aitest-regression:",
        "  image: mcr.microsoft.com/playwright:v1.63.0-noble",
        "  script:",
        "    - apt-get update && apt-get install -y python3-pip python3-venv git",
        "    - python3 -m venv .venv && . .venv/bin/activate",
        ...setup.map((s) => `    - ${s}`),
        `    - ${run}`,
        "  artifacts:",
        "    when: always",
        "    paths: [reports/]",
        "    reports:",
        "      junit: reports/ci/junit.xml",
        "",
      ].join("\n"),
    };
  }
  return {
    path: ".github/workflows/aitest.yml",
    content: [
      "# 由 AIProbe 生成：每次推送执行回归（不调用模型）。",
      "# 在仓库 Secrets 中配置：AITEST_AUTH_TOKEN、AITEST_ROLES（JSON，多角色账号）、AITEST_ROLE_TOKENS（JSON，可选）、AITEST_DB_PASSWORDS（JSON，数据库密码）。",
      "name: AI 测试回归",
      "on:",
      "  push:",
      "  workflow_dispatch:",
      "jobs:",
      "  regression:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - uses: actions/checkout@v4",
      "      - uses: actions/setup-python@v5",
      "        with: { python-version: \"3.12\" }",
      "      - uses: actions/setup-node@v4",
      "        with: { node-version: 22 }",
      "      - name: 安装 AIProbe 执行器",
      "        run: |",
      ...setup.map((s) => `          ${s}`),
      "      - name: 执行回归",
      `        run: ${run}`,
      "        env:",
      "          AITEST_AUTH_TOKEN: ${{ secrets.AITEST_AUTH_TOKEN }}",
      "          AITEST_ROLES: ${{ secrets.AITEST_ROLES }}",
      "          AITEST_ROLE_TOKENS: ${{ secrets.AITEST_ROLE_TOKENS }}",
      "          AITEST_DB_PASSWORDS: ${{ secrets.AITEST_DB_PASSWORDS }}",
      "      - uses: actions/upload-artifact@v4",
      "        if: always()",
      "        with:",
      "          name: aitest-reports",
      "          path: reports/",
      "",
    ].join("\n"),
  };
}

export function initCi(workspace: string, provider: "github" | "gitlab", toolRepo: string, env: string): string {
  if (!toolRepo) throw new Error("请用 --tool-repo 指定 AIProbe 仓库的 git 地址（CI 中从这里安装执行器）");
  const { path, content } = workflowTemplate(provider, toolRepo, env);
  const target = join(resolve(workspace), path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
  return target;
}

// --------------------------------------------------------------------------- 命令行

function parseArgs(argv: string[]): { cmd: string; flags: Record<string, string> } {
  const [cmd = "", ...rest] = argv;
  const flags: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    const m = rest[i].match(/^--([\w-]+)(?:=(.*))?$/);
    if (!m) throw new Error(`无法识别的参数：${rest[i]}`);
    flags[m[1]] = m[2] ?? (rest[i + 1] && !rest[i + 1].startsWith("--") ? rest[++i] : "true");
  }
  return { cmd, flags };
}

const USAGE = `用法：
  aitest-ci run   --workspace <dir> --env <name> [--suite api,ui] [--base-url URL] [--out DIR]
  aitest-ci perf  --workspace <dir> --env <name> [--path /api/x] [--method POST] [--body '{}'] [--scenario <case_id>]
                  [--vus 10] [--seconds 30] [--p95 500] [--max-failure-rate 0.01] [--ramp-up 10] [--ramp-down 5] [--out DIR]
  aitest-ci init  --workspace <dir> --tool-repo <git url> [--provider github|gitlab] [--env name]`;

async function main(argv: string[]): Promise<number> {
  const { cmd, flags } = parseArgs(argv);
  if (cmd === "run") {
    const report = await runCi({
      workspace: flags.workspace ?? ".",
      env: flags.env ?? "test",
      suites: flags.suite ? (flags.suite.split(",") as ("api" | "ui")[]) : undefined,
      baseUrl: flags["base-url"],
      outDir: flags.out,
      python: flags.python,
    });
    return report.exitCode;
  }
  if (cmd === "perf") {
    const report = await runPerfCi({
      workspace: flags.workspace ?? ".",
      env: flags.env ?? "test",
      path: flags.path,
      method: flags.method,
      body: flags.body,
      scenario: flags.scenario,
      vus: flags.vus ? parseInt(flags.vus) : undefined,
      seconds: flags.seconds ? parseInt(flags.seconds) : undefined,
      p95: flags.p95 ? parseFloat(flags.p95) : undefined,
      maxFailureRate: flags["max-failure-rate"] ? parseFloat(flags["max-failure-rate"]) : undefined,
      rampUp: flags["ramp-up"] ? parseInt(flags["ramp-up"]) : undefined,
      rampDown: flags["ramp-down"] ? parseInt(flags["ramp-down"]) : undefined,
      outDir: flags.out,
      python: flags.python,
    });
    return report.exitCode;
  }
  if (cmd === "init") {
    const provider = (flags.provider ?? "github") as "github" | "gitlab";
    if (!["github", "gitlab"].includes(provider)) throw new Error("--provider 只支持 github / gitlab");
    const file = initCi(flags.workspace ?? ".", provider, flags["tool-repo"] ?? process.env.AITEST_TOOL_REPO ?? "", flags.env ?? "test");
    console.log(`已生成 ${file}`);
    return 0;
  }
  console.error(USAGE);
  return 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      console.error(`aitest-ci：${(e as Error).message}`);
      process.exit(2);
    },
  );
}
