import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { caseHash, writeUiScript, type ExecutionContract } from "@ai-test/mcp-servers";
import { Orchestrator, type EngineCall } from "../src/main/orchestrator.js";
import { UiExecutionContracts } from "../src/main/uiExecutionContract.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function setup(options: { blocked?: boolean; generate?: boolean; malformed?: boolean; selectedData?: string[] } = {}) {
  const workspace = mkdtempSync(join(tmpdir(), "ui-contract-cache-")); dirs.push(workspace);
  const project = { id: "p", name: "demo", workspace_path: workspace, environments: { test: { base_url: "http://sut" } } };
  const source = { id: "tc_a", title: "列表可见", execution_mode: "ui", status: "reviewed", preconditions: ["服务可用"], data_refs: [] as string[], steps: ["打开列表"], expected: ["列表可见"] };
  let roles = ["admin"];
  const recipes = [{ key: "新增条件", check_script: "check-fixture", facts: ["服务可用"] }];
  const contract = (): ExecutionContract => ({ version: 1, status: options.blocked ? "needs_clarification" : "ready", issues: options.blocked ? ["缺少列表地址"] : [],
    dataRefs: options.selectedData, preconditions: [...source.preconditions], preconditionChecks: source.preconditions.map((text, i) => ({ id: `P${i + 1}.1`, sourceIndices: [i + 1], sourceQuotes: [text], statement: text, expected: text, method: 'ui', dependsOn: [] })), steps: [{ index: 1, source: source.steps[0], actions: [{ action: "navigate", instruction: "打开 /list", value: "/list" }], expected: [...source.expected] }] });
  let scripts: { case_id: string; framework: string; path: string }[] = [];
  const engine = vi.fn(async (args: string[]) => {
    switch (args[0]) {
      case "list-projects": return [project];
      case "list-cases": return [source];
      case "list-roles": return roles.map(role_name => ({ role_name }));
      case "list-scripts": return scripts;
      case "list-test-data": return recipes;
      case "agent-session": return { id: "as" };
      default: return {};
    }
  }) as unknown as EngineCall;
  const startThread = vi.fn(async () => "th");
  const runTurn = vi.fn(async (_id: string, prompt: string) => {
    if (prompt.includes("仅把 UI 用例转换")) return { threadId: "th", turnId: "convert", status: "completed", tokens: 10, message: options.malformed ? "invalid JSON" : JSON.stringify(contract()) };
    expect(prompt).toContain("已转换并缓存的执行用例");
    expect(prompt).toContain("browser.assertion_coverage");
    expect(prompt).toContain("name 是 read_value 保存的来源变量名");
    if (options.generate !== false) {
      const { path } = writeUiScript(workspace, { caseId: source.id, title: source.title, caseHash: caseHash(source), preconditionChecks: contract().preconditionChecks, steps: [
        { action: "goto", url: "/list" },
        ...source.preconditions.map((_, i) => ({ action: 'expectUrl' as const, pattern: '/list', preconditionIndices: [i + 1], preconditionCheckIds: [`P${i + 1}.1`] })),
        ...source.expected.map((_, i) => ({ action: 'expectUrl' as const, pattern: '/list', caseStep: 1, expectedIndices: [i + 1] })),
      ] });
      scripts = [{ case_id: source.id, framework: "playwright", path }];
    }
    return { threadId: "th", turnId: "execute", status: "completed", tokens: 20, message: "生成完成" };
  });
  const checkLogin = vi.fn(async () => ({ loggedIn: true }));
  const closeBrowser = vi.fn(async () => {});
  const ui = { createDebugBrowser: () => ({ newRoleContext: checkLogin, close: closeBrowser }), runUiSuite: vi.fn(), checkData: vi.fn(async () => [{ key: "新增条件", exists: true }]), seedData: vi.fn() };
  const make = () => new Orchestrator({ engine, ui: ui as any, agent: async () => ({ startThread, runTurn }), secretEnv: () => ({}) });
  return { workspace, project, source, runTurn, startThread, make, contract, checkLogin, closeBrowser, recipes, ui, setRoles: (next: string[]) => { roles = next; } };
}

describe("persisted UI conversion and script reuse", () => {
  it("repairs one structural error then explores, with the same schema and tool restrictions", async () => {
    const f = setup();
    const invalid = { ...f.contract(), extra: true };
    f.runTurn.mockImplementationOnce(async () => ({ threadId: "th", turnId: "bad", status: "completed", tokens: 7, message: JSON.stringify(invalid) }));
    expect(await f.make().exploreUiCase("p", "test", "tc_a")).toMatchObject({ scriptGenerated: true, tokens: 37 });
    expect(f.runTurn).toHaveBeenCalledTimes(3);
    expect(f.runTurn.mock.calls[1][1]).toContain("受限的结构修复");
    expect((f.runTurn.mock.calls[0] as any)[2].outputSchema).toEqual((f.runTurn.mock.calls[1] as any)[2].outputSchema);
    expect(f.startThread.mock.calls[1][0]).toMatchObject({ sandbox: "read-only", config: { "mcp_servers.browser.enabled": false } });
  });
  it("rejects a repair that changes a valid verification method", () => {
    const f = setup();
    const store = new UiExecutionContracts(f.workspace, "p", "test", "tc_a", f.source, ["admin"], {});
    const original = { ...f.contract(), extra: true };
    let error: unknown;
    try { store.parse(JSON.stringify(original)); } catch (e) { error = e; }
    const changed = f.contract();
    changed.preconditionChecks![0].method = "database";
    expect(() => store.parseRepair(JSON.stringify(original), error, JSON.stringify(changed))).toThrow("错误字段以外");
    expect(store.parseRepair(JSON.stringify(original), error, JSON.stringify(f.contract())).status).toBe("ready");
  });
  it("invalidates a cached plan when declared recipe facts change", async () => {
    const f = setup();
    await f.make().exploreUiCase("p", "test", "tc_a");
    f.recipes[0].facts.push("会员账号存在");
    await f.make().exploreUiCase("p", "test", "tc_a");
    expect(f.runTurn).toHaveBeenCalledTimes(4);
    expect(f.runTurn.mock.calls[2][1]).toContain("会员账号存在");
  });
  it("converts before exploration once, and reuses after a new orchestrator without any model call", async () => {
    const f = setup();
    const first = await f.make().exploreUiCase("p", "test", "tc_a");
    expect(first).toMatchObject({ scriptGenerated: true, tokens: 30 });
    expect(f.startThread.mock.calls[0][0]).toMatchObject({ sandbox: "read-only", config: { "mcp_servers.browser.enabled": false, "mcp_servers.case-store.enabled": false, "mcp_servers.pinky.enabled": false } });
    expect(f.startThread.mock.calls[1][0]).not.toHaveProperty("config");
    expect(f.runTurn).toHaveBeenCalledTimes(2);
    expect(await f.make().exploreUiCase("p", "test", "tc_a")).toMatchObject({ scriptGenerated: true, reused: true, tokens: 0 });
    expect(f.runTurn).toHaveBeenCalledTimes(2);
  });
  it.each(["preconditions", "expected", "data_refs", "environment", "roles"])("invalidates conversion and script on %s changes", async (field) => {
    const f = setup();
    await f.make().exploreUiCase("p", "test", "tc_a");
    if (field === "environment") f.project.environments.test.base_url = "http://other";
    else if (field === "roles") f.setRoles(["admin", "operator"]);
    else f.source[field as "preconditions" | "expected" | "data_refs"].push("新增条件");
    const out = await f.make().exploreUiCase("p", "test", "tc_a");
    expect(out.scriptGenerated).toBe(true);
    expect(f.runTurn).toHaveBeenCalledTimes(4);
  });
  it("reuses a converted plan after interrupted generation without calling the converter again", async () => {
    const f = setup({ generate: false });
    await f.make().exploreUiCase("p", "test", "tc_a");
    await f.make().exploreUiCase("p", "test", "tc_a");
    expect(f.runTurn).toHaveBeenCalledTimes(3);
    expect(f.runTurn.mock.calls.filter(([, p]) => p.includes("仅把 UI 用例转换"))).toHaveLength(1);
  });
  it("does not reuse clarification issues as an execution plan", async () => {
    const f = setup({ blocked: true });
    expect(await f.make().exploreUiCase("p", "test", "tc_a")).toMatchObject({ needsClarification: true, tokens: 10, scriptGenerated: false });
    expect(await f.make().exploreUiCase("p", "test", "tc_a")).toMatchObject({ needsClarification: true, tokens: 10, contractReused: false });
    expect(f.runTurn).toHaveBeenCalledTimes(2);
  });
  it("passes only data capabilities to both stages and prepares selected recipes", async () => {
    const f = setup({ selectedData: ["新增条件"] });
    f.recipes[0].check_script = "check-fixture --password=private-test-secret";
    expect(await f.make().exploreUiCase("p", "test", "tc_a")).toMatchObject({ scriptGenerated: true });
    expect(f.ui.checkData).toHaveBeenCalledWith(expect.anything(), ["新增条件"], f.recipes, f.workspace, expect.anything());
    for (const [, prompt] of f.runTurn.mock.calls) {
      expect(prompt).toContain('"key":"新增条件"');
      expect(prompt).toContain('"canCheck":true');
      expect(prompt).not.toContain("private-test-secret");
      expect(prompt).not.toContain("check-fixture");
    }
    expect(f.runTurn.mock.calls[1][1]).toContain('已绑定数据：["新增条件"]');
  });
  it("rejects unknown selected recipes before exploration or active plan creation", async () => {
    const f = setup({ selectedData: ["member@example.com"] });
    const out = await f.make().exploreUiCase("p", "test", "tc_a");
    expect(out).toMatchObject({ status: "failed", scriptGenerated: false });
    expect(out.message).toContain("未配置的数据配方");
    expect(f.runTurn).toHaveBeenCalledTimes(1);
    expect(f.ui.checkData).not.toHaveBeenCalled();
    expect(existsSync(join(f.workspace, ".aitest/ui-contracts"))).toBe(false);
  });
  it("blocks selected data that cannot be prepared before exploration", async () => {
    const f = setup({ selectedData: ["新增条件"] });
    f.ui.checkData.mockResolvedValue([{ key: "新增条件", exists: null, via: "api" }] as any);
    expect(await f.make().exploreUiCase("p", "test", "tc_a")).toMatchObject({ needsClarification: true, scriptGenerated: false });
    expect(f.runTurn).toHaveBeenCalledTimes(1);
    expect(f.ui.seedData).not.toHaveBeenCalled();
  });
  it("rechecks selected data even when the plan and script are reusable", async () => {
    const f = setup({ selectedData: ["新增条件"] });
    await f.make().exploreUiCase("p", "test", "tc_a");
    f.ui.checkData.mockResolvedValue([{ key: "新增条件", exists: null, via: "api" }] as any);
    expect(await f.make().exploreUiCase("p", "test", "tc_a")).toMatchObject({ needsClarification: true, scriptGenerated: false });
    expect(f.runTurn).toHaveBeenCalledTimes(2);
  });
  it.each(["key", "check_script"] as const)("invalidates plans when recipe %s changes", async (field) => {
    const f = setup();
    await f.make().exploreUiCase("p", "test", "tc_a");
    f.recipes[0][field] += "-updated";
    await f.make().exploreUiCase("p", "test", "tc_a");
    expect(f.runTurn).toHaveBeenCalledTimes(4);
  });
  it("retains clarification only as a diagnostic artifact", () => {
    const f = setup({ blocked: true });
    const store = new UiExecutionContracts(f.workspace, "p", "test", "tc_a", f.source, ["admin"], f.project.environments.test);
    store.save(f.contract());
    const folder = join(f.workspace, ".aitest/ui-contracts");
    expect(readdirSync(folder)).toEqual(["versions"]);
    expect(JSON.parse(readFileSync(join(f.workspace, store.artifactPath), "utf8")).contract.status).toBe("needs_clarification");
    expect(store.read()).toBeUndefined();
  });
  it("blocks database plans before exploration when no connection is configured", async () => {
    const f = setup();
    f.runTurn.mockImplementationOnce(async () => {
      const contract = f.contract(); contract.preconditionChecks![0].method = "database";
      return { threadId: "th", turnId: "convert", status: "completed", tokens: 10, message: JSON.stringify(contract) };
    });
    const out = await f.make().exploreUiCase("p", "test", "tc_a");
    expect(out).toMatchObject({ needsClarification: true, scriptGenerated: false });
    expect(out.message).toContain("未配置数据库连接");
    expect(f.runTurn).toHaveBeenCalledTimes(1);
    expect(f.runTurn.mock.calls[0][1]).toContain('"database":false');
    const folder = join(f.workspace, ".aitest/ui-contracts");
    expect(readdirSync(folder)).toEqual(["failures"]);
  });
  it("preserves the complete invalid response separately from active plans", async () => {
    const f = setup({ malformed: true });
    const invalid = "invalid JSON " + "x".repeat(4000);
    f.runTurn.mockImplementationOnce(async () => ({ threadId: "th", turnId: "convert", status: "completed", tokens: 10, message: invalid }));
    const out = await f.make().exploreUiCase("p", "test", "tc_a");
    expect(out).toMatchObject({ status: "failed", scriptGenerated: false });
    const folder = join(f.workspace, ".aitest/ui-contracts/failures");
    const artifact = readdirSync(folder).map(file => JSON.parse(readFileSync(join(folder, file), "utf8"))).find(a => a.message === invalid);
    expect(artifact.message).toBe(invalid);
    expect(artifact.error).toBeTruthy();
    expect(f.runTurn).toHaveBeenCalledTimes(2);
  });
  it("rejects malformed conversion before exploration", async () => {
    const f = setup({ malformed: true });
    expect(await f.make().exploreUiCase("p", "test", "tc_a")).toMatchObject({ status: "failed", scriptGenerated: false });
    expect(f.runTurn).toHaveBeenCalledTimes(2);
  });
  it("does not reuse a changed spec or tampered structured recording", async () => {
    const f = setup();
    await f.make().exploreUiCase("p", "test", "tc_a");
    const path = join(f.workspace, "scripts/ui/tc_a.spec.ts");
    writeFileSync(path, readFileSync(path, "utf8") + "\n// manual edit\n");
    await f.make().exploreUiCase("p", "test", "tc_a");
    expect(f.runTurn).toHaveBeenCalledTimes(3); // plan reused, script regenerated
    const meta = join(f.workspace, "scripts/ui/tc_a.steps.json");
    const data = JSON.parse(readFileSync(meta, "utf8")); data.steps[0].url = "/other";
    writeFileSync(meta, JSON.stringify(data));
    await f.make().exploreUiCase("p", "test", "tc_a");
    expect(f.runTurn).toHaveBeenCalledTimes(4);
  });
  it("does not count an old script as a new generation after source changes", async () => {
    const options = { generate: true }; const f = setup(options);
    await f.make().exploreUiCase("p", "test", "tc_a");
    f.source.preconditions.push("新前置条件"); options.generate = false;
    expect(await f.make().exploreUiCase("p", "test", "tc_a")).toMatchObject({ scriptGenerated: false });
  });
  it("invalidates a changed persisted plan and never silently binds an old script", async () => {
    const f = setup();
    await f.make().exploreUiCase("p", "test", "tc_a");
    const folder = join(f.workspace, ".aitest/ui-contracts");
    const path = join(folder, readdirSync(folder)[0]);
    const entry = JSON.parse(readFileSync(path, "utf8"));
    entry.contract.steps[0].actions[0].value = "/changed";
    writeFileSync(path, JSON.stringify(entry));
    await f.make().exploreUiCase("p", "test", "tc_a");
    expect(f.runTurn).toHaveBeenCalledTimes(4);
  });
  it("does not enter exploration when the case changes during conversion", async () => {
    const f = setup();
    f.runTurn.mockImplementationOnce(async () => {
      const message = JSON.stringify(f.contract());
      f.project.environments.test.base_url = "http://changed-during-conversion";
      return { threadId: "th", turnId: "convert", status: "completed", tokens: 10, message };
    });
    const out = await f.make().exploreUiCase("p", "test", "tc_a");
    expect(out.scriptGenerated).toBe(false);
    expect(out.message).toContain("转换期间");
    expect(f.runTurn).toHaveBeenCalledTimes(1);
  });
  it.each([1, 2])("invalidates version-%s clarification caches when conversion rules change", async (revision) => {
    const f = setup({ blocked: true });
    await f.make().exploreUiCase("p", "test", "tc_a");
    const folder = join(f.workspace, ".aitest/ui-contracts");
    const versions = join(folder, "versions");
    const path = join(versions, readdirSync(versions)[0]);
    const entry = JSON.parse(readFileSync(path, "utf8"));
    entry.revision = revision;
    writeFileSync(path, JSON.stringify(entry));
    await f.make().exploreUiCase("p", "test", "tc_a");
    expect(f.runTurn).toHaveBeenCalledTimes(2);
    expect(JSON.parse(readFileSync(path, "utf8")).revision).toBe(11);
  });
  it("refuses coverage loss and shares no cache across project or environment", () => {
    const f = setup();
    const store = new UiExecutionContracts(f.workspace, "p", "test", "tc_a", f.source, ["admin"], f.project.environments.test);
    const bad = f.contract(); bad.steps[0].expected = [];
    expect(() => store.save(bad)).toThrow("预期");
    store.save(f.contract());
    expect(new UiExecutionContracts(f.workspace, "other", "test", "tc_a", f.source, ["admin"], f.project.environments.test).read()).toBeUndefined();
    expect(new UiExecutionContracts(f.workspace, "p", "prod", "tc_a", f.source, ["admin"], f.project.environments.test).read()).toBeUndefined();
  });
});

it("passes the selected session role to both stages and invalidates the cached binding when it changes", async () => {
  const f = setup({ generate: false });
  f.setRoles(["admin", "viewer"]);
  await f.make().exploreUiCase("p", "test", "tc_a", { selectedRole: "admin" });
  expect(f.runTurn.mock.calls[0][1]).toContain('用户选择的登录态角色："admin"');
  expect(f.runTurn.mock.calls[1][1]).toContain('本次选择的登录态角色："admin"');
  await f.make().exploreUiCase("p", "test", "tc_a", { selectedRole: "admin" });
  expect(f.runTurn).toHaveBeenCalledTimes(3);
  await f.make().exploreUiCase("p", "test", "tc_a", { selectedRole: "viewer" });
  expect(f.runTurn).toHaveBeenCalledTimes(5);
  expect(f.runTurn.mock.calls[3][1]).toContain('用户选择的登录态角色："viewer"');
  expect(f.runTurn.mock.calls[4][1]).toContain('本次选择的登录态角色："viewer"');
});

it("rejects a removed or unknown session role before starting the model", async () => {
  const f = setup();
  await expect(f.make().exploreUiCase("p", "test", "tc_a", { selectedRole: "missing" })).rejects.toThrow("未配置");
  expect(f.runTurn).not.toHaveBeenCalled();
});

it('retains fingerprinted plan history when a case changes and is restored', async () => {
  const f = setup({generate:false});
  await f.make().exploreUiCase('p','test','tc_a');
  f.source.preconditions.push('第二项');
  await f.make().exploreUiCase('p','test','tc_a');
  f.source.preconditions.pop();
  const result = await f.make().exploreUiCase('p','test','tc_a');
  expect(result.contractReused).toBe(true);
  expect(f.runTurn.mock.calls.filter(([,p])=>p.includes('仅把 UI 用例转换'))).toHaveLength(2);
  expect(readdirSync(join(f.workspace,'.aitest/ui-contracts/versions'))).toHaveLength(2);
});

it("blocks an invalid selected login before creating model threads and closes the check session", async () => {
  const f = setup();
  f.checkLogin.mockRejectedValueOnce(new Error("session expired"));
  await expect(f.make().exploreUiCase("p", "test", "tc_a", { selectedRole: "admin" })).rejects.toThrow("AUTH_REQUIRED");
  expect(f.checkLogin).toHaveBeenCalledWith("admin", { requireLogin: true, login: undefined });
  expect(f.closeBrowser).toHaveBeenCalledOnce();
  expect(f.startThread).not.toHaveBeenCalled();
});
