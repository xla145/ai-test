import { describe, expect, it, vi } from "vitest";
import { Orchestrator, type EngineCall } from "../src/main/orchestrator.js";

function setup() {
  const engine = vi.fn(async (args: string[]) => {
    if (args[0] === "list-projects") return [{ id: "p", workspace_path: "/ws", environments: {
      test: { base_url: "http://test" }, prod: { base_url: "http://prod", production: true },
    } }];
    if (args[0] === "run-api-suite") return { run_id: "r", needs_agent: [], total: 1, passed: 1 };
    return [];
  });
  const agent = vi.fn();
  const orch = new Orchestrator({ engine: engine as unknown as EngineCall, agent, secretEnv: () => ({ AITEST_AUTH_TOKEN: "test-token" }) });
  return { orch, engine, agent };
}

describe("接口选择执行", () => {
  it("keeps selection and credentials through scheduling without a model call", async () => {
    const { orch, engine, agent } = setup();
    await orch.runRegression("p", "test", { caseIds: ["tc_one", "tc_flow"] });
    expect(engine).toHaveBeenCalledWith(
      ["run-api-suite", "--project", "p", "--env", "test", "--case-ids", '["tc_one","tc_flow"]'],
      { AITEST_AUTH_TOKEN: "test-token" },
    );
    expect(agent).not.toHaveBeenCalled();
  });
  it("rejects an empty selection and retains the production confirmation", async () => {
    const { orch, engine } = setup();
    await expect(orch.runRegression("p", "test", { caseIds: [] })).rejects.toThrow("至少选择");
    expect(engine).not.toHaveBeenCalled();
    await expect(orch.runRegression("p", "prod", { caseIds: ["tc_one"] })).rejects.toThrow();
    expect(engine.mock.calls.some(([args]) => args[0] === "run-api-suite")).toBe(false);
    await orch.runRegression("p", "prod", { caseIds: ["tc_one"], confirmProduction: true });
    expect(engine.mock.calls.some(([args]) => args.includes("--case-ids"))).toBe(true);
  });
  it("generates reviewed scripts and persists named selections without a model", async () => {
    const { orch, engine, agent } = setup();
    await orch.writeReviewedApiSuite("p");
    await orch.saveApiTestSet("p", "订单冒烟", ["tc_flow"]);
    await orch.listApiTestSets("p");
    expect(engine.mock.calls.map(([args]) => args)).toEqual([
      ["write-api-suite", "--project", "p", "--reviewed-only"],
      ["save-api-test-set", "--project", "p", "--name", "订单冒烟", "--case-ids", '["tc_flow"]'],
      ["list-api-test-sets", "--project", "p"],
    ]);
    expect(agent).not.toHaveBeenCalled();
  });
});
