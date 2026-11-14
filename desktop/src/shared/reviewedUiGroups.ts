import type { UiCaseGroup } from "./ipc.js";

/** 工作台列表、计数和批量操作共用同一个审核范围。 */
export function reviewedUiGroups(groups: UiCaseGroup[]): UiCaseGroup[] {
  return groups.map((group) => ({
    ...group,
    cases: group.cases.filter((c) => c.execution_mode === "ui" && c.status === "reviewed"),
  })).filter((group) => group.cases.length > 0);
}
