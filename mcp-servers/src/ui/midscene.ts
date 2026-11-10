import type { Page } from "playwright-core";

/**
 * Midscene.js 视觉操作（仅用于探索与自愈，不进入回归主路径）。
 *
 * - ai_locate：视觉定位元素 → 换算成可录制的 ref，脚本仍是确定性定位器；
 * - ai_assert：视觉判定，结果标记为「AI 判定」进入人工复核队列，不直接算通过；
 * - ai_act：直接执行自然语言操作，无法录制成确定性脚本，只在探索卡住时使用。
 *
 * Midscene 为可选依赖（npm i @midscene/web），模型通过其环境变量配置
 * （如 MIDSCENE_MODEL_NAME、OPENAI_BASE_URL；可接自部署 Qwen3-VL）。开启规划与定位缓存。
 */
export interface VisionAgent {
  aiAct(prompt: string): Promise<unknown>;
  aiAssert(assertion: string): Promise<void>;
  aiLocate(prompt: string): Promise<{ center: [number, number]; rect?: unknown }>;
}

export type VisionAgentFactory = (page: Page) => Promise<VisionAgent>;

export function midsceneFactory(cacheId = "aitest"): VisionAgentFactory {
  return async (page) => {
    const specifier = "@midscene/web/playwright";
    let mod: { PlaywrightAgent: new (page: Page, opts: Record<string, unknown>) => Record<string, any> };
    try {
      mod = await import(specifier);
    } catch {
      throw new Error("未安装 Midscene：在客户端目录执行 npm i @midscene/web，并配置视觉模型环境变量");
    }
    const agent = new mod.PlaywrightAgent(page, { cacheId, generateReport: true });
    return {
      aiAct: (p) => (agent.aiAct ?? agent.aiAction).call(agent, p),
      aiAssert: (a) => agent.aiAssert(a),
      aiLocate: (p) => agent.aiLocate(p),
    };
  };
}
