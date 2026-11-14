import { z } from "zod";
import { visualTargetSchema } from "./target.js";

const text = z.string().min(1).max(4000);
export const executionContractSchema = z.object({
  version: z.literal(1),
  status: z.enum(["ready", "needs_clarification"]),
  issues: z.array(text).max(50),
  // 原始前置条件和预期必须原样保留，不能通过转换删减覆盖。
  preconditions: z.array(text),
  steps: z.array(z.object({
    index: z.number().int().positive(),
    source: text,
    actions: z.array(z.object({
      action: z.enum(["navigate", "click", "fill", "check", "select", "press", "observe", "capture", "clock", "database"]),
      instruction: text,
      target: visualTargetSchema.optional(),
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
  const contract = executionContractSchema.parse(value);
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  if (!same(contract.preconditions, source.preconditions ?? [])) throw new Error("转换不得修改或遗漏原始前置条件");
  if (contract.steps.length !== (source.steps ?? []).length || contract.steps.some((s, i) => s.index !== i + 1 || s.source !== source.steps![i])) throw new Error("转换不得修改或遗漏原始步骤");
  if (!same(contract.steps.flatMap(s => s.expected), source.expected ?? [])) throw new Error("转换不得修改或遗漏原始预期");
  for (const step of contract.steps) for (const action of step.actions) {
    if (action.role && action.role !== "default" && !roles.includes(action.role)) throw new Error(`转换使用了未配置角色：${action.role}`);
    if (["click", "fill", "check", "select"].includes(action.action) && !action.target && contract.status === "ready") throw new Error("交互动作必须提供结构化 target，无法确定时标记待澄清");
    if (action.action === "fill" && action.target && action.target.control !== "textbox") throw new Error("输入动作必须绑定输入框");
    if (action.action === "check" && (action.target?.control !== "checkbox" || typeof action.value !== "boolean") && contract.status === "ready") throw new Error("开关动作必须提供布尔目标状态");
  }
  if (contract.status === "ready" && (contract.issues.length || !contract.steps.length || !source.expected?.length || contract.steps.some(s => !s.actions.length))) throw new Error("存在待澄清项或缺少动作/预期，不能标记可执行");
  if (contract.status === "needs_clarification" && !contract.issues.length) throw new Error("待澄清用例必须说明原因");
  return contract;
}
