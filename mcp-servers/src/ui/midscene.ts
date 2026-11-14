import type { Page } from "playwright-core";

/** 视觉能力只参与探索与人工复核，生成的回归脚本仍使用确定性定位器。 */
export interface VisionAgent {
  aiAct(prompt: string): Promise<unknown>;
  aiAssert(assertion: string): Promise<void>;
  aiLocate(prompt: string): Promise<{ center: [number, number]; rect?: unknown }>;
  readonly reportFile?: string | null;
}
export type VisionAgentFactory = (page: Page) => Promise<VisionAgent>;

/**
 * Midscene（1.17）的 aiLocate 返回的 center 已是页面逻辑坐标（CSS 像素）：
 * 它先按「截图宽 / innerWidth」把截图缩到逻辑尺寸再让模型定位，返回的 dpr 只是说明性字段。
 * 这里只做校验，不能再除以 dpr（否则高分屏上坐标减半，总是点到左上角）。
 */
export function cssCenter(center: [number, number]): [number, number] {
  if (!Array.isArray(center) || center.length !== 2 || !center.every(Number.isFinite)) {
    throw new Error("Midscene 返回了无效的视觉坐标");
  }
  return [center[0], center[1]];
}

/**
 * 交给 Midscene 的页面：截图改为 CDP 直接截取页面实际显示的画面。
 * 内嵌浏览器按桌面宽度渲染后整体缩小显示，Playwright 的 page.screenshot 不考虑这层缩放，
 * 画面与 innerWidth 对不上，模型给出的坐标会整体偏移。实际画面 + innerWidth 由 Midscene 自己换算，缩放下也准确。
 */
export function viewportScreenshotPage(page: Page): Page {
  const screenshot = async (opts: { type?: "png" | "jpeg"; quality?: number } = {}) => {
    const cdp = await page.context().newCDPSession(page);
    try {
      const format = opts.type === "png" ? "png" : "jpeg";
      const { data } = await cdp.send("Page.captureScreenshot", { format, ...(format === "jpeg" && opts.quality ? { quality: opts.quality } : {}) });
      return Buffer.from(data, "base64");
    } finally {
      await cdp.detach().catch(() => undefined);
    }
  };
  return new Proxy(page, {
    get(target, prop) {
      if (prop === "screenshot") return screenshot;
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export function midsceneFactory(cacheId = "aitest"): VisionAgentFactory {
  const agents = new WeakMap<Page, Promise<VisionAgent>>();
  return (page) => {
    const existing = agents.get(page);
    if (existing) return existing;
    const pending = (async (): Promise<VisionAgent> => {
      const { PlaywrightAgent } = await import("@midscene/web/playwright");
      const agent = new PlaywrightAgent(viewportScreenshotPage(page), {
        cache: { id: cacheId, strategy: "read-write" },
        generateReport: true,
        outputFormat: "single-html",
        autoPrintReportMsg: false,
      });
      page.once("close", () => {
        agents.delete(page);
        void agent.destroy().catch(() => undefined);
      });
      return {
        aiAct: (prompt) => agent.aiAct(prompt),
        aiAssert: async (assertion) => { await agent.aiAssert(assertion); },
        aiLocate: async (prompt) => {
          // 不用 Midscene 缓存：探索时 prompt 几乎不重复，从未命中；而定位错的结果写进缓存后会被原样复用
          const result = await agent.aiLocate(prompt, { cacheable: false });
          return { ...result, center: cssCenter(result.center) };
        },
        get reportFile() { return agent.reportFile; },
      };
    })();
    agents.set(page, pending);
    void pending.catch(() => agents.delete(page));
    return pending;
  };
}
