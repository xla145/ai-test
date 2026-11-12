import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { writeUiScript, type UiStep } from "@ai-test/mcp-servers";
import { Orchestrator, type EngineCall, type UiDeps } from "../src/main/orchestrator.js";

const mk = (id: string, tag: string, extra: Record<string, unknown> = {}) => ({
  id, title: `标签管理-停用标签 ${tag}`, execution_mode: "ui", status: "reviewed", lint_status: "passed", priority: "P1", data_refs: [],
  steps: ["进入标签管理页", `停用标签 ${tag}`], expected: ["展示标签列表", "状态显示为「已停用」"], preconditions: ["存在启用中的标签 TAG-1001"], ...extra,
});

function setup() {
  const ws = mkdtempSync(join(tmpdir(), "aitest-derive-"));
  const cases = [
    mk("tc_a", "TAG-1001"), mk("tc_b", "TAG-1002"), mk("tc_c", "TAG-1003", { lint_status: "blocked" }),
    { ...mk("tc_d", "TAG-1004"), steps: ["进入标签管理页", "启用标签 TAG-1004"] },
  ];
  const steps: UiStep[] = [
    { id: "S1", caseStep: 1, action: "goto", url: "/tags" },
    { id: "S2", caseStep: 2, action: "click", target: { kind: "testid", value: "disable-TAG-1001" } },
    { id: "S3", caseStep: 2, action: "expectText", target: { kind: "testid", value: "status-TAG-1001" }, text: "已停用" },
  ];
  const scripts = [{ case_id: "tc_a", framework: "playwright", path: writeUiScript(ws, { caseId: "tc_a", title: cases[0].title, steps }).path }];
  const calls: string[][] = [];
  const engine = vi.fn(async (args: string[]) => {
    calls.push(args);
    switch (args[0]) {
      case "list-projects": return [{ id: "p1", name: "demo", workspace_path: ws, environments: { test: { base_url: "http://sut" } } }];
      case "list-cases": return cases;
      case "list-scripts": return scripts;
      case "register-script": scripts.push({ case_id: args[4], framework: "playwright", path: args[6] }); return {};
      case "list-roles": case "list-test-data": return [];
      case "save-run": return { run_id: "run_1", total: 2, passed: 2, failed: 0, error: 0, skipped: 0, pass_rate: 1, failure_types: {}, needs_agent: [], reviews: 0 };
      default: return {};
    }
  }) as unknown as EngineCall;
  const ui: UiDeps = {
    checkData: vi.fn(async () => []) as any, seedData: vi.fn(async () => []) as any,
    runUiSuite: vi.fn(async (o: { caseIds: string[] }) => ({
      exitCode: 0, reportJson: "", htmlReport: "", stderr: "", errors: [],
      results: o.caseIds.map((id) => ({ case_id: id, status: "passed", duration: 1, message: "", evidence_paths: [], reviews: [] })),
    })) as any,
  };
  const orch = new Orchestrator({ engine, ui, secretEnv: () => ({}), agent: async () => { throw new Error("不应调用模型"); } });
  return { ws, orch, calls, ui };
}

describe("parameterized UI scripts", () => {
  it("groups cases that share a script skeleton", async () => {
    const { orch } = setup();
    const groups = await orch.uiCaseGroups("p1");
    expect(groups.map((g) => g.cases.map((c) => c.id))).toEqual([["tc_a", "tc_b", "tc_c"], ["tc_d"]]);
    expect(groups[0].cases[1].variant).toBe("TAG-1002");
  });

  it("derives sibling scripts by substituting parameters, without the model", async () => {
    const { ws, orch, calls } = setup();
    const out = await orch.deriveUiScripts("p1", "test", "tc_a");
    expect(out.derived).toEqual(["tc_b"]);
    expect(out.skipped).toEqual([{ caseId: "tc_c", reason: "用例被规范检查阻断" }]);
    const spec = readFileSync(join(ws, "scripts/ui/tc_b.spec.ts"), "utf8");
    expect(spec).toContain("disable-TAG-1002");
    expect(spec).not.toContain("TAG-1001");
    expect(spec).toContain("按参数替换自用例 tc_a");
    expect(JSON.parse(readFileSync(join(ws, "scripts/ui/tc_b.steps.json"), "utf8")).derivedFrom).toBe("tc_a");
    expect(existsSync(join(ws, "scripts/ui/tc_d.spec.ts"))).toBe(false);
    expect(calls.filter((c) => c[0] === "register-script").map((c) => c[4])).toEqual(["tc_b"]);
    // 派生出的脚本可单步调试，并标记来源
    expect((await orch.uiScriptDetail("p1", "test", "tc_b"))).toMatchObject({ synced: true, derivedFrom: "tc_a" });
    // 已有脚本的用例不会被覆盖
    expect((await orch.deriveUiScripts("p1", "test", "tc_a")).derived).toEqual([]);
  });

  it("validates several scripts headless in parallel, but only one at a time in the embedded browser", async () => {
    const { orch, ui } = setup();
    await orch.deriveUiScripts("p1", "test", "tc_a");
    await orch.runUiRegression("p1", "test", { mode: "validate", caseIds: ["tc_a", "tc_b"], workers: 3 });
    expect((ui.runUiSuite as any).mock.calls[0][0]).toMatchObject({ caseIds: ["tc_a", "tc_b"], workers: 3 });
    const states = await orch.uiScriptStates("p1", "test");
    expect(states.tc_b.validatedRunId).toBe("run_1");
    await expect(orch.runUiRegression("p1", "test", { mode: "validate", caseIds: ["tc_a", "tc_b"], embedded: true }))
      .rejects.toThrow("内嵌浏览器一次只能试跑一条用例");
  });
});
