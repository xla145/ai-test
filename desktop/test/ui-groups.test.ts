import { describe, expect, it } from "vitest";
import { deriveSteps, groupCases, maskText, variantLabel } from "../src/shared/uiGroups.js";

const mk = (id: string, title: string, steps: string[], expected: string[], preconditions: string[] = []) =>
  ({ id, title, execution_mode: "ui", steps, expected, preconditions });

describe("UI case grouping", () => {
  it("masks quoted text and latin/number tokens, keeps Chinese wording", () => {
    expect(maskText("在「搜索标签」输入 TAG-1001，等待 30 秒").values).toEqual(["搜索标签", "TAG-1001", "30"]);
    expect(maskText("停用标签 TAG-1001").skeleton).toBe(maskText("停用标签 TAG-2002").skeleton);
    expect(maskText("停用标签 TAG-1001").skeleton).not.toBe(maskText("启用标签 TAG-1001").skeleton);
  });

  it("groups cases that only differ in parameters and labels members by their varying values", () => {
    const cases = [
      mk("tc_1", "标签管理-停用标签 TAG-1001", ["进入标签管理页", "停用标签 TAG-1001"], ["展示标签列表", "状态显示为「已停用」"]),
      mk("tc_2", "综合总览-指标卡片", ["进入综合总览"], ["展示 4 张指标卡片"]),
      mk("tc_3", "标签管理-停用标签 TAG-1002", ["进入标签管理页", "停用标签 TAG-1002"], ["展示标签列表", "状态显示为「已停用」"]),
      mk("tc_4", "标签管理-启用标签 TAG-1001", ["进入标签管理页", "启用标签 TAG-1001"], ["展示标签列表", "状态显示为「已启用」"]),
    ];
    const groups = groupCases(cases);
    expect(groups.map((g) => g.cases.map((c) => c.id))).toEqual([["tc_1", "tc_3"], ["tc_2"], ["tc_4"]]);
    expect(groups[0].label).toBe("标签管理-停用标签");
    expect(variantLabel(groups[0], "tc_3")).toBe("TAG-1002");
    expect(groups[1].label).toBe("综合总览-指标卡片");
  });

  it("keeps cases without steps apart", () => {
    expect(groupCases([mk("tc_1", "A", [], []), mk("tc_2", "B", [], [])])).toHaveLength(2);
  });
});

describe("deriving steps by parameter substitution", () => {
  const steps = [
    { id: "S1", action: "goto", url: "/tags" },
    { id: "S2", action: "fill", target: { kind: "placeholder", value: "搜索标签" }, value: "TAG-1001" },
    { id: "S3", action: "click", target: { kind: "testid", value: "disable-TAG-1001" }, role: "TAG-1001" },
    { id: "S4", action: "click", target: { kind: "role", role: "button", name: "停用 TAG-1001" } },
    { id: "S5", action: "expectText", target: { kind: "testid", value: "count" }, text: "共 10 条，第 1 页" },
  ];

  it("replaces values everywhere except structural fields", () => {
    const out = deriveSteps(steps, ["TAG-1001", "1"], ["TAG-2002", "3"]);
    if (!out.ok) throw new Error(out.reason);
    expect(out.steps[1]).toMatchObject({ value: "TAG-2002" });
    expect(out.steps[2]).toMatchObject({ target: { kind: "testid", value: "disable-TAG-2002" }, role: "TAG-1001", id: "S3" });
    expect(out.steps[3]).toMatchObject({ target: { kind: "role", role: "button", name: "停用 TAG-2002" } });
    // 数字按整词替换：「10」里的 1 不动
    expect(out.steps[4]).toMatchObject({ text: "共 10 条，第 3 页" });
    expect(steps[1].value).toBe("TAG-1001");
  });

  it("refuses ambiguous or ineffective substitutions", () => {
    expect(deriveSteps(steps, ["A", "A"], ["B", "C"])).toMatchObject({ ok: false });
    expect(deriveSteps(steps, ["TAG-1001"], ["TAG-1001"])).toMatchObject({ ok: false });
    expect(deriveSteps(steps, ["不在脚本里"], ["别的值"])).toMatchObject({ ok: false });
    expect(deriveSteps(steps, ["TAG-1001", "TAG-1001"], ["TAG-2002", "TAG-1001"])).toMatchObject({ ok: false });
  });
});
