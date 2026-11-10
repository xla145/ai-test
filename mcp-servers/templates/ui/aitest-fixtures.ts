// 由 AI 测试客户端生成：脚本共用的辅助函数。
import { expect, type Browser, type Page, type TestInfo } from "@playwright/test";
import { existsSync } from "node:fs";
import { join } from "node:path";

/** 角色登录态（global-setup 生成） */
export function storageStateFor(role: string): string | undefined {
  const file = join(__dirname, ".auth", `${role}.json`);
  return existsSync(file) ? file : undefined;
}

/** 多角色：每个角色一个独立上下文 */
export async function openAs(browser: Browser, role: string): Promise<Page> {
  const context = await browser.newContext({ baseURL: process.env.AITEST_BASE_URL, storageState: storageStateFor(role) });
  return context.newPage();
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

/** 视觉判定：保存截图并标记为 AI 判定，由客户端送入人工复核队列，不直接算通过 */
export async function visualCheck(page: Page, testInfo: TestInfo, description: string) {
  const body = await page.screenshot({ fullPage: true });
  await testInfo.attach("ai-visual-check", { body, contentType: "image/png" });
  testInfo.annotations.push({ type: "ai-visual-check", description });
}
