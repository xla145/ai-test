import { chromium, type Browser } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BrowserSession } from "../src/ui/browser.js";
import { startDemoApp, type DemoApp } from "./fixtures/app.js";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runUiSuite } from "../src/ui/runner.js";
import { generateSpec } from "../src/ui/codegen.js";
import { chooseBrowser } from "../src/ui/chromium.js";

/** 模拟桌面端：浏览器已在运行（Electron 开了 remote-debugging-port），角色视图由“桌面端”创建 */
const PORT = 9400 + Math.floor(Math.random() * 400);
let host: Browser;
let app: DemoApp;

beforeAll(async () => {
  app = await startDemoApp();
  host = await chromium.launch({ executablePath: chooseBrowser().executablePath, args: [`--remote-debugging-port=${PORT}`] });
});

afterAll(async () => {
  await host?.close();
  await app?.close();
});

describe("CDP mode (embedded browser)", () => {
  it("logs in and switches isolated embedded role pages, with credentials excluded from live progress", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aitest-embedded-roles-"));
    const contexts = [];
    const viewMarkers: Record<string, string> = {};
    for (const role of ["default", "admin", "viewer"]) {
      const context = await host.newContext(); contexts.push(context);
      const page = await context.newPage();
      viewMarkers[role] = `aitest-view=${role}-${Date.now()}`;
      await page.goto(`data:text/html,#${viewMarkers[role]}`);
    }
    mkdirSync(join(dir, "scripts/ui"), { recursive: true });
    writeFileSync(join(dir, "scripts/ui/tc_roles.spec.ts"), generateSpec({ caseId: "tc_roles", title: "权限校验", steps: [
      { action: "goto", role: "admin", url: "/dashboard" },
      { action: "expectVisible", role: "admin", target: { kind: "testid", value: "menu-tags" } },
      { action: "goto", role: "viewer", url: "/dashboard" },
      { action: "expectHidden", role: "viewer", target: { kind: "testid", value: "menu-tags" } },
    ] }));
    const progress: { title: string; role?: string }[] = [];
    try {
      const out = await runUiSuite({ workspace: dir, baseUrl: app.url, caseIds: ["tc_roles"],
        cdpEndpoint: `http://127.0.0.1:${PORT}`, viewMarkers, onProgress: e => progress.push(e), env: {
          AITEST_ROLES: JSON.stringify([{ role: "admin", username: "alice", password: "pw-admin" }, { role: "viewer", username: "bob", password: "pw-viewer" }]),
          AITEST_LOGIN: JSON.stringify({ url: "/login", username: "#username", password: "#password", submit: "#login", success: "/dashboard" }),
        } });
      expect(out.results, out.stderr).toMatchObject([{ case_id: "tc_roles", status: "passed" }]);
      expect(progress.map(p => p.role).filter(Boolean)).toEqual(expect.arrayContaining(["admin", "viewer"]));
      expect(JSON.stringify(progress)).not.toContain("pw-admin");
      expect(JSON.stringify(progress)).not.toContain("pw-viewer");
    } finally { for (const context of contexts) await context.close(); rmSync(dir, { recursive: true, force: true }); }
  }, 60_000);

  it("replays an existing Playwright script in the prepared page without changing its source or closing the host", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aitest-embedded-run-"));
    const ctx = await host.newContext();
    const page = await ctx.newPage();
    const marker = `aitest-view=replay-${Date.now()}`;
    await page.goto(`${app.url}/login`);
    await page.evaluate((marker) => { (window as any).__aitestViewMarker = marker; }, marker);
    const source = 'import { test, expect } from "@playwright/test";\ntest("tc_replay embedded", async ({ page }) => { await page.goto("/login"); await expect(page.locator("#username")).toBeVisible(); });';
    mkdirSync(join(dir, "scripts/ui"), { recursive: true });
    const path = join(dir, "scripts/ui/tc_replay.spec.ts");
    writeFileSync(path, source);
    const progress: string[] = [];
    try {
      const out = await runUiSuite({ workspace: dir, baseUrl: app.url, caseIds: ["tc_replay"],
        cdpEndpoint: `http://127.0.0.1:${PORT}`, viewMarkers: { default: marker }, onProgress: e => progress.push(e.title) });
      expect(out.errors, out.stderr).toEqual([]);
      expect(out.results, out.stderr).toMatchObject([{ case_id: "tc_replay", status: "passed" }]);
      expect(page.url()).toContain("/login");
      expect(host.isConnected()).toBe(true);
      expect(readFileSync(path, "utf8")).toBe(source);
      expect(readdirSync(join(dir, "scripts/ui")).some(f => f.startsWith(".aitest-"))).toBe(false);
      expect(progress).toEqual(expect.arrayContaining([expect.stringMatching(/navigate|goto/i)]));
    } finally { await ctx.close(); rmSync(dir, { recursive: true, force: true }); }
  }, 60_000);

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

  it("attaches for debugging without navigating or replacing an existing role's login state", async () => {
    const context = await host.newContext();
    const page = await context.newPage();
    const marker = `aitest-view=preserve-${Date.now()}`;
    await page.goto(`${app.url}/login`);
    await page.locator("#username").fill("alice");
    await page.locator("#password").fill("pw-admin");
    await page.locator("#login").click();
    await page.waitForURL("**/dashboard");
    await page.evaluate((marker) => {
      (window as any).__aitestViewMarker = marker;
      localStorage.setItem("debug-token", "local-token");
      sessionStorage.setItem("debug-token", "session-token");
      (window as any).__debugInMemoryToken = "memory-token";
    }, marker);
    const cookies = await context.cookies();
    const session = new BrowserSession({
      cdpEndpoint: `http://127.0.0.1:${PORT}`, baseUrl: app.url,
      reuseExistingSession: true, openView: async () => marker,
    });
    try {
      // 无效凭据确保复用登录态的路径不会偷偷执行一次登录。
      const result = await session.newRoleContext("admin", {
        login: { url: "/login", username: "#username", password: "#password", submit: "#login", success: "/dashboard" },
        credentials: { username: "invalid", password: "invalid" },
      });
      expect(result).toMatchObject({ reusedState: true, loggedIn: false });
      expect(page.url()).toBe(`${app.url}/dashboard`);
      expect(await page.evaluate(() => [localStorage.getItem("debug-token"), sessionStorage.getItem("debug-token"), (window as any).__debugInMemoryToken]))
        .toEqual(["local-token", "session-token", "memory-token"]);
      expect(await context.cookies()).toEqual(cookies);
      await session.runStep({ action: "goto", url: "/tags", role: "admin" });
      expect(await page.evaluate(() => [localStorage.getItem("debug-token"), sessionStorage.getItem("debug-token")]))
        .toEqual(["local-token", "session-token"]);
      await session.runStep({ action: "expectVisible", role: "admin", target: { kind: "testid", value: "disable-TAG-1001" } });
    } finally {
      await session.close();
      await context.close();
    }
  }, 30_000);

  it("still logs in when debugging starts on the login page", async () => {
    const context = await host.newContext();
    const page = await context.newPage();
    const marker = `aitest-view=login-${Date.now()}`;
    await page.goto(`${app.url}/login`);
    await page.evaluate((marker) => { (window as any).__aitestViewMarker = marker; }, marker);
    const session = new BrowserSession({ cdpEndpoint: `http://127.0.0.1:${PORT}`, baseUrl: app.url,
      reuseExistingSession: true, openView: async () => marker });
    try {
      expect(await session.newRoleContext("admin", {
        login: { url: "/login", username: "#username", password: "#password", submit: "#login", success: "/dashboard" },
        credentials: { username: "alice", password: "pw-admin" },
      })).toMatchObject({ reusedState: false, loggedIn: true });
      expect(page.url()).toBe(`${app.url}/dashboard`);
    } finally { await session.close(); await context.close(); }
  }, 30_000);

  it("replays recorded steps in role views for step-by-step debugging without recording them", async () => {
    const openView = async (role: string) => {
      const ctx = await host.newContext();
      const page = await ctx.newPage();
      const marker = `aitest-view=debug-${role}-${Date.now()}`;
      await page.goto(`data:text/html,#${marker}`);
      return marker;
    };
    const session = new BrowserSession({ cdpEndpoint: `http://127.0.0.1:${PORT}`, openView, baseUrl: app.url });
    try {
      await session.newRoleContext("admin", {
        login: { url: "/login", username: "#username", password: "#password", submit: "#login", success: "/dashboard" },
        credentials: { username: "alice", password: "pw-admin" },
      });
      const steps = [
        { action: "goto", role: "admin", url: "/tags" },
        { action: "click", role: "admin", target: { kind: "testid", value: "disable-TAG-1001" } },
        { action: "expectText", role: "admin", target: { kind: "testid", value: "status-TAG-1001" }, text: "已停用" },
      ] as const;
      for (const st of steps) await session.runStep(st, { timeoutMs: 3000 });
      await expect(session.runStep({ action: "click", role: "admin", target: { kind: "testid", value: "no-such" } }, { timeoutMs: 500 }))
        .rejects.toThrow(/Timeout/);
      await expect(session.runStep({ action: "expectText", role: "admin", target: { kind: "testid", value: "status-TAG-1001" }, text: "启用中" }, { timeoutMs: 500 }))
        .rejects.toThrow("不包含「启用中」");
      await session.runStep({ action: "expectValue", role: "admin", target: { kind: "label", value: "搜索标签" }, value: "" }, { timeoutMs: 500 });
      await session.runStep({ action: "expectNoText", role: "admin", target: { kind: "testid", value: "status-TAG-1001" }, text: "启用中" }, { timeoutMs: 500 });
      await expect(session.runStep({ action: "expectValue", role: "admin", target: { kind: "label", value: "搜索标签" }, value: "x" }, { timeoutMs: 300 }))
        .rejects.toThrow("当前值为「」");
      expect(session.recording()).toEqual([]);
    } finally {
      await session.close();
    }
    expect(host.isConnected()).toBe(true);
  }, 60_000);
});
