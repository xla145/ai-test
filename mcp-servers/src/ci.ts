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
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
        "# 由 AI 测试客户端生成：每次推送执行回归（不调用模型）。",
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
      "# 由 AI 测试客户端生成：每次推送执行回归（不调用模型）。",
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
      "      - name: 安装 AI 测试客户端执行器",
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
  if (!toolRepo) throw new Error("请用 --tool-repo 指定 AI 测试客户端仓库的 git 地址（CI 中从这里安装执行器）");
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
  aitest-ci run  --workspace <dir> --env <name> [--suite api,ui] [--base-url URL] [--out DIR]
  aitest-ci init --workspace <dir> --tool-repo <git url> [--provider github|gitlab] [--env name]`;

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
