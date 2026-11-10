import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { initCi, runCi, toJunit } from "../src/ci.js";
import { runEngine } from "../src/engine.js";
import { ensureUiScaffold, generateSpec } from "../src/ui/codegen.js";
import { startDemoApp, type DemoApp } from "./fixtures/app.js";

const ENGINE_DIR = resolve(__dirname, "../../engine");
const ROLES = JSON.stringify([{ role: "admin", username: "alice", password: "pw-admin" }]);
let app: DemoApp;
let ws: string;

beforeAll(async () => {
  app = await startDemoApp();
  const dir = mkdtempSync(join(tmpdir(), "aitest-ci-src-"));
  ws = join(dir, "ws");
  // 「作者」的本地数据库：生成脚本并导出到 workspace
  const engine = <T,>(args: string[]) => runEngine<T>(args, { db: join(dir, "author.sqlite"), env: { PYTHONPATH: ENGINE_DIR } });
  const login = { url: "/login", username: "#username", password: "#password", submit: "#login", success: "/dashboard" };
  const p = await engine<{ id: string }>(["init-project", "--name", "CI 演示", "--workspace", ws,
    "--environments", JSON.stringify({ test: { base_url: app.url, login } })]);
  await engine(["add-role", "--project", p.id, "--role", "admin"]);
  const mk = async (c: object) => (await engine<{ id: string }>(["create-case", "--project", p.id, "--json", JSON.stringify(c)])).id;
  const ui = await mk({ title: "标签管理-停用标签", type: "ui", priority: "P0", steps: ["停用"], expected: ["已停用"] });
  await mk({ title: "登录页-可访问", type: "api", priority: "P1", steps: ["GET /login"], expected: ["200"],
    api: { method: "GET", path: "/login", auth: false, expected_status: [200] } });
  await mk({ title: "标签接口-未登录越权", type: "api", priority: "P0", category: "安全相关", steps: ["未登录停用标签"], expected: ["403"],
    api: { method: "POST", path: "/api/tags/TAG-1001/disable", auth: false, expected_status: [403] } });
  ensureUiScaffold(ws);
  writeFileSync(join(ws, "scripts/ui", `${ui}.spec.ts`), generateSpec({
    caseId: ui, title: "标签管理-停用标签", baseUrl: app.url,
    steps: [
      { role: "admin", action: "goto", url: `${app.url}/tags` },
      { role: "admin", action: "click", target: { kind: "testid", value: "disable-TAG-1001" } },
      { role: "admin", action: "expectText", target: { kind: "testid", value: "status-TAG-1001" }, text: "已停用" },
    ],
  }));
  await engine(["register-script", "--project", p.id, "--case", ui, "--path", `scripts/ui/${ui}.spec.ts`]);
  await engine(["write-api-suite", "--project", p.id]);
  await engine(["export-workspace", "--project", p.id, "--commit"]);
}, 60_000);

afterAll(async () => {
  await app?.close();
});

const secrets = () => ({ ...process.env, PYTHONPATH: ENGINE_DIR, AITEST_ROLES: ROLES, AITEST_ACTION_TIMEOUT: "2000", AITEST_TEST_TIMEOUT: "8000" });

describe("aitest-ci", () => {
  it("runs API and UI suites from a shared workspace without any model and writes JUnit", async () => {
    const summaryFile = join(mkdtempSync(join(tmpdir(), "gh-")), "summary.md");
    const logs: string[] = [];
    const report = await runCi({ workspace: ws, env: "test", secrets: { ...secrets(), GITHUB_STEP_SUMMARY: summaryFile }, log: (m) => logs.push(m) });
    expect(report.results.map((r) => [r.suite, r.status])).toEqual([["api", "passed"], ["api", "passed"], ["ui", "passed"]]);
    expect(report.exitCode).toBe(0);
    const junit = readFileSync(join(ws, "reports/ci/junit.xml"), "utf8");
    expect(junit).toContain('<testsuite name="api" tests="2" failures="0"');
    expect(junit).toContain('<testsuite name="ui" tests="1" failures="0"');
    expect(readFileSync(summaryFile, "utf8")).toContain("通过 3");
    expect(logs.join("\n")).toContain("不调用模型");
  }, 120_000);

  it("fails the build and lists undetermined failures after a page redesign", async () => {
    app.state.version = 2;
    app.state.disabled.clear();
    try {
      const report = await runCi({ workspace: ws, env: "test", suites: ["ui"], secrets: secrets(), log: () => undefined });
      expect(report.exitCode).toBe(1);
      expect(report.results[0]).toMatchObject({ suite: "ui", status: expect.stringMatching(/failed|error/) });
      expect(report.summary).toContain("待归因");
      expect(report.junit).toMatch(/<(failure|error) message=/);
    } finally {
      app.state.version = 1;
    }
  }, 120_000);

  it("explains a global login failure instead of reporting an empty run", async () => {
    const bad = { ...secrets(), AITEST_ROLES: JSON.stringify([{ role: "admin", username: "alice", password: "wrong" }]), AITEST_AUTH_MAX_AGE_MIN: "0" };
    await expect(runCi({ workspace: ws, env: "test", suites: ["ui"], secrets: bad, log: () => undefined }))
      .rejects.toThrow(/UI 执行失败：.*waitForURL/s);
  }, 120_000);

  it("overrides the base URL and reports a missing environment clearly", async () => {
    const report = await runCi({ workspace: ws, env: "staging", suites: ["api"], baseUrl: app.url, secrets: secrets(), log: () => undefined });
    expect(report.exitCode).toBe(0);
    await expect(runCi({ workspace: ws, env: "prod", secrets: secrets(), log: () => undefined })).rejects.toThrow("--base-url");
  }, 60_000);

  it("generates CI workflows that read credentials from CI secrets only", () => {
    const dir = mkdtempSync(join(tmpdir(), "wf-"));
    const gh = readFileSync(initCi(dir, "github", "https://git.example.com/team/ai-test.git", "test"), "utf8");
    expect(gh).toContain("git clone --depth 1 https://git.example.com/team/ai-test.git .aitest-tool");
    expect(gh).toContain("AITEST_ROLES: ${{ secrets.AITEST_ROLES }}");
    expect(gh).toContain("dist/ci.js run --workspace . --env test");
    const gl = readFileSync(initCi(dir, "gitlab", "https://git.example.com/team/ai-test.git", "staging"), "utf8");
    expect(gl).toContain("junit: reports/ci/junit.xml");
    expect(existsSync(join(dir, ".github/workflows/aitest.yml"))).toBe(true);
    expect(() => initCi(dir, "github", "", "test")).toThrow("--tool-repo");
  });

  it("escapes XML in JUnit output", () => {
    const x = toJunit([{ suite: "api", case_id: "tc_1", title: 'a<b>&"c"', status: "failed", duration: 1, message: "x < y\u0001" }]);
    expect(x).toContain('name="tc_1 a&lt;b&gt;&amp;&quot;c&quot;"');
    expect(x).not.toContain("\u0001");
  });
});
