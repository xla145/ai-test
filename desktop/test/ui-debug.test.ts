import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeUiScript, type UiStep } from "@ai-test/mcp-servers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Orchestrator, type EngineCall } from "../src/main/orchestrator.js";
import { UiDebugSession } from "../src/main/uiDebug.js";

const steps: UiStep[] = ["S1", "S2", "S3", "S4"].map((id) => ({ id, action: "press", key: id }));

function session(fail: Set<string> = new Set(), opts: { delay?: number } = {}) {
  const ran: string[] = [];
  const prepareRole = vi.fn(async () => undefined);
  const browser = {
    runStep: vi.fn(async (st: UiStep) => {
      if (opts.delay) await new Promise((r) => setTimeout(r, opts.delay));
      ran.push(st.id!);
      if (fail.has(st.id!)) { fail.delete(st.id!); throw new Error(`${st.id} 超时`); }
      return st.id === "S2" ? { note: "截图" } : {};
    }),
    resetCaptures: vi.fn(),
    close: vi.fn(async () => undefined),
  };
  const emit = vi.fn();
  const s = new UiDebugSession({
    projectId: "p", env: "test", caseId: "tc_a", file: { version: 1, caseId: "tc_a", title: "A", specHash: "", steps },
    browser, prepareRole, runOptions: {}, emit,
  });
  return { s, ran, browser, prepareRole, emit };
}

describe("UiDebugSession", () => {
  it("steps one at a time, prepares each role once and reports notes", async () => {
    const { s, ran, prepareRole } = session();
    expect(s.state()).toMatchObject({ phase: "paused", cursor: "S1" });
    await s.command({ type: "step" }); await s.idle();
    await s.command({ type: "step" }); await s.idle();
    expect(ran).toEqual(["S1", "S2"]);
    expect(prepareRole).toHaveBeenCalledTimes(1);
    expect(s.state()).toMatchObject({ phase: "paused", cursor: "S3", statuses: { S1: { status: "passed" }, S2: { status: "passed", note: "截图" } } });
  });

  it("continues until a breakpoint (not the starting step), then to the end", async () => {
    const { s, ran } = session();
    await s.command({ type: "breakpoint", stepId: "S3" });
    await s.command({ type: "continue" }); await s.idle();
    expect(ran).toEqual(["S1", "S2"]);
    expect(s.state()).toMatchObject({ phase: "paused", cursor: "S3", message: "停在断点 S3" });
    await s.command({ type: "continue" }); await s.idle();
    expect(ran).toEqual(["S1", "S2", "S3", "S4"]);
    expect(s.state().phase).toBe("finished");
    await expect(s.command({ type: "step" })).rejects.toThrow("最后一步");
  });

  it("stops at a failing step keeping the cursor there; retry, skip and seek move on", async () => {
    const { s, ran } = session(new Set(["S2"]));
    await s.command({ type: "continue" }); await s.idle();
    expect(s.state()).toMatchObject({ phase: "paused", cursor: "S2", statuses: { S2: { status: "failed", error: "S2 超时" } } });
    await s.command({ type: "step" }); await s.idle(); // 重试
    expect(s.state()).toMatchObject({ cursor: "S3", statuses: { S2: { status: "passed" } } });
    await s.command({ type: "skip" });
    expect(s.state()).toMatchObject({ cursor: "S4", statuses: { S3: { status: "skipped" } } });
    await s.command({ type: "seek", stepId: "S2" });
    expect(s.state()).toMatchObject({ cursor: "S2" });
    expect(s.state().statuses.S3).toBeUndefined();
    await s.command({ type: "runTo", stepId: "S3" }); await s.idle();
    expect(ran).toEqual(["S1", "S2", "S2", "S2", "S3"]);
    expect(s.state()).toMatchObject({ phase: "paused", cursor: "S4" });
    await expect(s.command({ type: "runTo", stepId: "S1" })).rejects.toThrow("已执行过");
  });

  it("pauses after the current step, rejects concurrent runs, restarts and stops", async () => {
    const { s, ran, browser } = session(new Set(), { delay: 20 });
    await s.command({ type: "continue" });
    await expect(s.command({ type: "step" })).rejects.toThrow("正在执行");
    await s.command({ type: "pause" }); await s.idle();
    expect(ran).toEqual(["S1"]);
    expect(s.state()).toMatchObject({ phase: "paused", cursor: "S2", message: "已暂停" });
    await s.command({ type: "restart" });
    expect(s.state()).toMatchObject({ cursor: "S1", statuses: {} });
    expect(browser.resetCaptures).toHaveBeenCalled();
    await s.command({ type: "stop" });
    expect(s.state().phase).toBe("stopped");
    expect(browser.close).toHaveBeenCalled();
    await expect(s.command({ type: "step" })).rejects.toThrow("调试已结束");
  });
});

describe("UI debug orchestration", () => {
  const dirs: string[] = [];
  afterEach(() => { dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })); });
  function setup() {
    const dir = mkdtempSync(join(tmpdir(), "aitest-ui-debug-")); dirs.push(dir);
    mkdirSync(join(dir, "scripts/ui"), { recursive: true });
    const { path } = writeUiScript(dir, { caseId: "tc_a", title: "A", steps: [
      { action: "goto", url: "/a" }, { action: "fill", target: { kind: "label", value: "密码" }, value: "", secretEnv: "AITEST_PW", role: "admin" },
    ] });
    writeFileSync(join(dir, "scripts/ui/tc_b.spec.ts"), "// 旧脚本");
    const engine = vi.fn(async (args: string[]) => {
      switch (args[0]) {
        case "list-projects": return [{ id: "p", workspace_path: dir, environments: { test: { base_url: "http://sut", login: { url: "/login" } } } }];
        case "list-cases": return [{ id: "tc_a", title: "A", execution_mode: "ui", status: "reviewed", data_refs: [] },
          { id: "tc_b", title: "B", execution_mode: "ui", status: "reviewed", data_refs: [] }];
        case "list-scripts": return [{ case_id: "tc_a", path, framework: "playwright" }, { case_id: "tc_b", path: "scripts/ui/tc_b.spec.ts", framework: "playwright" }];
        default: return [];
      }
    }) as unknown as EngineCall;
    const browser = { runStep: vi.fn(async () => ({})), resetCaptures: vi.fn(), close: vi.fn(async () => undefined), newRoleContext: vi.fn(async () => ({})) };
    const ui = { runUiSuite: vi.fn(), checkData: vi.fn(async () => []), seedData: vi.fn(), createDebugBrowser: vi.fn(() => browser) };
    const secretEnv = vi.fn(() => ({ AITEST_ROLES: JSON.stringify([{ role: "admin", username: "u", password: "pw" }]), AITEST_PW: "pw" }));
    const orch = new Orchestrator({ engine, ui: ui as any, agent: vi.fn(), secretEnv });
    return { orch, ui, browser, secretEnv };
  }

  it("replays steps with role login and secrets, and holds the browser exclusively until stopped", async () => {
    const { orch, browser, secretEnv } = setup();
    await expect(orch.uiDebugStart("p", "test", "tc_b")).rejects.toThrow("没有结构化步骤");
    const state = await orch.uiDebugStart("p", "test", "tc_a");
    expect(state).toMatchObject({ caseId: "tc_a", cursor: "S1", phase: "paused" });
    expect(secretEnv).toHaveBeenCalledWith("p", "test", ["admin"]);
    await expect(orch.uiDebugStart("p", "test", "tc_a")).rejects.toThrow("已有调试会话");
    await expect(orch.exploreUiCase("p", "test", "tc_a")).rejects.toThrow("单步调试进行中");
    await orch.uiDebugCommand({ type: "continue" });
    await vi.waitFor(() => expect(orch.uiDebugState()?.phase).toBe("finished"));
    expect(browser.newRoleContext).toHaveBeenCalledWith("default", {});
    expect(browser.newRoleContext).toHaveBeenCalledWith("admin", { login: { url: "/login" }, credentials: { username: "u", password: "pw" } });
    expect(browser.runStep.mock.calls[1][1]).toMatchObject({ secrets: { AITEST_PW: "pw" } });
    await orch.uiDebugCommand({ type: "stop" });
    expect(orch.uiDebugState()).toBeNull();
    await expect(orch.uiDebugCommand({ type: "step" })).rejects.toThrow("没有进行中的调试");
  });
});
