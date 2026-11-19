import { describe, expect, it, vi } from "vitest";
import { createAssistantCompletion } from "../src/main/assistant/model.js";
import type { EngineCall } from "../src/main/orchestrator/types.js";

const messages = [{ role: "user" as const, content: "解释这份报告" }];
const config = () => ({ baseUrl: "https://model.example/v1", model: "text-model", apiKey: "secret-model-key", tokenLimit: 10_000 });
function setup(response?: Response) {
  const engine = vi.fn(async (args: string[]) => args[0] === "check-budget"
    ? { allowed: true, month_used: 0, monthly_budget: 50_000, per_task_limit: 10_000 }
    : args[0] === "agent-session" ? { id: "session-1" } : {});
  const fetch = vi.fn(async () => response ?? new Response(JSON.stringify({ choices: [{ message: { content: "依据不足，需查看服务端日志。" }, finish_reason: "stop" }], usage: { total_tokens: 123 } })));
  const complete = createAssistantCompletion({ config, engine: engine as EngineCall, fetch: fetch as typeof globalThis.fetch });
  return { complete, engine, fetch };
}

describe("assistant model isolation", () => {
  it("uses only the configured text endpoint without tools, then settles actual usage", async () => {
    const { complete, engine, fetch } = setup();
    const result = await complete("project-1", messages, new AbortController().signal);
    expect(result.tokens).toBe(123);
    const [url, init] = (fetch.mock.calls as unknown as [string, RequestInit][])[0];
    expect(url).toBe("https://model.example/v1/chat/completions");
    expect(init.redirect).toBe("error");
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({ messages, model: "text-model", stream: false });
    expect(body).not.toHaveProperty("tools");
    expect(body).not.toHaveProperty("functions");
    expect(JSON.stringify(body)).not.toContain("secret-model-key");
    expect(engine.mock.calls.filter(([args]) => args[0] === "add-tokens").reduce((sum, [args]) => sum + Number(args.at(-1)), 0)).toBe(123);
  });

  it("rejects model tool calls rather than executing them", async () => {
    const { complete } = setup(new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{ function: { name: "deleteProject" } }] }, finish_reason: "tool_calls" }] })));
    await expect(complete("p", messages, new AbortController().signal)).rejects.toThrow("拒绝");
  });

  it("never applies a truncated answer", async () => {
    const { complete } = setup(new Response(JSON.stringify({ choices: [{ message: { content: "部分输出" }, finish_reason: "length" }] })));
    await expect(complete("p", messages, new AbortController().signal)).rejects.toThrow("未完整");
  });

  it("does not return raw provider error bodies or retry failed requests", async () => {
    const { complete, fetch } = setup(new Response("secret-model-key private upstream payload", { status: 401 }));
    await expect(complete("p", messages, new AbortController().signal)).rejects.toThrow("HTTP 401");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("retains the reserved budget when usage is missing", async () => {
    const { complete, engine } = setup(new Response(JSON.stringify({ choices: [{ message: { content: "回答" }, finish_reason: "stop" }] })));
    const result = await complete("p", messages, new AbortController().signal);
    const charges = engine.mock.calls.filter(([a]) => a[0] === "add-tokens");
    expect(charges).toHaveLength(1);
    expect(result.tokens).toBe(Number(charges[0][0].at(-1)));
  });

  it("rejects missing model configuration before any network request", async () => {
    const fetch = vi.fn();
    const complete = createAssistantCompletion({ config: () => ({ ...config(), model: "" }), engine: vi.fn() as EngineCall, fetch });
    await expect(complete("p", messages, new AbortController().signal)).rejects.toThrow("模型名称");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses a spent budget and oversized input before sending", async () => {
    const { complete, engine, fetch } = setup();
    engine.mockImplementation(async () => ({ allowed: false, month_used: 50_000, monthly_budget: 50_000, per_task_limit: 1000 }));
    await expect(complete("p", messages, new AbortController().signal)).rejects.toThrow("预算");
    await expect(complete("p", [{ role: "user", content: "长".repeat(30_000) }], new AbortController().signal)).rejects.toThrow("上下文过大");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not send cancelled requests", async () => {
    const { complete, fetch } = setup();
    const controller = new AbortController(); controller.abort();
    await expect(complete("p", messages, controller.signal)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects credential-bearing and non-http endpoints", async () => {
    const fetch = vi.fn();
    for (const baseUrl of ["file:///tmp/data", "https://name:pass@host/v1", "https://host/v1?key=secret"]) {
      const complete = createAssistantCompletion({ config: () => ({ ...config(), baseUrl }), engine: vi.fn() as EngineCall, fetch });
      await expect(complete("p", messages, new AbortController().signal)).rejects.toThrow("地址无效");
    }
    expect(fetch).not.toHaveBeenCalled();
  });
});
