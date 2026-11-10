import type { Locator, Page } from "playwright-core";

/**
 * 选择器规范（架构文档第 7 节）：data-testid → getByRole / getByLabel → 文本 → CSS，禁用绝对 XPath。
 * 探索时为每个元素按优先级算出候选定位器，取第一个在页面上唯一的那个写进脚本。
 */
export type LocatorSpec =
  | { kind: "testid"; value: string }
  | { kind: "role"; role: string; name: string }
  | { kind: "label"; value: string }
  | { kind: "placeholder"; value: string }
  | { kind: "text"; value: string }
  | { kind: "css"; value: string };

/** 页面内采集到的元素描述 */
export interface ElementInfo {
  tag: string;
  role?: string;
  name?: string;
  label?: string;
  placeholder?: string;
  testId?: string;
  text?: string;
  css: string;
}

const PRIORITY: LocatorSpec["kind"][] = ["testid", "role", "label", "placeholder", "text", "css"];

export function candidates(el: ElementInfo): LocatorSpec[] {
  const out: LocatorSpec[] = [];
  if (el.testId) out.push({ kind: "testid", value: el.testId });
  if (el.role && el.name) out.push({ kind: "role", role: el.role, name: el.name });
  if (el.label) out.push({ kind: "label", value: el.label });
  if (el.placeholder) out.push({ kind: "placeholder", value: el.placeholder });
  if (el.text && el.text.length <= 40) out.push({ kind: "text", value: el.text });
  if (el.css && !el.css.startsWith("/")) out.push({ kind: "css", value: el.css });
  return out.sort((a, b) => PRIORITY.indexOf(a.kind) - PRIORITY.indexOf(b.kind));
}

export function toLocator(page: Page, spec: LocatorSpec): Locator {
  switch (spec.kind) {
    case "testid":
      return page.getByTestId(spec.value);
    case "role":
      return page.getByRole(spec.role as Parameters<Page["getByRole"]>[0], { name: spec.name, exact: true });
    case "label":
      return page.getByLabel(spec.value, { exact: true });
    case "placeholder":
      return page.getByPlaceholder(spec.value, { exact: true });
    case "text":
      return page.getByText(spec.value, { exact: true });
    case "css":
      return page.locator(spec.value);
  }
}

const s = (v: string) => JSON.stringify(v);

/** 生成脚本中的定位器代码 */
export function toCode(spec: LocatorSpec, pageVar = "page"): string {
  switch (spec.kind) {
    case "testid":
      return `${pageVar}.getByTestId(${s(spec.value)})`;
    case "role":
      return `${pageVar}.getByRole(${s(spec.role)}, { name: ${s(spec.name)}, exact: true })`;
    case "label":
      return `${pageVar}.getByLabel(${s(spec.value)}, { exact: true })`;
    case "placeholder":
      return `${pageVar}.getByPlaceholder(${s(spec.value)}, { exact: true })`;
    case "text":
      return `${pageVar}.getByText(${s(spec.value)}, { exact: true })`;
    case "css":
      return `${pageVar}.locator(${s(spec.value)})`;
  }
}

/** 取第一个在页面上唯一匹配的候选 */
export async function pickUnique(page: Page, specs: LocatorSpec[]): Promise<LocatorSpec | undefined> {
  for (const spec of specs) {
    try {
      if ((await toLocator(page, spec).count()) === 1) return spec;
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
  const cssOf = (el) => {
    if (el.id && /^[A-Za-z][\w-]*$/.test(el.id)) return "#" + el.id;
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && parts.length < 4) {
      let part = cur.tagName.toLowerCase();
      const cls = [...cur.classList].filter((c) => /^[A-Za-z][\w-]*$/.test(c)).slice(0, 2);
      if (cls.length) part += "." + cls.join(".");
      const parent = cur.parentElement;
      if (parent) {
        const same = [...parent.children].filter((c) => c.tagName === cur.tagName);
        if (same.length > 1) part += ":nth-of-type(" + (same.indexOf(cur) + 1) + ")";
      }
      parts.unshift(part);
      if (cur.id) break;
      cur = parent;
    }
    return parts.join(" > ");
  };
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && st.visibility !== "hidden" && st.display !== "none";
  };
  const describe = (el) => {
    const role = roleOf(el);
    const text = clean(el.innerText || el.textContent);
    return {
      tag: el.tagName.toLowerCase(),
      role,
      name: role ? nameOf(el, role) : undefined,
      label: labelOf(el),
      placeholder: el.getAttribute("placeholder") || undefined,
      testId: el.getAttribute(testIdAttribute) || undefined,
      text: el.children.length === 0 && text ? text : undefined,
      css: cssOf(el),
      value: "value" in el && typeof el.value === "string" ? el.value : undefined,
      checked: "checked" in el ? el.checked : undefined,
      disabled: el.disabled || el.getAttribute("aria-disabled") === "true" || undefined,
    };
  };
  if (root) {
    const el = document.elementFromPoint(root.x, root.y);
    return el ? [describe(el.closest("button,a,input,select,textarea,[role],[" + testIdAttribute + "]") || el)] : [];
  }
  const selector = "a[href],button,input,select,textarea,summary,[role],[" + testIdAttribute + "],[onclick],[contenteditable=true],h1,h2,h3,h4,h5,h6";
  return [...document.querySelectorAll(selector)].filter(visible).slice(0, 300).map(describe);
}`;
