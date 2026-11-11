// 由 AIProbe 生成：只连接客户端准备的角色视图，不新建或关闭用户浏览器。
import { chromium, test as base, type Browser, type Page } from "@playwright/test";
export * from "@playwright/test";

const pages = new Map<string, Page>();
export async function embeddedPage(browser: Browser, role: string): Promise<Page> {
  const announce = () => process.stdout.write(`AITEST_STEP:${JSON.stringify({ title: `切换角色：${role}`, status: "running", role })}\n`);
  const cached = pages.get(role);
  if (cached && !cached.isClosed()) { announce(); await cached.bringToFront(); return cached; }
  const markers: Record<string, string> = JSON.parse(process.env.AITEST_VIEW_MARKERS || "{}");
  if (!markers[role]) throw new Error(`没有为角色 ${role} 准备内嵌浏览器`);
  const page = browser.contexts().flatMap(c => c.pages()).find(p => p.url().includes(markers[role]));
  if (!page) throw new Error(`无法找到角色 ${role} 的内嵌浏览器视图`);
  announce();
  await page.bringToFront();
  const goto = page.goto.bind(page);
  page.goto = (url, options) => goto(new URL(url, process.env.AITEST_BASE_URL).href, options);
  page.setDefaultTimeout(Number(process.env.AITEST_ACTION_TIMEOUT || 5000));
  const recipe = JSON.parse(process.env.AITEST_LOGIN || "null");
  const creds = JSON.parse(process.env.AITEST_ROLES || "[]").find((c: { role: string }) => c.role === role);
  if (recipe && creds) {
    await page.goto(new URL(recipe.url, process.env.AITEST_BASE_URL).href);
    await page.locator(recipe.username).fill(creds.username);
    await page.locator(recipe.password).fill(creds.password);
    await page.locator(recipe.submit).click();
    if (recipe.success) await page.waitForURL(u => u.toString().includes(recipe.success));
    else await page.waitForLoadState("networkidle");
  }
  pages.set(role, page);
  return page;
}

export const test = base.extend({
  browser: [async ({}, use) => {
    const browser = await chromium.connectOverCDP(process.env.AITEST_CDP_ENDPOINT!);
    try { await use(browser); } finally { pages.clear(); await browser.close(); }
  }, { scope: "worker" }],
  context: async ({ browser }, use) => {
    const page = await embeddedPage(browser, "default");
    await use(page.context());
  },
  page: async ({ browser, storageState }, use) => {
    const role = typeof storageState === "string" && storageState.startsWith("aitest-role:") ? storageState.slice(12) : "default";
    const page = await embeddedPage(browser, role);
    await use(page);
  },
});
