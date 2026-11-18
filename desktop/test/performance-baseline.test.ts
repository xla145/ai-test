import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Orchestrator, type EngineCall } from "../src/main/orchestrator.js";
import { readPerformanceResult } from "../src/main/performance.js";

const folders: string[] = [];
function setup() {
  const root = mkdtempSync(join(tmpdir(), "perf-baseline-"));
  folders.push(root);
  const reportDir = join(root, "reports", "performance");
  mkdirSync(reportDir, { recursive: true });
  const refs = new Map<string, { result_id: string }>();
  const engine = vi.fn(async (args: string[]) => {
    const value = (flag: string) => args[args.indexOf(flag) + 1];
    if (args[0] === "list-projects") return [{ id: "p", workspace_path: root, environments: {} }];
    const target = value("--target");
    if (args[0] === "perf-save-baseline") { refs.set(target, { result_id: value("--result") }); return {}; }
    if (args[0] === "perf-get-baseline") return refs.get(target) ?? null;
    throw new Error("Unexpected command");
  });
  const orch = new Orchestrator({ engine: engine as EngineCall, agent: vi.fn(), secretEnv: () => ({}) });
  const result = { id: "perf-saved", status: "passed", thresholdsPassed: true, requests: 10,
    p95Ms: 123, requestsPerSecond: 1, failureRate: 0, options: { method: "GET", path: "/health", vus: 1, seconds: 10, p95Ms: 500, maxFailureRate: 0.01 } };
  const write = (data = result) => writeFileSync(join(reportDir, `${data.id}.json`), JSON.stringify(data));
  return { root, reportDir, result, write, orch, engine };
}
afterEach(() => { for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }); });

describe("性能基线保存和读取", () => {
  it("saves a real report reference and reads back PerformanceResult, not database metadata", async () => {
    const { orch, write, result, engine } = setup();
    write();
    await orch.perfSetBaseline("p", "GET:/health", result.id);
    expect(engine).toHaveBeenCalledWith(["perf-save-baseline", "--project", "p", "--target", "GET:/health", "--result", result.id]);
    expect(await orch.perfGetBaseline("p", "GET:/health")).toEqual(result);
    expect(await orch.perfGetBaseline("p", "GET:/missing")).toBeNull();
  });
  it.each(["failed", "stopped", "error", "degraded"])("rejects %s results even when bypassing the UI", async status => {
    const { orch, write, result, engine } = setup();
    write({ ...result, status });
    await expect(orch.perfSetBaseline("p", "GET:/health", result.id)).rejects.toThrow("通过门槛");
    expect(engine.mock.calls.some(([args]) => args[0] === "perf-save-baseline")).toBe(false);
  });
  it("rejects missing reports, zero requests and wrong targets", async () => {
    const { orch, write, result } = setup();
    await expect(orch.perfSetBaseline("p", "GET:/health", result.id)).rejects.toThrow("找不到");
    write({ ...result, requests: 0 });
    await expect(orch.perfSetBaseline("p", "GET:/health", result.id)).rejects.toThrow("完整执行");
    write();
    await expect(orch.perfSetBaseline("p", "POST:/other", result.id)).rejects.toThrow("同一测试目标");
  });
  it("reads by ID regardless of how many newer reports exist", () => {
    const { root, write, result } = setup();
    write();
    for (let i = 0; i < 105; i++) write({ ...result, id: `perf-new-${i}` });
    expect(readPerformanceResult(root, result.id)).toEqual(result);
  });
  it("rejects traversal and a report symlink outside the report directory", () => {
    const { root, reportDir, result } = setup();
    expect(() => readPerformanceResult(root, "../secret")).toThrow("ID 无效");
    const outside = join(root, "outside.json");
    writeFileSync(outside, JSON.stringify(result));
    symlinkSync(outside, join(reportDir, `${result.id}.json`));
    expect(() => readPerformanceResult(root, result.id)).toThrow("报告目录");
  });
});
