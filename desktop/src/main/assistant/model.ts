import { randomUUID } from "node:crypto";
import type { EngineCall } from "../orchestrator/types.js";

export interface ChatMessage { role: "system" | "user" | "assistant"; content: string }
interface ModelConfig { baseUrl: string; model: string; apiKey: string; tokenLimit: number }
interface CompletionDeps {
  engine: EngineCall;
  config: () => ModelConfig;
  fetch?: typeof fetch;
}

async function readResponse(response: Response): Promise<unknown> {
  if (!response.body) throw new Error("模型未返回内容");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > 1_048_576) { await reader.cancel(); throw new Error("模型响应超过大小上限"); }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally { reader.releaseLock(); }
}

/** Chat uses no tool channel; model output cannot invoke the shell, MCP or business APIs. */
export function createAssistantCompletion(deps: CompletionDeps) {
  let tail: Promise<void> = Promise.resolve();
  return (projectId: string, messages: ChatMessage[], signal: AbortSignal): Promise<{ text: string; tokens: number }> => {
    const work = tail.then(async () => {
      signal.throwIfAborted();
      const config = deps.config();
      const url = new URL(config.baseUrl);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("助手模型服务地址无效，请检查模型设置");
      if (!config.model || !config.apiKey) throw new Error("助手需要已配置 Agent 模型名称和 API key（不读取 Codex 登录凭据），请到全局设置补齐");
      const inputBytes = Buffer.byteLength(JSON.stringify(messages), "utf8") + 512;
      if (inputBytes > 64_000) throw new Error("本轮上下文过大，请减少引用对象或新建对话");
      const budget = await deps.engine<{ allowed: boolean; month_used: number; monthly_budget: number | null; per_task_limit: number | null }>(["check-budget", "--project", projectId]);
      if (!budget.allowed) throw new Error("本月模型预算已用完；已有报告和确定性回归仍可使用");
      const limits = [config.tokenLimit, budget.per_task_limit, budget.monthly_budget == null ? null : budget.monthly_budget - budget.month_used]
        .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
      const available = Math.min(32_000, ...limits);
      const outputLimit = Math.min(2048, Math.floor(available - inputBytes));
      if (outputLimit < 256) throw new Error("剩余模型预算不足以处理本轮上下文，请减少引用内容");
      signal.throwIfAborted();
      const reserved = inputBytes + outputLimit;
      const session = await deps.engine<{ id: string }>(["agent-session", "--project", projectId, "--thread", `assistant-chat:${randomUUID()}`, "--purpose", "assistant_chat"]);
      // Reserve before network IO: a crash or missing usage must not silently evade the budget.
      await deps.engine(["add-tokens", "--session", session.id, "--tokens", String(reserved)]);
      let charged = reserved;
      let received = false;
      try {
        signal.throwIfAborted();
        const response = await (deps.fetch ?? fetch)(config.baseUrl.replace(/\/$/, "") + "/chat/completions", {
          method: "POST", redirect: "error",
          headers: { "content-type": "application/json", authorization: `Bearer ${config.apiKey}` },
          signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
          body: JSON.stringify({ model: config.model, messages, stream: false,
            ...(/^(?:o[1-9]|gpt-[5-9])/.test(config.model) ? { max_completion_tokens: outputLimit } : { max_tokens: outputLimit }) }),
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error(`模型服务返回 HTTP ${response.status}；请检查模型配置或稍后重试`);
        }
        const result = await readResponse(response) as {
          choices?: { message?: { content?: unknown; tool_calls?: unknown; function_call?: unknown }; finish_reason?: string }[];
          usage?: { total_tokens?: unknown };
        };
        const usage = result.usage?.total_tokens;
        if (typeof usage === "number" && Number.isSafeInteger(usage) && usage >= 0) { charged = usage; received = true; }
        const choice = result.choices?.[0];
        if (choice?.message?.tool_calls || choice?.message?.function_call) throw new Error("助手只支持文本回复，已拒绝模型返回的工具调用");
        if (choice?.finish_reason !== "stop") throw new Error("模型未完整结束本轮回复；没有执行或保存任何建议，请缩小问题范围重试");
        const content = choice.message?.content;
        if (typeof content !== "string" || !content.trim() || content.length > 32_000) throw new Error("模型返回了无效文本");
        signal.throwIfAborted();
        return { text: content, tokens: charged };
      } catch (error) {
        if (signal.aborted) throw new Error("助手已停止；已发送的模型请求可能产生用量，未确认用量暂按预留上限记账");
        if (error instanceof Error && /^模型|^助手/.test(error.message)) throw error;
        throw new Error("模型请求失败或超过 120 秒；未确认用量暂按预留上限记账，未自动重试");
      } finally {
        if (received && charged !== reserved) {
          try { await deps.engine(["add-tokens", "--session", session.id, "--tokens", String(charged - reserved)]); }
          catch { throw new Error("模型已返回，但用量结算失败；保留预留额度，本轮结果未应用，请先检查本地引擎"); }
        }
      }
    });
    tail = work.then(() => {}, () => {});
    return work;
  };
}
