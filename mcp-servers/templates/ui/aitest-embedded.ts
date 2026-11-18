import { recordSession } from "./aitest-fixtures";
// 由 AIProbe 生成：只连接客户端准备的角色视图，不新建或关闭用户浏览器。
import { chromium, test as base, type Browser, type Page } from "@playwright/test";
export * from "@playwright/test";

const pages = new Map<string, Page>();
export async function embeddedPage(browser: Browser, role: string): Promise<Page> {
  if (role === "default") role = process.env.AITEST_DEFAULT_ROLE || role;
  const announce = () => process.stdout.write(`AITEST_STEP:${JSON.stringify({ title: `切换角色：${role}`, status: "running", role })}\n`);
  const cached = pages.get(role);
  if (cached && !cached.isClosed()) { announce(); await cached.bringToFront(); return cached; }
  const markers: Record<string, string> = JSON.parse(process.env.AITEST_VIEW_MARKERS || "{}");
  if (!markers[role]) throw new Error(`没有为角色 ${role} 准备内嵌浏览器`);
  let page: Page | undefined;
  for (const candidate of browser.contexts().flatMap(c => c.pages())) {
    if (candidate.url().includes(markers[role]) || await candidate.evaluate("window.__aitestViewMarker").catch(() => undefined) === markers[role]) {
      page = candidate;
      break;
    }
  }
  if (!page) throw new Error(`无法找到角色 ${role} 的内嵌浏览器视图`);
  announce();
  await page.bringToFront();
  const goto = page.goto.bind(page);
  page.goto = (url, options) => goto(new URL(url, process.env.AITEST_BASE_URL).href, options);
  page.setDefaultTimeout(Number(process.env.AITEST_ACTION_TIMEOUT || 5000));
  // setDefaultTimeout 同时约束 goto / waitForURL：页面跳转单独给足时间，免得首屏稍慢就误报失败
  page.setDefaultNavigationTimeout(Number(process.env.AITEST_NAVIGATION_TIMEOUT || 30_000));
  const recipe = JSON.parse(process.env.AITEST_LOGIN || "null");
  const creds = JSON.parse(process.env.AITEST_ROLES || "[]").find((c: { role: string }) => c.role === role);
  // 手动登录已建立的会话不再被自动登录覆盖（验证码/会话内 token 也保留）。
  let reuseSession = false;
  const onLoginPage = (url: string) => {
    try {
      const current = new URL(url);
      const loginUrl = recipe && new URL(recipe.url, process.env.AITEST_BASE_URL);
      return Boolean(loginUrl && current.origin === loginUrl.origin
        && current.pathname === loginUrl.pathname && current.hash === loginUrl.hash);
    } catch { return false; }
  };
  try {
    const current = new URL(page.url());
    const baseUrl = new URL(process.env.AITEST_BASE_URL!);
    reuseSession = current.origin === baseUrl.origin && !onLoginPage(current.href);
  } catch { /* 新建的空白角色视图需要登录 */ }
  if (recipe && creds && !reuseSession) {
    await page.goto(new URL(recipe.url, process.env.AITEST_BASE_URL).href);
    await page.locator(recipe.username).fill(creds.username);
    await page.locator(recipe.password).fill(creds.password);
    await page.locator(recipe.submit).click();
    if (recipe.success) await page.waitForURL(u => u.toString().includes(recipe.success));
    else await page.waitForLoadState("networkidle");
    if (onLoginPage(page.url()) || (recipe.success && !page.url().includes(recipe.success))) {
      throw new Error(`角色「${role}」登录未完成，当前仍停留在登录页；请检查登录态、登录方式或验证码`);
    }
  }
  // 只拦截访问业务地址却被重定向到配置登录页；直接访问登录页的测试仍可执行。
  page.goto = async (url, options) => {
    const target = new URL(url, process.env.AITEST_BASE_URL).href;
    const response = await goto(target, options);
    if (reuseSession && recipe && !onLoginPage(target) && onLoginPage(page!.url())) {
      throw new Error(`登录态已失效或未登录：角色「${role}」访问目标页面后被重定向到登录页，请先完成该角色登录再试跑`);
    }
    return response;
  };
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
    try { await use(page); } finally { recordSession(page, role === "default" ? process.env.AITEST_DEFAULT_ROLE || role : role, true); }
  },
});
