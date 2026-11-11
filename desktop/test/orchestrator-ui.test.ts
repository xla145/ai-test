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

describe("production guard and UI failure details", () => {
  const prodProject = { ...project, environments: { ...project.environments, prod: { base_url: "https://prod", production: true } } };

  it("refuses to run against a production environment without confirmation", async () => {
    const { engine, ui, secretEnv } = setup([]);
    const prodEngine = vi.fn(async (args: string[]) => (args[0] === "list-projects" ? [prodProject] : (engine as any)(args))) as unknown as EngineCall;
    const orch = new Orchestrator({ engine: prodEngine, ui, secretEnv, agent: vi.fn() });
    await expect(orch.runRegression("p1", "prod")).rejects.toThrow("生产环境");
    await expect(orch.runUiRegression("p1", "prod")).rejects.toThrow("生产环境");
    expect(ui.runUiSuite).not.toHaveBeenCalled();
    expect((prodEngine as any).mock.calls.some(([a]: [string[]]) => a[0] === "run-api-suite")).toBe(false);
  });

  it("returns failure details merged with agent conclusions", async () => {
    const { engine, ui, secretEnv } = setup([]);
    const withResults = vi.fn(async (args: string[]) => {
      if (args[0] === "list-run-results") return [
        { case_id: "tc_a", status: "passed", failure_type: null, message: "" },
        { case_id: "tc_b", status: "failed", failure_type: "unknown", message: "Timeout waiting for locator" },
        { case_id: "tc_c", status: "error", failure_type: "environment", message: "ERR_CONNECTION_REFUSED" },
      ];
      return (engine as any)(args);
    }) as unknown as EngineCall;
    const orch = new Orchestrator({ engine: withResults, ui, secretEnv, agent: vi.fn() });
    vi.spyOn(orch, "healUi").mockResolvedValue([{ case_id: "tc_b", failure_type: "script_error", reason: "testid 变更" }]);
    const out = await orch.runUiRegression("p1", "test");
    expect(out.failures).toEqual([
      { case_id: "tc_b", status: "failed", message: "Timeout waiting for locator", failure_type: "script_error", reason: "testid 变更" },
      { case_id: "tc_c", status: "error", message: "ERR_CONNECTION_REFUSED", failure_type: "environment" },
    ]);
  });
});

describe("App testing", () => {
  const appProject = {
    ...project,
    environments: {
      test: { base_url: "http://sut", app: { android: "com.example.shop", ios: "com.example.shop.ios" } },
      prod: { base_url: "https://prod", production: true, app: { android: "com.example.shop" } },
      bare: { base_url: "http://bare" },
    },
  };
  function appSetup() {
    const calls: string[][] = [];
    const engine = vi.fn(async (args: string[]) => {
      calls.push(args);
      switch (args[0]) {
        case "list-projects": return [appProject];
        case "list-scripts": return [
          { case_id: "tc_a", path: "scripts/app/tc_a.yaml", framework: "maestro" },
          { case_id: "tc_b", path: "scripts/app/tc_b.yaml", framework: "maestro" },
          { case_id: "tc_c", path: "scripts/ui/tc_c.spec.ts", framework: "playwright" },
        ];
        case "list-cases": return cases;
        case "list-roles": return [{ role_name: "admin" }];
        case "save-run": return { run_id: "run_app", total: 2, passed: 1, failed: 1, error: 0, skipped: 0, pass_rate: 0.5, failure_types: {}, needs_agent: [] };
        case "list-run-results": return [
          { case_id: "tc_a", status: "passed", message: "" },
          { case_id: "tc_b", status: "failed", failure_type: "environment", message: "Device emulator-5554 not found" },
        ];
        default: return {};
      }
    }) as unknown as EngineCall;
    const runAppSuite = vi.fn(async () => ({
      exitCode: 1, junit: "", outDir: "/ws/reports/app-x", errors: [], stderr: "",
      results: [
        { case_id: "tc_a", status: "passed", duration: 1, message: "", evidence_paths: [], reviews: [] },
        { case_id: "tc_b", status: "failed", duration: 1, message: "Device emulator-5554 not found", evidence_paths: [], reviews: [] },
      ],
    }));
    const secretEnv = vi.fn(() => ({ AITEST_ROLES: JSON.stringify([{ role: "admin", username: "u", password: "p" }]) }));
    return { engine, calls, runAppSuite, secretEnv };
  }

  it("runs maestro flows for the chosen platform without the model and records rule attributions", async () => {
    const { engine, calls, runAppSuite, secretEnv } = appSetup();
    const agent = vi.fn();
    const orch = new Orchestrator({ engine, secretEnv, agent, app: { runAppSuite: runAppSuite as any, maestroBin: () => "/opt/maestro" } });
    const out = await orch.runAppRegression("p1", "test", "ios", { device: "UDID-1" });
    expect(agent).not.toHaveBeenCalled();
    expect(runAppSuite).toHaveBeenCalledWith({
      workspace: "/ws", platform: "ios", appId: "com.example.shop.ios", caseIds: ["tc_a", "tc_b"], device: "UDID-1",
      roles: [{ role: "admin", username: "u", password: "p" }], maestroBin: "/opt/maestro",
    });
    expect(calls.find((a) => a[0] === "save-run")).toContain("maestro");
    expect(out.failures).toEqual([{ case_id: "tc_b", status: "failed", message: "Device emulator-5554 not found", failure_type: "environment" }]);
    expect(calls.find((a) => a[0] === "set-attribution")).toEqual(
      ["set-attribution", "--run", "run_app", "--case", "tc_b", "--type", "environment", "--source", "rule", "--reason", "确定性规则判定"]);
  });

  it("guards production, missing app ids and missing Pinky", async () => {
    const { engine, runAppSuite, secretEnv } = appSetup();
    const orch = new Orchestrator({ engine, secretEnv, agent: vi.fn(), app: { runAppSuite: runAppSuite as any, pinkyEnabled: () => false } });
    await expect(orch.runAppRegression("p1", "prod", "android")).rejects.toThrow("生产环境");
    await expect(orch.runAppRegression("p1", "prod", "ios", { confirmProduction: true })).rejects.toThrow("iOS Bundle ID");
    await expect(orch.runAppRegression("p1", "bare", "android")).rejects.toThrow("Android 包名");
    await expect(orch.exploreAppCase("p1", "test", "android", "tc_a")).rejects.toThrow("Pinky");
    expect(runAppSuite).not.toHaveBeenCalled();
  });

  it("explores with an agent task that uses Pinky and the app server", async () => {
    const { engine, secretEnv, runAppSuite } = appSetup();
    const runTurn = vi.fn(async () => ({ status: "completed", message: "已生成脚本", tokens: 100 }));
    const orch = new Orchestrator({ engine, secretEnv, agent: async () => ({ startThread: async () => "th", runTurn }) as any,
      app: { runAppSuite: runAppSuite as any, pinkyEnabled: () => true } });
    await orch.exploreAppCase("p1", "test", "android", "tc_a");
    const prompt = (runTurn.mock.calls[0] as unknown as [string, string])[1];
    expect(prompt).toContain("pinky");
    expect(prompt).toContain("app.save_app_flow");
    expect(prompt).toContain("com.example.shop");
    expect(prompt).toContain("appId: ${APP_ID}");
  });
});
