import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AssistantService, type AssistantDeps } from "../src/main/assistant/service.js";
import { TaskManager } from "../src/main/orchestrator/taskManager.js";
import type { AssistantContext, AssistantConversation, AssistantSendInput } from "../src/shared/assistant.js";
import type { ApiDefinition } from "../src/shared/apiWorkspace.js";
import type { ProjectInfo } from "../src/main/orchestrator/types.js";

const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function temporary() { const d = mkdtempSync(join(tmpdir(), "assistant-test-")); dirs.push(d); return d; }
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function setup(file?: string) {
  const project: ProjectInfo = { id: "p1", name: "Current project", workspace_path: "/workspace", environments: {
    test: { base_url: "https://test.invalid", login: { password: "ENV_PASSWORD" } },
    prod: { base_url: "https://production.invalid", production: true },
    production: { base_url: "https://production.invalid" },
  } };
  const cases: Record<string, any>[] = [{ id: "c1", project_id: "p1", title: "Current case", status: "reviewed", lint_status: "passed", execution_mode: "api", api_revision: 1,
    api: { method: "GET", path: "/items", definition_id: "d1", definition_revision: 1, headers: { Authorization: "CASE_TOKEN" }, body: { password: "CASE_PASSWORD" } } }];
  const definitions = [{ id: "d1", title: "Current definition", summary: "Read items", method: "GET", path: "/items", revision: 1, removed: false,
    request: { method: "GET", path: "/items", headers: { token: "DEF_TOKEN" }, body: { secret: "DEF_SECRET" } }, operation: { responses: {} } }] as ApiDefinition[];
  const runs: Record<string, any>[] = [{ id: "r1", project_id: "p1", env: "test", started_at: "2026-01-01", total: 2, passed: 1, failed: 1 }];
  const tasks = new TaskManager();
  const deps: AssistantDeps = {
    tasks,
    project: vi.fn(async id => ({ ...project, id })),
    listCases: vi.fn(async id => id === "p1" ? cases : []),
    listDefinitions: vi.fn(async id => id === "p1" ? definitions : []),
    listRuns: vi.fn(async id => id === "p1" ? runs : []),
    runDetail: vi.fn(async id => ({ run: { id, env: "test" }, project: { id: "p1" }, summary: { total: 2, passed: 1, failed: 1 }, results: [
      { case_id: "c1", status: "failed", failure_type: "environment", message: "password=REPORT_PASSWORD", api_trace: { headers: { authorization: "REPORT_TOKEN" }, body: "REPORT_BODY" } },
    ] })),
    complete: vi.fn(async () => ({ text: "Read-only analysis", tokens: 100 })),
    saveDraft: vi.fn(async () => ({ id: "saved" })),
    runRegression: vi.fn(async () => ({ run: { run_id: "real-run", total: 2, passed: 1, failed: 1, error: 0, skipped: 0 } })),
  };
  return { service: new AssistantService(deps, file), deps, project, cases, definitions, runs, tasks };
}
const context = (references: AssistantContext["references"] = [{ kind: "case", id: "c1" }], env: string | undefined = "test"): AssistantContext => ({ page: "api", env, references });
const input = (mode: AssistantSendInput["mode"] = "ask", overrides: Partial<AssistantSendInput> = {}): AssistantSendInput => ({ requestId: crypto.randomUUID(), text: "Analyze the selection", mode, context: context(), consent: true, ...overrides });
async function idle(service: AssistantService, id: string) {
  let c!: AssistantConversation;
  await vi.waitFor(async () => { c = await service.assistantConversation("p1", id); expect(c.busy).toBe(false); }, { interval: 1, timeout: 1500 });
  return c;
}
async function proposal(s: ReturnType<typeof setup>, mode: "regression" | "draft" = "regression") {
  if (mode === "draft") vi.mocked(s.deps.complete).mockResolvedValue({ text: JSON.stringify({ drafts: [{ title: "Suggested scenario", priority: "P1", steps: ["Inspect"], expected: ["Expected condition"] }] }) });
  const c = await s.service.assistantCreateConversation("p1");
  const acknowledged = await s.service.assistantSend("p1", c.id, input(mode));
  expect(acknowledged.busy).toBe(true);
  expect(acknowledged.taskId).toBeTruthy();
  return idle(s.service, c.id);
}

describe("AssistantService authorization and provenance", () => {
  it("isolates conversations and all entity references by project", async () => {
    const s = setup();
    const c = await s.service.assistantCreateConversation("p1");
    expect(await s.service.assistantConversations("p2")).toEqual([]);
    await expect(s.service.assistantConversation("p2", c.id)).rejects.toThrow("不属于");
    await expect(s.service.assistantSend("p2", c.id, input())).rejects.toThrow("不属于");
    for (const kind of ["case", "definition", "run"] as const) {
      await expect(s.service.assistantSend("p1", c.id, input("ask", { context: context([{ kind, id: "foreign" }]) }))).rejects.toThrow("不属于");
    }
    expect(s.deps.complete).not.toHaveBeenCalled();
    expect(s.deps.runDetail).not.toHaveBeenCalled();
  });
  it("rejects foreign project fields even if a faulty listing includes them", async () => {
    const s = setup();
    s.cases[0].project_id = "p2";
    const c = await s.service.assistantCreateConversation("p1");
    await expect(s.service.assistantSend("p1", c.id, input())).rejects.toThrow("不属于");
    s.runs[0].project_id = "p1";
    vi.mocked(s.deps.runDetail).mockResolvedValue({ run: { id: "r1" }, project: { id: "p2" } });
    await expect(s.service.assistantSend("p1", c.id, input("report", { context: context([{ kind: "run", id: "r1" }]) }))).rejects.toThrow("不属于");
  });
  it("uses server labels and strips credential-bearing raw data before the model", async () => {
    const s = setup();
    const c = await s.service.assistantCreateConversation("p1");
    await s.service.assistantSend("p1", c.id, input("ask", { text: "token=USER_TOKEN password=USER_PASSWORD Authorization: Bearer USER_BEARER", context: context([
      { kind: "case", id: "c1", label: "FAKE_LABEL" }, { kind: "definition", id: "d1" }, { kind: "run", id: "r1" },
    ]) }));
    const done = await idle(s.service, c.id);
    const payload = JSON.stringify(vi.mocked(s.deps.complete).mock.calls[0][1]);
    for (const secret of ["ENV_PASSWORD", "CASE_TOKEN", "CASE_PASSWORD", "DEF_TOKEN", "DEF_SECRET", "REPORT_PASSWORD", "REPORT_TOKEN", "REPORT_BODY", "USER_TOKEN", "USER_PASSWORD", "USER_BEARER", "FAKE_LABEL"]) expect(payload).not.toContain(secret);
    expect(payload).toContain("Current case");
    expect(payload).toContain("Current definition");
    expect(done.messages[0].references?.[0].label).toBe("Current case");
    expect(done.messages.at(-1)?.content).toContain("服务端来源");
  });
  it("uses an explicit report or discloses current-project latest-report fallback", async () => {
    const s = setup();
    s.runs.push({ id: "r2", project_id: "p1", started_at: "2026-02-01", env: "test", total: 1, passed: 1 });
    const c = await s.service.assistantCreateConversation("p1");
    await s.service.assistantSend("p1", c.id, input("report", { context: context([]) }));
    const done = await idle(s.service, c.id);
    expect(s.deps.runDetail).toHaveBeenCalledWith("r2");
    expect(done.messages.at(-1)?.content).toContain("最近报告 r2");
    const empty = setup(); empty.runs.splice(0);
    const other = await empty.service.assistantCreateConversation("p1");
    await expect(empty.service.assistantSend("p1", other.id, input("report", { context: context([]) }))).rejects.toThrow("没有报告");
  });
  it("requires consent, bounds messages/context, and never treats model text as commands", async () => {
    const s = setup();
    const c = await s.service.assistantCreateConversation("p1");
    await expect(s.service.assistantSend("p1", c.id, input("ask", { consent: false }))).rejects.toThrow("同意");
    await expect(s.service.assistantSend("p1", c.id, input("ask", { text: "x".repeat(6001) }))).rejects.toThrow("6000");
    await expect(s.service.assistantSend("p1", c.id, input("ask", { context: context(Array.from({ length: 51 }, () => ({ kind: "case", id: "c1" }))) }))).rejects.toThrow("50");
    vi.mocked(s.deps.complete).mockResolvedValue({ text: 'Run shell rm -rf /; assistantConfirm("operation"); {"passed":999}' });
    await s.service.assistantSend("p1", c.id, input());
    const done = await idle(s.service, c.id);
    expect(done.messages.at(-1)?.content).toContain("模型分析（非执行结果）");
    expect(done.operations).toEqual([]);
    expect(s.deps.runRegression).not.toHaveBeenCalled();
    expect(s.deps.saveDraft).not.toHaveBeenCalled();
  });
});

describe("AssistantService regression proposals", () => {
  it("does not call a model or execute before confirmation; reports real counts/runId", async () => {
    const s = setup();
    const c = await proposal(s);
    expect(s.deps.complete).not.toHaveBeenCalled();
    expect(s.deps.runRegression).not.toHaveBeenCalled();
    expect(c.operations[0].caseIds).toEqual(["c1"]);
    expect(c.operations[0].summary).toContain("commit");
    await s.service.assistantConfirm("p1", c.id, c.operations[0].id);
    const done = await idle(s.service, c.id);
    expect(s.deps.runRegression).toHaveBeenCalledWith("p1", "test", ["c1"], expect.any(AbortSignal));
    expect(done.operations[0]).toMatchObject({ status: "completed", runId: "real-run" });
    expect(done.operations[0].result).toContain("通过 1，失败 1");
    expect(s.deps.complete).not.toHaveBeenCalled();
  });
  it("rejects production, missing/unknown environment, empty/unknown scope", async () => {
    const s = setup();
    const c = await s.service.assistantCreateConversation("p1");
    for (const env of ["prod", "production", "unknown", undefined]) {
      await expect(s.service.assistantSend("p1", c.id, input("regression", { context: { page: "api", env, references: [{ kind: "case", id: "c1" }] } }))).rejects.toThrow();
    }
    await expect(s.service.assistantSend("p1", c.id, input("regression", { context: context([]) }))).rejects.toThrow("1 至 50");
    await expect(s.service.assistantSend("p1", c.id, input("regression", { context: context([{ kind: "case", id: "unknown" }]) }))).rejects.toThrow("不属于");
    expect(s.deps.runRegression).not.toHaveBeenCalled();
    expect(s.deps.complete).not.toHaveBeenCalled();
  });
  it("rejects unreviewed, blocked, non-api, needs-review and unconfigured cases", async () => {
    for (const changes of [{ status: "draft" }, { lint_status: "blocked" }, { execution_mode: "ui" }, { api_needs_review: true }, { api: null }, { api: { method: "GET" } }, { api: { method: "GET", path: "/", definition_id: "foreign" } }]) {
      const s = setup(); Object.assign(s.cases[0], changes);
      const c = await s.service.assistantCreateConversation("p1");
      await expect(s.service.assistantSend("p1", c.id, input("regression"))).rejects.toThrow();
      expect(s.deps.runRegression).not.toHaveBeenCalled();
    }
  });
  it("derives reviewed nonblocking case scope from selected definitions and caps it at 50", async () => {
    const s = setup();
    s.cases.push({ ...s.cases[0], id: "draft", status: "draft" }, { ...s.cases[0], id: "blocked", lint_status: "blocked" });
    const c = await s.service.assistantCreateConversation("p1");
    await s.service.assistantSend("p1", c.id, input("regression", { context: context([{ kind: "definition", id: "d1" }]) }));
    const done = await idle(s.service, c.id);
    expect(done.operations[0].caseIds).toEqual(["c1"]);
    for (let i = 0; i < 50; i++) s.cases.push({ ...s.cases[0], id: `c${i + 2}` });
    await expect(s.service.assistantSend("p1", c.id, input("regression", { context: context([{ kind: "definition", id: "d1" }]) }))).rejects.toThrow("1 至 50");
  });
  it.each(["environment", "case version", "case payload", "definition revision", "production", "scope"])("expires confirmation when %s changes", async change => {
    const s = setup(); const c = await proposal(s);
    if (change === "environment") s.project.environments.test.base_url = "https://changed.invalid";
    if (change === "case version") s.cases[0].api_revision++;
    if (change === "case payload") s.cases[0].api.headers.Authorization = "changed";
    if (change === "definition revision") s.definitions[0].revision++;
    if (change === "production") s.project.environments.test.production = true;
    if (change === "scope") s.cases.splice(0);
    const snapshot = await s.service.assistantConfirm("p1", c.id, c.operations[0].id);
    expect(snapshot.operations[0].status).toBe("expired");
    expect(s.deps.runRegression).not.toHaveBeenCalled();
  });
  it("executes duplicate/concurrent confirmations only once and never replays terminal actions", async () => {
    const s = setup(); const c = await proposal(s); const op = c.operations[0];
    const run = deferred<any>(); vi.mocked(s.deps.runRegression).mockReturnValue(run.promise);
    const [a, b] = await Promise.all([s.service.assistantConfirm("p1", c.id, op.id), s.service.assistantConfirm("p1", c.id, op.id)]);
    expect(a.taskId).toBe(b.taskId);
    await vi.waitFor(() => expect(s.deps.runRegression).toHaveBeenCalledTimes(1), { interval: 1 });
    run.resolve({ run: { run_id: "r-real", total: 1, passed: 1 } });
    await idle(s.service, c.id);
    await s.service.assistantConfirm("p1", c.id, op.id);
    expect(s.deps.runRegression).toHaveBeenCalledTimes(1);
  });
  it("expires pending operations after fifteen minutes", async () => {
    const s = setup(); const c = await proposal(s);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 16 * 60_000);
    const done = await s.service.assistantConfirm("p1", c.id, c.operations[0].id);
    expect(done.operations[0].status).toBe("expired");
    expect(s.deps.runRegression).not.toHaveBeenCalled();
  });
  it("revalidates queued confirmations, and uses a separate outer channel", async () => {
    const s = setup(); const c = await proposal(s);
    const gate = deferred<void>();
    const blocker = s.tasks.enqueue("assistant-operation", { projectId: "p1", env: "test", source: "agent", kind: "blocker", caseIds: [] }, async () => gate.promise);
    await s.service.assistantConfirm("p1", c.id, c.operations[0].id);
    s.cases[0].api_revision++;
    gate.resolve(); await blocker;
    expect((await idle(s.service, c.id)).operations[0].status).toBe("expired");
    expect(s.deps.runRegression).not.toHaveBeenCalled();
    const second = setup(); const p = await proposal(second);
    vi.mocked(second.deps.runRegression).mockImplementation(async (_project, _env, _ids, signal) => second.tasks.enqueue("api", { projectId: "p1", env: "test", source: "api", kind: "inner regression", caseIds: ["c1"] }, async () => ({ run: { run_id: "inner", total: 1, passed: 1 } }), signal));
    await second.service.assistantConfirm("p1", p.id, p.operations[0].id);
    expect((await idle(second.service, p.id)).operations[0].runId).toBe("inner");
  });
  it("does not invent passing results from malformed executor output", async () => {
    const s = setup(); const c = await proposal(s);
    vi.mocked(s.deps.runRegression).mockResolvedValue({ text: "passed", passed: 999 });
    await s.service.assistantConfirm("p1", c.id, c.operations[0].id);
    const done = await idle(s.service, c.id);
    expect(done.operations[0].status).toBe("failed");
    expect(done.operations[0].runId).toBeUndefined();
    expect(done.operations[0].result).toContain("可信");
  });
});

describe("AssistantService draft review", () => {
  it("strictly validates drafts but does not save automatically", async () => {
    const s = setup(); const c = await proposal(s, "draft");
    expect(c.operations[0]).toMatchObject({ kind: "save-drafts", status: "pending", drafts: [{ title: "Suggested scenario", priority: "P1", steps: ["Inspect"], expected: ["Expected condition"] }] });
    expect(s.deps.saveDraft).not.toHaveBeenCalled();
    await s.service.assistantConfirm("p1", c.id, c.operations[0].id);
    expect((await idle(s.service, c.id)).operations[0].status).toBe("completed");
    expect(s.deps.saveDraft).toHaveBeenCalledExactlyOnceWith("p1", c.operations[0].drafts![0]);
    expect(s.deps.runRegression).not.toHaveBeenCalled();
  });
  it.each([
    '```json\n{"drafts":[]}\n```',
    JSON.stringify({ drafts: Array.from({ length: 7 }, () => ({ title: "Too many", priority: "P1", steps: ["a"], expected: ["b"] })) }),
    JSON.stringify({ drafts: [{ title: "Injection", priority: "P1", steps: ["a"], expected: ["b"], command: "touch /tmp/pwned" }] }),
    JSON.stringify({ drafts: [{ title: "Bad", priority: "INVALID", steps: ["a"], expected: ["b"] }] }),
    JSON.stringify({ drafts: [{ title: "Bad", priority: "P1", steps: ["a"], expected: [] }] }),
  ])("rejects malformed/oversized/executable draft output", async text => {
    const s = setup(); vi.mocked(s.deps.complete).mockResolvedValue({ text });
    const c = await s.service.assistantCreateConversation("p1");
    await s.service.assistantSend("p1", c.id, input("draft"));
    const done = await idle(s.service, c.id);
    expect(done.operations).toEqual([]);
    expect(done.messages.at(-1)?.content).toContain("失败");
    expect(s.deps.saveDraft).not.toHaveBeenCalled();
  });
  it("records partial success and never automatically retries failed inserts", async () => {
    const s = setup();
    vi.mocked(s.deps.complete).mockResolvedValue({ text: JSON.stringify({ drafts: [1, 2, 3].map(i => ({ title: `Draft ${i}`, priority: "P2", steps: ["a"], expected: ["b"] })) }) });
    vi.mocked(s.deps.saveDraft).mockResolvedValueOnce({ id: "saved-one" }).mockRejectedValueOnce(new Error("Insert rejected"));
    const c = await s.service.assistantCreateConversation("p1");
    await s.service.assistantSend("p1", c.id, input("draft"));
    const ready = await idle(s.service, c.id);
    await s.service.assistantConfirm("p1", c.id, ready.operations[0].id);
    const done = await idle(s.service, c.id);
    expect(done.operations[0].status).toBe("failed");
    expect(done.operations[0].result).toContain("保存 1 条");
    await s.service.assistantConfirm("p1", c.id, ready.operations[0].id);
    expect(s.deps.saveDraft).toHaveBeenCalledTimes(2);
  });
});

describe("AssistantService task control, idempotency, and durability", () => {
  it("deduplicates send requestIds, rejects conflicts and rejects new messages while busy", async () => {
    const s = setup(); const answer = deferred<{ text: string }>(); vi.mocked(s.deps.complete).mockReturnValue(answer.promise);
    const c = await s.service.assistantCreateConversation("p1"); const request = input();
    const [a, b] = await Promise.all([s.service.assistantSend("p1", c.id, request), s.service.assistantSend("p1", c.id, request)]);
    expect(a.taskId).toBe(b.taskId);
    await expect(s.service.assistantSend("p1", c.id, { ...request, text: "Changed" })).rejects.toThrow("requestId");
    await expect(s.service.assistantSend("p1", c.id, input())).rejects.toThrow("正在处理");
    answer.resolve({ text: "Done" }); await idle(s.service, c.id);
    await s.service.assistantSend("p1", c.id, request);
    expect(s.deps.complete).toHaveBeenCalledTimes(1);
    expect((await s.service.assistantConversation("p1", c.id)).messages).toHaveLength(2);
  });
  it("binds taskId in the acknowledgement and stops queued work precisely", async () => {
    const s = setup(); const gate = deferred<void>();
    const blocker = s.tasks.enqueue("assistant-operation", { projectId: "p1", env: "test", source: "agent", kind: "unrelated", caseIds: [] }, async () => gate.promise);
    const c = await s.service.assistantCreateConversation("p1");
    const ack = await s.service.assistantSend("p1", c.id, input());
    expect(s.tasks.records.find(t => t.id === ack.taskId)?.status).toBe("queued");
    await s.service.assistantStop("p1", c.id);
    expect(s.tasks.records.find(t => t.id === ack.taskId)?.status).toBe("stopped");
    expect(s.tasks.records.find(t => t.kind === "unrelated")?.status).toBe("running");
    gate.resolve(); await blocker;
    await vi.waitFor(() => expect(s.tasks.records.find(t => t.id === ack.taskId)?.canStop).toBe(false), { interval: 1 });
    expect(s.deps.complete).not.toHaveBeenCalled();
    expect((await s.service.assistantConversation("p1", c.id)).busy).toBe(false);
  });
  it("cancels a queued confirmed operation without executing any side effects", async () => {
    const s = setup(); const c = await proposal(s); const gate = deferred<void>();
    const blocker = s.tasks.enqueue("assistant-operation", { projectId: "p1", env: "test", source: "agent", kind: "unrelated", caseIds: [] }, async () => gate.promise);
    const ack = await s.service.assistantConfirm("p1", c.id, c.operations[0].id);
    await s.service.assistantCancelOperation("p1", c.id, c.operations[0].id);
    expect(s.tasks.records.find(t => t.id === ack.taskId)?.status).toBe("stopped");
    gate.resolve(); await blocker;
    await vi.waitFor(() => expect(s.tasks.records.find(t => t.id === ack.taskId)?.canStop).toBe(false), { interval: 1 });
    expect(s.deps.runRegression).not.toHaveBeenCalled();
    expect((await s.service.assistantConversation("p1", c.id)).operations[0].status).toBe("cancelled");
  });
  it("passes exact stop signal and ignores a late model response", async () => {
    const s = setup(); const answer = deferred<{ text: string }>(); vi.mocked(s.deps.complete).mockReturnValue(answer.promise);
    const c = await s.service.assistantCreateConversation("p1"); await s.service.assistantSend("p1", c.id, input("draft"));
    await vi.waitFor(() => expect(s.deps.complete).toHaveBeenCalled(), { interval: 1 });
    const signal = vi.mocked(s.deps.complete).mock.calls[0][2];
    await s.service.assistantStop("p1", c.id); expect(signal.aborted).toBe(true);
    answer.resolve({ text: JSON.stringify({ drafts: [{ title: "Late", priority: "P1", steps: ["a"], expected: ["b"] }] }) });
    await vi.waitFor(() => expect(s.tasks.records[0].status).toBe("stopped"), { interval: 1 });
    expect((await s.service.assistantConversation("p1", c.id)).operations).toEqual([]);
    expect(s.deps.saveDraft).not.toHaveBeenCalled();
  });
  it("persists private atomic snapshots and recovers busy/running as unconfirmed failure without replay", async () => {
    const file = join(temporary(), "history.json"); const s = setup(file); const c = await proposal(s);
    const run = deferred<any>(); vi.mocked(s.deps.runRegression).mockReturnValue(run.promise);
    await s.service.assistantConfirm("p1", c.id, c.operations[0].id);
    await vi.waitFor(() => expect(s.deps.runRegression).toHaveBeenCalledOnce(), { interval: 1 });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const restarted = new AssistantService(s.deps, file);
    const done = await restarted.assistantConversation("p1", c.id);
    expect(done.busy).toBe(false);
    expect(done.notice).toContain("PROCESS_RESTARTED");
    expect(done.operations[0].status).toBe("failed");
    await restarted.assistantConfirm("p1", c.id, c.operations[0].id);
    expect(s.deps.runRegression).toHaveBeenCalledOnce();
    const disk = JSON.parse(readFileSync(file, "utf8")); expect(disk.conversations[0].conversation.busy).toBe(false);
    run.resolve({ run: { run_id: "late-old", total: 1, passed: 1 } });
    await idle(s.service, c.id);
  });
  it("retains request deduplication across restart", async () => {
    const file = join(temporary(), "history.json"); const s = setup(file); const c = await s.service.assistantCreateConversation("p1"); const request = input();
    await s.service.assistantSend("p1", c.id, request); await idle(s.service, c.id);
    const restarted = new AssistantService(s.deps, file);
    await restarted.assistantSend("p1", c.id, request);
    expect(s.deps.complete).toHaveBeenCalledOnce();
  });
  it("fails closed when storage cannot be committed and does not enqueue a model/effect", async () => {
    const root = temporary(); const parent = join(root, "blocked"); const file = join(parent, "history.json");
    const s = setup(file); const c = await s.service.assistantCreateConversation("p1");
    rmSync(file); rmSync(parent, { recursive: true }); writeFileSync(parent, "not a directory");
    await expect(s.service.assistantSend("p1", c.id, input())).rejects.toThrow();
    expect(s.tasks.records).toHaveLength(0);
    expect(s.deps.complete).not.toHaveBeenCalled();
    expect(s.deps.saveDraft).not.toHaveBeenCalled();
    expect(s.deps.runRegression).not.toHaveBeenCalled();
  });
});

describe("AssistantService additional fail-closed boundaries", () => {
  it("bounds model conversation history independently of the persisted conversation", async () => {
    const s = setup(); const c = await s.service.assistantCreateConversation("p1");
    for (let i = 0; i < 13; i++) {
      await s.service.assistantSend("p1", c.id, input("ask", { text: `Message ${i} ` + "x".repeat(3000) }));
      await idle(s.service, c.id);
    }
    const messages = vi.mocked(s.deps.complete).mock.calls.at(-1)![1];
    expect(messages.length).toBeLessThanOrEqual(11);
    expect(messages.slice(1).every(m => m.content.length <= 1800)).toBe(true);
    expect(messages.slice(1).some(m => m.content.startsWith("Message 0 "))).toBe(false);
    expect((await s.service.assistantConversation("p1", c.id)).messages).toHaveLength(26);
  });
  it("honors an explicit report reference instead of choosing a more recent report", async () => {
    const s = setup(); s.runs.push({ id: "r2", started_at: "2027-01-01", env: "test" });
    const c = await s.service.assistantCreateConversation("p1");
    await s.service.assistantSend("p1", c.id, input("report", { context: context([{ kind: "run", id: "r1" }]) }));
    const done = await idle(s.service, c.id);
    expect(s.deps.runDetail).toHaveBeenCalledExactlyOnceWith("r1");
    expect(done.messages.at(-1)?.content).not.toContain("最近报告");
  });
  it("rejects reuse of a foreign operation ID and does not execute cancelled proposals", async () => {
    const s = setup(); const c = await proposal(s);
    const other = await s.service.assistantCreateConversation("p1");
    await expect(s.service.assistantConfirm("p1", other.id, c.operations[0].id)).rejects.toThrow("不存在");
    await s.service.assistantCancelOperation("p1", c.id, c.operations[0].id);
    expect((await s.service.assistantConfirm("p1", c.id, c.operations[0].id)).operations[0].status).toBe("cancelled");
    expect(s.deps.runRegression).not.toHaveBeenCalled();
  });
  it("expires a confirmation that waited in the queue beyond the authorization TTL", async () => {
    const s = setup(); const c = await proposal(s); const gate = deferred<void>();
    const blocker = s.tasks.enqueue("assistant-operation", { projectId: "p1", env: "test", source: "agent", kind: "unrelated", caseIds: [] }, async () => gate.promise);
    await s.service.assistantConfirm("p1", c.id, c.operations[0].id);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 16 * 60_000);
    gate.resolve(); await blocker;
    expect((await idle(s.service, c.id)).operations[0].status).toBe("expired");
    expect(s.deps.runRegression).not.toHaveBeenCalled();
  });
  it("aborts a running regression with its precise task signal and never publishes late success", async () => {
    const s = setup(); const c = await proposal(s); const run = deferred<any>();
    vi.mocked(s.deps.runRegression).mockReturnValue(run.promise);
    const ack = await s.service.assistantConfirm("p1", c.id, c.operations[0].id);
    await vi.waitFor(() => expect(s.deps.runRegression).toHaveBeenCalledOnce(), { interval: 1 });
    const signal = vi.mocked(s.deps.runRegression).mock.calls[0][3];
    await s.service.assistantStop("p1", c.id);
    expect(signal.aborted).toBe(true);
    run.resolve({ run: { run_id: "late", total: 1, passed: 1 } });
    await vi.waitFor(() => expect(s.tasks.records.find(t => t.id === ack.taskId)?.status).toBe("stopped"), { interval: 1 });
    const done = await s.service.assistantConversation("p1", c.id);
    expect(done.operations[0].status).toBe("cancelled");
    expect(done.operations[0].runId).toBeUndefined();
  });
  it("does not execute a confirmation if its authorization commit fails", async () => {
    const file = join(temporary(), "history.json"); const s = setup(file); const c = await proposal(s);
    rmSync(file); writeFileSync(file, "blocked");
    const repository = (s.service as any).repository;
    vi.spyOn(repository, "put").mockImplementation(() => { throw new Error("disk unavailable"); });
    await expect(s.service.assistantConfirm("p1", c.id, c.operations[0].id)).rejects.toThrow("disk unavailable");
    expect(s.deps.runRegression).not.toHaveBeenCalled();
    expect(s.deps.saveDraft).not.toHaveBeenCalled();
  });
  it("stops a newly enqueued task when taskId binding cannot be persisted", async () => {
    const s = setup(); const c = await s.service.assistantCreateConversation("p1");
    const repository = (s.service as any).repository;
    const original = repository.put.bind(repository);
    let puts = 0;
    vi.spyOn(repository, "put").mockImplementation((...args: unknown[]) => {
      if (++puts === 2) throw new Error("binding failed");
      original(...args);
    });
    await expect(s.service.assistantSend("p1", c.id, input())).rejects.toThrow("binding failed");
    await vi.waitFor(() => expect(s.tasks.records[0].status).toBe("stopped"), { interval: 1 });
    expect(s.deps.complete).not.toHaveBeenCalled();
    expect((await s.service.assistantConversation("p1", c.id)).busy).toBe(false);
  });
  it("preserves known partial insert count even if its first checkpoint write fails", async () => {
    const s = setup(); const c = await proposal(s, "draft");
    const repository = (s.service as any).repository;
    const original = repository.put.bind(repository);
    let failed = false;
    vi.spyOn(repository, "put").mockImplementation((row: any) => {
      if (!failed && row.operations[c.operations[0].id]?.saved === 1) { failed = true; throw new Error("checkpoint failed"); }
      original(row);
    });
    await s.service.assistantConfirm("p1", c.id, c.operations[0].id);
    const done = await idle(s.service, c.id);
    expect(done.operations[0].status).toBe("failed");
    expect(done.operations[0].result).toContain("保存 1 条");
    expect(done.operations[0].result).toContain("持久化失败");
    await s.service.assistantConfirm("p1", c.id, c.operations[0].id);
    expect(s.deps.saveDraft).toHaveBeenCalledOnce();
  });
  it("deduplicates special object-key request IDs instead of treating them as prototypes", async () => {
    const s = setup(); const c = await s.service.assistantCreateConversation("p1"); const request = input("ask", { requestId: "__proto__" });
    await s.service.assistantSend("p1", c.id, request); await idle(s.service, c.id);
    await s.service.assistantSend("p1", c.id, request);
    expect(s.deps.complete).toHaveBeenCalledOnce();
  });
});

describe("AssistantService structured secret redaction", () => {
  it("removes whole user-supplied headers/body blocks, token variants, and URL credentials", async () => {
    const s = setup(); const c = await s.service.assistantCreateConversation("p1");
    const text = 'Review {"headers":{"X-Custom":"NESTED_HEADER"},"body":{"profile":{"name":"PRIVATE_BODY"}},"access_token":"ACCESS_SECRET"}; URL https://user:URL_PASSWORD@example.invalid/path?token=QUERY_SECRET';
    await s.service.assistantSend("p1", c.id, input("ask", { text }));
    await idle(s.service, c.id);
    const payload = JSON.stringify(vi.mocked(s.deps.complete).mock.calls[0][1]);
    for (const secret of ["NESTED_HEADER", "PRIVATE_BODY", "ACCESS_SECRET", "URL_PASSWORD", "QUERY_SECRET"]) expect(payload).not.toContain(secret);
  });
});

describe("AssistantService actionable evidence and interface scope", () => {
  it("does not include multi-interface flows when selecting an interface definition", async () => {
    const s = setup();
    s.cases.push({ ...s.cases[0], id: "flow", api: null, api_flow: [s.cases[0].api, { method: "DELETE", path: "/other" }] });
    const c = await s.service.assistantCreateConversation("p1");
    await s.service.assistantSend("p1", c.id, input("regression", { context: context([{ kind: "definition", id: "d1" }]) }));
    expect((await idle(s.service, c.id)).operations[0].caseIds).toEqual(["c1"]);
  });
  it("provides selected case steps and redacted failure evidence instead of titles alone", async () => {
    const s = setup();
    s.cases[0].steps = ["提交缺少必填参数的请求"];
    s.cases[0].expected = ["HTTP 400，明确指出参数缺失"];
    vi.mocked(s.deps.runDetail).mockResolvedValue({ run: { id: "r1", project_id: "p1" }, results: [
      { case_id: "c1", status: "failed", message: "expected HTTP 400, received 200; password=PRIVATE_VALUE" },
    ] });
    const c = await s.service.assistantCreateConversation("p1");
    await s.service.assistantSend("p1", c.id, input("report", { context: context([{ kind: "case", id: "c1" }, { kind: "run", id: "r1" }]) }));
    await idle(s.service, c.id);
    const prompt = vi.mocked(s.deps.complete).mock.calls[0][1][0].content;
    expect(prompt).toContain("提交缺少必填参数");
    expect(prompt).toContain("expected HTTP 400, received 200");
    expect(prompt).not.toContain("PRIVATE_VALUE");
  });
});
