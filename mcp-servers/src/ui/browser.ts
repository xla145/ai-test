import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { chromium, selectors, type Browser, type BrowserContext, type Page } from "playwright-core";
import { DEFAULT_ROLE, type Step } from "./codegen.js";
import { candidates, COLLECT_SCRIPT, pickUnique, toLocator, type ElementInfo, type LocatorSpec } from "./locator.js";

/**
 * 探索模式的浏览器会话（browser MCP Server 的实现）。
 *
 * - 桌面端：Playwright 通过 connectOverCDP 连接 Electron 内嵌浏览器，用户实时看到 agent 的操作；
 *   每个角色对应一个独立 session partition 的 WebContentsView，由桌面端按需创建。
 * - 无桌面端（CI、命令行）：自行启动 Chromium。
 * 每一步操作都按选择器规范录制，最后生成确定性脚本。
 */
export interface LoginRecipe {
  url: string;
  username: string;
  password: string;
  submit: string;
  success?: string;
}

export interface Credentials {
  username: string;
  password: string;
}

export interface BrowserSessionOptions {
  cdpEndpoint?: string;
  /** CDP 模式下请桌面端为角色准备视图，返回该视图初始 URL 中的标记 */
  openView?: (role: string) => Promise<string>;
  headless?: boolean;
  executablePath?: string;
  baseUrl?: string;
  testIdAttribute?: string;
}

export interface SnapshotElement {
  ref: string;
  role?: string;
  name?: string;
  testId?: string;
  text?: string;
  label?: string;
  placeholder?: string;
  value?: string;
  checked?: boolean;
  disabled?: boolean;
}

interface RefEntry {
  role: string;
  info: ElementInfo;
}

interface CapturedRequest {
  url: string;
  method: string;
  body: unknown;
}

export class BrowserSession {
  private browser?: Browser;
  private readonly pages = new Map<string, Page>();
  private readonly contexts = new Map<string, BrowserContext>();
  private refs = new Map<string, RefEntry>();
  private refSeq = 0;
  private steps: Step[] = [];
  private captures = new Map<string, { role: string; pattern: string; list: CapturedRequest[] }>();
  currentRole = DEFAULT_ROLE;

  constructor(private opts: BrowserSessionOptions = {}) {
    if (opts.testIdAttribute) selectors.setTestIdAttribute(opts.testIdAttribute);
  }

  configure(opts: Partial<BrowserSessionOptions>): void {
    this.opts = { ...this.opts, ...opts };
  }

  get baseUrl(): string | undefined {
    return this.opts.baseUrl;
  }

  async close(): Promise<void> {
    if (this.opts.cdpEndpoint) {
      // 不关闭内嵌浏览器，只断开连接
      await this.browser?.close().catch(() => undefined);
    } else {
      for (const c of this.contexts.values()) await c.close().catch(() => undefined);
      await this.browser?.close().catch(() => undefined);
    }
    this.browser = undefined;
    this.pages.clear();
    this.contexts.clear();
  }

  private async ensureBrowser(): Promise<Browser> {
    if (this.browser?.isConnected()) return this.browser;
    this.browser = this.opts.cdpEndpoint
      ? await chromium.connectOverCDP(this.opts.cdpEndpoint)
      : await chromium.launch({ headless: this.opts.headless ?? true, executablePath: this.opts.executablePath });
    return this.browser;
  }

  private async findPageByMarker(browser: Browser, marker: string, timeoutMs = 10_000): Promise<Page> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      for (const ctx of browser.contexts()) {
        const page = ctx.pages().find((p) => p.url().includes(marker));
        if (page) return page;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`内嵌浏览器中找不到角色视图（${marker}）`);
  }

  /** 新建（或切换到）角色上下文；需要登录时由客户端提供账号，登录态保存为 storageState */
  async newRoleContext(
    role: string,
    opts: { storageStatePath?: string; login?: LoginRecipe; credentials?: Credentials } = {},
  ): Promise<{ role: string; loggedIn: boolean; reusedState: boolean }> {
    const browser = await this.ensureBrowser();
    let page = this.pages.get(role);
    let reusedState = false;
    if (!page) {
      if (this.opts.cdpEndpoint) {
        if (!this.opts.openView) throw new Error("CDP 模式需要桌面端提供角色视图");
        page = await this.findPageByMarker(browser, await this.opts.openView(role));
      } else {
        reusedState = Boolean(opts.storageStatePath && existsSync(opts.storageStatePath));
        const context = await browser.newContext({
          baseURL: this.opts.baseUrl,
          storageState: reusedState ? opts.storageStatePath : undefined,
        });
        this.contexts.set(role, context);
        page = await context.newPage();
      }
      this.pages.set(role, page);
    }
    this.currentRole = role;
    let loggedIn = false;
    if (opts.login && opts.credentials && !reusedState) {
      await performLogin(page, opts.login, opts.credentials, this.opts.baseUrl);
      loggedIn = true;
      if (opts.storageStatePath && !this.opts.cdpEndpoint) {
        mkdirSync(dirname(opts.storageStatePath), { recursive: true });
        await page.context().storageState({ path: opts.storageStatePath });
      }
    }
    return { role, loggedIn, reusedState };
  }

  async page(role = this.currentRole): Promise<Page> {
    if (!this.pages.has(role)) await this.newRoleContext(role);
    return this.pages.get(role)!;
  }

  private record(step: Step): void {
    this.steps.push({ ...step, role: step.role ?? this.currentRole });
  }

  private absolute(url: string): string {
    if (/^https?:\/\//.test(url) || !this.opts.baseUrl) return url;
    return this.opts.baseUrl.replace(/\/$/, "") + (url.startsWith("/") ? url : `/${url}`);
  }

  async navigate(url: string): Promise<{ url: string; title: string }> {
    const page = await this.page();
    await page.goto(this.absolute(url));
    this.record({ action: "goto", url: this.absolute(url) });
    return { url: page.url(), title: await page.title() };
  }

  /** 页面快照：可交互元素（带 ref）与可见文本摘要，供 agent 规划下一步 */
  async snapshot(opts: { maxText?: number } = {}) {
    const page = await this.page();
    const infos = (await page.evaluate(
      `(${COLLECT_SCRIPT})(${JSON.stringify({ testIdAttribute: this.testIdAttr() })})`,
    )) as (ElementInfo & Omit<SnapshotElement, "ref">)[];
    this.refs = new Map();
    const elements: SnapshotElement[] = infos.map((info) => {
      const ref = `e${++this.refSeq}`;
      this.refs.set(ref, { role: this.currentRole, info });
      const { css: _css, tag: _tag, ...rest } = info;
      return { ref, ...rest };
    });
    const text = (await page.evaluate("document.body ? document.body.innerText : ''")) as string;
    return {
      role: this.currentRole,
      url: page.url(),
      title: await page.title(),
      elements,
      text: text.replace(/\n{3,}/g, "\n\n").slice(0, opts.maxText ?? 3000),
    };
  }

  /** 视觉定位（midscene）得到坐标后，换成可录制的 ref */
  async refAt(x: number, y: number): Promise<SnapshotElement | undefined> {
    const page = await this.page();
    const infos = (await page.evaluate(
      `(${COLLECT_SCRIPT})(${JSON.stringify({ testIdAttribute: this.testIdAttr(), root: { x, y } })})`,
    )) as ElementInfo[];
    if (!infos.length) return undefined;
    const ref = `e${++this.refSeq}`;
    this.refs.set(ref, { role: this.currentRole, info: infos[0] });
    const { css: _css, tag: _tag, ...rest } = infos[0];
    return { ref, ...rest };
  }

  private testIdAttr(): string {
    return this.opts.testIdAttribute ?? "data-testid";
  }

  private async target(ref: string): Promise<{ page: Page; spec: LocatorSpec; role: string }> {
    const entry = this.refs.get(ref);
    if (!entry) throw new Error(`未知的 ref：${ref}，请先调用 snapshot`);
    const page = await this.page(entry.role);
    const spec = await pickUnique(page, candidates(entry.info));
    if (!spec) throw new Error(`元素 ${ref} 没有唯一的定位器，请为被测页面补充 data-testid 或换一个元素`);
    return { page, spec, role: entry.role };
  }

  async click(ref: string) {
    const { page, spec, role } = await this.target(ref);
    await toLocator(page, spec).click();
    this.record({ action: "click", target: spec, role });
    return { locator: spec, url: page.url() };
  }

  async type(ref: string, text: string, opts: { secretEnv?: string } = {}) {
    const { page, spec, role } = await this.target(ref);
    await toLocator(page, spec).fill(text);
    this.record({ action: "fill", target: spec, value: opts.secretEnv ? "" : text, secretEnv: opts.secretEnv, role });
    return { locator: spec };
  }

  async select(ref: string, value: string) {
    const { page, spec, role } = await this.target(ref);
    await toLocator(page, spec).selectOption(value);
    this.record({ action: "select", target: spec, value, role });
    return { locator: spec };
  }

  async check(ref: string, checked: boolean) {
    const { page, spec, role } = await this.target(ref);
    await toLocator(page, spec).setChecked(checked);
    this.record({ action: "check", target: spec, checked, role });
    return { locator: spec };
  }

  async press(key: string) {
    const page = await this.page();
    await page.keyboard.press(key);
    this.record({ action: "press", key });
  }

  /** 断言先在当前页面上验证通过，再录进脚本 */
  async expectVisible(ref: string, visible = true) {
    const { page, spec, role } = await this.target(ref).catch(async (e) => {
      if (visible) throw e;
      const entry = this.refs.get(ref);
      if (!entry) throw e;
      const spec = candidates(entry.info)[0];
      return { page: await this.page(entry.role), spec, role: entry.role };
    });
    const loc = toLocator(page, spec);
    if (visible) await loc.waitFor({ state: "visible", timeout: 5000 });
    else await loc.waitFor({ state: "hidden", timeout: 5000 });
    this.record({ action: visible ? "expectVisible" : "expectHidden", target: spec, role });
    return { locator: spec };
  }

  async expectText(ref: string, text: string, timeoutMs = 5000) {
    const { page, spec, role } = await this.target(ref);
    const loc = toLocator(page, spec);
    let actual = "";
    const ok = await poll(async () => {
      actual = (await loc.innerText({ timeout: 1000 }).catch(() => "")).replace(/\s+/g, " ");
      return actual.includes(text);
    }, timeoutMs);
    if (!ok) throw new Error(`断言不成立：元素文本为「${actual.slice(0, 200)}」，不包含「${text}」`);
    this.record({ action: "expectText", target: spec, text, role });
    return { locator: spec, actual };
  }

  async expectUrl(pattern: string, timeoutMs = 5000) {
    const page = await this.page();
    if (!(await poll(async () => page.url().includes(pattern), timeoutMs))) {
      throw new Error(`断言不成立：当前 URL 为 ${page.url()}`);
    }
    this.record({ action: "expectUrl", pattern });
    return { url: page.url() };
  }

  async startCapture(name: string, urlPattern: string) {
    if (!/^[A-Za-z_$][\w$]*$/.test(name)) throw new Error("capture 名称需是合法的变量名，如 pageviewEvents");
    const page = await this.page();
    const list: CapturedRequest[] = [];
    page.on("request", (r) => {
      if (r.url().includes(urlPattern)) list.push({ url: r.url(), method: r.method(), body: parseBody(r.postData()) });
    });
    this.captures.set(name, { role: this.currentRole, pattern: urlPattern, list });
    this.record({ action: "startCapture", name, urlPattern });
    return { name, urlPattern };
  }

  getCaptured(name: string): CapturedRequest[] {
    const c = this.captures.get(name);
    if (!c) throw new Error(`未开始抓包：${name}`);
    return c.list;
  }

  async expectRequest(name: string, fields: Record<string, unknown>, forbidden: string[] = [], timeoutMs = 5000) {
    const c = this.captures.get(name);
    if (!c) throw new Error(`未开始抓包：${name}`);
    let matched: Record<string, unknown>[] = [];
    await poll(async () => (matched = matchEvents(c.list, fields)).length > 0, timeoutMs);
    if (!matched.length) throw new Error(`断言不成立：未捕获到匹配 ${JSON.stringify(fields)} 的上报（共 ${c.list.length} 条）`);
    const leaked = forbidden.filter((k) => matched.some((e) => hasKey(e, k)));
    if (leaked.length) throw new Error(`上报中带出了敏感字段：${leaked.join(", ")}`);
    this.record({ action: "expectRequest", name, fields, forbidden, role: c.role });
    return { matched: matched.length };
  }

  /** 前端计时：Playwright clock，需在 navigate 之前调用 */
  async installClock(time: string) {
    const page = await this.page();
    await page.clock.install({ time: new Date(time) });
    this.record({ action: "installClock", time });
  }

  async fastForward(ms: number) {
    const page = await this.page();
    await page.clock.fastForward(ms);
    this.record({ action: "fastForward", ms });
  }

  async visualCheck(description: string, evidenceDir: string) {
    const path = await this.screenshot(join(evidenceDir, `visual-${Date.now()}.png`));
    this.record({ action: "visualCheck", description });
    return { screenshot: path, note: "已录入脚本：回归时截图并进入人工复核队列，不直接算通过" };
  }

  async screenshot(path: string, fullPage = true): Promise<string> {
    const page = await this.page();
    mkdirSync(dirname(path), { recursive: true });
    await page.screenshot({ path, fullPage });
    return path;
  }

  recording(): Step[] {
    return [...this.steps];
  }

  /** 丢弃最后 n 步录制（例如探索中走错的步骤） */
  undo(n = 1): Step[] {
    this.steps.splice(Math.max(0, this.steps.length - n), n);
    return this.recording();
  }

  resetRecording(): void {
    this.steps = [];
    this.captures.clear();
  }
}

/** 与 Playwright expect 一致的自动重试：条件在超时内成立即通过 */
async function poll(fn: () => Promise<boolean>, timeoutMs: number, intervalMs = 100): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await fn()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

export async function performLogin(page: Page, recipe: LoginRecipe, cred: Credentials, baseUrl?: string): Promise<void> {
  const url = /^https?:\/\//.test(recipe.url) || !baseUrl ? recipe.url : baseUrl.replace(/\/$/, "") + recipe.url;
  await page.goto(url);
  await page.locator(recipe.username).fill(cred.username);
  await page.locator(recipe.password).fill(cred.password);
  await page.locator(recipe.submit).click();
  if (recipe.success) await page.waitForURL((u) => u.toString().includes(recipe.success!), { timeout: 15_000 });
  else await page.waitForLoadState("networkidle");
}

export function parseBody(raw: string | null): unknown {
  if (raw == null) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    if (/^[^=&\s]+=[^&]*(&[^=&\s]+=[^&]*)*$/.test(raw)) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of new URLSearchParams(raw)) {
        try {
          out[k] = JSON.parse(v);
        } catch {
          out[k] = v;
        }
      }
      return out;
    }
    return raw;
  }
}

function events(body: unknown): Record<string, unknown>[] {
  if (Array.isArray(body)) return body.flatMap(events);
  if (body && typeof body === "object") {
    const obj = body as Record<string, unknown>;
    return [obj, ...Object.values(obj).filter(Array.isArray).flatMap((v) => events(v))];
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

export function matchEvents(list: CapturedRequest[], fields: Record<string, unknown>): Record<string, unknown>[] {
  return list.flatMap((c) => events(c.body)).filter((e) => Object.entries(fields).every(([k, v]) => pick(e, k) === v));
}
