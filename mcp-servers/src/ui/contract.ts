import { z } from "zod";
import { visualTargetSchema } from "./target.js";

const text = z.string().min(1).max(4000);
const preconditionCheck = z.object({
  id: z.string().regex(/^P\d+(?:\.\d+)*$/),
  sourceIndices: z.array(z.number().int().positive()).min(1),
  sourceQuotes: z.array(text).min(1),
  statement: text,
  expected: text,
  method: z.enum(["session", "ui", "api", "database", "manual"]),
  verificationHint: text.optional(),
  dependsOn: z.array(z.string().regex(/^P\d+(?:\.\d+)*$/)).default([]),
}).strict();
export const executionContractSchema = z.object({
  version: z.literal(1),
  status: z.enum(["ready", "needs_clarification"]),
  issues: z.array(text).max(50),
  // 原始前置条件和预期必须原样保留，不能通过转换删减覆盖。
  preconditions: z.array(text),
  // Optional during migration; when present it is the atomic, evidence-bearing plan.
  preconditionChecks: z.array(preconditionCheck).optional(),
  steps: z.array(z.object({
    index: z.number().int().positive(),
    source: text,
    actions: z.array(z.object({
      action: z.enum(["navigate", "click", "fill", "check", "select", "press", "observe", "capture", "clock", "database"]),
      instruction: text,
      target: visualTargetSchema.optional(),
      // 尚未观察页面时保存业务定位描述，探索时再解析为真实控件，不虚构 DOM。
      targetHint: text.optional(),
      role: text.optional(),
      value: z.union([z.string(), z.boolean(), z.number()]).optional(),
    }).strict()).max(50),
    expected: z.array(text),
  }).strict()).max(200),
}).strict();
export type ExecutionContract = z.infer<typeof executionContractSchema>;
export interface ContractCase { preconditions?: string[]; steps?: string[]; expected?: string[] }

/** 结构与覆盖检查不调用模型；语义不明由转换阶段明确报告，不能继续浏览器探索。 */
export function validateExecutionContract(value: unknown, source: ContractCase, roles: string[]): ExecutionContract {
  // Models occasionally emit JSON-friendly issue objects or zero-based source
  // indexes despite the contract examples. Normalize those two harmless
  // representations before schema validation; all semantic checks below still
  // apply after normalization.
  if (value && typeof value === "object") {
    const candidate = value as Record<string, unknown>;
    const issues = Array.isArray(candidate.issues)
      ? candidate.issues.map((issue) => typeof issue === "string" ? issue
        : issue && typeof issue === "object" && typeof (issue as Record<string, unknown>).message === "string"
          ? (issue as Record<string, unknown>).message as string
          : issue)
      : candidate.issues;
    const rawChecks = candidate.preconditionChecks;
    const conditions = source.preconditions ?? [];
    // Index base belongs to the whole response, not each individual check.
    // Require a zero plus matching verbatim quotes for every shifted reference;
    // mixed bases, fractions and invalid references remain validation errors.
    const zeroBased = Array.isArray(rawChecks) && rawChecks.some(check => check?.sourceIndices?.includes(0))
      && rawChecks.every(check => check && Array.isArray(check.sourceIndices) && check.sourceIndices.length
        && check.sourceIndices.every((i: unknown) => typeof i === "number" && Number.isInteger(i) && i >= 0 && i < conditions.length)
        && Array.isArray(check.sourceQuotes) && check.sourceQuotes.length
        && check.sourceQuotes.every((quote: unknown) => typeof quote === "string" && check.sourceIndices.some((i: number) => conditions[i].includes(quote))));
    const checks = zeroBased ? rawChecks.map(check => ({ ...check, sourceIndices: check.sourceIndices.map((i: number) => i + 1) })) : rawChecks;
    value = { ...candidate, issues, preconditionChecks: checks };
  }
  // 待澄清结果不是可执行计划：模型可能返回部分 target，保留原因与原始用例，
  // 只移除无法执行的定位字段，避免把合理阻塞变成 JSON 校验失败并反复花费 token。
  if (value && typeof value === "object" && "status" in value && value.status === "needs_clarification"
    && "steps" in value && Array.isArray(value.steps)) {
    value = { ...value, steps: value.steps.map(step => ({ ...step, actions: Array.isArray(step.actions)
      ? step.actions.map((action: Record<string, unknown>) => {
        if (action.target === undefined || visualTargetSchema.safeParse(action.target).success) return action;
        const { target: _partial, ...rest } = action;
        return rest;
      }) : step.actions })) };
  }
  const contract = executionContractSchema.parse(value);
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  if (!same(contract.preconditions, source.preconditions ?? [])) throw new Error("转换不得修改或遗漏原始前置条件");
  if (contract.preconditionChecks) {
    const ids = new Set<string>();
    for (const check of contract.preconditionChecks) {
      if (ids.has(check.id)) throw new Error(`前置检查 ID 重复：${check.id}`);
      ids.add(check.id);
      if (check.sourceIndices.some(i => i > contract.preconditions.length)) throw new Error(`前置检查 ${check.id} 引用不存在的原文条件`);
      if (check.sourceQuotes.some(quote => !check.sourceIndices.some(i => contract.preconditions[i - 1].includes(quote)))) throw new Error(`前置检查 ${check.id} 引用内容不在原文中`);
      if (check.dependsOn.some(id => id === check.id || !contract.preconditionChecks!.some(c => c.id === id))) throw new Error(`前置检查 ${check.id} 的依赖无效`);
    }
    for (let i = 1; i <= contract.preconditions.length; i++) if (!contract.preconditionChecks.some(c => c.sourceIndices.includes(i))) throw new Error(`原始前置条件 ${i} 没有检查计划`);
    const visited = new Set<string>(), visiting = new Set<string>();
    const visit = (id: string) => {
      if (visiting.has(id)) throw new Error("前置检查依赖存在循环");
      if (visited.has(id)) return;
      visiting.add(id);
      for (const dependency of contract.preconditionChecks!.find(c => c.id === id)!.dependsOn) visit(dependency);
      visiting.delete(id); visited.add(id);
    };
    for (const check of contract.preconditionChecks) visit(check.id);
  }
  if (contract.steps.length !== (source.steps ?? []).length || contract.steps.some((s, i) => s.index !== i + 1 || s.source !== source.steps![i])) throw new Error("转换不得修改或遗漏原始步骤");
  if (!same(contract.steps.flatMap(s => s.expected), source.expected ?? [])) throw new Error("转换不得修改或遗漏原始预期");
  for (const step of contract.steps) for (const action of step.actions) {
    if (contract.status === "ready" && action.role && action.role !== "default" && !roles.includes(action.role)) throw new Error(`转换使用了未配置角色：${action.role}`);
    if (["click", "fill", "check", "select"].includes(action.action) && !action.target && !action.targetHint && contract.status === "ready") throw new Error("交互动作必须提供 target 或待页面确认的 targetHint");
    if (action.action === "fill" && action.target && action.target.control !== "textbox") throw new Error("输入动作必须绑定输入框");
    if (action.action === "check" && ((action.target && action.target.control !== "checkbox") || typeof action.value !== "boolean") && contract.status === "ready") throw new Error("开关动作必须提供布尔目标状态");
  }
  if (contract.status === "ready" && (contract.issues.length || !contract.steps.length || !source.expected?.length || contract.steps.some(s => !s.actions.length))) throw new Error("存在待澄清项或缺少动作/预期，不能标记可执行");
  if (contract.status === "needs_clarification" && !contract.issues.length) throw new Error("待澄清用例必须说明原因");
  return contract;
}
