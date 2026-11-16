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
    expect(orch.uiTasks()).toEqual([]);
    const runCall = calls.find(([a]) => a[0] === "run-api-suite")!;
    expect(runCall[0]).toEqual(["run-api-suite", "--project", "p1", "--env", "test"]);
    expect(runCall[1]).toEqual({ AITEST_AUTH_TOKEN: "Bearer s" });
  });

  it("injects the selected API identity only into this run and keeps the selected environment", async () => {
    const { engine, calls } = fakeEngine({ run_id: "r1", total: 1, passed: 1, needs_agent: [] });
    const secretEnv = vi.fn(() => ({ AITEST_ROLE_TOKENS: '{"运营":"test-token"}' }));
    const orch = new Orchestrator({ engine, agent: vi.fn(), secretEnv });
    await orch.runRegression("p1", "test", { selectedRole: "运营", caseIds: ["case1"] });
    const call = calls.find(([a]) => a[0] === "run-api-suite")!;
    expect(call[0]).toEqual(["run-api-suite", "--project", "p1", "--env", "test", "--case-ids", '["case1"]']);
    expect(call[1]).toEqual({ AITEST_ROLE_TOKENS: '{"运营":"test-token"}', AITEST_API_SELECTED_ROLE: "运营" });
    expect(secretEnv).toHaveBeenCalledWith("p1", "test", ["*"]);
    await orch.runRegression("p1", "test");
    expect(calls.filter(([a]) => a[0] === "run-api-suite")[1][1]).not.toHaveProperty("AITEST_API_SELECTED_ROLE");
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
    expect(runTurn.mock.calls[0][2]).toEqual({ tokenLimit: 5000, signal: expect.any(AbortSignal) });
    expect(calls.map(([a]) => a[0])).toContain("agent-session");
    expect(calls.find(([a]) => a[0] === "add-tokens")![0]).toEqual(["add-tokens", "--session", "as_1", "--tokens", "777"]);
    expect(orch.uiTasks()).toEqual([expect.objectContaining({ source: "agent", kind: "分析失败原因", status: "completed", canStop: true, finishedAt: expect.any(String) })]);
  });

  it("exposes API enrichment while running and preserves its failure", async () => {
    const { engine } = fakeEngine({});
    let rejectTurn!: (error: Error) => void;
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const runTurn = vi.fn(() => new Promise<never>((_resolve, reject) => { rejectTurn = reject; started(); }));
    const orch = new Orchestrator({ engine, agent: async () => ({ startThread: async () => "api-thread", runTurn }), secretEnv: () => ({}) });
    const pending = orch.generateApiSuite("p1", "/ws/openapi.json", true);
    await ready;
    expect(orch.uiTasks()).toEqual([expect.objectContaining({ source: "agent", kind: "生成接口脚本", status: "running", canStop: true })]);
    const rejected = expect(pending).rejects.toThrow("接口 Agent 连接失败");
    rejectTurn(new Error("接口 Agent 连接失败"));
    await rejected;
    expect(orch.uiTasks()[0]).toMatchObject({ status: "failed", detail: "接口 Agent 连接失败", finishedAt: expect.any(String) });
  });

  it("rejects unknown environments", async () => {
    const { engine } = fakeEngine({});
    const orch = new Orchestrator({ engine, agent: vi.fn(), secretEnv: () => ({}) });
    await expect(orch.runRegression("p1", "prod")).rejects.toThrow("未配置环境");
  });

  it("keeps the deterministic API report when AI triage fails", async () => {
    const { engine } = fakeEngine({ run_id: "r3", total: 1, passed: 0, failed: 1, error: 0, skipped: 0, pass_rate: 0, failure_types: {}, needs_agent: ["tc_x"] });
    const orch = new Orchestrator({
      engine,
      agent: async () => ({ startThread: async () => "th_failed", runTurn: async () => { throw new Error("模型暂时不可用"); } }),
      secretEnv: () => ({}),
    });
    const result = await orch.runRegression("p1", "test");
    expect(result.run.run_id).toBe("r3");
    expect(result.triage).toBeUndefined();
    expect(result.analysis).toMatchObject({ status: "failed", error: "模型暂时不可用" });
  });

  it("disables AI analysis even when the report contains unknown failures", async () => {
    const { engine } = fakeEngine({ run_id: "r4", total: 1, needs_agent: ["tc_x"] });
    const agent = vi.fn();
    const orch = new Orchestrator({ engine, agent, secretEnv: () => ({}) });
    const result = await orch.runRegression("p1", "test", { autoTriage: false });
    expect(result.run.run_id).toBe("r4");
    expect(result.analysis).toBeUndefined();
    expect(agent).not.toHaveBeenCalled();
  });

  it.each([
    ["interrupted_budget", '[{"case_id":"tc_x","failure_type":"data"}]'],
    ["completed", '[{"case_id":"another-case","failure_type":"data"}]'],
    ["completed", '[{"case_id":"tc_x","failure_type":"made-up"}]'],
  ])("preserves the report when triage is incomplete or untrusted (%s)", async (status, message) => {
    const { engine, calls } = fakeEngine({ run_id: "r5", needs_agent: ["tc_x"] });
    const orch = new Orchestrator({ engine, secretEnv: () => ({}), agent: async () => ({
      startThread: async () => "th", runTurn: async () => ({ threadId: "th", turnId: "u", status, message, tokens: 3 }),
    }) });
    const result = await orch.runRegression("p1", "test");
    expect(result.run.run_id).toBe("r5");
    expect(result.analysis?.status).toBe("failed");
    expect(calls.filter(([a]) => a[0] === "set-attribution").every(([a]) => !a.includes("another-case"))).toBe(true);
  });
});

describe("parseTriage", () => {
  it("parses bare and fenced arrays and tolerates garbage", () => {
    expect(parseTriage('[{"case_id":"a","failure_type":"environment"}]')).toHaveLength(1);
    expect(parseTriage("没有结论")).toEqual([]);
  });
  it("accepts the unified failure taxonomy and rejects invalid field types", () => {
    expect(parseTriage('[{"case_id":"a","failure_type":"auth","reason":"登录失效"},{"case_id":"b","failure_type":"unknown"}]')).toHaveLength(2);
    expect(parseTriage('[{"case_id":"a","failure_type":"made-up"},{"case_id":"b","failure_type":"model","reason":{}}]')).toEqual([]);
  });
});

describe("paged lists", () => {
  it("maps page queries, search and multi-value filters to engine arguments", async () => {
    const { engine, calls } = fakeEngine({});
    const orch = new Orchestrator({ engine, agent: vi.fn(), secretEnv: () => ({}) });
    await orch.pageCases("p1", { page: 2, pageSize: 20, query: "标签", filters: { execution_mode: "ui,capture", priority: undefined } });
    await orch.pageIssues("p1", { page: 1, pageSize: 10, level: "warn" });
    await orch.pageProposals("p1", { page: 1, pageSize: 5, status: "pending" });
    await orch.pageReviews("p1", { page: 3, pageSize: 10 });
    await orch.pageAttributions("p1", { page: 1, pageSize: 10, pending: true });
    await orch.lint("p1");
    expect(calls.map(([a]) => a)).toEqual([
      ["list-cases", "--project", "p1", "--query", "标签", "--execution-mode", "ui,capture", "--page", "2", "--page-size", "20"],
      ["list-issues", "--project", "p1", "--level", "warn", "--page", "1", "--page-size", "10"],
      ["list-proposals", "--project", "p1", "--status", "pending", "--page", "1", "--page-size", "5"],
      ["list-reviews", "--project", "p1", "--page", "3", "--page-size", "10"],
      ["list-attributions", "--project", "p1", "--pending", "--page", "1", "--page-size", "10"],
      // 规范检查不再随结果返回全部问题，明细改为分页读取
      ["lint", "--project", "p1"],
    ]);
  });
});

describe("two-level projects", () => {
  it("creates groups without a workspace, sub-projects with a parent, and clears settings to inherit", async () => {
    const { engine, calls } = fakeEngine({});
    const orch = new Orchestrator({ engine, agent: vi.fn(), secretEnv: () => ({}) });
    await orch.createProject("特征中心", "", {}, { kind: "group" });
    await orch.createProject("v4.4", "/ws/a", {}, { parent: "grp_1" });
    await orch.moveProject("p1", "");
    await orch.setSettings("p1", { currency: null, price_per_mtok: 20, per_task_token_limit: undefined });
    expect(calls.map(([a]) => a).filter((a) => a[0] !== "get-settings")).toEqual([
      ["init-project", "--name", "特征中心", "--kind", "group", "--environments", "{}"],
      ["init-project", "--name", "v4.4", "--workspace", "/ws/a", "--environments", "{}", "--parent", "grp_1"],
      ["update-project", "--project", "p1", "--parent", ""],
      ["set-setting", "--project", "p1", "--key", "currency", "--value", ""],
      ["set-setting", "--project", "p1", "--key", "price_per_mtok", "--value", "20"],
    ]);
  });
});
