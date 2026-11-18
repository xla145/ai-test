// 由 AIProbe 生成：脚本共用的辅助函数。
import { expect, test, type Browser, type Page, type TestInfo } from "@playwright/test";
import { execFile } from "node:child_process";
import valueTools from "./aitest-values.cjs";

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

/** 角色登录态（global-setup 生成） */
export function storageStateFor(role: string): string | undefined {
  if (role === "default" && process.env.AITEST_DEFAULT_ROLE) role = process.env.AITEST_DEFAULT_ROLE;
  if (process.env.AITEST_EMBEDDED) return `aitest-role:${role}`;
  return join(process.env.AITEST_AUTH_DIR || join(__dirname, ".auth"), `${Buffer.from(role).toString("hex")}.json`);
}

/** 多角色：每个角色一个独立上下文 */
export async function openAs(browser: Browser, role: string): Promise<Page> {
  if (process.env.AITEST_EMBEDDED) return (await import("./aitest-embedded")).embeddedPage(browser, role);
  const state = storageStateFor(role)!;
  if (!existsSync(state)) throw new Error(`AUTH_REQUIRED: 角色「${role}」没有可恢复的登录态`);
  const context = await browser.newContext({ baseURL: process.env.AITEST_BASE_URL, storageState: state });
  if (existsSync(`${state}.session.json`)) {
    await context.addInitScript(({ origin, values }) => {
      if (location.origin === origin) for (const [key, value] of Object.entries(values)) sessionStorage.setItem(key, String(value));
    }, JSON.parse(readFileSync(`${state}.session.json`, "utf8")));
  }
  const page = await context.newPage();
  prepareSessionPage(page);
  recordSession(page, role, true);
  return page;
}

export function recordSession(page: Page, role: string, restored: boolean) {
  let u: URL;
  try { u = new URL(page.url()); } catch { return; }
  test.info().annotations.push({ type: "aitest-context", description: JSON.stringify({ role,
    sessionId: process.env.AITEST_SESSION_ID, pageUrl: u.origin + u.pathname + u.hash.split("?")[0], restored,
    mode: process.env.AITEST_EMBEDDED ? "embedded" : "isolated", viewport: page.viewportSize() }) });
}

/** Check configured authentication boundary after navigation, without modifying business actions. */
export function prepareSessionPage(page: Page) {
  const recipe = JSON.parse(process.env.AITEST_LOGIN || "null");
  const isLogin = (url: string) => {
    if (!recipe) {
      const u = new URL(url, process.env.AITEST_BASE_URL);
      return /(?:^|[\/#])(?:login|signin|sign-in)(?:[\/?#]|$)/i.test(u.pathname + u.hash);
    }
    const u = new URL(url, process.env.AITEST_BASE_URL), l = new URL(recipe.url, process.env.AITEST_BASE_URL);
    return u.origin === l.origin && u.pathname === l.pathname && u.hash === l.hash;
  };
  const goto = page.goto.bind(page);
  page.goto = async (url, options) => {
    const target = new URL(url, process.env.AITEST_BASE_URL).href;
    const result = await goto(target, { waitUntil: 'domcontentloaded', ...options });
    if (!isLogin(target) && isLogin(page.url())) throw new Error("AUTH_REQUIRED: 登录态失效，请重新登录执行角色");
    return result;
  };
}

const { numericEqual, equalValue } = valueTools;
export const readValue = valueTools.readValue;
export async function expectCollection(locator: import("@playwright/test").Locator, rule: { selector: string; minCount?: number; maxCount?: number; contains?: string; equals?: string }) {
  valueTools.validateCollectionRule(rule);
  await expect.poll(async () => (await valueTools.checkCollection(locator, rule)).matched, { message: 'ASSERTION_FAILED: 集合不满足用例规则' }).toBe(true);
}
export async function expectObserved(locator: import("@playwright/test").Locator, expected: unknown, source: string, normalize: string) {
  await expect.poll(async () => equalValue(await readValue(locator, source), expected, normalize), { message: "ASSERTION_FAILED: 读取值与预期不一致" }).toBe(true);
}
export async function expectNumber(locator: import("@playwright/test").Locator, expected: string | number, tolerance: string | number = 0) {
  await expect.poll(async () => numericEqual(await locator.innerText(), expected, tolerance), { message: `数值不等于 ${expected}` }).toBe(true);
}

export interface Captured { url: string; method: string; body: unknown }

function parseBody(raw: string | null): unknown {
  if (raw == null) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    if (/^[^=&\s]+=[^&]*(&[^=&\s]+=[^&]*)*$/.test(raw)) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of new URLSearchParams(raw)) {
        try { out[k] = JSON.parse(v); } catch { out[k] = v; }
      }
      return out;
    }
    return raw;
  }
}

/** 埋点抓包：内嵌浏览器基于 Chromium，直接拦截上报请求，不需要另外架设代理 */
export function captureRequests(page: Page, urlPattern: string): Captured[] {
  const list: Captured[] = [];
  page.on("request", (r) => {
    if (r.url().includes(urlPattern)) list.push({ url: r.url(), method: r.method(), body: parseBody(r.postData()) });
  });
  return list;
}

/** 一次上报可能是单个事件、事件数组或 {events: [...]}，逐个展开 */
export function events(body: unknown): Record<string, unknown>[] {
  if (Array.isArray(body)) return body.flatMap(events);
  if (body && typeof body === "object") {
    const obj = body as Record<string, unknown>;
    const nested = Object.values(obj).filter(Array.isArray).flatMap((v) => events(v));
    return [obj, ...nested];
  }
  return [];
}

function pick(obj: unknown, dotted: string): unknown {
  return dotted.split(".").reduce<unknown>((cur, k) => (cur && typeof cur === "object" ? (cur as Record<string, unknown>)[k] : undefined), obj);
}

function hasKey(obj: unknown, key: string): boolean {
  if (!obj || typeof obj !== "object") return false;
  return Object.entries(obj as Record<string, unknown>).some(([k, v]) => k === key || hasKey(v, key));
}

export function matching(list: Captured[], fields: Record<string, unknown>): Record<string, unknown>[] {
  return list.flatMap((c) => events(c.body)).filter((e) => Object.entries(fields).every(([k, v]) => pick(e, k) === v));
}

/** 断言存在字段匹配的上报，且匹配到的上报不带敏感字段 */
export async function expectCaptured(list: Captured[], fields: Record<string, unknown>, forbidden: string[] = []) {
  await expect
    .poll(() => matching(list, fields).length, { message: `未捕获到匹配的上报：${JSON.stringify(fields)}` })
    .toBeGreaterThan(0);
  for (const e of matching(list, fields)) {
    for (const key of forbidden) expect(hasKey(e, key), `上报中带出了敏感字段 ${key}`).toBe(false);
  }
}

/**
 * 数据库断言（入库校验）：调用执行引擎，与接口脚本的数据库校验是同一套实现；只读，入库延迟时在超时内重试。
 * 连接配置由客户端 / CI 通过 AITEST_DATABASES 注入（含密码，不写进脚本）。
 */
export async function expectDb(check: { db?: string; sql: string; params?: Record<string, unknown>; expect?: Record<string, unknown>; timeout_ms?: number; description?: string }) {
  const python = process.env.AITEST_PYTHON || "python3";
  let out: string;
  try {
    ({ stdout: out } = await promisify(execFile)(python, ["-m", "aitest", "db-check", "--runtime", "--spec", JSON.stringify(check)], { env: process.env, maxBuffer: 10 * 1024 * 1024 }));
  } catch (e) {
    out = (e as { stdout?: string }).stdout ?? "";
    if (!out) throw new Error(`无法调用执行引擎做数据库校验：${(e as Error).message}`);
  }
  const res = JSON.parse(out.trim().split("\n").pop() ?? "{}") as { ok: boolean; error?: string; data?: { ok: boolean; errors: string[]; rows: unknown[] } };
  if (!res.ok) throw new Error(`数据库校验出错：${res.error}`);
  expect(res.data!.ok, `数据库校验失败（${check.description ?? check.sql}）：${res.data!.errors.join("；")}；查询结果：${JSON.stringify(res.data!.rows.slice(0, 5))}`).toBe(true);
}

/** 视觉判定：保存截图并标记为 AI 判定，由客户端送入人工复核队列，不直接算通过 */
export async function visualCheck(page: Page, testInfo: TestInfo, description: string) {
  // 以文件形式附加：JSON 报告里才有路径，复核队列才能显示截图
  const path = testInfo.outputPath(`visual-check-${testInfo.annotations.filter((a) => a.type === "ai-visual-check").length + 1}.png`);
  if (process.env.AITEST_EMBEDDED) {
    // 内嵌浏览器有缩放（按桌面宽度渲染后缩小显示），Playwright 截图会错位：直接截视图显示的画面
    const cdp = await page.context().newCDPSession(page);
    try { writeFileSync(path, Buffer.from((await cdp.send("Page.captureScreenshot", { format: "png" })).data, "base64")); }
    finally { await cdp.detach().catch(() => undefined); }
  } else {
    await page.screenshot({ path, fullPage: true });
  }
  await testInfo.attach("ai-visual-check", { path, contentType: "image/png" });
  testInfo.annotations.push({ type: "ai-visual-check", description });
}
