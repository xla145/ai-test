import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runEngine } from "../src/engine.js";
import { createServer } from "../src/server.js";
import type { SecretResolver } from "../src/secrets.js";
import type { VisionAgentFactory } from "../src/ui/midscene.js";
import { runUiSuite } from "../src/ui/runner.js";
import { startDemoApp, type DemoApp } from "./fixtures/app.js";

const ENGINE_DIR = resolve(__dirname, "../../engine");
const ROLES = [
  { role: "admin", username: "alice", password: "pw-admin" },
  { role: "viewer", username: "bob", password: "pw-viewer" },
];
const LOGIN = { url: "/login", username: "#username", password: "#password", submit: "#login", success: "/dashboard" };

/** 模拟桌面端凭据代理：账号只在这里出现 */
const secrets: SecretResolver = {
  resolve: async (_p, _e, opts) => (opts?.roles ? { AITEST_ROLES: JSON.stringify(ROLES.filter((r) => opts.roles!.includes(r.role))) } : {}),
};

let app: DemoApp;
let dir: string;
let engine: <T>(args: string[]) => Promise<T>;
let client: Client;
let projectId: string;
let caseId: string;
let matrixCaseId: string;

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as { text: string }[])[0].text;
  if (res.isError) throw new Error(`${name}: ${text}`);
  return JSON.parse(text);
};

beforeAll(async () => {
  app = await startDemoApp();
  dir = mkdtempSync(join(tmpdir(), "aitest-ui-"));
  const opts = { db: join(dir, "db.sqlite"), env: { PYTHONPATH: ENGINE_DIR } };
  engine = (args) => runEngine(args, opts);
  const project = await engine<{ id: string }>(["init-project", "--name", "ui-demo", "--workspace", join(dir, "ws"),
    "--environments", JSON.stringify({ test: { base_url: app.url, login: LOGIN } })]);
  projectId = project.id;
  for (const r of ROLES) await engine(["add-role", "--project", projectId, "--role", r.role]);
  const mk = async (c: Record<string, unknown>) =>
    (await engine<{ id: string }>(["create-case", "--project", projectId, "--json", JSON.stringify({ type: "ui", priority: "P0", ...c })])).id;
  caseId = await mk({ title: "标签管理-停用标签", steps: ["进入标签管理", "停用 TAG-1001"], expected: ["列表显示 TAG-1001", "状态显示已停用，并上报 click 埋点"] });
  matrixCaseId = await mk({ title: "权限-标签管理菜单", steps: ["管理员登录查看菜单", "访客登录查看菜单"], expected: ["显示标签管理", "不显示标签管理"] });

  // 视觉定位用假的 Midscene：返回元素中心坐标
  let pageRef: any;
  const vision: VisionAgentFactory = async (page) => {
    pageRef = page;
    return {
      aiAct: async () => undefined,
      aiAssert: async (a) => { if (a.includes("红色")) throw new Error("不是红色"); },
      aiLocate: async () => {
        const box = (await pageRef.getByPlaceholder("搜索标签").boundingBox())!;
        return { center: [box.x + box.width / 2, box.y + box.height / 2] as [number, number] };
      },
    };
  };
  const server = createServer("browser", { engine: opts, secrets, vision, headless: true });
  const [a, b] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
}, 60_000);

afterAll(async () => {
  await client?.close();
  await app?.close();
});

describe("browser MCP server: explore → script → regression → heal input", () => {
  it("explores as admin, records assertions and capture, and saves a deterministic script", async () => {
    await call("open_project", { project_id: projectId, env: "test" });
    const ctx = await call("new_role_context", { role: "admin" });
    expect(ctx).toMatchObject({ role: "admin", loggedIn: true });
    expect(existsSync(join(dir, "ws/scripts/ui/.auth/admin.json"))).toBe(true);

    await call("navigate", { url: "/tags" });
    const snap = await call("snapshot");
    expect(snap.title).toBe("标签管理");
    const btn = snap.elements.find((e: any) => e.testId === "disable-TAG-1001");
    const status = snap.elements.find((e: any) => e.testId === "status-TAG-1001");
    expect(btn).toMatchObject({ role: "button", name: "停用" });

    // 视觉定位 → 可录制的 ref（定位器仍是确定性的）
    const located = await call("ai_locate", { prompt: "搜索框" });
    await call("type", { ref: located.ref, text: "TAG" });

    await call("start_capture", { name: "clickEvents", url_pattern: "/track" });
    await call("click", { ref: btn.ref });
    await call("expect_text", { ref: status.ref, text: "已停用" });
    await call("expect_request", { name: "clickEvents", fields: { event: "click", client_type: "web" }, forbidden: ["phone"] });
    await expect(call("expect_request", { name: "clickEvents", fields: { event: "pageview" } })).rejects.toThrow("未捕获");
    await expect(call("expect_text", { ref: status.ref, text: "启用中" })).rejects.toThrow("断言不成立");

    const review = await call("ai_assert", { assertion: "缺失值显示为灰色", case_id: caseId });
    expect(review.ai_verdict).toBe("pass");

    const saved = await call("save_ui_script", { case_id: caseId });
    expect(saved.path).toBe(`scripts/ui/${caseId}.spec.ts`);
    const spec = readFileSync(join(dir, "ws", saved.path), "utf8");
    expect(spec).toContain(`// 用例 ID：${caseId}`);
    expect(spec).toContain('test.use({ storageState: storageStateFor("admin") });');
    expect(spec).toContain('await page.getByTestId("disable-TAG-1001").click();');
    expect(spec).toContain('await page.getByRole("textbox", { name: "搜索标签", exact: true }).fill("TAG");');
    expect(spec).toContain('await page.goto("/tags");');
    expect(spec).not.toContain("pw-admin");
    expect((await engine<any[]>(["list-scripts", "--case", caseId]))[0].framework).toBe("playwright");
    expect((await engine<any[]>(["list-reviews"]))[0]).toMatchObject({ kind: "ai_assert", ai_verdict: "pass", status: "pending" });
  }, 60_000);

  it("records a multi-role permission matrix", async () => {
    await call("new_role_context", { role: "admin" });
    await call("navigate", { url: "/dashboard" });
    const adminMenu = (await call("snapshot")).elements.find((e: any) => e.testId === "menu-tags");
    await call("expect_visible", { ref: adminMenu.ref });
    await call("new_role_context", { role: "viewer" });
    await call("navigate", { url: "/dashboard" });
    const viewerSnap = await call("snapshot");
    expect(viewerSnap.elements.find((e: any) => e.testId === "menu-tags")).toBeUndefined();
    const roleBadge = viewerSnap.elements.find((e: any) => e.testId === "current-role");
    await call("expect_text", { ref: roleBadge.ref, text: "viewer" });
    const saved = await call("save_ui_script", { case_id: matrixCaseId });
    const spec = readFileSync(join(dir, "ws", saved.path), "utf8");
    expect(spec).toContain('await openAs(browser, "admin")');
    expect(spec).toContain('await openAs(browser, "viewer")');
  }, 60_000);

  it("runs the generated scripts as a regression without any model", async () => {
    const out = await call("run_playwright_script", {});
    expect(out.results.map((r: any) => [r.case_id, r.status])).toEqual(
      expect.arrayContaining([[caseId, "passed"], [matrixCaseId, "passed"]]),
    );
    expect(app.state.beacons.length).toBeGreaterThan(1);
  }, 120_000);

  it("fails with a locator timeout after a page redesign and leaves trace evidence for healing", async () => {
    app.state.version = 2;
    app.state.disabled.clear();
    const out = await runUiSuite({
      workspace: join(dir, "ws"), baseUrl: app.url, caseIds: [caseId],
      env: { AITEST_ROLES: JSON.stringify(ROLES), AITEST_LOGIN: JSON.stringify(LOGIN), AITEST_TEST_TIMEOUT: "8000", AITEST_ACTION_TIMEOUT: "2000" },
    });
    const [r] = out.results;
    expect(r.status).not.toBe("passed");
    expect(r.message).toContain("disable-TAG-1001");
    expect(r.failure_type).toBeUndefined(); // 交给 agent 判断是改版还是缺陷
    expect(r.evidence_paths.some((p) => p.endsWith("trace.zip"))).toBe(true);

    writeFileSync(join(dir, "r.json"), JSON.stringify(out.results));
    const run = await engine<any>(["save-run", "--project", projectId, "--env", "test", "--results-file", join(dir, "r.json")]);
    expect(run.needs_agent).toEqual([caseId]);
    app.state.version = 1;
  }, 120_000);
});
