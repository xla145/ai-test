import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { caseHash, writeUiScript, type ExecutionContract } from "@ai-test/mcp-servers";
import { Orchestrator, type EngineCall } from "../src/main/orchestrator.js";
import { UiExecutionContracts } from "../src/main/uiExecutionContract.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function setup(options: { blocked?: boolean; generate?: boolean; malformed?: boolean } = {}) {
  const workspace = mkdtempSync(join(tmpdir(), "ui-contract-cache-")); dirs.push(workspace);
  const project = { id: "p", name: "demo", workspace_path: workspace, environments: { test: { base_url: "http://sut" } } };
  const source = { id: "tc_a", title: "列表可见", execution_mode: "ui", status: "reviewed", preconditions: ["服务可用"], data_refs: [] as string[], steps: ["打开列表"], expected: ["列表可见"] };
  let roles = ["admin"];
  const contract = (): ExecutionContract => ({ version: 1, status: options.blocked ? "needs_clarification" : "ready", issues: options.blocked ? ["缺少列表地址"] : [],
    preconditions: [...source.preconditions], steps: [{ index: 1, source: source.steps[0], actions: [{ action: "navigate", instruction: "打开 /list", value: "/list" }], expected: [...source.expected] }] });
  let scripts: { case_id: string; framework: string; path: string }[] = [];
  const engine = vi.fn(async (args: string[]) => {
    switch (args[0]) {
      case "list-projects": return [project];
      case "list-cases": return [source];
      case "list-roles": return roles.map(role_name => ({ role_name }));
      case "list-scripts": return scripts;
      case "agent-session": return { id: "as" };
      default: return {};
    }
  }) as unknown as EngineCall;
  const startThread = vi.fn(async () => "th");
  const runTurn = vi.fn(async (_id: string, prompt: string) => {
    if (prompt.includes("仅把 UI 用例转换")) return { threadId: "th", turnId: "convert", status: "completed", tokens: 10, message: options.malformed ? "invalid JSON" : JSON.stringify(contract()) };
    expect(prompt).toContain("已转换并缓存的执行用例");
    if (options.generate !== false) {
      const { path } = writeUiScript(workspace, { caseId: source.id, title: source.title, caseHash: caseHash(source), steps: [
        { action: "goto", url: "/list" }, { action: "expectUrl", pattern: "/list" },
      ] });
      scripts = [{ case_id: source.id, framework: "playwright", path }];
    }
    return { threadId: "th", turnId: "execute", status: "completed", tokens: 20, message: "生成完成" };
  });
  const make = () => new Orchestrator({ engine, agent: async () => ({ startThread, runTurn }), secretEnv: () => ({}) });
  return { workspace, project, source, runTurn, startThread, make, contract, setRoles: (next: string[]) => { roles = next; } };
}

describe("persisted UI conversion and script reuse", () => {
  it("converts before exploration once, and reuses after a new orchestrator without any model call", async () => {
    const f = setup();
    const first = await f.make().exploreUiCase("p", "test", "tc_a");
    expect(first).toMatchObject({ scriptGenerated: true, tokens: 30 });
    expect(f.startThread.mock.calls[0][0]).toMatchObject({ sandbox: "read-only" });
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
  it("persists clarification issues and never enters exploration until the case changes", async () => {
    const f = setup({ blocked: true });
    expect(await f.make().exploreUiCase("p", "test", "tc_a")).toMatchObject({ needsClarification: true, tokens: 10, scriptGenerated: false });
    expect(await f.make().exploreUiCase("p", "test", "tc_a")).toMatchObject({ needsClarification: true, tokens: 0, contractReused: true });
    expect(f.runTurn).toHaveBeenCalledTimes(1);
  });
  it("rejects malformed conversion before exploration", async () => {
    const f = setup({ malformed: true });
    expect(await f.make().exploreUiCase("p", "test", "tc_a")).toMatchObject({ status: "failed", scriptGenerated: false });
    expect(f.runTurn).toHaveBeenCalledTimes(1);
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
  it("invalidates version-1 clarification caches so old UI-detail blockers cannot persist", async () => {
    const f = setup({ blocked: true });
    await f.make().exploreUiCase("p", "test", "tc_a");
    const folder = join(f.workspace, ".aitest/ui-contracts");
    const path = join(folder, readdirSync(folder)[0]);
    const entry = JSON.parse(readFileSync(path, "utf8"));
    entry.revision = 1;
    writeFileSync(path, JSON.stringify(entry));
    await f.make().exploreUiCase("p", "test", "tc_a");
    expect(f.runTurn).toHaveBeenCalledTimes(2);
    expect(JSON.parse(readFileSync(path, "utf8")).revision).toBe(2);
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
