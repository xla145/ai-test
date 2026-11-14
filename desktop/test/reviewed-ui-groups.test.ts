import { expect, it } from "vitest";
import { reviewedUiGroups } from "../src/shared/reviewedUiGroups";
import type { UiGroupCase } from "../src/shared/ipc";

it("工作台仅保留审核通过的 UI 用例，并去掉空组，不修改原数据", () => {
  const make = (id: string, status: string, execution_mode = "ui"): UiGroupCase => ({
    id, status, execution_mode, title: id, priority: "P1", lint_status: "passed", variant: "",
  });
  const groups = [
    { id: "mixed", label: "模块", cases: [make("ok", "reviewed"), make("draft", "draft"), make("old", "deprecated"), make("api", "reviewed", "api"), make("capture", "reviewed", "capture")] },
    { id: "empty", label: "待审核", cases: [make("pending", "draft")] },
  ];
  expect(reviewedUiGroups(groups)).toEqual([{ ...groups[0], cases: [groups[0].cases[0]] }]);
  expect(groups[0].cases).toHaveLength(5);
});
