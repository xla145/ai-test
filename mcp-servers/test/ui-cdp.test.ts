import { chromium, type Browser } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BrowserSession } from "../src/ui/browser.js";
import { startDemoApp, type DemoApp } from "./fixtures/app.js";

/** 模拟桌面端：浏览器已在运行（Electron 开了 remote-debugging-port），角色视图由“桌面端”创建 */
const PORT = 9400 + Math.floor(Math.random() * 400);
let host: Browser;
let app: DemoApp;

beforeAll(async () => {
  app = await startDemoApp();
  host = await chromium.launch({ args: [`--remote-debugging-port=${PORT}`] });
});

afterAll(async () => {
  await host?.close();
  await app?.close();
});

describe("CDP mode (embedded browser)", () => {
  it("finds the role view by its URL marker and drives it", async () => {
    const opened: string[] = [];
    const openView = async (role: string) => {
      opened.push(role);
      const ctx = await host.newContext(); // 对应 Electron 的独立 session partition
      const page = await ctx.newPage();
      const marker = `aitest-view=${role}-${Date.now()}`;
      await page.goto(`data:text/html,<title>${role}</title>#${marker}`);
      return marker;
    };
    const session = new BrowserSession({ cdpEndpoint: `http://127.0.0.1:${PORT}`, openView, baseUrl: app.url });
    try {
      await session.newRoleContext("admin", {
        login: { url: "/login", username: "#username", password: "#password", submit: "#login", success: "/dashboard" },
        credentials: { username: "alice", password: "pw-admin" },
      });
      const snap = await session.snapshot();
      expect(snap.url).toContain("/dashboard");
      const menu = snap.elements.find((e) => e.testId === "menu-tags")!;
      await session.click(menu.ref);
      await session.expectUrl("/tags");
      expect(opened).toEqual(["admin"]);
      expect(session.recording().map((s) => s.action)).toEqual(["click", "expectUrl"]);
    } finally {
      await session.close();
    }
    // 断开连接不关闭宿主浏览器
    expect(host.isConnected()).toBe(true);
  }, 60_000);
});
