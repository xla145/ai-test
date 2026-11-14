import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BrowserSession } from "../src/ui/browser.js";
import { locateRequest, resolveTargetScope, type VisualTarget } from "../src/ui/target.js";
import { UI_SERVERS } from "../src/ui/tools.js";
import { generateSpec, writeUiScript } from "../src/ui/codegen.js";
import { runUiSuite } from "../src/ui/runner.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer as createMcpServer } from "../src/server.js";

let session: BrowserSession;
beforeEach(() => { session = new BrowserSession({ headless: true }); });
afterEach(async () => { await session.close(); });
const target: VisualTarget = { page: "模型管理", scope: [{ kind: "region", name: "故障切换配置" }], control: "textbox", placeholder: "搜索模型" };
const center = async (selector: string) => {
  const b = (await (await session.page()).locator(selector).boundingBox())!;
  return [b.x + b.width / 2, b.y + b.height / 2] as const;
};
const regions = `<section role="region" aria-label="普通路由配置"><input placeholder="搜索模型"></section><section role="region" aria-label="故障切换配置"><input placeholder="搜索模型"></section>`;

it("compiles structured targets, preserves label semantics and rejects conflicting or incomplete inputs", () => {
  const req = locateRequest({ target });
  expect(req.intent).toBe("fill");
  expect(req.prompt).toContain("区域「故障切换配置」");
  expect(req.text).toBe("搜索模型");
  expect(locateRequest({ target: { ...target, control: "checkbox", placeholder: undefined, label: "开启兜底" } }).text).toBeUndefined();
  expect(() => locateRequest({ target, intent: "check" })).toThrow("类型不匹配");
  expect(() => locateRequest({ target, text: "旁边的文字" })).toThrow("自身文字");
  expect(() => locateRequest({ target: { ...target, scope: [{ kind: "row", name: "模型" }] } })).toThrow("key");
  expect(() => locateRequest({ prompt: " " })).toThrow("非空");
  expect(locateRequest({ prompt: "保存", intent: "click" }).prompt).toBe("保存");
});

it("blocks missing or ambiguous scopes before invoking the vision model", async () => {
  const page = await session.page();
  await page.setContent('<section role="region" aria-label="普通路由配置"><input></section>');
  const aiLocate = vi.fn();
  const tool = UI_SERVERS.find(s => s.name === "browser")!.tools({ session, vision: async () => ({ aiLocate }) } as any).find(t => t.name === "ai_locate")!;
  await expect(tool.handler({ target })).rejects.toThrow("目标范围缺失");
  expect(aiLocate).not.toHaveBeenCalled();
  await page.setContent(regions + regions);
  await expect(tool.handler({ target })).rejects.toThrow("范围不唯一");
  expect(aiLocate).not.toHaveBeenCalled();
});

it("accepts structured targets through the public MCP schema and returns a recordable verified ref", async () => {
  const page = await session.page();
  await page.setContent(regions);
  const aiLocate = vi.fn(async (_prompt: string) => ({ center: [...await center('section[aria-label="故障切换配置"] input')] as [number, number] }));
  const server = createMcpServer("browser", { session, engine: {}, secrets: { resolve: async () => ({}) }, vision: async () => ({ aiLocate, aiAct: async () => undefined, aiAssert: async () => undefined }) });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "structured-target-test", version: "1" });
  try {
    await Promise.all([server.connect(a), client.connect(b)]);
    const result = await client.callTool({ name: "ai_locate", arguments: { target } });
    expect(result.isError).not.toBe(true);
    const found = JSON.parse((result.content as { text: string }[])[0].text);
    expect(found).toMatchObject({ scope_verified: true, target_verified: true, role: "textbox" });
    expect(aiLocate).toHaveBeenCalledWith(locateRequest({ target }).prompt);
    const typed = await client.callTool({ name: "type", arguments: { ref: found.ref, text: "MODEL-UI-001" } });
    expect(typed.isError).not.toBe(true);
    expect(await page.locator('section[aria-label="故障切换配置"] input').inputValue()).toBe("MODEL-UI-001");
  } finally { await client.close(); await server.close(); }
});

it("rejects a same-named control in the wrong region and records the correct region for replay", async () => {
  const page = await session.page();
  await page.setContent(regions);
  const wrong = await center('section[aria-label="普通路由配置"] input');
  await expect(session.locateAt(...wrong, { intent: "fill", target, expect: "搜索模型" })).rejects.toThrow("不在指定范围");
  const found = await session.locateAt(...await center('section[aria-label="故障切换配置"] input'), { intent: "fill", target, expect: "搜索模型" });
  await session.type(found.element!.ref, "MODEL-UI-001");
  await session.expectValue(found.element!.ref, "MODEL-UI-001");
  const steps = session.recording();
  expect(JSON.stringify(steps)).toContain("故障切换配置");
  expect(JSON.stringify(steps)).not.toContain("nodeId");
  // New nodes and reordered sections: replay uses semantic scope, not transient refs or position.
  await page.setContent(regions);
  await page.locator("section").first().evaluate(el => el.parentElement!.append(el));
  for (const step of steps) await session.runStep(step);
  expect(await page.locator('section[aria-label="普通路由配置"] input').inputValue()).toBe("");
  expect(await page.locator('section[aria-label="故障切换配置"] input').inputValue()).toBe("MODEL-UI-001");
});

it("checks target label and role in addition to membership in the region", async () => {
  const page = await session.page();
  await page.setContent('<section role="region" aria-label="故障切换配置"><label>其他输入<input placeholder="搜索模型"></label><button>保存</button></section>');
  await expect(session.locateAt(...await center("input"), { intent: "fill", target: { ...target, label: "正确输入" } })).rejects.toThrow("标签不匹配");
  await expect(session.locateAt(...await center("button"), { intent: "click", target })).rejects.toThrow("类型");
});

it("binds rows by an exact business key and does not accept a prefix match", async () => {
  const page = await session.page();
  await page.setContent('<table><tr><td>MODEL-UI-0010</td><td><button>编辑</button></td></tr></table>');
  const rowTarget: VisualTarget = { page: "模型管理", scope: [{ kind: "row", name: "模型记录", key: "MODEL-UI-001" }], control: "button", text: "编辑" };
  await expect(resolveTargetScope(page, rowTarget)).rejects.toThrow("缺失");
});

it("rejects an under-specified target even when the visual point and CSS selector are unique", async () => {
  const page = await session.page();
  await page.setContent('<section role="region" aria-label="故障切换配置"><input data-testid="first" placeholder="搜索模型"><input data-testid="second" placeholder="搜索模型"></section>');
  await expect(session.locateAt(...await center('[data-testid="first"]'), { intent: "fill", target })).rejects.toThrow("目标描述不唯一");
});

it("does not silently resolve a stale ref to another unique matching element", async () => {
  const page = await session.page();
  await page.setContent('<div><button>保存</button></div><div><button>取消</button></div>');
  const ref = (await session.snapshot()).elements.find(e => e.name === "保存")!.ref;
  await page.locator("div").first().evaluate(el => el.remove());
  await page.locator("button").evaluate(el => el.textContent = "保存");
  await expect(session.click(ref)).rejects.toThrow("目标已变化");
  expect(session.recording()).toHaveLength(0);
});

const selectRegion = (name: string, value: string) => `<section role="region" aria-label="${name}"><h2>${name}</h2><div class="el-form-item"><label class="el-form-item__label">备用渠道</label><div class="el-select"><div class="el-select__wrapper"><div class="el-select__selection"><input readonly role="combobox" aria-label="备用渠道"><span class="el-select__selected-item">${value}</span></div></div></div></div></section>`;
const selects = (wrong = false) => selectRegion("普通路由配置", wrong ? "阿里云源" : "不设置") + selectRegion("故障切换配置", wrong ? "错误渠道" : "阿里云源");

it("keeps selected-value assertions on their original field when expected text moves elsewhere", async () => {
  const page = await session.page();
  await page.setContent(selects());
  const ref = (await session.locateAt(...await center('section[aria-label="故障切换配置"] input'))).element!.ref;
  await session.expectValue(ref, "阿里云源");
  const step = session.recording().at(-1)!;
  expect(step).toMatchObject({ action: "expectText", exact: true });
  expect(JSON.stringify((step as any).target)).not.toContain("阿里云源");
  expect(generateSpec({ caseId: "tc_value", title: "字段身份", steps: [step] })).toContain("故障切换配置");
  await page.setContent(selects(true));
  await expect(session.runStep(step, { timeoutMs: 200 })).rejects.toThrow("断言不成立");
});

it("replays the generated spec in a fresh browser and fails when only another field has the expected value", async () => {
  let wrong = false;
  const server = createServer((_req, res) => { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(selects(wrong)); });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as any).port}`;
  const workspace = mkdtempSync(join(tmpdir(), "aitest-scope-"));
  try {
    await session.navigate(url);
    const ref = (await session.locateAt(...await center('section[aria-label="故障切换配置"] input'))).element!.ref;
    await session.expectValue(ref, "阿里云源");
    writeUiScript(workspace, { caseId: "tc_scope", title: "下拉字段身份", baseUrl: url, steps: session.recording() });
    await session.close();
    const run = () => runUiSuite({ workspace, baseUrl: url, caseIds: ["tc_scope"], workers: 1, env: { AITEST_TEST_TIMEOUT: "8000", AITEST_ACTION_TIMEOUT: "1000", AITEST_EXPECT_TIMEOUT: "500" } });
    expect((await run()).results[0].status).toBe("passed");
    wrong = true;
    const failed = (await run()).results[0];
    expect(failed.status).toBe("failed");
    expect(failed.message).toContain("错误渠道");
  } finally {
    server.closeAllConnections();
    await new Promise<void>(r => server.close(() => r()));
    rmSync(workspace, { recursive: true, force: true });
  }
}, 40_000);
