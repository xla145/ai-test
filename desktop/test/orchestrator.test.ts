import { describe, expect, it, vi } from "vitest";
import { Orchestrator, parseTriage, type EngineCall } from "../src/main/orchestrator.js";

const project = { id: "p1", name: "demo", workspace_path: "/ws", environments: { test: { base_url: "http://t" } } };

function fakeEngine(run: Record<string, unknown>) {
  const calls: [string[], Record<string, string> | undefined][] = [];
  const engine = vi.fn(async (args: string[], env?: Record<string, string>) => {
    calls.push([args, env]);
    switch (args[0]) {
      case "list-projects": return [project];
      case "run-api-suite": return run;
      case "summarize-failures": return [
        { case_id: "tc_env", failure_type: "environment", message: "ConnectError" },
        { case_id: "tc_x", failure_type: "unknown", message: "状态码 201 不在预期 [400] 中" },
      ];
      case "agent-session": return { id: "as_1" };
      default: return {};
    }
  }) as unknown as EngineCall;
  return { engine, calls };
}

describe("Orchestrator", () => {
  it("runs regression without the agent when everything passes", async () => {
    const { engine, calls } = fakeEngine({ run_id: "r1", total: 3, passed: 3, failed: 0, error: 0, skipped: 0, pass_rate: 1, failure_types: {}, needs_agent: [] });
    const agent = vi.fn();
    const orch = new Orchestrator({ engine, agent, secretEnv: () => ({ AITEST_AUTH_TOKEN: "Bearer s" }) });
    const { run, triage } = await orch.runRegression("p1", "test");
    expect(run.passed).toBe(3);
    expect(triage).toBeUndefined();
    expect(agent).not.toHaveBeenCalled();
    const runCall = calls.find(([a]) => a[0] === "run-api-suite")!;
    expect(runCall[0]).toEqual(["run-api-suite", "--project", "p1", "--env", "test"]);
    expect(runCall[1]).toEqual({ AITEST_AUTH_TOKEN: "Bearer s" });
  });

  it("sends only undetermined failures to a dedicated triage thread and records tokens", async () => {
    const { engine, calls } = fakeEngine({ run_id: "r2", total: 3, passed: 1, failed: 2, error: 0, skipped: 0, pass_rate: 0.33, failure_types: {}, needs_agent: ["tc_x"] });
    const startThread = vi.fn(async () => "th_9");
    const runTurn = vi.fn(async (_t: string, prompt: string) => {
      expect(prompt).toContain("tc_x");
      expect(prompt).not.toContain("tc_env");
      return { threadId: "th_9", turnId: "u", status: "completed", tokens: 777,
        message: '结论：\n```json\n[{"case_id":"tc_x","failure_type":"product_bug","reason":"未校验 age 上限"}]\n```' };
    });
    const orch = new Orchestrator({ engine, agent: async () => ({ startThread, runTurn }), secretEnv: () => ({}), tokenLimit: 5000 });
    const { triage } = await orch.runRegression("p1", "test");
    expect(triage).toEqual([
      { case_id: "tc_env", failure_type: "environment", reason: "确定性规则判定" },
      { case_id: "tc_x", failure_type: "product_bug", reason: "未校验 age 上限" },
    ]);
    expect(startThread).toHaveBeenCalledWith({ cwd: "/ws", approvalPolicy: "on-request", sandbox: "workspace-write" });
    expect(runTurn.mock.calls[0][2]).toEqual({ tokenLimit: 5000 });
    expect(calls.map(([a]) => a[0])).toContain("agent-session");
    expect(calls.find(([a]) => a[0] === "add-tokens")![0]).toEqual(["add-tokens", "--session", "as_1", "--tokens", "777"]);
  });

  it("rejects unknown environments", async () => {
    const { engine } = fakeEngine({});
    const orch = new Orchestrator({ engine, agent: vi.fn(), secretEnv: () => ({}) });
    await expect(orch.runRegression("p1", "prod")).rejects.toThrow("未配置环境");
  });
});

describe("parseTriage", () => {
  it("parses bare and fenced arrays and tolerates garbage", () => {
    expect(parseTriage('[{"case_id":"a","failure_type":"environment"}]')).toHaveLength(1);
    expect(parseTriage("没有结论")).toEqual([]);
  });
});
