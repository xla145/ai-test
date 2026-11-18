import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { caseHash, writeUiScript } from "@ai-test/mcp-servers";
import { UiWorkflow } from "../src/main/uiWorkflow.js";
import { Orchestrator, type EngineCall } from "../src/main/orchestrator.js";

const dirs: string[] = [];
afterEach(() => { dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })); });
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "aitest-ui-review-")); dirs.push(dir);
  mkdirSync(join(dir, "scripts/ui"), { recursive: true });
  const path = "scripts/ui/tc_a.spec.ts";
  writeFileSync(join(dir, path), "// version 1");
  return { dir, path, workflow: new UiWorkflow(dir) };
}
describe("UI script confirmation", () => {
  it("requires a passed validation of the current content and environment, and persists confirmation", () => {
    const { dir, path, workflow } = setup();
    const hash = workflow.hash(path);
    expect(() => workflow.confirm("test", "tc_a", path, hash)).toThrow("试跑通过");
    workflow.record("test", "r_failed", { tc_a: hash }, []);
    expect(() => workflow.confirm("test", "tc_a", path, hash)).toThrow("未通过");
    workflow.record("test", "r_ok", { tc_a: hash }, ["tc_a"]);
    workflow.confirm("test", "tc_a", path, hash);
    expect(new UiWorkflow(dir).states("test", { tc_a: path }).tc_a.status).toBe("confirmed");
    expect(workflow.states("staging", { tc_a: path }).tc_a.status).toBe("pending");
    writeFileSync(join(dir, path), "// version 2");
    expect(workflow.states("test", { tc_a: path }).tc_a).toMatchObject({ status: "pending", validatedRunId: undefined });
    expect(() => workflow.confirm("test", "tc_a", path, hash)).toThrow("已变化");
  });

  it("revokes confirmation when a new validation starts, and requires matching context", () => {
    const { workflow, path } = setup();
    const hash = workflow.hash(path);
    const context = { fingerprints: { tc_a: "env-v1" } };
    workflow.record("test", "ok", { tc_a: hash }, ["tc_a"], context);
    workflow.confirm("test", "tc_a", path, hash, context);
    expect(workflow.states("test", { tc_a: path }, { fingerprints: { tc_a: "env-v2" } }).tc_a.status).toBe("pending");
    workflow.begin("test", { tc_a: hash }, context.fingerprints);
    expect(workflow.states("test", { tc_a: path }, context).tc_a.status).toBe("pending");
    expect(() => workflow.confirm("test", "tc_a", path, hash, context)).toThrow("尚未完整结束");
  });

  it("requires all reviews from this exact run and case to pass", () => {
    const { workflow, path } = setup();
    const hash = workflow.hash(path);
    workflow.record("test", "r1", { tc_a: hash }, ["tc_a"], {}, {}, { tc_a: 1 });
    expect(() => workflow.confirm("test", "tc_a", path, hash)).toThrow("人工复核");
    const review = { run_id: "r1", case_id: "tc_a", status: "pending" };
    expect(() => workflow.confirm("test", "tc_a", path, hash, { reviews: [review] })).toThrow("人工复核");
    expect(() => workflow.confirm("test", "tc_a", path, hash, { reviews: [{ ...review, run_id: "old", status: "confirmed_pass" }] })).toThrow("人工复核");
    workflow.confirm("test", "tc_a", path, hash, { reviews: [{ ...review, status: "confirmed_pass" }] });
    expect(workflow.states("test", { tc_a: path }, { reviews: [{ ...review, status: "confirmed_fail" }] }).tc_a.status).toBe("pending");
  });

  it("reads structured steps and flags specs modified after generation", () => {
    const { dir, workflow } = setup();
    const { path } = writeUiScript(dir, { caseId: "tc_s", title: "S", steps: [
      { action: "goto", url: "/tags", caseStep: 1 },
      { action: "click", target: { kind: "testid", value: "disable" }, caseStep: 2, role: "admin" },
    ] });
    const detail = workflow.detail(path);
    expect(detail).toMatchObject({ path, synced: true, steps: [
      { id: "S1", action: "goto", description: "打开 /tags", caseStep: 1 },
      { id: "S2", description: "点击 testid「disable」", caseStep: 2, role: "admin" },
    ] });
    writeFileSync(join(dir, path), detail.code + "// 合并了修正建议\n");
    expect(workflow.detail(path).synced).toBe(false);
    expect(workflow.detail("scripts/ui/tc_a.spec.ts")).toEqual({ path: "scripts/ui/tc_a.spec.ts", code: "// version 1", synced: false });
  });

  it("rejects script paths outside the workspace", () => {
    const { workflow } = setup();
    expect(() => workflow.hash("/etc/hosts")).toThrow("项目工作目录");
  });
});

describe("UI workbench orchestration", () => {
  function orchestration() {
    const { dir, path, workflow } = setup();
    const rows = [{ id: "tc_a", title: "A", execution_mode: "ui", status: "reviewed", data_refs: [], steps: ["打开列表"], expected: ["列表可见"] },
      { id: "tc_b", title: "B", execution_mode: "ui", status: "reviewed", data_refs: [], steps: ["打开列表"], expected: ["列表可见"] }];
    writeUiScript(dir, { caseId: "tc_a", title: "A", caseHash: caseHash(rows[0]), steps: [
      { action: "goto", url: "/", caseStep: 1 },
      { action: "expectVisible", target: { kind: "testid", value: "list" }, caseStep: 1, expectedIndices: [1] },
    ] });
    const engine = vi.fn(async (args: string[]) => {
      switch (args[0]) {
        case "list-projects": return [{ id: "p", workspace_path: dir, environments: { test: { base_url: "http://sut" }, prod: { base_url: "http://prod", production: true } } }];
        case "list-cases": return rows;
        case "list-scripts": return [{ case_id: "tc_a", path, framework: "playwright" }];
        case "list-roles": return [{ role_name: "admin" }];
        case "list-reviews": case "list-test-data": case "list-run-results": return [];
        case "save-run": return { run_id: "r1", total: 1, passed: 1, failed: 0, error: 0, reviews: 0, needs_agent: ["tc_a"] };
        default: return {};
      }
    }) as unknown as EngineCall;
    const ui = { prepareEmbedded: vi.fn(async () => ({ cdpEndpoint: "http://127.0.0.1:9333", viewMarkers: { default: "marker" } })),
      checkData: vi.fn(async () => []), seedData: vi.fn(async () => []),
      runUiSuite: vi.fn(async () => ({ exitCode: 0, htmlReport: "report", reportJson: "", stderr: "", errors: [], results: [{ case_id: "tc_a", status: "passed", duration: 1, message: "", evidence_paths: [], reviews: [] }] })) };
    const agent = vi.fn();
    const orch = new Orchestrator({ engine, ui: ui as any, agent, secretEnv: () => ({}) });
    return { orch, ui, agent, workflow, path, dir, rows };
  }
  it("validates one selected script in a fresh context then runs only its confirmed version without the model", async () => {
    const { orch, ui, agent, workflow, path } = orchestration();
    await expect(orch.runUiRegression("p", "test", { caseIds: ["tc_a"], mode: "regression" })).rejects.toThrow("尚未确认");
    await orch.runUiRegression("p", "test", { caseIds: ["tc_a"], mode: "validate", embedded: true });
    expect(ui.runUiSuite.mock.calls[0][0]).toMatchObject({ caseIds: ["tc_a"] });
    expect(ui.runUiSuite.mock.calls[0][0].cdpEndpoint).toBeUndefined();
    expect(ui.runUiSuite.mock.calls[0][0].sessionSource).toEqual({ cdpEndpoint: "http://127.0.0.1:9333", viewMarkers: { default: "marker" } });
    await orch.confirmUiScript("p", "test", "tc_a", workflow.hash(path));
    await orch.runUiRegression("p", "test", { caseIds: ["tc_a"], mode: "regression" });
    expect(ui.runUiSuite.mock.calls[1][0]).toMatchObject({ caseIds: ["tc_a"] });
    expect(agent).not.toHaveBeenCalled();
    await expect(orch.runUiRegression("p", "test", { caseIds: [], mode: "regression" })).rejects.toThrow("请选择");
    await expect(orch.runUiRegression("p", "test", { caseIds: ["foreign"], mode: "regression" })).rejects.toThrow("当前项目");
    await expect(orch.runUiRegression("p", "prod", { caseIds: ["tc_a"], mode: "validate", embedded: true })).rejects.toThrow("生产环境");
  });
  it("forwards the selected role only to embedded trials and rejects stale selections", async () => {
    const { orch, ui } = orchestration();
    await expect(orch.runUiRegression("p", "test", { caseIds: ["tc_a"], mode: "validate", embedded: true, selectedRole: "missing" })).rejects.toThrow("未配置");
    expect(ui.prepareEmbedded).not.toHaveBeenCalled();
    await orch.runUiRegression("p", "test", { caseIds: ["tc_a"], mode: "validate", embedded: true, selectedRole: "admin" });
    expect(ui.prepareEmbedded).toHaveBeenCalledWith("p", "test", ["admin"], "admin");
    expect(ui.runUiSuite.mock.calls[0][0]).toMatchObject({ defaultRole: "admin" });
    await orch.runUiRegression("p", "test", { caseIds: ["tc_a"], mode: "validate", selectedRole: "admin" });
    expect(ui.runUiSuite.mock.calls[1][0]).toMatchObject({ roleBindings: { tc_a: "admin" } });
  });
  it.each(["missing", "mixed", "reviews", "exit", "global", "foreign"])("blocks incomplete validation: %s", async (kind) => {
    const { orch, ui, workflow, path } = orchestration();
    const output = await ui.runUiSuite.getMockImplementation()!();
    if (kind === "missing") output.results = [];
    if (kind === "foreign") output.results.push({ ...output.results[0], case_id: "foreign" });
    if (kind === "mixed") output.results.push({ ...output.results[0], status: "skipped" });
    if (kind === "reviews") (output.results[0].reviews as unknown[]).push({ kind: "visual", description: "check", evidence_paths: [] });
    if (kind === "exit") output.exitCode = 1;
    if (kind === "global") (output.errors as string[]).push("setup failed");
    ui.runUiSuite.mockResolvedValueOnce(output);
    const result = await orch.runUiRegression("p", "test", { caseIds: ["tc_a"], mode: "validate" });
    expect(result.validationIssues.tc_a).toBeTruthy();
    await expect(orch.confirmUiScript("p", "test", "tc_a", workflow.hash(path))).rejects.toThrow();
  });

  it("persists the selected role for headless replay and revokes stale validation", async () => {
    const { orch, workflow, path, rows, ui } = orchestration();
    const result = await orch.runUiRegression("p", "test", { caseIds: ["tc_a"], mode: "validate", embedded: true, selectedRole: "admin" });
    expect(result.validationIssues.tc_a).toBeUndefined();
    await orch.confirmUiScript("p", "test", "tc_a", workflow.hash(path));
    await orch.runUiRegression("p", "test", { caseIds: ["tc_a"], mode: "regression" });
    expect(ui.runUiSuite.mock.calls[1][0]).toMatchObject({ roleBindings: { tc_a: "admin" } });
    rows[0].expected = ["new expectation"];
    expect((await orch.uiScriptStates("p", "test")).tc_a.status).toBe("pending");
    rows[0].expected = ["列表可见"];
    ui.runUiSuite.mockRejectedValueOnce(new Error("browser closed"));
    await expect(orch.runUiRegression("p", "test", { caseIds: ["tc_a"], mode: "validate" })).rejects.toThrow("browser closed");
    expect((await orch.uiScriptStates("p", "test")).tc_a.status).toBe("pending");
  });

  it("says explicitly whether exploration produced a script, and why not", async () => {
    const { orch, agent } = orchestration();
    const runTurn = vi.fn(async () => ({ status: "interrupted_budget", message: "我先打开登录页。", tokens: 9 }));
    agent.mockResolvedValue({ startThread: async () => "thread", runTurn });
    const missing = await orch.exploreUiCase("p", "test", "tc_b") as { scriptGenerated: boolean; message: string };
    expect((runTurn.mock.calls[0] as unknown as [string, string])[1]).toContain("仅把 UI 用例转换");
    expect(missing.scriptGenerated).toBe(false);
    expect(missing).toMatchObject({ status: "interrupted_budget", message: "我先打开登录页。" });
    runTurn.mockResolvedValueOnce({ status: "completed", message: "已生成", tokens: 9 });
    expect(await orch.exploreUiCase("p", "test", "tc_a")).toMatchObject({ scriptGenerated: false, status: "failed" });
  });
  it("rejects foreign or blocked cases and production exploration before calling the model", async () => {
    const { orch, agent } = orchestration();
    await expect(orch.exploreUiCase("p", "prod", "tc_a")).rejects.toThrow("生产环境");
    await expect(orch.exploreUiCase("p", "test", "foreign")).rejects.toThrow("不属于");
    await expect(orch.reviseUiScript("p", "test", "tc_a", "")).rejects.toThrow("修正说明");
    expect(agent).not.toHaveBeenCalled();
  });
  it("turns user feedback into a reviewed proposal rather than overwriting the script", async () => {
    const { orch, agent, workflow, path } = orchestration();
    const before = workflow.hash(path);
    const runTurn = vi.fn(async () => ({ status: "completed", message: "已提交建议", tokens: 1 }));
    agent.mockResolvedValue({ startThread: async () => "thread", runTurn });
    await orch.reviseUiScript("p", "test", "tc_a", "第 2 步应该点击近 30 日");
    const prompt = (runTurn.mock.calls[0] as unknown as [string, string])[1];
    expect(prompt).toContain("第 2 步应该点击近 30 日");
    expect(prompt).toContain("report.propose_script_fix");
    expect(prompt).toContain("不要直接覆盖现有脚本");
    expect(workflow.hash(path)).toBe(before);
  });
  it("prevents another UI task from taking over the browser until the current run completes", async () => {
    const { orch, ui } = orchestration();
    let complete: (() => void) | undefined;
    const original = ui.runUiSuite.getMockImplementation()!;
    ui.runUiSuite.mockImplementationOnce(async () => {
      await new Promise<void>(resolve => { complete = resolve; });
      return original();
    });
    const running = orch.runUiRegression("p", "test", { caseIds: ["tc_a"], mode: "validate", embedded: true });
    await vi.waitFor(() => expect(complete).toBeDefined());
    await expect(orch.exploreUiCase("p", "test", "tc_a")).rejects.toThrow("已有 UI 任务");
    complete!();
    await running;
  });
});
