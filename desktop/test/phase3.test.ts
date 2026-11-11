import { describe, expect, it, vi } from "vitest";
import { buildCodexConfig } from "../src/main/codex/config.js";
import { AGENT_KEY_ENV, checkModel, codexProvider, midsceneEnv, validateSettings } from "../src/main/models.js";
import { BudgetExceededError, Orchestrator, type EngineCall } from "../src/main/orchestrator.js";

describe("model settings (domestic / private deployments)", () => {
  it("keeps OpenAI default and builds an OpenAI-compatible provider for other presets", () => {
    expect(codexProvider({ agent: { preset: "openai" } })).toEqual({ model: undefined });
    const { provider } = codexProvider({ agent: { preset: "dashscope" } });
    expect(provider).toEqual({ id: "aitest_dashscope", name: "阿里云百炼（通义千问）", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      envKey: AGENT_KEY_ENV, model: "qwen-max" });
    const toml = buildCodexConfig({ mcpServers: [], ...codexProvider({ agent: { preset: "private", baseUrl: "http://10.0.0.8:8000/v1/", model: "Qwen3-32B" } }) });
    expect(toml).toContain('base_url = "http://10.0.0.8:8000/v1"');
    expect(toml).toContain('model = "Qwen3-32B"');
    expect(toml).toContain(`env_key = "${AGENT_KEY_ENV}"`);
    expect(toml).toContain('wire_api = "responses"');
    expect(toml).not.toMatch(/sk-|api_key\s*=/);
  });

  it("validates missing addresses and model names", () => {
    expect(validateSettings({ agent: { preset: "openai" } })).toEqual([]);
    expect(validateSettings({ agent: { preset: "private" } })).toEqual(["agent模型缺少服务地址", "agent模型缺少模型名"]);
    expect(validateSettings({ agent: { preset: "deepseek" }, vision: { preset: "ark" } })).toEqual(["视觉模型缺少模型名"]);
    expect(validateSettings({ agent: { preset: "private", baseUrl: "10.0.0.8", model: "m" } })[0]).toContain("http");
  });

  it("maps the vision model to Midscene env only when configured", () => {
    expect(midsceneEnv({ agent: { preset: "openai" } }, "k")).toEqual({});
    const env = midsceneEnv({ agent: { preset: "deepseek" }, vision: { preset: "private", baseUrl: "http://gpu:8000/v1", model: "Qwen3-VL-8B" } }, "key");
    expect(env).toMatchObject({ AITEST_MIDSCENE: "1", MIDSCENE_MODEL_NAME: "Qwen3-VL-8B", OPENAI_BASE_URL: "http://gpu:8000/v1",
      OPENAI_API_KEY: "key", MIDSCENE_USE_QWEN_VL: "1" });
  });

  it("checks connectivity via /models and falls back to a 1-token chat call", async () => {
    const ok = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: "qwen-max" }, { id: "qwen-plus" }] }), { status: 200 }));
    const r1 = await checkModel({ preset: "dashscope" }, "agent", "k", ok as unknown as typeof fetch);
    expect(r1).toMatchObject({ ok: true, modelListed: true, detail: "服务可用" });
    expect((ok.mock.calls[0] as unknown[])[0]).toBe("https://dashscope.aliyuncs.com/compatible-mode/v1/models");
    expect(((ok.mock.calls[0] as unknown[])[1] as RequestInit).headers).toMatchObject({ authorization: "Bearer k" });

    const fallback = vi.fn(async (url: string) =>
      url.endsWith("/models") ? new Response("nope", { status: 404 }) : new Response("{}", { status: 200 }));
    expect(await checkModel({ preset: "private", baseUrl: "http://gpu/v1", model: "m" }, "agent", "k", fallback as unknown as typeof fetch))
      .toMatchObject({ ok: true, detail: "服务可用（对话接口探活）" });
    const denied = vi.fn(async () => new Response("", { status: 401 }));
    expect((await checkModel({ preset: "deepseek" }, "agent", "bad", denied as unknown as typeof fetch)).detail).toContain("API key");
    const down = vi.fn(async () => { throw new Error("ECONNREFUSED"); });
    expect(await checkModel({ preset: "deepseek" }, "agent", "k", down as unknown as typeof fetch)).toMatchObject({ ok: false });
  });
});

const project = { id: "p1", name: "demo", workspace_path: "/ws", environments: { test: { base_url: "http://t" } } };

function engineWith(budget: Record<string, unknown>) {
  const calls: string[][] = [];
  const engine = vi.fn(async (args: string[]) => {
    calls.push(args);
    switch (args[0]) {
      case "list-projects": return [project];
      case "check-budget": return budget;
      case "agent-session": return { id: "as_1" };
      case "summarize-failures": return [
        { case_id: "tc_env", failure_type: "environment", message: "ConnectError" },
        { case_id: "tc_x", failure_type: "unknown", message: "x" },
      ];
      default: return {};
    }
  }) as unknown as EngineCall;
  return { engine, calls };
}

describe("cost control and attribution", () => {
  it("refuses agent tasks once the monthly budget is used up", async () => {
    const { engine } = engineWith({ allowed: false, month_used: 2100, monthly_budget: 2000, per_task_limit: null });
    const agent = vi.fn();
    const orch = new Orchestrator({ engine, agent, secretEnv: () => ({}) });
    await expect(orch.generateCases("p1", "req.md")).rejects.toBeInstanceOf(BudgetExceededError);
    expect(agent).not.toHaveBeenCalled();
  });

  it("caps each task at the smaller of the app and project limits", async () => {
    const { engine } = engineWith({ allowed: true, month_used: 0, monthly_budget: 10000, per_task_limit: 800 });
    const runTurn = vi.fn(async () => ({ threadId: "t", turnId: "u", status: "completed", tokens: 10, message: "" }));
    const orch = new Orchestrator({ engine, agent: async () => ({ startThread: async () => "t", runTurn }), secretEnv: () => ({}), tokenLimit: 5000 });
    await orch.generateCases("p1", "req.md");
    expect((runTurn.mock.calls[0] as unknown[])[2]).toEqual({ tokenLimit: 800 });
  });

  it("persists rule and agent attributions for later human confirmation", async () => {
    const { engine, calls } = engineWith({ allowed: true, per_task_limit: null });
    const runTurn = vi.fn(async () => ({ threadId: "t", turnId: "u", status: "completed", tokens: 10,
      message: '[{"case_id":"tc_x","failure_type":"product_bug","reason":"校验缺失"},{"case_id":"tc_y","failure_type":"weird"}]' }));
    const orch = new Orchestrator({ engine, agent: async () => ({ startThread: async () => "t", runTurn }), secretEnv: () => ({}) });
    await orch.triage("p1", "run_1");
    const recorded = calls.filter((a) => a[0] === "set-attribution");
    expect(recorded).toEqual([
      ["set-attribution", "--run", "run_1", "--case", "tc_env", "--type", "environment", "--source", "rule", "--reason", "确定性规则判定"],
      ["set-attribution", "--run", "run_1", "--case", "tc_x", "--type", "product_bug", "--source", "agent", "--reason", "校验缺失"],
    ]);
  });

  it("records UI edits as human interventions", async () => {
    const { engine, calls } = engineWith({});
    const orch = new Orchestrator({ engine, agent: vi.fn(), secretEnv: () => ({}) });
    await orch.updateCase("tc_1", { status: "reviewed" });
    expect(calls.at(-1)).toEqual(["update-case", "--case", "tc_1", "--json", '{"status":"reviewed"}', "--actor", "human"]);
  });
});
