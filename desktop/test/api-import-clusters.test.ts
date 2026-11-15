import { describe, expect, it } from "vitest";
import { clusterImportChanges } from "../src/shared/apiImportClusters";
import type { ApiImportPreview } from "../src/shared/apiWorkspace";

const rows = (names: string[]): ApiImportPreview["changes"] => names.map((module, i) => ({
  module, path: "/endpoint/" + i, method: "GET", summary: module, change: "added",
}));

describe("import module clustering", () => {
  it("merges domain variants but keeps generic and unrelated names separate", () => {
    const groups = clusterImportChanges(rows(["订单管理", "商品管理", "订单", "管理", "未分组", "未分组管理"]));
    expect(groups.find((g) => g.modules.includes("订单"))?.modules).toEqual(["订单", "订单管理"]);
    expect(groups.find((g) => g.modules.includes("商品管理"))?.modules).toEqual(["商品管理"]);
    expect(groups.find((g) => g.modules.includes("管理"))?.modules).toEqual(["管理"]);
    expect(groups.find((g) => g.modules.includes("未分组"))?.modules).toEqual(["未分组"]);
  });
  it("normalizes whitespace, separators and Latin case", () => {
    expect(clusterImportChanges(rows(["User-API", "user api", "UserController"]))).toHaveLength(1);
  });
  it("sorts deterministically and preserves every selectable endpoint", () => {
    const input = rows(["商品", "订单管理", "订单", "账户", ""]);
    const groups = clusterImportChanges(input);
    expect(clusterImportChanges([...input].reverse())).toEqual(groups);
    expect(groups.flatMap((g) => g.rows)).toHaveLength(input.length);
    expect(new Set(groups.flatMap((g) => g.rows.map((r) => r.path))).size).toBe(input.length);
    expect(groups.map((g) => g.modules[0])).toEqual(groups.map((g) => g.modules[0]).sort((a, b) => a.localeCompare(b, "zh-CN")));
  });
  it("does not join unrelated modules through a similar intermediate module", () => {
    const groups = clusterImportChanges(rows(["订单", "订单用户", "用户"]));
    expect(groups.some((g) => g.modules.includes("订单") && g.modules.includes("用户"))).toBe(false);
  });
});

it("combines model service submodules under a single business prefix", () => {
  const names = ["处理历史", "服务监测", "告警与禁用", "平台模型管理", "渠道管理", "数据看板。", "运行监控", "API Key 管理"];
  const groups = clusterImportChanges(rows(names.map((n) => "模型服务 v2 - " + n)));
  expect(groups).toHaveLength(1);
  expect(groups[0].label).toBe("模型服务 v2");
  expect(groups[0].rows).toHaveLength(8);
  expect(clusterImportChanges(rows(["模型服务 v2 - 渠道管理", "模型服务 v3 - 渠道管理"]))).toHaveLength(2);
});

it("keeps separate business prefixes and supports compact Chinese separators", () => {
  const groups = clusterImportChanges(rows(["模型服务 v2-处理历史", "模型服务 v2-渠道管理", "订单服务 - 渠道管理"]));
  expect(groups).toHaveLength(2);
  expect(groups.find((g) => g.label === "模型服务 v2")?.rows).toHaveLength(2);
});
