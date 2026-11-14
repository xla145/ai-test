import { describe, expect, it } from "vitest";
import { buildUiCaseTree } from "../src/shared/uiCaseTree.js";
import type { UiGroupCase } from "../src/shared/ipc.js";

const mk = (id: string, module_path?: string[]): UiGroupCase => ({
  id, title: id, module_path, priority: "P1", status: "reviewed", lint_status: "ok", execution_mode: "ui", variant: "",
});

describe("UI 模块树", () => {
  it("按完整路径隔离同名模块，父模块同时保留直属用例和子模块", () => {
    const cases = [mk("a", ["系统", "设置"]), mk("b", ["业务", "设置"]), mk("c", ["系统"]), mk("d", ["系统", "设置"])];
    const tree = buildUiCaseTree(cases);
    expect(tree.map((n) => n.name)).toEqual(["系统", "业务"]);
    expect(tree[0].descendants.map((c) => c.id)).toEqual(["a", "c", "d"]);
    expect(tree[0].cases.map((c) => c.id)).toEqual(["c"]);
    expect(tree[0].modules[0].cases.map((c) => c.id)).toEqual(["a", "d"]);
    expect(tree[1].modules[0].cases.map((c) => c.id)).toEqual(["b"]);
    expect(tree[0].modules[0].key).not.toBe(tree[1].modules[0].key);
  });

  it("兼容旧数据与空路径，模块路径分隔符不会导致键冲突", () => {
    const tree = buildUiCaseTree([mk("a"), mk("b", [" ", ""]), mk("c", ["A/B"]), mk("d", ["A", "B"])]);
    expect(tree[0].name).toBe("未分模块");
    expect(tree[0].descendants.map((c) => c.id)).toEqual(["a", "b"]);
    expect(tree[1].key).not.toBe(tree[2].modules[0].key);
  });
});
