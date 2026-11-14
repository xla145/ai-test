import type { Locator, Page } from "playwright-core";

/**
 * 选择器规范（架构文档第 7 节）：data-testid → getByRole / getByLabel → 文本 → CSS，禁用绝对 XPath。
 * 探索时为每个元素按优先级算出候选定位器，取第一个在页面上唯一的那个写进脚本。
 */
/** 先限定到某一行（如表格里含「TAG-1001」的那一行），再在行内定位；用于列表中重复出现的单元格、按钮 */
export interface Within { css: string; hasText?: string; hasExactText?: string | string[]; within?: Within }

export type LocatorSpec = (
  | { kind: "testid"; value: string }
  | { kind: "role"; role: string; name: string }
  | { kind: "label"; value: string }
  | { kind: "placeholder"; value: string }
  | { kind: "text"; value: string }
  /** hasText：按元素包含的文字筛选，代替 nth-of-type 这类位置选择器 */
  | { kind: "css"; value: string; hasText?: string }
) & { within?: Within };

/** 页面内采集到的元素描述 */
export interface ElementInfo {
  /** Ephemeral identity, never serialized into regression selectors. */
  nodeId?: string;
  tag: string;
  role?: string;
  name?: string;
  label?: string;
  placeholder?: string;
  testId?: string;
  text?: string;
  /** 页面内唯一的 CSS（不用生成的 id / class；必要时才带 nth-of-type） */
  css: string;
  /** 元素自身的标签 + 稳定 class（如 li.el-sub-menu），配合 hasText 使用 */
  cssLoose?: string;
  /** 元素的简短文字（自身文字或第一段文字），配合 cssLoose 使用 */
  labelText?: string;
  /** 元素在表格行里：行选择器、能唯一确定该行的文字、行内的相对 CSS */
  scope?: { css: string; key?: string; exactKey?: string; inner: string; within?: Within };
  row?: { css: string; key: string; inner: string };
}

/** 依赖元素位置的 CSS：页面结构或数据顺序一变就会点错 */
export const isPositional = (spec: LocatorSpec) => spec.kind === "css" && !spec.within && !spec.hasText && spec.value.includes(":nth-of-type");

/**
 * 候选按稳定性排列：testid → role / label / placeholder / 文本 → 限定到行内 → CSS + 文字 → 纯 CSS。
 */
export function candidates(el: ElementInfo): LocatorSpec[] {
  const out: LocatorSpec[] = [];
  if (el.scope) out.push({ kind: "css", value: el.scope.inner, within: { css: el.scope.css, hasText: el.scope.key, hasExactText: el.scope.exactKey, within: el.scope.within } });
  if (el.testId) out.push({ kind: "testid", value: el.testId });
  if (el.role && el.name) out.push({ kind: "role", role: el.role, name: el.name });
  if (el.label) out.push({ kind: "label", value: el.label });
  if (el.placeholder) out.push({ kind: "placeholder", value: el.placeholder });
  if (el.text && el.text.length <= 40) out.push({ kind: "text", value: el.text });
  if (el.row?.key) {
    const within = { css: el.row.css, hasText: el.row.key };
    if (el.role && el.name) out.push({ kind: "role", role: el.role, name: el.name, within });
    if (el.text && el.text.length <= 40) out.push({ kind: "text", value: el.text, within });
    if (el.row.inner) out.push({ kind: "css", value: el.row.inner, within });
  }
  if (el.cssLoose && el.labelText) out.push({ kind: "css", value: el.cssLoose, hasText: el.labelText });
  // 带 nth-of-type 的 CSS 排在最后
  if (el.css && !el.css.startsWith("/")) out.push({ kind: "css", value: el.css });
  return out;
}

/** 定位器用来识别元素的文字（断言这些文字等于断言定位器本身） */
export function specTexts(spec: LocatorSpec): string[] {
  const own = spec.kind === "role" ? [spec.name] : spec.kind === "css" ? (spec.hasText ? [spec.hasText] : []) : [spec.value];
  const scopeTexts = (scope?: Within): string[] => scope ? [scope.hasText, ...[scope.hasExactText ?? []].flat(), ...scopeTexts(scope.within)].filter((x): x is string => Boolean(x)) : [];
  return [...own, ...scopeTexts(spec.within)];
}

export function scopeLocator(page: Page, scope: Within): Locator {
  const root = scope.within ? scopeLocator(page, scope.within) : page;
  let loc = root.locator(scope.css, scope.hasText ? { hasText: scope.hasText } : {});
  for (const text of [scope.hasExactText ?? []].flat()) loc = loc.filter({ has: page.getByText(text, { exact: true }) });
  return loc;
}

export function toLocator(page: Page, spec: LocatorSpec): Locator {
  const root: Page | Locator = spec.within ? scopeLocator(page, spec.within) : page;
  switch (spec.kind) {
    case "testid":
      return root.getByTestId(spec.value);
    case "role":
      return root.getByRole(spec.role as Parameters<Page["getByRole"]>[0], { name: spec.name, exact: true });
    case "label":
      return root.getByLabel(spec.value, { exact: true });
    case "placeholder":
      return root.getByPlaceholder(spec.value, { exact: true });
    case "text":
      return root.getByText(spec.value, { exact: true });
    case "css":
      return spec.hasText ? root.locator(spec.value, { hasText: spec.hasText }) : root.locator(spec.value);
  }
}

const s = (v: string) => JSON.stringify(v);

/** 生成脚本中的定位器代码 */
export function toCode(spec: LocatorSpec, pageVar = "page"): string {
  const scopeCode = (scope: Within): string => {
    const parent = scope.within ? scopeCode(scope.within) : pageVar;
    let loc = `${parent}.locator(${s(scope.css)}${scope.hasText ? `, { hasText: ${s(scope.hasText)} }` : ""})`;
    for (const text of [scope.hasExactText ?? []].flat()) loc += `.filter({ has: ${pageVar}.getByText(${s(text)}, { exact: true }) })`;
    return loc;
  };
  const root = spec.within ? scopeCode(spec.within) : pageVar;
  switch (spec.kind) {
    case "testid":
      return `${root}.getByTestId(${s(spec.value)})`;
    case "role":
      return `${root}.getByRole(${s(spec.role)}, { name: ${s(spec.name)}, exact: true })`;
    case "label":
      return `${root}.getByLabel(${s(spec.value)}, { exact: true })`;
    case "placeholder":
      return `${root}.getByPlaceholder(${s(spec.value)}, { exact: true })`;
    case "text":
      return `${root}.getByText(${s(spec.value)}, { exact: true })`;
    case "css":
      return spec.hasText ? `${root}.locator(${s(spec.value)}, { hasText: ${s(spec.hasText)} })` : `${root}.locator(${s(spec.value)})`;
  }
}

/** 取第一个在页面上唯一匹配的候选 */
export async function pickUnique(page: Page, specs: LocatorSpec[], nodeId?: string): Promise<LocatorSpec | undefined> {
  for (const spec of specs) {
    try {
      const locator = toLocator(page, spec);
      if (await locator.count() !== 1) continue;
      if (nodeId && !await locator.evaluate((el, expected) => {
        const registry = (window as any)[Symbol.for("aitest.elementIdentity")];
        return registry?.nodes.get(el) === expected;
      }, nodeId)) continue;
      return spec;
    } catch {
      // 非法选择器等，跳过
    }
  }
  return undefined;
}

/**
 * 在页面内执行：收集可交互元素与标题类元素的描述。
 * 以字符串形式注入，避免依赖打包器对函数的转换。
 */
export const COLLECT_SCRIPT = String.raw`(args) => {
  const { testIdAttribute, root } = args;
  const identityKey = Symbol.for("aitest.elementIdentity");
  const identity = window[identityKey] || (window[identityKey] = { prefix: Array.from(crypto.getRandomValues(new Uint32Array(4))).join("-"), next: 0, nodes: new WeakMap() });
  const nodeId = (el) => { if (!identity.nodes.has(el)) identity.nodes.set(el, identity.prefix + ":" + (++identity.next)); return identity.nodes.get(el); };
  const IMPLICIT = { BUTTON: "button", A: "link", SELECT: "combobox", TEXTAREA: "textbox",
    H1: "heading", H2: "heading", H3: "heading", H4: "heading", H5: "heading", H6: "heading",
    NAV: "navigation", TABLE: "table", DIALOG: "dialog", IMG: "img", LI: "listitem" };
  const INPUT_ROLE = { checkbox: "checkbox", radio: "radio", button: "button", submit: "button", reset: "button",
    range: "slider", search: "searchbox", number: "spinbutton" };
  const clean = (t) => (t || "").replace(/\s+/g, " ").trim();
  const roleOf = (el) => {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit.split(" ")[0];
    if (el.tagName === "A" && !el.hasAttribute("href")) return undefined;
    if (el.tagName === "INPUT") return INPUT_ROLE[(el.getAttribute("type") || "text").toLowerCase()] || "textbox";
    return IMPLICIT[el.tagName];
  };
  const labelOf = (el) => {
    if (el.labels && el.labels.length) return clean(el.labels[0].innerText);
    const by = el.getAttribute("aria-labelledby");
    if (by) return clean(by.split(" ").map((id) => document.getElementById(id)?.innerText || "").join(" "));
    return undefined;
  };
  const nameOf = (el, role) => {
    const aria = el.getAttribute("aria-label");
    if (aria) return clean(aria);
    const label = labelOf(el);
    if (label) return label;
    if (el.tagName === "IMG") return clean(el.getAttribute("alt"));
    if (el.tagName === "INPUT" && ["button", "submit", "reset"].includes(el.type)) return clean(el.value);
    if (["textbox", "combobox", "searchbox", "spinbutton"].includes(role)) return clean(el.getAttribute("title"));
    return clean(el.innerText || el.textContent).slice(0, 80) || clean(el.getAttribute("title"));
  };
  // 框架生成的 id / class（el-id-1024-3、message_2、el-table_1_column_3、css-1x2y）和状态 class（is-active）每次渲染都可能变，不进选择器
  const UNSTABLE_CLASS = /\d|^(is|has)-(active|focus|focused|hover|checked|selected|disabled|opened|open|expanded|current|loading|visible|hidden|show)$|^(active|current|selected|focus|hover|open|show)$|^(router-link|v-|css-|sc-|jsx-|_)/;
  const stableId = (id) => /^[A-Za-z][\w-]*$/.test(id) && !/\d/.test(id);
  const stableClasses = (el) => [...el.classList].filter((c) => /^[A-Za-z][\w-]*$/.test(c) && !UNSTABLE_CLASS.test(c)).slice(0, 2);
  const looseOf = (el) => {
    const cls = stableClasses(el);
    return cls.length ? el.tagName.toLowerCase() + "." + cls.join(".") : undefined;
  };
  // 一层选择器：稳定 id，或标签 + 稳定 class；同级里分不开时才加 nth-of-type
  const partOf = (el) => {
    if (el.id && stableId(el.id)) return "#" + el.id;
    let part = looseOf(el) || el.tagName.toLowerCase();
    const parent = el.parentElement;
    if (parent && [...parent.children].filter((c) => c.matches(part)).length > 1) {
      part += ":nth-of-type(" + ([...parent.children].filter((c) => c.tagName === el.tagName).indexOf(el) + 1) + ")";
    }
    return part;
  };
  // 自下而上拼接，在 scope 内唯一就停：选择器尽量短，少依赖页面结构
  const pathOf = (el, stop, scope) => {
    const parts = [];
    for (let cur = el; cur && cur.nodeType === 1 && cur !== stop && parts.length < 5; cur = cur.parentElement) {
      const part = partOf(cur);
      parts.unshift(part);
      try { if (scope.querySelectorAll(parts.join(" > ")).length === 1) break; } catch { /* 非法选择器继续向上 */ }
      if (part.startsWith("#")) break;
    }
    return parts.join(" > ");
  };
  const cssOf = (el) => pathOf(el, null, document);
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && st.visibility !== "hidden" && st.display !== "none";
  };
  const firstText = (el) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const t = clean(n.textContent);
      if (t && n.parentElement && visible(n.parentElement)) return t;
    }
    return undefined;
  };
  // 表格行：按从左到右取第一段只在这一行出现的文字作为行的标识（通常是编号 / 名称列，比状态列稳定）；
  // 纯序号（1、2、3）随排序变化，不用
  const rowTexts = new Map();
  const rowsOf = (sel) => {
    if (!rowTexts.has(sel)) rowTexts.set(sel, [...document.querySelectorAll(sel)].map((r) => clean(r.textContent).toLowerCase()));
    return rowTexts.get(sel);
  };
  const rowOf = (el) => {
    const r = el.closest("tr,[role=row]");
    if (!r || r === el) return undefined;
    const sel = r.tagName === "TR" ? "tr" : "[role=row]";
    const texts = [];
    for (const c of r.querySelectorAll("*")) {
      if (c.children.length) continue;
      const t = clean(c.textContent);
      if (t && t.length <= 40 && !/^\d{1,3}$/.test(t) && !texts.includes(t)) texts.push(t);
      if (texts.length >= 8) break;
    }
    const key = texts.find((t) => rowsOf(sel).filter((x) => x.includes(t.toLowerCase())).length === 1);
    return key ? { css: sel, key, inner: pathOf(el, r, r) } : undefined;
  };
  const namedPanel = (el) => {
    for (let panel = el.parentElement; panel; panel = panel.parentElement) {
      if (!panel.matches('section,[role="region"],.el-drawer,.el-dialog,[role="dialog"],dialog')) continue;
      const aria = panel.getAttribute("aria-label");
      if (aria) return { css: panel.tagName.toLowerCase() + "[aria-label=" + JSON.stringify(aria) + "]:visible", element: panel };
      const heading = panel.querySelector('h1,h2,h3,.el-dialog__title,.el-drawer__title');
      const name = heading && clean(heading.textContent);
      if (name) return { css: (looseOf(panel) || panel.tagName.toLowerCase()) + ":visible", hasExactText: name, element: panel };
    }
  };
  const formScope = (el) => {
    const form = el.closest(".el-form-item");
    const label = form && form.querySelector(".el-form-item__label");
    const key = label && clean(label.textContent);
    if (key && form !== el) {
      const panel = namedPanel(form);
      const within = panel && { css: panel.css, hasExactText: panel.hasExactText };
      return { css: ".el-form-item:visible", exactKey: key, inner: pathOf(el, form, form), within };
    }
    const panel = namedPanel(el);
    // No expected/display value is used to identify a named region.
    if (panel) {
      const container = panel.element;
      if (container && container !== el) return { css: panel.css, exactKey: panel.hasExactText, inner: pathOf(el, container, container) };
    }
    return undefined;
  };
  const describe = (el) => {
    const role = roleOf(el);
    const text = clean(el.innerText || el.textContent);
    const short = text && text.length <= 40 ? text : firstText(el);
    return {
      nodeId: nodeId(el),
      tag: el.tagName.toLowerCase(),
      role,
      name: role ? nameOf(el, role) : undefined,
      label: labelOf(el),
      placeholder: el.getAttribute("placeholder") || undefined,
      testId: el.getAttribute(testIdAttribute) || undefined,
      text: el.children.length === 0 && text ? text : undefined,
      css: args.scopeElement ? pathOf(el, args.scopeElement, args.scopeElement) : cssOf(el),
      cssLoose: looseOf(el),
      labelText: short && short.length <= 40 ? short : undefined,
      row: rowOf(el),
      scope: formScope(el),
      value: "value" in el && typeof el.value === "string" ? el.value : undefined,
      checked: "checked" in el ? el.checked : undefined,
      disabled: el.disabled || el.getAttribute("aria-disabled") === "true" || undefined,
    };
  };
  const normalize = (el, intent) => {
    if (!intent) return el;
    const sel = intent === "fill" ? 'input:not([type=hidden]):not([readonly]):not([disabled]),textarea:not([readonly]):not([disabled]),[contenteditable=true]'
      : intent === "check" ? 'input[type=checkbox],input[type=radio],[role=switch],[role=checkbox]'
      : 'button,a[href],input:not([type=hidden]),select,textarea,[role=button],[role=combobox],[role=menuitem],[role=option],[role=tab],[onclick],.el-select__wrapper';
    if (intent === "click") {
      const select = el.closest(".el-select");
      const wrapper = select && select.querySelector(".el-select__wrapper");
      if (wrapper && visible(wrapper)) return wrapper;
    }
    if (el.matches(sel) && visible(el)) return el;
    if (el.tagName === "LABEL" && el.control && el.control.matches(sel) && visible(el.control)) return el.control;
    const field = el.closest(".el-form-item") || el.closest("label,.el-switch,.el-checkbox") || el;
    const found = [...field.querySelectorAll(sel)].filter(visible);
    if (found.length === 1) return found[0];
    if (intent === "click") {
      const parent = el.closest(sel);
      if (parent && visible(parent)) return parent;
    }
    throw new Error("目标类型不匹配或存在多个控件，请限定表单项；不能操作文字标签或整个容器");
  };
  if (args.normalize) {
    const targets = [args.normalize.element].filter(Boolean);
    if (targets.length !== 1) throw new Error("目标已变化或不唯一，请重新定位");
    const el = targets[0];
    if (args.normalize.intent === "selected") {
      const select = el.closest(".el-select");
      if (!select) return [];
      const selection = select.querySelector(".el-select__selection");
      if (!selection) throw new Error("无法识别下拉框的选中值区域");
      if (args.scopeElement && !args.scopeElement.contains(selection)) throw new Error("选中值越出指定范围");
      return [describe(selection)];
    }
    const target = normalize(el, args.normalize.intent);
    if (args.scopeElement && !args.scopeElement.contains(target)) throw new Error("目标控件越出指定范围");
    return [describe(target)];
  }
  if (args.narrow) {
    // 断言落在大容器上时，找容器里真正显示这段文字的元素（只有一处时才换）
    const box = document.querySelector("[data-aitest-narrow]");
    if (!box) return [];
    box.removeAttribute("data-aitest-narrow");
    const t = args.narrow.text;
    const skipTag = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1 };
    const has = (el) => clean(el.textContent).includes(t);
    const found = [...box.querySelectorAll("*")].filter((el) => !skipTag[el.tagName] && has(el)
      && ![...el.children].some((c) => !skipTag[c.tagName] && has(c)) && visible(el));
    const exact = found.filter((el) => clean(el.textContent) === t);
    const tight = found.filter((el) => clean(el.textContent).replace(t, "").replace(/\s+/g, "").length <= Math.max(8, t.length));
    const pick = exact.length === 1 ? exact[0] : !exact.length && tight.length === 1 ? tight[0] : undefined;
    return pick ? [describe(pick)] : [{ tag: "", css: "", matches: exact.length || tight.length }];
  }
  if (typeof args.text === "string" && args.text) {
    // 按文本找元素：取文本包含目标、且没有子元素也包含它的最内层可见元素（表格单元格、徽标、统计文字等）
    const norm = (el) => clean(el.textContent);
    const hit = (el) => (args.exact ? norm(el) === args.text : norm(el).includes(args.text));
    const skip = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1 };
    const out = [];
    for (const el of document.body ? document.body.querySelectorAll("*") : []) {
      if (skip[el.tagName] || !hit(el)) continue;
      if ([...el.children].some((c) => !skip[c.tagName] && hit(c))) continue;
      if (!visible(el)) continue;
      const row = el.closest("tr,li,[role=row],[role=listitem]");
      out.push({ ...describe(el), text: norm(el).slice(0, 120),
        context: row && row !== el ? clean(row.innerText || row.textContent).slice(0, 160) : undefined });
      if (out.length >= (args.limit || 10)) break;
    }
    return out;
  }
  if (args.point) {
    // 视觉定位落点 → 元素：默认取落点处最内层元素，只有可交互祖先足够小时才上升到它（避免整行 / 整个容器）；
    // 给了 expect 文本时，要求元素文本包含它，落点处没有就在附近找最近的一个
    const { x, y, rect, expect, radius } = args.point;
    const vw = window.innerWidth, vh = window.innerHeight;
    const area = (el) => { const r = el.getBoundingClientRect(); return r.width * r.height; };
    const center = (el) => { const r = el.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; };
    const iou = (el) => {
      if (!rect) return 0;
      const r = el.getBoundingClientRect();
      const w = Math.max(0, Math.min(r.right, rect.left + rect.width) - Math.max(r.left, rect.left));
      const h = Math.max(0, Math.min(r.bottom, rect.top + rect.height) - Math.max(r.top, rect.top));
      const inter = w * h;
      return inter / (r.width * r.height + rect.width * rect.height - inter || 1);
    };
    const own = (el) => clean(el.textContent);
    const targetText = (el) => [own(el), el.getAttribute("placeholder"), el.getAttribute("aria-label"), labelOf(el)].filter(Boolean).join(" ");
    const leaf = document.elementFromPoint(x, y);
    const scope = args.scopeElement;
    if (scope && (!leaf || !scope.contains(leaf))) throw new Error("视觉目标不在指定范围内，请重新定位");
    const chain = [];
    for (let cur = leaf; cur && cur !== document.body && chain.length < 8; cur = cur.parentElement) if (visible(cur)) chain.push(cur);
    const interactiveSel = "button,a,input,select,textarea,[role],[" + testIdAttribute + "]";
    const small = (el) => area(el) <= vw * vh * 0.1;
    const result = (el, extra) => {
      const target = normalize(el, args.point.intent);
      if (scope && !scope.contains(target)) throw new Error("目标控件越出指定范围");
      const guard = args.point.target;
      if (guard) {
        const mismatch = (target) => {
          const control = guard.control;
          const actualRole = roleOf(target);
          const select = target.closest('.el-select');
          const roleOk = control === 'textbox' ? ['textbox','searchbox','spinbutton'].includes(actualRole)
            : control === 'checkbox' ? ['checkbox','switch'].includes(actualRole)
            : control === 'combobox' ? actualRole === 'combobox' || !!select
            : actualRole === control;
          if (!roleOk) return "目标控件类型与结构化描述不匹配";
          const fieldLabel = target.closest('.el-form-item')?.querySelector('.el-form-item__label');
          const labels = [labelOf(target), fieldLabel && clean(fieldLabel.textContent)];
          const names = [nameOf(target, actualRole), select?.querySelector('[role=combobox]')?.getAttribute('aria-label')];
          if (guard.label && !labels.includes(guard.label)) return "目标关联标签不匹配";
          if (guard.name && !names.includes(guard.name)) return "目标名称不匹配";
          if (guard.placeholder && target.getAttribute('placeholder') !== guard.placeholder) return "目标占位文字不匹配";
          if (guard.text && own(target) !== guard.text) return "目标自身文字不匹配";
        };
        const reason = mismatch(target);
        if (reason) throw new Error(reason);
        const matches = new Set();
        for (const candidate of (scope || document.body).querySelectorAll('input,textarea,button,select,a,[role],.el-select__wrapper,[contenteditable=true]')) {
          if (!visible(candidate)) continue;
          try {
            const normalized = normalize(candidate, args.point.intent);
            if ((!scope || scope.contains(normalized)) && !mismatch(normalized)) matches.add(normalized);
          } catch { /* A different control is not a target candidate. */ }
        }
        if (matches.size !== 1 || !matches.has(target)) throw new Error("目标描述不唯一，请补充区域、表单项或对象身份");
      }
      return { ...describe(target), text: own(target).slice(0, 120), ...extra };
    };
    if (!expect) {
      if (!chain.length) return [];
      const inner = chain[0];
      const act = inner.closest(interactiveSel);
      let pick = act && act !== document.body && small(act) && area(act) <= Math.max(area(inner) * 6, 2500) ? act : inner;
      if (rect) {
        const best = chain.reduce((a, b) => (iou(b) > iou(a) ? b : a), pick);
        if (iou(best) > iou(pick) + 0.2) pick = best;
      }
      return [result(pick, { matched: undefined })];
    }
    const has = (el) => targetText(el).includes(expect);
    // 元素文本基本就是目标：去掉目标后剩下的文字不多。整行、整个单元格这类还带着别的内容的元素不算命中
    const tight = (el) => has(el) && (own(el) || el.getAttribute("placeholder") || el.getAttribute("aria-label") || labelOf(el) || "").replace(expect, "").replace(/\s+/g, "").length <= Math.max(8, expect.length);
    const innermost = chain.find(tight);
    if (innermost) {
      const act = innermost.closest(interactiveSel);
      const pick = act && small(act) && tight(act) ? act : innermost;
      return [result(pick, { matched: true })];
    }
    // 落点不对：在页面里找包含目标文本的最内层可见元素，取离落点最近的
    const skip = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1 };
    const found = [];
    for (const el of (scope || document.body)?.querySelectorAll("*") || []) {
      if (skip[el.tagName] || !has(el) || !visible(el)) continue;
      if ([...el.children].some((c) => !skip[c.tagName] && has(c))) continue;
      if (!tight(el)) continue;
      const [cx, cy] = center(el);
      found.push({ el, d: Math.hypot(cx - x, cy - y) });
    }
    found.sort((a, b) => a.d - b.d);
    const atPoint = chain.length ? own(chain[0]).slice(0, 80) : "";
    if (found.length && found[0].d <= radius) {
      return [result(found[0].el, { matched: true, adjusted: Math.round(found[0].d), pointText: atPoint })];
    }
    return [{ tag: "", css: "", matched: false, pointText: atPoint, elsewhere: found.length,
      nearestDistance: found.length ? Math.round(found[0].d) : undefined }];
  }
  if (root) {
    const el = document.elementFromPoint(root.x, root.y);
    return el ? [describe(el.closest("button,a,input,select,textarea,[role],[" + testIdAttribute + "]") || el)] : [];
  }
  const selector = "a[href],button,input,select,textarea,summary,[role],[" + testIdAttribute + "],[onclick],[contenteditable=true],h1,h2,h3,h4,h5,h6";
  return [...document.querySelectorAll(selector)].filter(visible).slice(0, 300).map(describe);
}`;
