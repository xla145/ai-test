import { expect, it } from "vitest";
import { candidates, toCode, validateReplayTarget } from "../src/ui/locator.js";
import { generateSpec } from "../src/ui/codegen.js";

const rowButton = {
  tag: "button", role: "button", name: "编辑", text: "编辑",
  css: "tr:nth-of-type(1) button", testId: "edit",
  row: { css: "tr", key: "MODEL-001", inner: "button" },
};

it("keeps row identity even when filtering makes the global button unique", () => {
  const specs = candidates(rowButton);
  expect(specs.length).toBeGreaterThan(0);
  for (const spec of specs) {
    expect(spec.within).toMatchObject({ css: "tr", hasExactText: "MODEL-001" });
  }
  const script = generateSpec({ caseId: "tc_row_identity", title: "编辑目标模型", steps: [
    { action: "click", target: specs[0] },
  ] });
  expect(script).toContain('filter({ has: page.getByText("MODEL-001", { exact: true }) })');
});

it("keeps both panel and row when collection confirms the panel contains the row", () => {
  const specs = candidates({ ...rowButton, scope: { css: "section", exactKey: "平台模型", inner: "button", containsRow: true } });
  expect(specs[0].within).toMatchObject({ css: "tr", hasExactText: "MODEL-001", within: { css: "section", hasExactText: "平台模型" } });
  expect(toCode(specs[0])).not.toContain("nth-of-type");
});

it("does not invert a form item inside a row or guess an unknown hierarchy", () => {
  for (const containsRow of [false, undefined]) {
    const specs = candidates({ ...rowButton, scope: { css: ".el-form-item", exactKey: "名称", inner: "input", containsRow } });
    expect(specs[0].within).toMatchObject({ css: ".el-form-item", hasExactText: "名称" });
  }
});

it("validates any nested scope without assuming table, card, dialog, or form semantics", () => {
  for (const within of [
    { css: "tr" }, { css: ".card", hasText: "商品" }, { css: '[role="dialog"]', hasExactText: "设置" },
  ]) expect(() => validateReplayTarget({ kind: "text", value: "编辑", within })).not.toThrow();
  expect(() => validateReplayTarget({ kind: "text", value: "编辑", within: { css: "  " } })).toThrow("缺少 CSS");
  expect(() => validateReplayTarget({ kind: "text", value: "编辑", within: { css: ".card", hasText: " " } })).toThrow("文本条件");
});
