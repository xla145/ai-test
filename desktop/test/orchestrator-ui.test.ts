import { describe, expect, it, vi } from "vitest";
import { Orchestrator, type EngineCall, type UiDeps } from "../src/main/orchestrator.js";

const project = {
  id: "p1", name: "demo", workspace_path: "/ws",
  environments: { test: { base_url: "http://sut", login: { url: "/login", username: "#u", password: "#p", submit: "#s" } } },
};
const cases = [
  { id: "tc_a", title: "A", execution_mode: "ui", status: "reviewed", data_refs: [] },
  { id: "tc_b", title: "B", execution_mode: "ui", status: "reviewed", data_refs: ["DEM-1002"] },
  { id: "tc_c", title: "C", execution_mode: "ui", status: "reviewed", data_refs: ["U1003"] },
  { id: "tc_d", title: "D", execution_mode: "ui", status: "draft", data_refs: [] }, // 无脚本
];

function setup(uiResults: any[]) {
  const calls: string[][] = [];
  const engine = vi.fn(async (args: string[]) => {
    calls.push(args);
    switch (args[0]) {
      case "list-projects": return [project];
      case "list-scripts": return ["tc_a", "tc_b", "tc_c"].map((id) => ({ case_id: id, path: `scripts/ui/${id}.spec.ts`, framework: "playwright" }));
      case "list-cases": return cases;
      case "list-test-data": return [];
      case "list-roles": return [{ role_name: "admin" }];
      case "save-run": return { run_id: "run_1", total: 2, passed: 1, failed: 1, error: 0, skipped: 0, pass_rate: 0.5, failure_types: {}, needs_agent: ["tc_b"], reviews: 0 };
      case "agent-session": return { id: "as_1" };
      default: return {};
    }
  }) as unknown as EngineCall;
  const ui: UiDeps = {
    checkData: vi.fn(async (_e, keys: string[]) => keys.map((k) => ({ key: k, exists: false, via: "api" as const }))) as any,
    seedData: vi.fn(async (_e, keys: string[]) => keys.map((k) => ({ key: k, seeded: k === "DEM-1002", via: "api" }))) as any,
    runUiSuite: vi.fn(async () => ({ exitCode: 1, reportJson: "", htmlReport: "/ws/reports/x/html", stderr: "", results: uiResults })) as any,
  };
  const secretEnv = vi.fn((_p: string, _e: string, roles?: string[]) => ({ AITEST_ROLES: JSON.stringify(roles ?? []) }));
  return { engine, calls, ui, secretEnv };
}

describe("UI regression orchestration", () => {
  it("seeds data, degrades cases with missing data, runs scripts without the model and heals undetermined failures", async () => {
    const results = [
      { case_id: "tc_a", status: "passed", duration: 1, message: "", evidence_paths: [], reviews: [] },
      { case_id: "tc_b", status: "failed", duration: 1, message: 'waiting for getByTestId("old")', evidence_paths: ["reports/x/trace.zip"], reviews: [] },
    ];
    const { engine, calls, ui, secretEnv } = setup(results);
    const runTurn = vi.fn(async (_t: string, prompt: string) => ({
      threadId: "th", turnId: "u", status: "completed", tokens: 10,
      message: '```json\n[{"case_id":"tc_b","failure_type":"script_error","reason":"按钮 testid 变更"}]\n```',
      prompt,
    }));
    const orch = new Orchestrator({ engine, ui, secretEnv, agent: async () => ({ startThread: async () => "th", runTurn }) });
    const out = await orch.runUiRegression("p1", "test");

    expect(ui.seedData).toHaveBeenCalledWith(project.environments.test, ["DEM-1002", "U1003"], [], "/ws", expect.anything());
    expect(out.degraded).toEqual(["tc_c"]);
    expect(out.missingData).toEqual(["U1003"]);
    const runArgs = (ui.runUiSuite as any).mock.calls[0][0];
    expect(runArgs.caseIds).toEqual(["tc_a", "tc_b"]);
    expect(runArgs.env.AITEST_LOGIN).toContain("#u");
    expect(secretEnv).toHaveBeenCalledWith("p1", "test", ["admin"]);
    expect(calls.find((a) => a[0] === "save-run")).toContain("playwright");

    const prompt = runTurn.mock.calls[0][1];
    expect(prompt).toContain("自愈模式");
    expect(prompt).toContain("scripts/ui/tc_b.spec.ts");
    expect(prompt).toContain("reports/x/trace.zip");
    expect(prompt).not.toContain("tc_a");
    expect(out.heal).toEqual([{ case_id: "tc_b", failure_type: "script_error", reason: "按钮 testid 变更" }]);
  });

  it("does not call the agent when every failure is already classified", async () => {
    const { engine, ui, secretEnv } = setup([
      { case_id: "tc_b", status: "failed", duration: 1, message: "net::ERR_CONNECTION_REFUSED", evidence_paths: [], reviews: [], failure_type: "environment" },
    ]);
    const agent = vi.fn();
    const orch = new Orchestrator({ engine, ui, secretEnv, agent });
    const out = await orch.healUi("p1", "test", "run_1", [
      { case_id: "tc_b", status: "failed", duration: 1, message: "x", evidence_paths: [], reviews: [], failure_type: "environment" },
    ]);
    expect(out).toEqual([]);
    expect(agent).not.toHaveBeenCalled();
    await orch.runUiRegression("p1", "test", { autoHeal: false });
    expect(agent).not.toHaveBeenCalled();
  });

  it("starts an explore task in its own thread", async () => {
    const { engine, ui, secretEnv } = setup([]);
    const runTurn = vi.fn(async () => ({ threadId: "th", turnId: "u", status: "completed", tokens: 5, message: "ok" }));
    const startThread = vi.fn(async () => "th_explore");
    const orch = new Orchestrator({ engine, ui, secretEnv, agent: async () => ({ startThread, runTurn }) });
    await orch.exploreUiCase("p1", "test", "tc_a");
    expect((runTurn.mock.calls[0] as unknown[])[1]).toContain("browser.save_ui_script（case_id=tc_a）");
    expect(startThread).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/ws" }));
  });
});

describe("reports", () => {
  it("passes run ids, formats and output paths to the engine", async () => {
    const calls: string[][] = [];
    const engine = vi.fn(async (args: string[]) => { calls.push(args); return { path: "/out" }; }) as unknown as EngineCall;
    const orch = new Orchestrator({ engine, agent: vi.fn(), secretEnv: () => ({}) });
    await orch.listRuns("p1", "playwright", 20);
    await orch.runDetail("run_1");
    await orch.exportReport(["run_1", "run_2"], "html", "/tmp/r.html");
    await orch.exportReport(["run_1"], "xlsx");
    await orch.exportCasesExcel("p1", "/tmp/c.xlsx");
    expect(calls).toEqual([
      ["list-runs", "--project", "p1", "--limit", "20", "--framework", "playwright"],
      ["run-detail", "--run", "run_1"],
      ["export-report", "--run", "run_1", "--run", "run_2", "--format", "html", "--out", "/tmp/r.html"],
      ["export-report", "--run", "run_1", "--format", "xlsx"],
      ["export-excel", "--project", "p1", "--out", "/tmp/c.xlsx"],
    ]);
    expect(() => orch.exportReport([], "html")).toThrow("请选择");
  });

  it("records the Playwright HTML report location on UI runs", async () => {
    const { engine, calls, ui, secretEnv } = setup([{ case_id: "tc_a", status: "passed", duration: 1, message: "", evidence_paths: [], reviews: [] }]);
    const orch = new Orchestrator({ engine, ui, secretEnv, agent: vi.fn() });
    await orch.runUiRegression("p1", "test");
    const save = calls.find((a) => a[0] === "save-run")!;
    expect(save.slice(-2)).toEqual(["--html-report", "/ws/reports/x/html"]);
  });
});
