import { EventEmitter } from "node:events";
import type { Page } from "playwright-core";
import { describe, expect, it, vi } from "vitest";
import { cssCenter, midsceneFactory } from "../src/ui/midscene.js";

const sdk = vi.hoisted(() => ({ options: [] as unknown[], pages: [] as unknown[], agents: [] as any[], destroy: vi.fn(async () => undefined) }));
vi.mock("@midscene/web/playwright", () => ({
  PlaywrightAgent: class {
    reportFile = "/tmp/report.html";
    constructor(page: unknown, options: unknown) { sdk.pages.push(page); sdk.options.push(options); sdk.agents.push(this); }
    aiAct = vi.fn(async () => "done");
    aiAssert = vi.fn(async (text: string) => { if (text === "fail") throw new Error("assertion failed"); });
    aiLocate = vi.fn(async () => ({ center: [240, 160], dpr: 2, rect: {} }));
    destroy = sdk.destroy;
  },
}));

describe("Midscene adapter", () => {
  it("keeps Midscene's CSS-pixel center as is and rejects invalid model coordinates", () => {
    // Midscene 1.17 的 center 已是逻辑坐标；之前再除以 dpr，高分屏上总是点到左上角
    expect(cssCenter([240, 160])).toEqual([240, 160]);
    expect(() => cssCenter([NaN, 1])).toThrow("无效");
    expect(() => cssCenter([1] as unknown as [number, number])).toThrow("无效");
  });

  it("gives Midscene screenshots of what the page actually renders (CDP), not Playwright's zoom-blind capture", async () => {
    const send = vi.fn(async () => ({ data: Buffer.from("jpg").toString("base64") }));
    const detach = vi.fn(async () => undefined);
    const page = Object.assign(new EventEmitter(), {
      context: () => ({ newCDPSession: async () => ({ send, detach }) }),
      screenshot: vi.fn(),
      url: () => "http://sut/",
    }) as unknown as Page;
    sdk.pages.length = 0;
    await midsceneFactory("shot")(page);
    const wrapped = sdk.pages[0] as Page;
    expect((await wrapped.screenshot({ type: "jpeg", quality: 90 })).toString()).toBe("jpg");
    expect(send).toHaveBeenCalledWith("Page.captureScreenshot", { format: "jpeg", quality: 90 });
    expect(detach).toHaveBeenCalled();
    expect((page as unknown as { screenshot: ReturnType<typeof vi.fn> }).screenshot).not.toHaveBeenCalled();
    expect(wrapped.url()).toBe("http://sut/");
    sdk.options.length = 0;
  });

  it("reuses one SDK agent per page, preserves assertion errors and cleans up on close", async () => {
    const page = new EventEmitter() as unknown as Page;
    sdk.agents.length = 0;
    const factory = midsceneFactory("test-project");
    const [a, b] = await Promise.all([factory(page), factory(page)]);
    expect(a).toBe(b);
    expect(sdk.options).toEqual([{ cache: { id: "test-project", strategy: "read-write" },
      generateReport: true, outputFormat: "single-html", autoPrintReportMsg: false }]);
    expect((await a.aiLocate("save")).center).toEqual([240, 160]);
    // 定位不读写 Midscene 缓存：错的定位结果不会被原样复用
    expect(sdk.agents[0].aiLocate).toHaveBeenCalledWith("save", { cacheable: false });
    await expect(a.aiAssert("fail")).rejects.toThrow("assertion failed");
    await expect(a.aiAct("open")).resolves.toBe("done");
    expect(a.reportFile).toBe("/tmp/report.html");
    (page as unknown as EventEmitter).emit("close");
    expect(sdk.destroy).toHaveBeenCalledOnce();
  });
});
