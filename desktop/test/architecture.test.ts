import { mkdtempSync, rmSync, writeFileSync, appendFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBridge } from "../src/renderer/bridge";
import { observeSystemTheme } from "../src/renderer/theme";
import { taskReducer, emptyTasks } from "../src/renderer/stores/taskStore";
import { mergeProgress } from "../src/renderer/stores/progressState";
import { TaskManager } from "../src/main/orchestrator/taskManager";
import { Diagnostics } from "../src/main/diagnostics";
import { TaskApprovals } from "../src/main/taskApprovals";
import { PerformanceMetrics, JsonLinesTail } from "../src/main/performanceProgress";
import { PageRegistry, pages } from "../src/renderer/pageRegistry";
import { checkExecutors } from "../src/main/executors";
import type { AitestApi } from "../src/shared/ipc";

const dirs: string[] = [];
const dir = () => { const d = mkdtempSync(join(tmpdir(), "aiprobe-architecture-")); dirs.push(d); return d; };
afterEach(() => dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })));
const meta = { projectId: "p", env: "test", kind: "test", caseIds: [], source: "api" as const };
const deferred = <T = void,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };

describe("safe bridge", () => {
  it("deduplicates only identical reads and releases failed calls", async () => {
    const gate = deferred<string[]>();
    const read = vi.fn(() => gate.promise), write = vi.fn(async () => "ok");
    const bridge = createBridge({ listCases: read, updateCase: write } as unknown as AitestApi);
    const first = bridge.api.listCases("p"), second = bridge.api.listCases("p"), third = bridge.api.listCases("q");
    expect(first).toBe(second); expect(third).not.toBe(first); expect(bridge.activeCount).toBe(2);
    gate.resolve([]); await Promise.all([first, third]); expect(read).toHaveBeenCalledTimes(2); expect(bridge.activeCount).toBe(0);
    await Promise.all([bridge.api.updateCase("x", {}), bridge.api.updateCase("x", {})]); expect(write).toHaveBeenCalledTimes(2);
    read.mockImplementationOnce(() => { throw new Error("Error invoking remote method 'x': Error: failed"); });
    await expect(bridge.api.listCases("p")).rejects.toThrow(/^failed$/);
    await bridge.api.listCases("p"); expect(bridge.activeCount).toBe(0);
  });
  it("retries only explicit read transport failures, never mutations or business errors", async () => {
    const disconnected = Object.assign(new Error("disconnected"), { code: "IPC_DISCONNECTED" });
    const listProjects = vi.fn().mockRejectedValueOnce(disconnected).mockResolvedValue([]);
    const updateCase = vi.fn().mockRejectedValue(disconnected);
    const bridge = createBridge({ listProjects, updateCase } as unknown as AitestApi);
    await bridge.api.listProjects(); expect(listProjects).toHaveBeenCalledTimes(2);
    await expect(bridge.api.updateCase("x", {})).rejects.toThrow(); expect(updateCase).toHaveBeenCalledTimes(1);
    listProjects.mockRejectedValue(new Error("business")); await expect(bridge.api.listProjects()).rejects.toThrow("business"); expect(listProjects).toHaveBeenCalledTimes(3);
  });
  it("shares one subscription and isolates subscribers and cleanup", () => {
    let receive!: (event: unknown) => void;
    const off = vi.fn(), onEvent = vi.fn(fn => { receive = fn; return off; });
    const bridge = createBridge({ onEvent } as unknown as AitestApi);
    const second = vi.fn(), stop = bridge.api.onEvent(() => { throw new Error("consumer"); });
    bridge.api.onEvent(second); receive({ method: "test" }); expect(second).toHaveBeenCalledOnce(); expect(onEvent).toHaveBeenCalledOnce();
    stop(); expect(off).not.toHaveBeenCalled(); bridge.dispose(); expect(off).toHaveBeenCalledOnce();
  });
});

describe("task channels", () => {
  it("queues FIFO, runs other channels concurrently and survives failures", async () => {
    const tasks = new TaskManager(), gate = deferred(); const order: string[] = [];
    const a = tasks.enqueue("a", meta, async () => { order.push("a1"); await gate.promise; throw new Error("failed"); });
    const rejection = expect(a).rejects.toThrow("failed");
    const b = tasks.enqueue("a", meta, async () => { order.push("a2"); });
    const c = tasks.enqueue("c", { ...meta, projectId: "q" }, async () => { order.push("c"); });
    await c; expect(order).toEqual(["a1", "c"]); expect(tasks.records.some(t => t.status === "queued")).toBe(true);
    gate.resolve(); await rejection; await b; expect(order).toEqual(["a1", "c", "a2"]);
    expect((tasks as any).chains.size).toBe(0);
  });
  it("stops queued work without invoking it and keeps late success stopped", async () => {
    const tasks = new TaskManager(), gate = deferred(), called = vi.fn();
    const running = tasks.enqueue("a", meta, async () => { await gate.promise; return "late"; });
    await Promise.resolve();
    const queued = tasks.enqueue("a", meta, called); const qRejected = expect(queued).rejects.toThrow();
    const rRejected = expect(running).rejects.toThrow();
    tasks.stop(tasks.records[0].id); tasks.stop(tasks.records[1].id);
    expect(tasks.records.map(t => t.status)).toEqual(["stopped", "stopping"]);
    await qRejected; // queued cancellation does not wait for the running predecessor
    gate.resolve(); await rRejected; expect(called).not.toHaveBeenCalled(); expect(tasks.records.every(t => t.status === "stopped")).toBe(true);
  });
  it("inherits parent cancellation without an explicit external signal", async () => {
    const tasks = new TaskManager(), ready = deferred(), exit = deferred();
    const work = tasks.enqueue("parent", meta, async () => tasks.enqueue("child", meta, async ({ signal }) => {
      ready.resolve(); await exit.promise; signal.throwIfAborted();
    }));
    const rejected = expect(work).rejects.toThrow(); await ready.promise;
    const parent = tasks.records.find(t => !t.parentTaskId)!; tasks.stop(parent.id);
    expect(tasks.records.every(t => t.status === "stopping")).toBe(true); exit.resolve(); await rejected;
    expect(tasks.records.every(t => t.status === "stopped")).toBe(true);
  });
  it("persists restart failure, returns isolated snapshots and never prunes live tasks", async () => {
    const file = join(dir(), "tasks.json"), tasks = new TaskManager(file), gate = deferred();
    const running = tasks.enqueue("live", meta, async () => gate.promise);
    for (let i=0;i<105;i++) await tasks.enqueue("done", meta, async () => i);
    expect(tasks.records).toHaveLength(101); expect(tasks.records.some(t => t.status === "running")).toBe(true);
    const snapshot = tasks.snapshot(); snapshot.tasks[0].kind = "mutated"; expect(tasks.records[0].kind).toBe("test");
    const restored = new TaskManager(file); expect(restored.records.every(t => t.status !== "running")).toBe(true);
    gate.resolve(); await running;
  });
});

describe("progress and diagnostics", () => {
  it("bounds diagnostic logs and drops free-text/secret fields", () => {
    const diagnostics = new Diagnostics(2);
    for (let i=0;i<3;i++) diagnostics.record({ chainId: "agent", taskId: String(i), projectId: "p", env: "test" }, "execute", { password: "secret", token: "secret", message: "secret", code: "secret", count: i, status: "running" });
    const output = diagnostics.export(); expect(output.truncated).toBe(true); expect(output.events).toHaveLength(2); expect(JSON.stringify(output)).not.toContain("secret"); expect(diagnostics.export("1").events).toHaveLength(1);
  });
  it("ignores stale task snapshots and merges replay with live events by sequence", () => {
    const next = taskReducer(emptyTasks, { revision: 3, tasks: [] }); expect(taskReducer(next, { revision: 2, tasks: [] })).toBe(next);
    const event = (seq: number, taskId = "a") => ({ taskId, seq, projectId: "p", env: "test", timestamp: seq, kind: "stage" as const, data: { stage: "run" } });
    expect(mergeProgress({ events: [event(3)], truncated: false }, { events: [event(1), event(3), event(4,"other")], truncated: false }, "a").events.map(e=>e.seq)).toEqual([1,3]);
  });
  it("calculates window P95 and request rate, not single request latency", () => {
    const metrics = new PerformanceMetrics(10000);
    const point = (metric: string, value: number) => JSON.stringify({ type: "Point", metric, data: { time: new Date(11000).toISOString(), value, tags: { url: "sensitive" } } });
    for(let i=1;i<=20;i++) metrics.accept(point("http_req_duration",i)); metrics.accept(point("http_reqs",20));
    expect(metrics.snapshot(12000).data).toMatchObject({ p95Ms: 19, requestsPerSecond: 10, samples: 20, windowSeconds: 2 });
    expect(metrics.snapshot(20000).data).toMatchObject({ p95Ms: null, requestsPerSecond: 0 });
  });
  it("marks overflow rather than returning biased percentiles", () => {
    const metrics = new PerformanceMetrics(0,5000,1);
    for(const value of [1,100]) metrics.accept(JSON.stringify({ type: "Point", metric: "http_req_duration", data: { time: new Date(1000).toISOString(), value } }));
    expect(metrics.snapshot(2000).data).toMatchObject({ truncated: true, p95Ms: null });
  });
  it("tails partial UTF8 lines, drains the final line and ignores missing files", () => {
    const file = join(dir(),"points"), lines: string[] = []; const tail = new JsonLinesTail(file, line => lines.push(line.trim()));
    const content = Buffer.from('{"value":"中文"}\n{"last":1}');
    const boundary = content.indexOf(Buffer.from("中")) + 1;
    tail.read(); writeFileSync(file, content.subarray(0, boundary)); tail.read(); expect(lines).toEqual([]);
    appendFileSync(file, content.subarray(boundary)); tail.read(true);
    expect(lines).toEqual(['{"value":"中文"}','{"last":1}']);
  });
});

describe("extension and policy boundaries", () => {
  it("isolates approval contexts and rejects unknown threads", () => {
    const scopes = new TaskApprovals();
    scopes.bind("a", { id:"a", name:"a", workspace_path:"/a", environments: { test:{ base_url:"http://a.test" } } });
    scopes.bind("b", { id:"b", name:"b", workspace_path:"/b", environments: { prod:{ base_url:"http://b.test", production:true } } });
    expect(scopes.get("a")?.allowedHosts).toEqual(["a.test"]); expect(scopes.get("b")?.productionHosts).toEqual(["b.test"]);
    scopes.release("a"); expect(scopes.get("a")).toBeUndefined(); expect(scopes.get("unknown")).toBeUndefined();
  });
  it("keeps common pages for App projects and detects invalid registrations", () => {
    expect(pages.list("app").map(p=>p.key)).toContain("performance"); expect(pages.list("api").map(p=>p.key)).not.toContain("ui");
    expect(pages.get("ui")?.keepAlive).toBe(true); expect(pages.get("settings")?.action).toBe("settings");
    const registry = new PageRegistry(); const definition = pages.get("home")!; registry.register(definition); expect(()=>registry.register(definition)).toThrow("重复");
  });
  it("checks pytest using the configured interpreter and never downloads packages", async () => {
    const command = vi.fn(async () => ({ ok:true, detail:"version" })), packages = vi.fn(() => ({ok:false,detail:"missing"}));
    const checks = await checkExecutors({ python:"/python",codex:"/codex",maestro:"/maestro",pinky:"/pinky",pinkyEnabled:false,pythonEnv:{PYTHONPATH:"bundled"} }, command, packages);
    expect(command).toHaveBeenCalledWith("/python",["-m","pytest","--version"],{PYTHONPATH:"bundled"}); expect(checks.pinky.ok).toBe(false); expect(checks.midscene.ok).toBe(false);
    expect(command.mock.calls.some(([bin])=>bin==="npx")).toBe(false);
  });
  it("cleans the theme listener on unmount", () => {
    const query = { addEventListener:vi.fn(), removeEventListener:vi.fn() }; const notify = vi.fn();
    const off = observeSystemTheme(query as unknown as MediaQueryList,notify); expect(query.addEventListener).toHaveBeenCalledWith("change",notify); off(); expect(query.removeEventListener).toHaveBeenCalledWith("change",notify);
  });
});
