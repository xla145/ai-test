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
let visionTarget = (page: any) => page.getByPlaceholder("搜索标签");

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

  // 视觉定位用假的 Midscene：返回 visionTarget 指向元素的中心坐标（默认搜索框）
  let pageRef: any;
  const vision: VisionAgentFactory = async (page) => {
    pageRef = page;
    return {
      aiAct: async () => undefined,
      aiAssert: async (a) => { if (a.includes("红色")) throw new Error("不是红色"); },
      aiLocate: async () => {
        const box = (await visionTarget(pageRef).boundingBox())!;
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

  it("explores with fewer round trips: actions return snapshots, find_text locates plain text, mismatches fail fast", async () => {
    await call("open_project", { project_id: projectId, env: "test" });
    await call("new_role_context", { role: "admin" });
    const nav = await call("navigate", { url: "/tags" });
    expect(nav.snapshot.title).toBe("标签管理");
    const search = nav.snapshot.elements.find((e: any) => e.placeholder === "搜索标签");

    // 非交互文字：不调用视觉模型，按文本拿到可录制的 ref，带所在行的上下文
    const found = await call("find_text", { text: "TAG-1001", exact: true });
    expect(found.matches).toHaveLength(1);
    expect(found.matches[0]).toMatchObject({ text: "TAG-1001" });
    expect(found.matches[0].context).toContain("TAG-1001");
    await call("expect_text", { ref: found.matches[0].ref, text: "TAG-1001" });
    expect((await call("find_text", { text: "不存在的文字" })).matches).toEqual([]);

    // 连续按键一次完成，每个按键各录一步；返回操作后的快照
    await call("click", { ref: search.ref });
    const pressed = await call("press", { key: ["Tab", "Tab"] });
    expect(pressed.snapshot.elements.length).toBeGreaterThan(0);
    // 旧 ref 在新快照后仍可用
    await call("expect_text", { ref: found.matches[0].ref, text: "TAG-1001" });

    // 已抓到请求但字段不匹配：很快失败，并给出实际抓到的内容
    await call("start_capture", { name: "fastEvents", url_pattern: "/track" });
    const btn = (await call("snapshot")).elements.find((e: any) => /^disable-|^tag-disable-/.test(e.testId ?? ""));
    const clicked = await call("click", { ref: btn.ref });
    expect(clicked.snapshot).toBeDefined();
    await call("expect_request", { name: "fastEvents", fields: { event: "click" } });
    const t0 = Date.now();
    await expect(call("expect_request", { name: "fastEvents", fields: { event: "nope" } })).rejects.toThrow(/最近抓到：POST .*\/track/);
    expect(Date.now() - t0).toBeLessThan(1500);

    const steps = await call("recording");
    expect(steps.filter((st: any) => st.action === "press").map((st: any) => st.key)).toEqual(["Tab", "Tab"]);
    // 对按 TAG-1001 找到的单元格断言「包含 TAG-1001」恒成立：录成等价的可见断言
    expect(steps.filter((st: any) => st.action === "expectVisible")).toHaveLength(2);
    expect(steps.filter((st: any) => st.action === "expectText")).toHaveLength(0);
    await call("open_project", { project_id: projectId, env: "test" }); // 清空录制，不影响其它用例
  }, 60_000);

  it("verifies visual locating against the target text instead of returning whatever is under the point", async () => {
    await call("open_project", { project_id: projectId, env: "test" });
    await call("new_role_context", { role: "admin" });
    await call("navigate", { url: "/tags" });
    const status = (await call("find_text", { text: "TAG-1001", exact: true })).matches[0];
    const statusText = (await call("snapshot")).text.includes("已停用") ? "已停用" : "启用中";
    try {
      // 模型点到了同一行的标签编号单元格，要找的是状态：改用附近包含目标文字的元素
      visionTarget = (page) => page.getByText("TAG-1001", { exact: true });
      const fixed = await call("ai_locate", { prompt: `TAG-1001 这一行的状态文字`, text: statusText });
      expect(fixed).toMatchObject({ verified: true, expected: statusText, testId: "status-TAG-1001" });
      expect(fixed.note).toContain("已改用");
      await call("expect_text", { ref: fixed.ref, text: statusText });

      // 落点正确：不调整
      visionTarget = (page) => page.getByTestId("status-TAG-1001");
      const exact = await call("ai_locate", { prompt: `状态徽标「${statusText}」` });
      expect(exact).toMatchObject({ verified: true, testId: "status-TAG-1001" });
      expect(exact.note).toBeUndefined();

      // 页面上根本没有目标文字：报错，不返回错的元素
      await expect(call("ai_locate", { prompt: "状态徽标「已归档」" })).rejects.toThrow(/视觉定位不准：落点处是「.*」，不包含「已归档」/);

      // 多处引号无法判断目标：不校验，并明确告知
      visionTarget = (page) => page.getByText("TAG-1001", { exact: true });
      const unverified = await call("ai_locate", { prompt: "「TAG-1001」所在行的「状态」" });
      expect(unverified).toMatchObject({ verified: false, text: "TAG-1001" });
      expect(status.ref).toBeTruthy();
    } finally {
      visionTarget = (page) => page.getByPlaceholder("搜索标签");
      await call("open_project", { project_id: projectId, env: "test" });
    }
  }, 60_000);

  it("records selectors that survive row reordering and asserts on the element that shows the text", async () => {
    const listCase = (await engine<{ id: string }>(["create-case", "--project", projectId, "--json", JSON.stringify({
      type: "ui", priority: "P1", title: "标签列表-停用第二个标签", steps: ["停用 TAG-2002"], expected: ["TAG-2002 状态为已停用", "共 3 条"] })])).id;
    await call("open_project", { project_id: projectId, env: "test" });
    await call("new_role_context", { role: "admin" });
    const nav = await call("navigate", { url: "/list" });

    // 每行都有「停用」：限定到 TAG-2002 那一行，不用行号，也不用 el-id-* 这类生成的 id
    const btn = (await call("find_text", { text: "停用", exact: true })).matches.find((m: any) => m.context?.includes("TAG-2002"));
    const clicked = await call("click", { ref: btn.ref });
    expect(clicked.locator).toEqual({ kind: "role", role: "button", name: "停用", within: { css: "tr", hasText: "TAG-2002" } });

    // 状态单元格：按行 + 行内位置断言，而不是按「已停用」这段字找（TAG-2003 也是已停用）
    const status = (await call("find_text", { text: "已停用", exact: true })).matches.find((m: any) => m.context?.includes("TAG-2002"));
    const st = await call("expect_text", { ref: status.ref, text: "已停用" });
    expect(st.locator).toEqual({ kind: "css", value: "span.status", within: { css: "tr", hasText: "TAG-2002" } });

    // 断言落在整块区域上：收窄到显示这段文字的元素
    const region = nav.snapshot.elements.find((e: any) => e.role === "region");
    const total = await call("expect_text", { ref: region.ref, text: "共 3 条" });
    expect(total.note).toContain("已改为断言其中显示「共 3 条」的元素");
    expect(total.locator).toEqual({ kind: "css", value: "span.el-pagination__total" });
    // 「不包含」仍对整块区域断言；选择器不带生成的 id 和状态 class
    const none = await call("expect_no_text", { ref: region.ref, text: "TAG-9999" });
    expect(none.locator).toEqual({ kind: "css", value: "div.fc-split-main" });

    // 按 TAG-2001 找到的单元格再断言包含 TAG-2001：录成「可见」，再断言一次不重复录入
    const key = (await call("find_text", { text: "TAG-2001", exact: true })).matches[0];
    const same = await call("expect_text", { ref: key.ref, text: "TAG-2001" });
    expect(same.note).toContain("已录为「可见」断言");
    expect(same.locator).toEqual({ kind: "text", value: "TAG-2001" });
    expect((await call("expect_visible", { ref: key.ref })).note).toContain("未重复录入");

    const saved = await call("save_ui_script", { case_id: listCase });
    const spec = readFileSync(join(dir, "ws", saved.path), "utf8");
    expect(spec).toContain('await page.locator("tr", { hasText: "TAG-2002" }).getByRole("button", { name: "停用", exact: true }).click();');
    expect(spec).not.toMatch(/nth-of-type|el-id-|is-active|el-table_1/);
    expect(spec.match(/toBeVisible/g)).toHaveLength(1);

    // 行顺序变了，脚本照样通过
    app.state.listOrder = ["TAG-2002", "TAG-2003", "TAG-2001"];
    try {
      const out = await runUiSuite({
        workspace: join(dir, "ws"), baseUrl: app.url, caseIds: [listCase],
        env: { AITEST_ROLES: JSON.stringify(ROLES), AITEST_LOGIN: JSON.stringify(LOGIN) },
      });
      expect(out.results.map((r) => [r.status, r.message])).toEqual([["passed", ""]]);
    } finally {
      app.state.listOrder = ["TAG-2001", "TAG-2002", "TAG-2003"];
      await call("open_project", { project_id: projectId, env: "test" });
    }
  }, 120_000);
});
