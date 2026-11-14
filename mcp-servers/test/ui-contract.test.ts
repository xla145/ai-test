import { describe, expect, it } from "vitest";
import { validateExecutionContract } from "../src/ui/contract.js";

const source = { preconditions: ["已有指定模型"], steps: ["启用模型"], expected: ["模型已启用"] };
const plan = () => ({ version: 1, status: "ready", issues: [], preconditions: source.preconditions,
  steps: [{ index: 1, source: source.steps[0], expected: source.expected, actions: [{ action: "check", instruction: "启用指定模型", role: "admin", value: true,
    target: { page: "模型管理", scope: [{ kind: "row", name: "模型行", key: "model-1" }], control: "checkbox", label: "启用" } }] }] });
describe("execution contract coverage gate", () => {
  it("accepts an explicit single action and retains all original coverage", () => {
    expect(validateExecutionContract(plan(), source, ["admin"])).toEqual(plan());
  });
  it("rejects lost steps, preconditions and expectations", () => {
    expect(() => validateExecutionContract({ ...plan(), steps: [] }, source, ["admin"])).toThrow("步骤");
    expect(() => validateExecutionContract({ ...plan(), preconditions: [] }, source, ["admin"])).toThrow("前置条件");
    const value = plan(); value.steps[0].expected = ["列表可见"];
    expect(() => validateExecutionContract(value, source, ["admin"])).toThrow("预期");
  });
  it("rejects fuzzy role substitution and unspecified toggle state", () => {
    expect(() => validateExecutionContract(plan(), source, ["administrator"])).toThrow("未配置角色");
    const value: any = plan(); delete value.steps[0].actions[0].value;
    expect(() => validateExecutionContract(value, source, ["admin"])).toThrow("布尔");
  });
  it("requires a structured interactive target and explicit reasons for blocked plans", () => {
    const value: any = plan(); delete value.steps[0].actions[0].target;
    expect(() => validateExecutionContract(value, source, ["admin"])).toThrow("target");
    value.status = "needs_clarification";
    expect(() => validateExecutionContract(value, source, ["admin"])).toThrow("原因");
    value.issues = ["缺少目标模型编号"];
    expect(validateExecutionContract(value, source, ["admin"]).status).toBe("needs_clarification");
  });
});
