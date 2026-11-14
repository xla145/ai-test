import type { Page } from "playwright-core";
import { z } from "zod";
import { scopeLocator, type Within } from "./locator.js";

const text = z.string().trim().min(1).max(200);
export const visualTargetSchema = z.object({
  page: text,
  scope: z.array(z.object({
    kind: z.enum(["region", "dialog", "row", "form_item", "listbox"]),
    name: text,
    key: text.optional(),
  }).strict()).min(1).max(6),
  control: z.enum(["textbox", "checkbox", "combobox", "button", "option"]),
  name: text.optional(), label: text.optional(), placeholder: text.optional(), text: text.optional(),
}).strict().superRefine((target, ctx) => {
  if (![target.name, target.label, target.placeholder, target.text].some(Boolean)) ctx.addIssue({ code: "custom", message: "目标必须声明名称、标签、占位文字或自身文字" });
  if (target.scope.some(s => s.kind === "row" && !s.key)) ctx.addIssue({ code: "custom", message: "列表行必须声明唯一业务 key" });
});
export type VisualTarget = z.infer<typeof visualTargetSchema>;
export type LocateIntent = "click" | "fill" | "check";

/** Scope is validated against DOM independently; the model only receives this prompt. */
export function locateRequest(input: { prompt?: string; target?: VisualTarget; intent?: LocateIntent; text?: string }) {
  if (!input.target) {
    if (!input.prompt?.trim()) throw new Error("请提供结构化 target 或非空 prompt");
    return { ...input, prompt: input.prompt.trim() };
  }
  const target = visualTargetSchema.parse(input.target);
  const intent: LocateIntent = input.intent ?? (target.control === "textbox" ? "fill" : target.control === "checkbox" ? "check" : "click");
  if ((intent === "fill" && target.control !== "textbox") || (intent === "check" && target.control !== "checkbox")) throw new Error("intent 与控件类型不匹配");
  if (input.text && input.text !== target.text && input.text !== target.placeholder) throw new Error("text 必须是目标自身文字或 placeholder，关联标签请放入 target.label");
  const kinds = { region: "区域", dialog: "对话框", row: "列表行", form_item: "表单项", listbox: "选项列表" };
  const controls = { textbox: "可编辑输入框", checkbox: "复选框开关", combobox: "下拉框", button: "按钮", option: "选项" };
  const scopes = target.scope.map(s => `${kinds[s.kind]}「${s.name}」${s.key ? `（对象「${s.key}」）` : ""}`).join("内的");
  const identity = [target.label && `关联标签为「${target.label}」`, target.name && `名称为「${target.name}」`,
    target.placeholder && `占位文字为「${target.placeholder}」`, target.text && `自身文字为「${target.text}」`].filter(Boolean).join("，");
  const purpose = intent === "fill" ? "输入内容" : intent === "check" ? "设置勾选状态" : target.control === "combobox" ? "打开选项" : "点击";
  return {
    target, intent, text: input.text ?? target.text ?? target.placeholder,
    prompt: `在「${target.page}」页面的${scopes}内，定位${controls[target.control]}，${identity}，用于${purpose}。目标必须能由这些条件唯一确定。`,
  };
}

/** Resolve each scope uniquely before spending a visual-model call. No nearest/first fallback. */
export async function resolveTargetScope(page: Page, target: VisualTarget): Promise<Within> {
  let parent: Within | undefined;
  const selectors = { region: '[role="region"],section', dialog: '[role="dialog"],dialog,.el-dialog,.el-drawer',
    row: 'tr,[role="row"]', form_item: '.el-form-item', listbox: '[role="listbox"]' };
  for (const part of target.scope) {
    const css = selectors[part.kind].split(",").map(s => `${s}:visible`).join(",");
    const variants: Within[] = part.kind === "row"
      ? [{ css, hasExactText: part.key!, within: parent }]
      : [
        { css: selectors[part.kind].split(",").map(s => `${s}[aria-label=${JSON.stringify(part.name)}]:visible`).join(","), within: parent },
        { css, hasExactText: part.name, within: parent },
      ];
    let resolved: Within | undefined;
    for (const candidate of variants) {
      const count = await scopeLocator(page, candidate).count();
      if (count > 1) throw new Error(`目标范围不唯一：${part.name}，匹配 ${count} 处`);
      if (count === 1) { resolved = candidate; break; }
    }
    if (!resolved) throw new Error(`目标范围缺失：${part.name}${part.key ? `（${part.key}）` : ""}`);
    if (part.kind !== "row" && part.key) {
      const loc = scopeLocator(page, resolved);
      if (await loc.getByText(part.key, { exact: true }).count() !== 1) throw new Error(`目标对象不匹配：${part.key}`);
      // Persist the key check as well as the scope name into replay.
      resolved = { ...resolved, hasExactText: [...[resolved.hasExactText ?? []].flat(), part.key] };
    }
    parent = resolved;
  }
  return parent!;
}
