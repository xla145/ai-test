import type { ModelProvider } from "./codex/config.js";

/**
 * 国内模型与私有化部署（架构文档第 4、13、15 节）。
 *
 * - 模型分级：agent（用例设计、失败归因）用强模型；视觉定位（Midscene）用便宜的视觉模型或自部署 Qwen3-VL。
 * - 都走 OpenAI 兼容接口：Codex 通过 model_providers 配置，Midscene 通过环境变量配置。
 * - API key 存系统钥匙串，只以环境变量注入子进程，不写进配置文件。
 * - 非 GPT 模型效果需实测：提供连通性检查，先确认可用性与合规再启用。
 */
export interface ModelPreset {
  id: string;
  name: string;
  baseUrl: string;
  /** 默认文本 / agent 模型 */
  model: string;
  /** 默认视觉模型（空表示该服务不提供） */
  visionModel?: string;
  /** Midscene 的视觉模型族 */
  visionFamily?: "qwen-vl" | "doubao-vision" | "openai";
  note: string;
}

export const PRESETS: ModelPreset[] = [
  { id: "openai", name: "OpenAI（默认）", baseUrl: "https://api.openai.com/v1", model: "", visionModel: "", visionFamily: "openai",
    note: "Codex 默认配置；国内使用需先确认可用性与合规" },
  { id: "dashscope", name: "阿里云百炼（通义千问）", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "qwen-max", visionModel: "qwen-vl-max", visionFamily: "qwen-vl", note: "OpenAI 兼容模式" },
  { id: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat",
    note: "无视觉模型，视觉定位需另配" },
  { id: "ark", name: "火山方舟（豆包）", baseUrl: "https://ark.cn-beijing.volces.com/api/v3", model: "",
    visionModel: "", visionFamily: "doubao-vision", note: "模型名填方舟上的推理接入点 ID" },
  { id: "private", name: "私有化部署（OpenAI 兼容）", baseUrl: "", model: "", visionModel: "", visionFamily: "qwen-vl",
    note: "如 vLLM / SGLang 部署的 Qwen3、Qwen3-VL；地址与模型名按部署填写" },
];

export const VISION_FAMILIES = ["qwen2.5-vl", "qwen3-vl", "qwen3", "doubao-vision", "doubao-seed", "gpt-5", "gpt-6", "gemini", "glm-v", "kimi"] as const;

export interface ModelSlot {
  visionFamily?: string;
  preset: string;
  baseUrl?: string;
  model?: string;
}

export interface ModelSettings {
  agent: ModelSlot;
  vision?: ModelSlot;
}

export const DEFAULT_MODEL_SETTINGS: ModelSettings = { agent: { preset: "openai" } };

export function presetOf(id: string): ModelPreset {
  const p = PRESETS.find((x) => x.id === id);
  if (!p) throw new Error(`未知的模型服务：${id}`);
  return p;
}

export function resolveSlot(slot: ModelSlot, kind: "agent" | "vision"): { baseUrl: string; model: string; preset: ModelPreset } {
  const preset = presetOf(slot.preset);
  const baseUrl = (slot.baseUrl || preset.baseUrl).replace(/\/$/, "");
  const model = slot.model || (kind === "agent" ? preset.model : preset.visionModel ?? "");
  return { baseUrl, model, preset };
}

/** 存放 API key 的环境变量名（Codex 的 env_key）；值来自钥匙串 */
export const AGENT_KEY_ENV = "AITEST_AGENT_API_KEY";

export function validateSettings(s: ModelSettings): string[] {
  const errors: string[] = [];
  for (const [kind, slot] of [["agent", s.agent], ["vision", s.vision]] as const) {
    if (!slot) continue;
    const { baseUrl, model, preset } = resolveSlot(slot, kind);
    if (!baseUrl) errors.push(`${kind === "agent" ? "agent" : "视觉"}模型缺少服务地址`);
    else if (!/^https?:\/\//.test(baseUrl)) errors.push(`服务地址应以 http(s):// 开头：${baseUrl}`);
    if (!model && !(kind === "agent" && preset.id === "openai")) errors.push(`${kind === "agent" ? "agent" : "视觉"}模型缺少模型名`);
  }
  return errors;
}

/** Codex 配置：OpenAI 默认不需要自定义 provider */
export function codexProvider(s: ModelSettings): { provider?: ModelProvider; model?: string } {
  const { baseUrl, model, preset } = resolveSlot(s.agent, "agent");
  if (preset.id === "openai" && !s.agent.baseUrl) return { model: model || undefined };
  return { provider: { id: `aitest_${preset.id}`, name: preset.name, baseUrl, envKey: AGENT_KEY_ENV, model } };
}

/** 模型名可推断常见模型族；方舟接入点等不透明名称可手动指定。 */
export function visionFamilyOf(slot: ModelSlot): string {
  if (slot.visionFamily) return slot.visionFamily;
  const { model, preset } = resolveSlot(slot, "vision");
  const name = model.toLowerCase();
  if (/qwen3[.-][56]/.test(name)) return "qwen3";
  if (/qwen3.*vl/.test(name)) return "qwen3-vl";
  if (/qwen/.test(name)) return "qwen2.5-vl";
  if (/doubao.*seed/.test(name)) return "doubao-seed";
  if (/gpt-6/.test(name)) return "gpt-6";
  if (/gpt-5/.test(name)) return "gpt-5";
  if (/gemini/.test(name)) return "gemini";
  if (/glm/.test(name)) return "glm-v";
  if (/kimi/.test(name)) return "kimi";
  return preset.visionFamily === "doubao-vision" ? "doubao-vision"
    : preset.visionFamily === "openai" ? "gpt-5" : "qwen3-vl";
}

export function midsceneEnv(s: ModelSettings, apiKey: string): Record<string, string> {
  if (!s.vision) return {};
  const { baseUrl, model } = resolveSlot(s.vision, "vision");
  return {
    AITEST_MIDSCENE: "1",
    MIDSCENE_MODEL_NAME: model,
    MIDSCENE_MODEL_BASE_URL: baseUrl,
    MIDSCENE_MODEL_API_KEY: apiKey,
    MIDSCENE_MODEL_FAMILY: visionFamilyOf(s.vision),
    MIDSCENE_REPORT_QUIET: "1",
  };
}

export interface ModelCheck {
  ok: boolean;
  status?: number;
  latencyMs: number;
  modelListed?: boolean;
  models?: string[];
  detail: string;
}

/** 连通性检查：先查 /models，不支持时用 1 token 的对话请求探活 */
export async function checkModel(slot: ModelSlot, kind: "agent" | "vision", apiKey: string,
  fetchImpl: typeof fetch = fetch, timeoutMs = 15_000): Promise<ModelCheck> {
  const { baseUrl, model } = resolveSlot(slot, kind);
  const started = Date.now();
  const headers = { authorization: `Bearer ${apiKey}`, "content-type": "application/json" };
  const call = (path: string, init: RequestInit = {}) =>
    fetchImpl(baseUrl + path, { ...init, headers, signal: AbortSignal.timeout(timeoutMs) });
  try {
    let res = await call("/models");
    if (res.ok) {
      const body = (await res.json().catch(() => ({}))) as { data?: { id: string }[] };
      const ids = (body.data ?? []).map((m) => m.id);
      const listed = model ? ids.includes(model) : undefined;
      return {
        ok: true, status: res.status, latencyMs: Date.now() - started, modelListed: listed, models: ids.slice(0, 20),
        detail: listed === false ? `服务可用，但模型列表中没有 ${model}（部分服务不列出全部模型）` : "服务可用",
      };
    }
    if (res.status === 401 || res.status === 403) {
      return { ok: false, status: res.status, latencyMs: Date.now() - started, detail: "鉴权失败：请检查 API key" };
    }
    res = await call("/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: "user", content: "ping" }] }),
    });
    return {
      ok: res.ok, status: res.status, latencyMs: Date.now() - started,
      detail: res.ok ? "服务可用（对话接口探活）" : `对话接口返回 ${res.status}：${(await res.text()).slice(0, 200)}`,
    };
  } catch (e) {
    return { ok: false, latencyMs: Date.now() - started, detail: `无法连接 ${baseUrl}：${(e as Error).message}` };
  }
}
