import { beforeEach, describe, expect, it, vi } from "vitest";
import { Orchestrator, type EngineCall } from "../src/main/orchestrator";
import { runPerformance } from "../src/main/performance";
import { workspaceMock } from "../src/renderer/pages/api/workspaceMock";
import type { PerformanceOptions } from "../src/shared/performance";

vi.mock("../src/main/performance", async importOriginal => ({
  ...await importOriginal<typeof import("../src/main/performance")>(),
  runPerformance: vi.fn(async () => ({ id: "perf-test", status: "passed", requests: 5, p95Ms: 100 })),
}));
const options: PerformanceOptions = { path: "/injected", method: "DELETE", vus: 1, seconds: 1, p95Ms: 500, maxFailureRate: .01, definitionId: "api_products", definitionRevision: 1 };

async function setup() {
  const definitions = await workspaceMock([]).listApiDefinitions("p");
  const engine = vi.fn(async (args: string[]) => args[0] === "list-projects"
    ? [{ id: "p", workspace_path: "/workspace", environments: { test: { base_url: "http://localhost:3000" }, prod: { base_url: "http://localhost:3000", production: true } } }]
    : definitions);
  const orch = new Orchestrator({ engine: engine as EngineCall, agent: vi.fn(), secretEnv: () => ({}) });
  return { definitions, engine, orch };
}

beforeEach(() => vi.clearAllMocks());
describe("性能执行使用当前项目接口目录", () => {
  it("resolves catalogue metadata before calling the runner", async () => {
    const { orch, engine } = await setup();
    await orch.runPerformance("p", "test", options);
    expect(engine.mock.calls.some(([args]) => args[0] === "api-workspace")).toBe(true);
    expect(vi.mocked(runPerformance).mock.calls[0][3]).toMatchObject({
      method: "GET", path: "/products", definitionId: "api_products", definitionRevision: 1, definitionName: "商品列表",
    });
  });

  it("rejects a missing selection, another project's ID and a stale revision", async () => {
    const { orch } = await setup();
    await expect(orch.runPerformance("p", "test", { ...options, definitionId: undefined })).rejects.toThrow("接口列表");
    await expect(orch.runPerformance("p", "test", { ...options, definitionId: "foreign" })).rejects.toThrow("当前项目");
    await expect(orch.runPerformance("p", "test", { ...options, definitionRevision: 0 })).rejects.toThrow("更新");
    expect(runPerformance).not.toHaveBeenCalled();
  });

  it("rejects removed definitions and production before launching k6", async () => {
    const { orch, definitions } = await setup();
    definitions.find(d => d.id === "api_products")!.removed = true;
    await expect(orch.runPerformance("p", "test", options)).rejects.toThrow("移除");
    await expect(orch.runPerformance("p", "prod", options)).rejects.toThrow("生产");
    expect(runPerformance).not.toHaveBeenCalled();
  });
});
