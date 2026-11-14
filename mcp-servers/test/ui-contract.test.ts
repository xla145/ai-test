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

it("accepts UI details deferred to page observation without inventing a row key", () => {
  const value: any = plan();
  delete value.steps[0].actions[0].target;
  value.steps[0].actions[0].targetHint = "当前新增页唯一 Key 输入框对应的启用开关";
  expect(validateExecutionContract(value, source, ["admin"]).status).toBe("ready");
  delete value.steps[0].actions[0].value;
  expect(() => validateExecutionContract(value, source, ["admin"])).toThrow("布尔");
});

it("keeps real clarification reasons from a model response containing partial targets", () => {
  const value: any = plan();
  value.status = "needs_clarification";
  value.issues = ["前置条件要求超级管理员，当前只配置运营管理员"];
  value.steps[0].actions[0].target = { scope: [{ kind: "region", name: "左侧菜单" }], name: "渠道管理" };
  value.steps[0].actions[0].role = "超级管理员";
  const out = validateExecutionContract(value, source, ["运营管理员"]);
  expect(out.status).toBe("needs_clarification");
  expect(out.issues).toEqual(value.issues);
  expect(out.steps[0].actions[0].target).toBeUndefined();
  expect(out.steps[0].expected).toEqual(source.expected);
  value.status = "ready"; value.issues = [];
  expect(() => validateExecutionContract(value, source, ["超级管理员"])).toThrow();
});
