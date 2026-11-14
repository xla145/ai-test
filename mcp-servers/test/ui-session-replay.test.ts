import { chromium, type Browser } from "playwright-core";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserSession } from "../src/ui/browser.js";
import { chooseBrowser } from "../src/ui/chromium.js";
import { generateSpec } from "../src/ui/codegen.js";
import { UI_SERVERS } from "../src/ui/tools.js";
import { startDemoApp, type DemoApp } from "./fixtures/app.js";

let host: Browser;
let app: DemoApp;
const port = 9900 + Math.floor(Math.random() * 200);
beforeAll(async () => {
  app = await startDemoApp();
  host = await chromium.launch({ executablePath: chooseBrowser().executablePath, args: [`--remote-debugging-port=${port}`] });
});
afterAll(async () => { await host?.close(); await app?.close(); });

it.each(["default", "admin"])("MCP trial preserves the manually logged-in %s page without storageState or valid credentials", async role => {
  const workspace = mkdtempSync(join(tmpdir(), "aitest-session-replay-"));
  const context = await host.newContext();
  const page = await context.newPage();
  const spareContext = await host.newContext();
  const sparePage = await spareContext.newPage();
  const session = new BrowserSession();
  try {
    await page.goto(`${app.url}/login`);
    await page.locator("#username").fill("alice");
    await page.locator("#password").fill("pw-admin");
    await page.locator("#login").click();
    await page.waitForURL("**/dashboard");
    await page.evaluate(() => { sessionStorage.setItem("session-only", "preserved"); });
    const openView = vi.fn(async (_project: string, requested: string, env: string) => {
      expect(env).toBe("test");
      const marker = `session-${requested}`;
      await (requested === role ? page : sparePage).evaluate(m => { (window as any).__aitestViewMarker = m; }, marker);
      return marker;
    });
    const tools = UI_SERVERS.find(s => s.name === "browser")!.tools({
      session, cdpEndpoint: `http://127.0.0.1:${port}`,
      engine: (async (args: string[]) => {
        if (args[0] === "get-project") return { id: "p", name: "demo", workspace_path: workspace, environments: { test: {
          base_url: app.url, login: { url: "/login", username: "#username", password: "#password", submit: "#login", success: "/dashboard" },
        } } };
        if (args[0] === "list-roles") return [{ role_name: "admin" }];
        return {};
      }) as any,
      secrets: { openView, resolve: async () => ({ AITEST_ROLES: JSON.stringify([{ role: "admin", username: "wrong", password: "wrong" }]) }) },
    });
    await tools.find(t => t.name === "open_project")!.handler({ project_id: "p", env: "test" });
    mkdirSync(join(workspace, "scripts/ui"), { recursive: true });
    writeFileSync(join(workspace, "scripts/ui/tc_session.spec.ts"), generateSpec({ caseId: "tc_session", title: "保留手动登录", steps: [
      { action: "goto", role, url: "/tags" },
      { action: "expectVisible", role, target: { kind: "testid", value: "disable-TAG-1001" } },
    ] }));
    const out: any = await tools.find(t => t.name === "run_playwright_script")!.handler({ case_ids: ["tc_session"] });
    expect(out, JSON.stringify(out)).toMatchObject({ session_mode: "embedded", exit_code: 0, results: [{ status: "passed" }] });
    expect(await page.evaluate(() => sessionStorage.getItem("session-only"))).toBe("preserved");
    expect(sparePage.url()).toBe("about:blank"); // 不把已登录角色复制到另一个角色
    expect(host.isConnected()).toBe(true);
  } finally {
    await session.close(); await context.close(); await spareContext.close(); rmSync(workspace, { recursive: true, force: true });
  }
}, 60_000);
