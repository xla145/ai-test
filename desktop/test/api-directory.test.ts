import { describe, expect, it } from "vitest";
import { groupDefinitions, matchesDefinitionScope, regressionDefinitionGroups } from "../src/shared/apiDirectory";
import type { ApiDefinition } from "../src/shared/apiWorkspace";

const definition = (id: string, path: string, module = id): ApiDefinition => ({
  id, path, method: "GET", module, summary: id, source: "test", title: "test", version: "1", revision: 1,
  removed: false, request: { method: "GET", path, expected_status: [200] }, operation: { params: [], responses: {} },
});

describe("API directory and regression scope", () => {
  it("groups endpoints by their OpenAPI module tag", () => {
    const rows = [definition("a", "/users", "用户模块"), definition("b", "/users/{id}", "用户模块"),
      definition("c", "/orders", "订单模块"), definition("d", "/users/search", "用户模块")];
    const groups = groupDefinitions(rows);
    expect(groups.map((g) => g.label)).toEqual(["用户模块", "订单模块"].sort((a, b) => a.localeCompare(b, "zh-CN")));
    expect(groups.find((g) => g.label === "用户模块")?.children?.map((n) => n.definition?.id)).toEqual(["a", "b", "d"]);
    expect(groups.flatMap((g) => g.rows).map((d) => d.id).sort()).toEqual(["a", "b", "c", "d"]);
    expect(groupDefinitions([...rows].reverse())).toEqual(groups);
  });
  it("keeps endpoints with the same path as separate method leaves", () => {
    const rows = [definition("get", "/users", "用户"), { ...definition("post", "/users", "用户"), method: "POST" }];
    expect(groupDefinitions(rows)[0].children?.map((n) => n.definition?.id)).toEqual(["get", "post"]);
    expect(groupDefinitions([])).toEqual([]);
  });
  it("matches exact interface identity and excludes wider flows", () => {
    const scope = [definition("users", "/users")];
    expect(matchesDefinitionScope({ api: { definition_id: "users", method: "GET", path: "/users" } }, scope)).toBe(true);
    expect(matchesDefinitionScope({ api: { method: "GET", path: "/users" } }, scope)).toBe(true);
    expect(matchesDefinitionScope({ api: { method: "POST", path: "/users" } }, scope)).toBe(false);
    expect(matchesDefinitionScope({ api: { definition_id: "other", method: "GET", path: "/users" } }, scope)).toBe(false);
    expect(matchesDefinitionScope({ api: { method: "GET", path: "/users/{id}" } }, scope)).toBe(false);
    expect(matchesDefinitionScope({ api_flow: [{ method: "GET", path: "/users" }] }, scope)).toBe(false);
    expect(matchesDefinitionScope({ api: { method: "GET", path: "/users" } }, [])).toBe(false);
  });
});


describe("regression interface list", () => {
  it("retains empty, draft-only and blocked interfaces without making them executable", () => {
    const definitions = [definition("empty", "/empty"), definition("draft", "/draft"), definition("blocked", "/blocked"), definition("ready", "/ready")];
    const cases = [
      { id: "draft-case", status: "draft", blocked: false, api: { definition_id: "draft", method: "GET", path: "/draft" } },
      { id: "blocked-case", status: "reviewed", blocked: true, api: { definition_id: "blocked", method: "GET", path: "/blocked" } },
      { id: "ready-case", status: "reviewed", blocked: false, api: { definition_id: "ready", method: "GET", path: "/ready" } },
      { id: "flow", status: "reviewed", blocked: false, api_flow: [{ method: "GET", path: "/empty" }] },
      { id: "outside", status: "reviewed", blocked: false, api: { method: "GET", path: "/outside" } },
    ];
    const groups = regressionDefinitionGroups(definitions, cases, (c) => c.status === "reviewed" && !c.blocked);
    expect(groups.map((g) => g.definition.id)).toEqual(["empty", "draft", "blocked", "ready"]);
    expect(groups.map((g) => g.related.length)).toEqual([0, 1, 1, 1]);
    expect(groups.flatMap((g) => g.eligible.map((c) => c.id))).toEqual(["ready-case"]);
  });
});
