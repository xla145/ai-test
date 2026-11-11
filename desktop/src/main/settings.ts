import { randomUUID } from "node:crypto";
import { presetOf, PRESETS, type ModelSettings, type ModelSlot } from "./models.js";
import type { GlobalSettings, ModelEntry } from "../shared/ipc.js";

export type { GeneralSettings, GlobalSettings, ModelEntry } from "../shared/ipc.js";

/**
 * 全局配置（不随项目）：存 userData/settings.json。
 * - 模型：可添加多个，分别指定哪个用于 agent、哪个用于视觉定位；API key 按模型存钥匙串（aitest:model:<id>）。
 * - 运行环境：Python / Codex 路径、agent 单次任务 token 上限；环境变量（AITEST_PYTHON 等）优先于这里的配置。
 * - 外观：主题。
 */
export const DEFAULT_TASK_TOKEN_LIMIT = 200_000;

export const DEFAULT_SETTINGS: GlobalSettings = {
  version: 2,
  models: [{ id: "agent", name: "OpenAI（默认）", preset: "openai" }],
  agentModelId: "agent",
  general: { theme: "system" },
};

/** 钥匙串中模型 API key 的引用。旧版的 agent / vision 两槽迁移后 id 不变，原有 key 继续可用 */
export const modelKeyRef = (id: string) => `aitest:model:${id}`;

export const newModelId = () => `m_${randomUUID().slice(0, 8)}`;

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** 读取 settings.json 的内容，兼容旧格式 { models: { agent, vision } } */
export function migrate(raw: unknown): GlobalSettings {
  const r = (raw ?? {}) as Record<string, any>;
  if (Array.isArray(r.models)) {
    const s: GlobalSettings = {
      ...clone(DEFAULT_SETTINGS),
      ...r,
      version: 2,
      general: { ...DEFAULT_SETTINGS.general, ...(r.general ?? {}) },
    };
    if (!s.models.length) s.models = clone(DEFAULT_SETTINGS.models);
    if (!s.models.some((m) => m.id === s.agentModelId)) s.agentModelId = s.models[0].id;
    if (s.visionModelId && !s.models.some((m) => m.id === s.visionModelId)) delete s.visionModelId;
    return s;
  }
  const old = (r.models ?? {}) as Partial<ModelSettings>;
  if (!old.agent) return clone(DEFAULT_SETTINGS);
  const entry = (id: string, slot: ModelSlot, suffix: string): ModelEntry => ({
    id, name: `${presetOf(slot.preset).name.replace(/（.*）$/, "")}${suffix}`, ...slot,
  });
  const models = [entry("agent", old.agent, "")];
  if (old.vision) models.push(entry("vision", old.vision, "（视觉）"));
  return {
    version: 2, models, agentModelId: "agent", ...(old.vision ? { visionModelId: "vision" } : {}),
    general: { ...DEFAULT_SETTINGS.general },
  };
}

const slotOf = ({ preset, baseUrl, model }: ModelEntry): ModelSlot => ({
  preset, ...(baseUrl ? { baseUrl } : {}), ...(model ? { model } : {}),
});

/** 当前生效的 agent / 视觉模型，交给 Codex 与 Midscene 配置 */
export function activeModels(s: GlobalSettings): ModelSettings {
  const find = (id?: string) => s.models.find((m) => m.id === id);
  const agent = find(s.agentModelId) ?? s.models[0];
  const vision = find(s.visionModelId);
  return { agent: slotOf(agent), ...(vision ? { vision: slotOf(vision) } : {}) };
}

/** 模型条目在哪个用途上测试连通：被选为视觉模型时按视觉模型解析默认模型名 */
export const usageOf = (s: GlobalSettings, id: string): "agent" | "vision" =>
  s.visionModelId === id && s.agentModelId !== id ? "vision" : "agent";

export function validateGlobal(s: GlobalSettings): string[] {
  const errors: string[] = [];
  const names = new Set<string>();
  const ids = new Set<string>();
  if (!s.models.length) errors.push("至少需要一个模型");
  for (const m of s.models) {
    const label = m.name?.trim() || m.id;
    if (!m.name?.trim()) errors.push("模型名称不能为空");
    else if (names.has(m.name.trim())) errors.push(`模型名称重复：${m.name}`);
    names.add(m.name?.trim());
    if (ids.has(m.id)) errors.push(`模型 id 重复：${m.id}`);
    ids.add(m.id);
    const preset = PRESETS.find((p) => p.id === m.preset);
    if (!preset) {
      errors.push(`${label}：未知的模型服务 ${m.preset}`);
      continue;
    }
    const baseUrl = m.baseUrl || preset.baseUrl;
    if (!baseUrl) errors.push(`${label}：缺少服务地址`);
    else if (!/^https?:\/\//.test(baseUrl)) errors.push(`${label}：服务地址应以 http(s):// 开头`);
    const kind = usageOf(s, m.id);
    // 不支持视觉却被选为视觉模型：由下面的检查给出原因，这里不重复报缺少模型名
    if (kind === "vision" && !preset.visionFamily) continue;
    const model = m.model || (kind === "agent" ? preset.model : preset.visionModel);
    if (!model && !(preset.id === "openai" && kind === "agent")) errors.push(`${label}：缺少模型名`);
  }
  if (!ids.has(s.agentModelId)) errors.push("请选择 agent 使用的模型");
  if (s.visionModelId) {
    const v = s.models.find((m) => m.id === s.visionModelId);
    if (!v) errors.push("视觉模型不存在");
    else if (!PRESETS.find((p) => p.id === v.preset)?.visionFamily) errors.push(`${v.name}：该服务不提供视觉模型，不能用于视觉定位`);
  }
  const g = s.general;
  if (!["system", "light", "dark"].includes(g.theme)) errors.push("主题无效");
  for (const [k, label] of [["maestroPath", "Maestro"], ["pinkyPath", "Pinky"]] as const) {
    if (g[k] != null && typeof g[k] !== "string") errors.push(`${label} 路径无效`);
  }
  if (g.taskTokenLimit != null && (!Number.isInteger(g.taskTokenLimit) || g.taskTokenLimit <= 0)) {
    errors.push("单次任务 token 上限应为正整数");
  }
  return errors;
}
