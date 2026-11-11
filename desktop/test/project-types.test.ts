import { describe, expect, it, vi } from "vitest";
import { visibleProjectTab } from "../src/renderer/projectTypes.js";
import { Orchestrator, type EngineCall } from "../src/main/orchestrator.js";

describe("项目测试端", () => {
  it.each([
    ["web", true, false], ["app", false, true], ["api", false, false], ["multi", true, true],
  ] as const)("%s displays its own test tabs and keeps common capabilities", (type, web, app) => {
    expect(visibleProjectTab("ui", type)).toBe(web);
    expect(visibleProjectTab("app", type)).toBe(app);
    for (const key of ["import", "api", "cases", "run", "db", "reports", "ops"]) {
      expect(visibleProjectTab(key, type)).toBe(true);
    }
  });
  it("keeps all tabs for projects created before types existed", () => {
    expect(visibleProjectTab("ui")).toBe(true);
    expect(visibleProjectTab("app")).toBe(true);
  });
  it("passes project types on create and update while keeping groups separate", async () => {
    const engine = vi.fn(async () => ({}));
    const orch = new Orchestrator({ engine: engine as EngineCall, agent: vi.fn(), secretEnv: () => ({}) });
    await orch.createProject("移动端", "/ws/app", {}, { parent: "g", projectType: "app" });
    await orch.setProjectType("p", "web");
    await orch.createProject("产品", "", {}, { kind: "group", projectType: "app" });
    expect(engine.mock.calls).toEqual([
      [["init-project", "--name", "移动端", "--workspace", "/ws/app", "--environments", "{}", "--parent", "g", "--project-type", "app"]],
      [["update-project", "--project", "p", "--project-type", "web"]],
      [["init-project", "--name", "产品", "--kind", "group", "--environments", "{}"]],
    ]);
  });
});
