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
  it("validates atomic precondition plans without embedding business rules", () => {
    const value = { ...plan(), preconditionChecks: [{ id: "P1.1", sourceIndices: [1], sourceQuotes: ["已有指定模型"], statement: "指定模型存在", expected: "存在", method: "ui", dependsOn: [] }] };
    expect(validateExecutionContract(value, source, ["admin"]).preconditionChecks).toHaveLength(1);
    expect(() => validateExecutionContract({ ...value, preconditionChecks: [{ ...value.preconditionChecks![0], sourceIndices: [2] }] }, source, ["admin"])).toThrow("不存在");
    expect(() => validateExecutionContract({ ...value, preconditionChecks: [{ ...value.preconditionChecks![0], dependsOn: ["P1.1"] }] }, source, ["admin"])).toThrow("无效");
  });
  it("accepts database parameter bindings only at database checks/actions", () => {
    const value: any = { ...plan(), preconditionChecks: [{ id: "P1.1", sourceIndices: [1], sourceQuotes: ["已有指定模型"], statement: "指定模型存在", expected: "存在", method: "database", paramRefs: { model: "username" }, dependsOn: [] }] };
    expect(validateExecutionContract(value, source, ["admin"]).preconditionChecks?.[0].paramRefs).toEqual({ model: "username" });
    const databaseAction = { action: "database", instruction: "核对本例数据", paramRefs: { model: "username" } };
    expect(validateExecutionContract({ ...value, steps: [{ ...value.steps[0], actions: [databaseAction] }] }, source, []).steps[0].actions[0].paramRefs).toEqual({ model: "username" });
    expect(() => validateExecutionContract({ ...value, steps: [{ ...value.steps[0], actions: [{ ...databaseAction, paramRefs: { model: "unknown" } }] }] }, source, [])).toThrow();
    value.preconditionChecks[0].method = "ui";
    expect(() => validateExecutionContract(value, source, [])).toThrow("paramRefs");
    value.preconditionChecks[0].method = "database";
    value.steps[0].actions[0].paramRefs = { model: "username" };
    expect(() => validateExecutionContract(value, source, [])).toThrow("paramRefs");
  });
  it("rejects runtime checks with no actual constraint", () => {
    const value: any = { ...plan(), preconditionChecks: [{ id: "P1.1", sourceIndices: [1], sourceQuotes: ["已有指定模型"], statement: "输入存在", expected: "存在", method: "runtime", runtime: { valueRef: "password" }, dependsOn: [] }] };
    expect(() => validateExecutionContract(value, source, [])).toThrow("实际约束");
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

it("preserves a condition-based target until exploration resolves its identity", () => {
  const source = {
    preconditions: ["存在符合指定条件的记录"],
    steps: ["打开符合指定条件的记录详情"],
    expected: ["显示该记录详情"],
  };
  const value = {
    version: 1, status: "ready", issues: [], preconditions: source.preconditions,
    steps: [{ index: 1, source: source.steps[0], expected: source.expected, actions: [
      { action: "observe", instruction: "核对指定条件及候选范围，确认唯一匹配的稳定标识；存在多个匹配时停止并报告" },
      { action: "click", instruction: "打开已确认记录的详情", targetHint: "符合指定条件且已确认身份的记录的详情入口" },
    ] }],
  };
  const result = validateExecutionContract(value, source, []);
  expect(result).toEqual(value);
  expect(result.steps[0].actions[1].target).toBeUndefined();
  const missingTarget = structuredClone(value);
  delete (missingTarget.steps[0].actions[1] as { targetHint?: string }).targetHint;
  expect(() => validateExecutionContract(missingTarget, source, [])).toThrow("target");
});

it("normalizes model issue objects and zero-based precondition indexes", () => {
  const value: any = {
    ...plan(),
    status: "needs_clarification",
    issues: [{ id: "I1", message: "缺少搜索关键词" }],
    preconditionChecks: [{ id: "P1.1", sourceIndices: [0], sourceQuotes: ["已有指定模型"], statement: "指定模型存在", expected: "存在", method: "ui", dependsOn: [] }],
  };
  const out = validateExecutionContract(value, source, ["admin"]);
  expect(out.issues).toEqual(["缺少搜索关键词"]);
  expect(out.preconditionChecks?.[0].sourceIndices).toEqual([1]);
});

it("shifts the whole zero-based response and leaves caller data unchanged", () => {
  const original = { ...source, preconditions: ["已登录后台", "已有指定模型"] };
  const value = { ...plan(), preconditions: original.preconditions, preconditionChecks: original.preconditions.map((quote, i) => ({
    id: `P${i + 1}.1`, sourceIndices: [i], sourceQuotes: [quote], statement: quote, expected: quote, method: "ui", dependsOn: [],
  })) };
  const before = structuredClone(value);
  expect(validateExecutionContract(value, original, ["admin"]).preconditionChecks?.map(c => c.sourceIndices)).toEqual([[1], [2]]);
  expect(value).toEqual(before);
  value.preconditionChecks = value.preconditionChecks.map((c, i) => ({ ...c, sourceIndices: [i + 1] }));
  expect(validateExecutionContract(value, original, ["admin"]).preconditionChecks?.map(c => c.sourceIndices)).toEqual([[1], [2]]);
});

it("does not repair mixed bases, invalid references or malformed issues", () => {
  const original = { ...source, preconditions: ["已登录后台", "已有指定模型"] };
  const checks = original.preconditions.map((quote, i) => ({ id: `P${i + 1}.1`, sourceIndices: [i], sourceQuotes: [quote], statement: quote, expected: quote, method: "ui", dependsOn: [] }));
  const value: any = { ...plan(), preconditions: original.preconditions, preconditionChecks: checks };
  value.preconditionChecks[1].sourceIndices = [2];
  expect(() => validateExecutionContract(value, original, ["admin"])).toThrow();
  value.preconditionChecks[1].sourceIndices = [0.5];
  expect(() => validateExecutionContract(value, original, ["admin"])).toThrow();
  value.preconditionChecks[1].sourceIndices = [1];
  value.preconditionChecks[1].sourceQuotes = ["原文中不存在的条件"];
  expect(() => validateExecutionContract(value, original, ["admin"])).toThrow();
  expect(() => validateExecutionContract({ ...plan(), status: "needs_clarification", issues: [{}] }, source, ["admin"])).toThrow();
  expect(() => validateExecutionContract({ ...plan(), issues: [{ message: "存在阻塞" }] }, source, ["admin"])).toThrow("不能标记可执行");
});
