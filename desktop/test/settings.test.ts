import { describe, expect, it } from "vitest";
import { codexProvider, midsceneEnv } from "../src/main/models.js";
import { activeModels, DEFAULT_SETTINGS, migrate, modelKeyRef, usageOf, validateGlobal, type GlobalSettings } from "../src/main/settings.js";

const base = (): GlobalSettings => ({
  version: 2,
  models: [
    { id: "a", name: "百炼", preset: "dashscope", model: "qwen-max" },
    { id: "v", name: "私有 VL", preset: "private", baseUrl: "http://gpu:8000/v1", model: "Qwen3-VL-8B" },
    { id: "d", name: "DeepSeek", preset: "deepseek" },
  ],
  agentModelId: "a",
  visionModelId: "v",
  general: { theme: "system" },
});

describe("global settings", () => {
  it("migrates the old two-slot format and keeps the keychain refs", () => {
    const s = migrate({ models: { agent: { preset: "deepseek" }, vision: { preset: "private", baseUrl: "http://gpu/v1", model: "VL" } } });
    expect(s.models.map((m) => [m.id, m.name])).toEqual([["agent", "DeepSeek"], ["vision", "私有化部署（视觉）"]]);
    expect(s.agentModelId).toBe("agent");
    expect(s.visionModelId).toBe("vision");
    // 旧版 key 存在 aitest:model:agent / aitest:model:vision，迁移后继续可用
    expect(modelKeyRef("agent")).toBe("aitest:model:agent");
    expect(modelKeyRef("vision")).toBe("aitest:model:vision");
    expect(migrate({})).toEqual(DEFAULT_SETTINGS);
    expect(migrate(undefined).general.theme).toBe("system");
  });

  it("repairs dangling selections when reading", () => {
    const s = migrate({ ...base(), agentModelId: "gone", visionModelId: "gone", general: { theme: "dark" } });
    expect(s.agentModelId).toBe("a");
    expect(s.visionModelId).toBeUndefined();
    expect(s.general.theme).toBe("dark");
  });

  it("feeds only the selected models to Codex and Midscene", () => {
    const s = base();
    expect(activeModels(s)).toEqual({
      agent: { preset: "dashscope", model: "qwen-max" },
      vision: { preset: "private", baseUrl: "http://gpu:8000/v1", model: "Qwen3-VL-8B" },
    });
    expect(codexProvider(activeModels(s)).provider?.model).toBe("qwen-max");
    expect(midsceneEnv(activeModels({ ...s, visionModelId: undefined }), "k")).toEqual({});
    expect(usageOf(s, "v")).toBe("vision");
    expect(usageOf(s, "a")).toBe("agent");
  });

  it("validates models and general settings", () => {
    expect(validateGlobal(base())).toEqual([]);
    const s = base();
    s.models.push({ id: "x", name: "百炼", preset: "private" });
    expect(validateGlobal(s)).toEqual(expect.arrayContaining(["模型名称重复：百炼", "百炼：缺少服务地址", "百炼：缺少模型名"]));
    // DeepSeek 没有视觉模型
    expect(validateGlobal({ ...base(), visionModelId: "d" })).toEqual(["DeepSeek：该服务不提供视觉模型，不能用于视觉定位"]);
    expect(validateGlobal({ ...base(), agentModelId: "nope" })).toContain("请选择 agent 使用的模型");
    expect(validateGlobal({ ...base(), general: { theme: "system", taskTokenLimit: -1 } })).toEqual(["单次任务 token 上限应为正整数"]);
    expect(validateGlobal({ ...base(), models: [{ id: "p", name: "p", preset: "private", baseUrl: "gpu:8000", model: "m" }], agentModelId: "p", visionModelId: undefined }))
      .toEqual(["p：服务地址应以 http(s):// 开头"]);
  });
});
