import { describe, expect, it } from "vitest";
import { NAV_SECTIONS, navLabel } from "../src/renderer/nav";
import { workspaceMock } from "../src/renderer/pages/api/workspaceMock";
import { createPerformanceDemo, performanceDemoRows } from "../src/renderer/performanceDemo";
import { performanceSeriesKey, performanceTrend } from "../src/renderer/pages/performanceView";
import { bindPerformanceDefinition, performanceDefinitionIssue, performanceRequestFromDefinition, resolvePerformancePath } from "../src/shared/performanceSource";
import { performancePlan, redactPerformanceOptions } from "../src/main/performance";
import type { ApiDefinition } from "../src/shared/apiWorkspace";

const load = { path: "/spoof", vus: 5, seconds: 10, p95Ms: 500, maxFailureRate: 0.01, definitionId: "api_get", definitionRevision: 1 };
const catalogue = () => workspaceMock([]);
const lookup = async (id: string) => (await catalogue().listApiDefinitions("p")).find(d => d.id === id)!;

describe("性能测试入口与接口数据源", () => {
  it("has exactly one performance entry in execution, not engineering", () => {
    expect(NAV_SECTIONS.flatMap(s => s.items).filter(i => i.key === "performance")).toHaveLength(1);
    expect(NAV_SECTIONS.find(s => s.key === "execute")!.items.some(i => i.key === "performance")).toBe(true);
    expect(navLabel("performance")).toBe("性能测试");
  });

  it("copies the catalogue request without mutating it", async () => {
    const definition = await lookup("api_create");
    const request = performanceRequestFromDefinition(definition);
    expect(request.body).toEqual({ productId: "SKU-1024", quantity: 1 });
    (request.body as Record<string, unknown>).quantity = 9;
    expect((definition.request.body as Record<string, unknown>).quantity).toBe(1);
  });

  it("overrides a caller-supplied method/path using the current definition", async () => {
    const definition = await lookup("api_get");
    const options = bindPerformanceDefinition(definition, { ...load, method: "DELETE" });
    expect(options).toMatchObject({ method: "GET", path: "/orders/{orderId}", definitionName: "查询订单", definitionRevision: 1 });
    expect(options.pathParams).toEqual(definition.request.path_params);
  });

  it("retains JSON body, auth, role, query, headers and timeout", async () => {
    const definition = await lookup("api_create");
    Object.assign(definition.request, { query: { page: 2 }, headers: { clientid: "desktop" }, timeout: 15, auth: false, role: "buyer" });
    const bound = bindPerformanceDefinition(definition, { ...load, definitionId: definition.id });
    expect(bound).toMatchObject({ body: definition.request.body, query: { page: 2 }, headers: { clientid: "desktop" }, timeoutSeconds: 15, auth: false, role: "buyer" });
  });

  it("rejects removed, unsupported, stale and foreign definitions", async () => {
    const d = await lookup("api_get");
    expect(() => bindPerformanceDefinition({ ...d, removed: true }, load)).toThrow("移除");
    expect(() => bindPerformanceDefinition({ ...d, revision: 2 }, load)).toThrow("更新");
    expect(() => bindPerformanceDefinition(d, { ...load, definitionId: "other" })).toThrow("接口列表");
    expect(performanceDefinitionIssue({ ...d, unsupported_body: true })).toContain("请求体");
    expect(performanceDefinitionIssue({ ...d, method: "TRACE" })).toContain("暂不支持");
    expect(() => bindPerformanceDefinition({ ...d, request: { ...d.request, encrypt: true } }, load)).toThrow("加密");
  });

  it("requires actual path and query parameter values", async () => {
    const d = await lookup("api_get");
    expect(() => bindPerformanceDefinition(d, { ...load, pathParams: {} })).toThrow("orderId");
    expect(() => bindPerformanceDefinition(d, { ...load, pathParams: { orderId: "${id}" } })).toThrow("实际测试数据");
    const required: ApiDefinition = { ...d, operation: { ...d.operation, params: [...d.operation.params, { name: "page", location: "query", required: true, schema: {} }] } };
    expect(() => bindPerformanceDefinition(required, load)).toThrow("page");
    expect(bindPerformanceDefinition(required, { ...load, query: { page: 0 } }).query).toEqual({ page: 0 });
  });

  it.each(["//evil.test", "/orders?token=x", "/bad\\path", "/orders/${id}"])("rejects an unsafe or unresolved template %s", path => {
    expect(() => resolvePerformancePath(path, { id: 1 })).toThrow();
  });

  it("encodes path parameters, preserves the environment base path and sends query arrays", async () => {
    const d = await lookup("api_get");
    const options = bindPerformanceDefinition(d, { ...load, pathParams: { orderId: "ID /?#" }, query: { page: 0, tags: ["a&b", "c"], active: false } });
    const plan = performancePlan("http://localhost:3000/api/", options);
    const url = new URL(plan.target);
    expect(url.pathname).toBe("/api/orders/ID%20%2F%3F%23");
    expect(url.searchParams.getAll("tags")).toEqual(["a&b", "c"]);
    expect(url.searchParams.get("page")).toBe("0");
    expect(url.searchParams.get("active")).toBe("false");
    expect(() => resolvePerformancePath("/{id}", { id: ".." })).toThrow();
  });

  it("keeps request secrets out of generated source and persisted options", async () => {
    const d = await lookup("api_create");
    const options = bindPerformanceDefinition(d, { ...load, definitionId: d.id, headers: { Authorization: "Bearer secret-token" }, body: { password: "sensitive-pass", productId: "SKU" } });
    const plan = performancePlan("http://localhost:3000", options);
    expect(plan.code).not.toContain("secret-token");
    expect(plan.code).not.toContain("sensitive-pass");
    expect(JSON.parse(plan.env.AIPROBE_BODY)).toEqual(options.body);
    const snapshot = redactPerformanceOptions(options);
    expect(JSON.stringify(snapshot)).not.toContain("secret-token");
    expect(JSON.stringify(snapshot)).not.toContain("sensitive-pass");
    expect(snapshot.body).toMatchObject({ productId: "SKU", password: "[已隐藏]" });
    expect(plan.code).toContain('"p(99)"');
  });
});

describe("性能演示数据与趋势", () => {
  it("uses only definitions from the existing interface catalogue", async () => {
    const defs = await catalogue().listApiDefinitions("p");
    const rows = performanceDemoRows("p", defs);
    expect(rows).toHaveLength(12);
    expect(new Set(rows.map(r => r.status))).toEqual(new Set(["passed", "failed", "degraded", "stopped", "error"]));
    for (const r of rows) {
      const d = defs.find(d => d.id === r.options.definitionId)!;
      expect(r.options.path).toBe(d.path);
      expect(r.options.method).toBe(d.method);
      expect(r.message).toContain("演示数据");
      expect(r.reportPath).toBe("");
    }
    expect(rows.find(r => r.status === "error")!.p95Ms).toBeNull();
    expect(performanceDemoRows("empty", [])).toEqual([]);
  });

  it("isolates projects and returns cloned results", async () => {
    const demo = createPerformanceDemo(catalogue().listApiDefinitions);
    const rows = await demo.performanceHistory("p");
    rows[0].status = "passed";
    expect((await demo.performanceHistory("p"))[0].status).toBe("error");
    expect((await demo.performanceHistory("other"))[0].id).not.toBe(rows[0].id);
  });

  it("stores a demo baseline per project and rejects invalid selections", async () => {
    const demo = createPerformanceDemo(catalogue().listApiDefinitions);
    const rows = await demo.performanceHistory("p");
    const passed = rows.find(r => r.status === "passed")!;
    const key = `${passed.options.method}:${passed.options.path}`;
    await demo.perfSetBaseline("p", key, passed.id);
    expect((await demo.perfGetBaseline("p", key))?.id).toBe(passed.id);
    expect(await demo.perfGetBaseline("other", key)).toBeNull();
    await expect(demo.perfSetBaseline("other", key, passed.id)).rejects.toThrow();
    await expect(demo.perfSetBaseline("p", "GET:/wrong", passed.id)).rejects.toThrow("同一目标");
    await expect(demo.perfSetBaseline("p", key, rows[0].id)).rejects.toThrow("已通过");
  });

  it("sorts oldest first and never joins different targets, environments or loads", async () => {
    const demo = createPerformanceDemo(catalogue().listApiDefinitions);
    const rows = await demo.performanceHistory("p");
    const product = rows.find(r => r.options.definitionId === "api_products" && r.status === "passed")!;
    const key = performanceSeriesKey(product);
    const foreign = { ...product, id: "foreign", env: "staging" };
    const changedLoad = { ...product, id: "changed", options: { ...product.options, vus: 50 } };
    const points = performanceTrend([...rows, foreign, changedLoad], key);
    expect(points).toHaveLength(8);
    expect(points[0].p95Ms).toBe(200);
    expect(points.at(-1)?.p95Ms).toBe(215);
    expect(points.some(r => ["error", "stopped"].includes(r.status))).toBe(false);
    expect(performanceTrend(rows, key, 2)).toHaveLength(2);
    expect(performanceTrend(rows, key, 0)).toEqual([]);
  });
});
