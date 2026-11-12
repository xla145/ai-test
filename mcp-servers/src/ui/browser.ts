import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { chromium, selectors, type Browser, type BrowserContext, type Page } from "playwright-core";
import { chooseBrowser } from "./chromium.js";
import { DEFAULT_ROLE, type DbCheck, type Step, type UiStep } from "./codegen.js";
import { candidates, COLLECT_SCRIPT, isPositional, pickUnique, specTexts, toLocator, type ElementInfo, type LocatorSpec } from "./locator.js";

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
  /** 调试时优先保留同站点现有会话，避免再次登录覆盖 token。 */
  reuseExistingSession?: boolean;
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
  /** find_text：所在行 / 列表项的文本，用于区分多处命中 */
  context?: string;
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

/** 探索时单个操作的超时：点不到（被遮挡、不可见）就尽快失败，让 agent 换办法 */
export const EXPLORE_ACTION_TIMEOUT_MS = 5_000;
/** 探索时断言的等待上限：成立即返回；页面已基本静止，不成立时不必等满回归用的 5 秒 */
export const EXPLORE_ASSERT_TIMEOUT_MS = 2_000;
/** 已抓到请求但字段不匹配时只再等这么久（大概率是字段写错，而不是请求还没发出） */
const CAPTURE_MISMATCH_WAIT_MS = 500;
/** ref 表保留的上限：旧 ref 在新快照后仍可用（并行调用、操作自带快照），超出后丢弃最早的 */
const MAX_REFS = 3000;

export interface StepRunOptions {
  /** 断言与操作的超时（毫秒） */
  timeoutMs?: number;
  /** fill 步骤中 secretEnv 对应的值 */
  secrets?: Record<string, string>;
  /** 数据库断言由调用方执行（引擎 db-check），失败时抛错 */
  dbCheck?: (check: DbCheck) => Promise<void>;
  /** 视觉判定截图目录 */
  evidenceDir?: string;
}

export class BrowserSession {
  private browser?: Browser;
  private readonly pages = new Map<string, Page>();
  private readonly contexts = new Map<string, BrowserContext>();
  private refs = new Map<string, RefEntry>();
  private refSeq = 0;
  private steps: UiStep[] = [];
  /** 之后录制的步骤对应用例第几步（从 1 开始），用于界面对照 */
  currentCaseStep?: number;
  private captures = new Map<string, { role: string; pattern: string; list: CapturedRequest[]; off?: () => void }>();
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
      : await chromium.launch({ headless: this.opts.headless ?? true,
        executablePath: this.opts.executablePath ?? chooseBrowser({ headless: this.opts.headless ?? true }).executablePath });
    return this.browser;
  }

  private async findPageByMarker(browser: Browser, marker: string, timeoutMs = 10_000): Promise<Page> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      for (const ctx of browser.contexts()) {
        for (const page of ctx.pages()) {
          if (page.url().includes(marker) || await page.evaluate(
            "window.__aitestViewMarker",
          ).catch(() => undefined) === marker) return page;
        }
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
      // 探索时点不到就尽快失败（Playwright 默认 30 秒），页面跳转仍给 30 秒
      page.setDefaultTimeout(EXPLORE_ACTION_TIMEOUT_MS);
      page.setDefaultNavigationTimeout(30_000);
      this.pages.set(role, page);
    }
    this.currentRole = role;
    let loggedIn = false;
    // 新 BrowserSession 也可连接已手动登录的角色页；只有同站点且不在登录页时才沿用。
    if (this.opts.cdpEndpoint && this.opts.reuseExistingSession && this.opts.baseUrl) {
      try {
        const current = new URL(page.url());
        const base = new URL(this.opts.baseUrl);
        const login = opts.login && new URL(opts.login.url, this.opts.baseUrl);
        reusedState = current.origin === base.origin && (!login || current.pathname !== login.pathname);
      } catch { /* 空白页没有可复用的站点会话 */ }
    }
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
    this.steps.push({ ...step, role: step.role ?? this.currentRole, ...(this.currentCaseStep ? { caseStep: this.currentCaseStep } : {}), source: "ai" });
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
    const elements: SnapshotElement[] = infos.map((info) => this.addRef(info));
    const text = (await page.evaluate("document.body ? document.body.innerText : ''")) as string;
    return {
      role: this.currentRole,
      url: page.url(),
      title: await page.title(),
      elements,
      text: text.replace(/\n{3,}/g, "\n\n").slice(0, opts.maxText ?? 3000),
    };
  }

  /** 登记一个元素并返回带 ref 的描述。旧 ref 不随新快照失效：定位器在使用时重新解析 */
  private addRef(info: ElementInfo): SnapshotElement {
    const ref = `e${++this.refSeq}`;
    this.refs.set(ref, { role: this.currentRole, info });
    for (const old of this.refs.keys()) {
      if (this.refs.size <= MAX_REFS) break;
      this.refs.delete(old);
    }
    const { css: _css, tag: _tag, cssLoose: _loose, labelText: _label, row: _row, ...rest } = info;
    return { ref, ...rest };
  }

  /**
   * 操作后的页面快照：等页面稍稳定再取，省去 agent 每次操作后单独调用 snapshot 的一轮。
   * 页面正在跳转等原因取不到时返回 undefined，由 agent 自行再调 snapshot。
   */
  async snapshotAfterAction(): Promise<Awaited<ReturnType<BrowserSession["snapshot"]>> | undefined> {
    const page = await this.page();
    for (let attempt = 0; attempt < 2; attempt++) {
      await page.waitForLoadState("domcontentloaded", { timeout: 3000 }).catch(() => undefined);
      await page.waitForTimeout(250);
      try {
        return await this.snapshot({ maxText: 1500 });
      } catch {
        // 执行上下文被跳转销毁：再等一次
      }
    }
    return undefined;
  }

  /**
   * 按文本确定性定位：返回文本包含（exact 时等于）目标的最内层可见元素，带 ref。
   * 用于 snapshot 不列出的非交互元素（表格单元格、状态徽标、统计文字），不调用视觉模型。
   */
  async findText(text: string, opts: { exact?: boolean; limit?: number } = {}): Promise<SnapshotElement[]> {
    const wanted = text.replace(/\s+/g, " ").trim();
    if (!wanted) throw new Error("text 不能为空");
    const page = await this.page();
    const infos = (await page.evaluate(
      `(${COLLECT_SCRIPT})(${JSON.stringify({ testIdAttribute: this.testIdAttr(), text: wanted, exact: opts.exact ?? false, limit: Math.min(opts.limit ?? 10, 30) })})`,
    )) as ElementInfo[];
    return infos.map((info) => this.addRef(info));
  }

  /** 视觉定位（midscene）得到坐标后，换成可录制的 ref（不校验文本） */
  async refAt(x: number, y: number): Promise<SnapshotElement | undefined> {
    const out = await this.locateAt(x, y);
    return out.element;
  }

  /**
   * 视觉定位结果 → 可录制的 ref，并校验是不是要找的元素。
   * - 默认取落点处最内层元素；可交互祖先足够小才用它，避免拿到整行 / 整个容器。
   * - rect 为模型给出的元素框，用来在落点的祖先里挑框最接近的。
   * - expect 为目标元素应包含的文字：落点处的元素不含它时，在 radius 像素内找最近的包含它的元素；找不到返回 matched=false。
   */
  async locateAt(x: number, y: number, opts: { rect?: { left: number; top: number; width: number; height: number }; expect?: string; radius?: number } = {}): Promise<{
    element?: SnapshotElement; matched?: boolean; adjusted?: number; pointText?: string; elsewhere?: number; nearestDistance?: number;
  }> {
    const page = await this.page();
    const rect = opts.rect && opts.rect.width > 10 && opts.rect.height > 10 ? opts.rect : undefined;
    const expect = opts.expect?.replace(/\s+/g, " ").trim() || undefined;
    const [info] = (await page.evaluate(
      `(${COLLECT_SCRIPT})(${JSON.stringify({ testIdAttribute: this.testIdAttr(), point: { x, y, rect, expect, radius: opts.radius ?? 150 } })})`,
    )) as (ElementInfo & { matched?: boolean; adjusted?: number; pointText?: string; elsewhere?: number; nearestDistance?: number })[];
    if (!info) return {};
    const { matched, adjusted, pointText, elsewhere, nearestDistance, ...el } = info;
    if (matched === false) return { matched, pointText, elsewhere, nearestDistance };
    return { element: this.addRef(el), matched, adjusted, pointText };
  }

  private testIdAttr(): string {
    return this.opts.testIdAttribute ?? "data-testid";
  }

  /**
   * ref → 唯一定位器。
   * avoidText：断言的文字。按这段文字找到的定位器（getByText("已停用")、名称里带它的按钮）再断言它，
   * 等于什么都没验证，这类候选排到不依赖文字的定位器之后，选中时 dependent=true，由调用方改成「可见」断言。
   */
  private async target(ref: string, opts: { avoidText?: string } = {}): Promise<{ page: Page; spec: LocatorSpec; role: string; dependent: boolean }> {
    const entry = this.refs.get(ref);
    if (!entry) throw new Error(`未知的 ref：${ref}，请先调用 snapshot`);
    const page = await this.page(entry.role);
    const all = candidates(entry.info);
    const avoid = opts.avoidText?.toLowerCase();
    const dependent = (c: LocatorSpec) => Boolean(avoid) && specTexts(c).some((t) => t.toLowerCase().includes(avoid!));
    // 不依赖文字的稳定定位器 → 依赖文字的 → 位置选择器（nth-of-type）
    const tiers = [all.filter((c) => !dependent(c) && !isPositional(c)), all.filter(dependent), all.filter((c) => !dependent(c) && isPositional(c))];
    for (const tier of tiers) {
      const spec = await pickUnique(page, tier);
      if (spec) return { page, spec, role: entry.role, dependent: dependent(spec) };
    }
    throw new Error(`元素 ${ref} 没有唯一的定位器，请为被测页面补充 data-testid 或换一个元素`);
  }

  /** 录入断言；与上一次操作之后已录的断言完全相同时不重复录入 */
  private recordAssertion(step: Step): boolean {
    const key = (x: Step) => JSON.stringify({ ...x, role: x.role ?? this.currentRole, caseStep: undefined, source: undefined, id: undefined });
    for (let i = this.steps.length - 1; i >= 0 && this.steps[i].action.startsWith("expect"); i--) {
      if (key(this.steps[i]) === key(step)) return false;
    }
    this.record(step);
    return true;
  }

  /**
   * 断言目标是大容器（整个列表区、整页主体）时，换成容器里真正显示这段文字的那个元素。
   * 容器的选择器通常又长又依赖结构，「容器里某处有这段字」也说明不了它出现在对的地方。
   */
  private async narrow(ref: string, text: string): Promise<{ ref: string; note?: string }> {
    const { page, spec } = await this.target(ref);
    const loc = toLocator(page, spec);
    const inner = (await loc.innerText({ timeout: 1000 }).catch(() => "")).replace(/\s+/g, " ");
    if (inner.length <= Math.max(100, text.length * 4) || !inner.includes(text)) return { ref };
    const marked = await loc.evaluate((el) => { el.setAttribute("data-aitest-narrow", "1"); return true; }).catch(() => false);
    if (!marked) return { ref };
    const [info] = (await page.evaluate(
      `(${COLLECT_SCRIPT})(${JSON.stringify({ testIdAttribute: this.testIdAttr(), narrow: { text } })})`,
    )) as (ElementInfo & { matches?: number })[];
    if (!info?.tag) {
      return { ref, note: `断言目标是整块区域（${inner.length} 字），其中「${text}」出现 ${info?.matches ?? 0} 处，无法自动收窄；建议用 find_text 取具体元素再断言` };
    }
    const narrowed = this.addRef(info);
    return { ref: narrowed.ref, note: `断言目标是整块区域（${inner.length} 字），已改为断言其中显示「${text}」的元素（${narrowed.ref}）` };
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

  /** 按键；传数组时依次按下（如 Tab、Tab、Enter），每个按键各录一步 */
  async press(key: string | string[]) {
    const page = await this.page();
    for (const k of Array.isArray(key) ? key : [key]) {
      await page.keyboard.press(k);
      this.record({ action: "press", key: k });
    }
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
    if (visible) await loc.waitFor({ state: "visible", timeout: EXPLORE_ASSERT_TIMEOUT_MS });
    else await loc.waitFor({ state: "hidden", timeout: EXPLORE_ASSERT_TIMEOUT_MS });
    const recorded = this.recordAssertion({ action: visible ? "expectVisible" : "expectHidden", target: spec, role });
    return { locator: spec, ...(recorded ? {} : { note: "与已录入的断言相同，未重复录入" }) };
  }

  async expectText(ref: string, text: string, timeoutMs = EXPLORE_ASSERT_TIMEOUT_MS) {
    const narrowed = await this.narrow(ref, text);
    const { page, spec, role, dependent } = await this.target(narrowed.ref, { avoidText: text });
    const loc = toLocator(page, spec);
    let actual = "";
    const ok = await poll(async () => {
      actual = (await loc.innerText({ timeout: 1000 }).catch(() => "")).replace(/\s+/g, " ");
      return actual.includes(text);
    }, timeoutMs);
    if (!ok) throw new Error(`断言不成立：元素文本为「${actual.slice(0, 200)}」，不包含「${text}」`);
    // 定位器本身就是按这段文字找的：「包含该文字」恒成立，录成等价的「可见」断言
    const step: Step = dependent ? { action: "expectVisible", target: spec, role } : { action: "expectText", target: spec, text, role };
    const recorded = this.recordAssertion(step);
    const notes = [
      narrowed.note,
      dependent ? "定位器本身按这段文字匹配，已录为「可见」断言；要验证某一行 / 某个字段的值，请对该行里的单元格断言" : undefined,
      recorded ? undefined : "与已录入的断言相同，未重复录入",
    ].filter(Boolean);
    return { locator: spec, actual, ...(notes.length ? { note: notes.join("；") } : {}) };
  }

  async expectNoText(ref: string, text: string, timeoutMs = EXPLORE_ASSERT_TIMEOUT_MS) {
    const { page, spec, role } = await this.target(ref);
    const loc = toLocator(page, spec);
    let actual = "";
    const ok = await poll(async () => {
      actual = (await loc.innerText({ timeout: 1000 }).catch(() => "")).replace(/\s+/g, " ");
      return !actual.includes(text);
    }, timeoutMs);
    if (!ok) throw new Error(`断言不成立：元素文本「${actual.slice(0, 200)}」中包含「${text}」`);
    const recorded = this.recordAssertion({ action: "expectNoText", target: spec, text, role });
    return { locator: spec, ...(recorded ? {} : { note: "与已录入的断言相同，未重复录入" }) };
  }

  /** 输入框 / 下拉框的当前值（下拉框为 option 的 value，如「全部」常为空字符串） */
  async expectValue(ref: string, value: string, timeoutMs = EXPLORE_ASSERT_TIMEOUT_MS) {
    const { page, spec, role } = await this.target(ref);
    const loc = toLocator(page, spec);
    let actual = "";
    const ok = await poll(async () => (actual = await loc.inputValue({ timeout: 1000 }).catch(() => "\u0000")) === value, timeoutMs);
    if (!ok) throw new Error(`断言不成立：当前值为「${actual === "\u0000" ? "（无法读取）" : actual}」，期望「${value}」`);
    const recorded = this.recordAssertion({ action: "expectValue", target: spec, value, role });
    return { locator: spec, ...(recorded ? {} : { note: "与已录入的断言相同，未重复录入" }) };
  }

  async expectUrl(pattern: string, timeoutMs = EXPLORE_ASSERT_TIMEOUT_MS) {
    const page = await this.page();
    if (!(await poll(async () => page.url().includes(pattern), timeoutMs))) {
      throw new Error(`断言不成立：当前 URL 为 ${page.url()}`);
    }
    const recorded = this.recordAssertion({ action: "expectUrl", pattern });
    return { url: page.url(), ...(recorded ? {} : { note: "与已录入的断言相同，未重复录入" }) };
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

  async expectRequest(name: string, fields: Record<string, unknown>, forbidden: string[] = [], timeoutMs = EXPLORE_ASSERT_TIMEOUT_MS) {
    const c = this.captures.get(name);
    if (!c) throw new Error(`未开始抓包：${name}`);
    let matched: Record<string, unknown>[] = [];
    // 一条都没抓到：请求可能还没发出，等满；已抓到但不匹配：多半是字段写错，很快返回并给出实际内容
    const started = Date.now();
    await poll(async () => (matched = matchEvents(c.list, fields)).length > 0
      || (c.list.length > 0 && Date.now() - started >= CAPTURE_MISMATCH_WAIT_MS), timeoutMs);
    if (!matched.length) {
      const seen = c.list.slice(-3).map((r) => `${r.method} ${r.url.slice(0, 160)} 请求体：${r.body === undefined ? "（无）" : JSON.stringify(r.body).slice(0, 200)}`);
      throw new Error(`断言不成立：未捕获到匹配 ${JSON.stringify(fields)} 的上报（共 ${c.list.length} 条）。`
        + `fields 只匹配请求体（JSON / 表单）里的字段，不匹配 URL 查询参数。${seen.length ? `最近抓到：${seen.join("；")}` : ""}`);
    }
    const leaked = forbidden.filter((k) => matched.some((e) => hasKey(e, k)));
    if (leaked.length) throw new Error(`上报中带出了敏感字段：${leaked.join(", ")}`);
    this.record({ action: "expectRequest", name, fields, forbidden, role: c.role });
    return { matched: matched.length };
  }

  /** 数据库断言：由调用方先验证通过（引擎 db-check），这里只录入脚本 */
  recordDbCheck(check: DbCheck) {
    this.record({ action: "expectDb", check });
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
    if (this.opts.cdpEndpoint) {
      // 内嵌浏览器按桌面宽度渲染后缩小显示，Playwright 的截图尺寸不考虑这层缩放（画面只占图的一部分）。
      // 直接截视图实际显示的画面：与用户看到的一致，图也更小；只能是当前可见区域
      await writeViewportCapture(page, path);
      return path;
    }
    // 按 CSS 像素截图：Retina 屏上不放大一倍，图更小，模型读得更快
    await page.screenshot({ path, fullPage, scale: "css" });
    return path;
  }

  recording(): UiStep[] {
    return [...this.steps];
  }

  /** 丢弃最后 n 步录制（例如探索中走错的步骤） */
  undo(n = 1): UiStep[] {
    this.steps.splice(Math.max(0, this.steps.length - n), n);
    return this.recording();
  }

  resetRecording(): void {
    this.steps = [];
    this.currentCaseStep = undefined;
    this.resetCaptures();
  }

  /** 移除抓包监听（调试重新开始时调用，避免旧监听继续累积） */
  resetCaptures(): void {
    for (const c of this.captures.values()) c.off?.();
    this.captures.clear();
  }

  /**
   * 回放一个已录制的步骤（单步调试用）：直接按定位器执行，不写入录制。
   * 断言失败时抛错，错误信息用于界面展示；visualCheck 只截图，不判定。
   */
  async runStep(step: Step, opts: StepRunOptions = {}): Promise<{ note?: string; evidence?: string }> {
    const timeout = opts.timeoutMs ?? 5000;
    const role = step.role ?? DEFAULT_ROLE;
    const page = await this.page(role);
    this.currentRole = role;
    const loc = "target" in step ? toLocator(page, step.target) : undefined;
    switch (step.action) {
      case "goto":
        await page.goto(this.absolute(step.url), { timeout: Math.max(timeout, 30_000) });
        return {};
      case "click":
        await loc!.click({ timeout });
        return {};
      case "fill": {
        const value = step.secretEnv ? opts.secrets?.[step.secretEnv] : step.value;
        if (step.secretEnv && value === undefined) throw new Error(`缺少敏感值 ${step.secretEnv}，请在「角色与登录」中配置`);
        await loc!.fill(value ?? "", { timeout });
        return {};
      }
      case "select":
        await loc!.selectOption(step.value, { timeout });
        return {};
      case "check":
        await loc!.setChecked(step.checked, { timeout });
        return {};
      case "press":
        await page.keyboard.press(step.key);
        return {};
      case "expectVisible":
        await loc!.waitFor({ state: "visible", timeout }).catch(() => { throw new Error("断言不成立：元素在超时内没有出现"); });
        return {};
      case "expectHidden":
        await loc!.waitFor({ state: "hidden", timeout }).catch(() => { throw new Error("断言不成立：元素在超时内仍然可见"); });
        return {};
      case "expectText": {
        let actual = "";
        const ok = await poll(async () => {
          actual = (await loc!.innerText({ timeout: 1000 }).catch(() => "")).replace(/\s+/g, " ");
          return actual.includes(step.text);
        }, timeout);
        if (!ok) throw new Error(`断言不成立：元素文本为「${actual.slice(0, 200)}」，不包含「${step.text}」`);
        return {};
      }
      case "expectNoText": {
        let actual = "";
        const ok = await poll(async () => {
          actual = (await loc!.innerText({ timeout: 1000 }).catch(() => "")).replace(/\s+/g, " ");
          return !actual.includes(step.text);
        }, timeout);
        if (!ok) throw new Error(`断言不成立：元素文本「${actual.slice(0, 200)}」中包含「${step.text}」`);
        return {};
      }
      case "expectValue": {
        let actual = "";
        const ok = await poll(async () => (actual = await loc!.inputValue({ timeout: 1000 }).catch(() => "\u0000")) === step.value, timeout);
        if (!ok) throw new Error(`断言不成立：当前值为「${actual === "\u0000" ? "（无法读取）" : actual}」，期望「${step.value}」`);
        return {};
      }
      case "expectUrl": {
        const base = this.opts.baseUrl?.replace(/\/$/, "");
        const pattern = base && step.pattern.startsWith(base) ? step.pattern.slice(base.length) || "/" : step.pattern;
        if (!(await poll(async () => page.url().includes(pattern), timeout))) throw new Error(`断言不成立：当前 URL 为 ${page.url()}`);
        return {};
      }
      case "startCapture": {
        this.captures.get(step.name)?.off?.();
        const list: CapturedRequest[] = [];
        const listener = (r: import("playwright-core").Request) => {
          if (r.url().includes(step.urlPattern)) list.push({ url: r.url(), method: r.method(), body: parseBody(r.postData()) });
        };
        page.on("request", listener);
        this.captures.set(step.name, { role, pattern: step.urlPattern, list, off: () => page.off("request", listener) });
        return {};
      }
      case "expectRequest": {
        const c = this.captures.get(step.name);
        if (!c) throw new Error(`未开始抓包：${step.name}（请从开始抓包的步骤起执行）`);
        let matched: Record<string, unknown>[] = [];
        await poll(async () => (matched = matchEvents(c.list, step.fields)).length > 0, timeout);
        if (!matched.length) throw new Error(`断言不成立：未捕获到匹配 ${JSON.stringify(step.fields)} 的上报（共 ${c.list.length} 条）`);
        const leaked = (step.forbidden ?? []).filter((k) => matched.some((e) => hasKey(e, k)));
        if (leaked.length) throw new Error(`上报中带出了敏感字段：${leaked.join(", ")}`);
        return {};
      }
      case "installClock":
        await page.clock.install({ time: new Date(step.time) });
        return {};
      case "fastForward":
        await page.clock.fastForward(step.ms);
        return {};
      case "expectDb":
        if (!opts.dbCheck) return { note: "调试模式未连接数据库，已跳过" };
        await opts.dbCheck(step.check);
        return {};
      case "visualCheck": {
        if (!opts.evidenceDir) return { note: "视觉判定需人工确认" };
        const evidence = await this.screenshot(join(opts.evidenceDir, `visual-${Date.now()}.png`));
        return { note: "已截图，视觉判定需人工确认", evidence };
      }
    }
  }
}

/** 用 CDP 截取页面当前显示的画面（不裁剪，缩放下也准确） */
export async function writeViewportCapture(page: Page, path: string): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  try {
    const { data } = await cdp.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(path, Buffer.from(data, "base64"));
  } finally {
    await cdp.detach().catch(() => undefined);
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
