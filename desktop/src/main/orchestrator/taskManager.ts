import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { UiTaskRecord } from "../../shared/ipc.js";
import type { TaskProgress, TaskProgressData, TaskProgressSnapshot, TaskSnapshot } from "../../shared/taskProgress.js";
import { Diagnostics } from "../diagnostics.js";
export const activeTask = (t: UiTaskRecord) => ["queued", "running", "stopping"].includes(t.status);
export interface TaskContext { task: UiTaskRecord; signal: AbortSignal }
type Meta = Pick<UiTaskRecord, "projectId" | "env" | "kind" | "caseIds" | "source"> & Partial<Pick<UiTaskRecord, "purpose" | "runId">>;

export class TaskManager extends EventEmitter {
  records: UiTaskRecord[] = [];
  private controllers = new Map<string, AbortController>();
  private chains = new Map<string, Promise<void>>();
  private context = new AsyncLocalStorage<TaskContext>();
  private revision = 0;
  private sequence = 0;
  private lastSteps = new Map<string, string>();
  private progressByTask = new Map<string, TaskProgressSnapshot>();
  readonly diagnostics = new Diagnostics();
  constructor(private file?: string) {
    super();
    if (file && existsSync(file)) {
      try {
        const previous: unknown = JSON.parse(readFileSync(file, "utf8"));
        if (Array.isArray(previous)) this.records = previous.filter(t => t && typeof t.id === "string").sort((a, b) => Number(activeTask(b)) - Number(activeTask(a))).slice(0, 100).map(t => activeTask(t)
          ? { ...t, status: "failed", canStop: false, detail: "应用重启时任务未确认完成（PROCESS_RESTARTED）", updatedAt: new Date().toISOString(), finishedAt: new Date().toISOString() } : t);
      } catch { /* corrupt history cannot block startup */ }
      this.changed();
    }
  }
  current() { return this.context.getStore(); }
  snapshot(): TaskSnapshot { return { revision: this.revision, tasks: structuredClone(this.records) }; }
  progressSnapshot(id: string): TaskProgressSnapshot { return structuredClone(this.progressByTask.get(id) ?? { events: [], truncated: false }); }
  chainId(task: UiTaskRecord) { return ({ performance: "performance-run", api: "api-regression", ui: "ui-testing", app: "app-testing", agent: "agent" })[task.source ?? "ui"]; }
  step(stepId: string, data: Record<string, unknown> = {}, outcome: "ok" | "error" = "ok") {
    const task = this.current()?.task;
    if (task) {
      if (stepId !== "complete") this.lastSteps.set(task.id, stepId);
      this.diagnostics.record({ taskId: task.id, projectId: task.projectId, env: task.env, chainId: this.chainId(task) }, stepId, data, outcome);
      const stages: Record<string, string> = { validate: "校验执行配置", "inject-secrets": "准备鉴权", "prepare-environment": "准备环境", "generate-plan": "生成执行计划", spawn: "执行测试", execute: "执行任务", "start-thread": "创建 Agent 会话", "parse-summary": "解析执行汇总", "collect-results": "收集执行结果", "generate-report": "生成报告", "write-report": "保存报告" };
      task.stage = stepId === "complete" ? ({ completed: "已完成", failed: "未通过", stopped: "已停止" } as Record<string, string>)[task.status] ?? task.stage : stages[stepId] ?? task.stage;
      task.updatedAt = new Date().toISOString();
      if (stepId !== "complete") { this.publish({ kind: "stage", data: { stage: task.stage } }, task); this.changed(); }
    }
  }
  changed() {
    let ended = 0;
    this.records = this.records.filter(t => activeTask(t) || ++ended <= 100);
    const ids = new Set(this.records.map(t => t.id));
    for (const id of this.progressByTask.keys()) if (!ids.has(id)) this.progressByTask.delete(id);
    if (this.file) {
      try { mkdirSync(dirname(this.file), { recursive: true }); writeFileSync(`${this.file}.tmp`, JSON.stringify(this.records), { mode: 0o600 }); renameSync(`${this.file}.tmp`, this.file); }
      catch { for (const task of this.records) task.persistenceError = "任务历史保存失败；当前状态仅保留在内存中"; }
    }
    this.revision++;
    this.emit("task-records", this.snapshot());
  }
  publish(value: TaskProgressData, task = this.current()?.task) {
    if (!task) return;
    const event: TaskProgress = { ...value, taskId: task.id, projectId: task.projectId, env: task.env, timestamp: Date.now(), seq: ++this.sequence };
    const buffer = this.progressByTask.get(task.id) ?? { events: [], truncated: false };
    buffer.events.push(event);
    if (buffer.events.length > 120) { buffer.events.shift(); buffer.truncated = true; }
    this.progressByTask.set(task.id, buffer);
    this.emit("task-progress", event);
  }
  progress(p: Record<string, any>) {
    const task = p.taskId ? this.records.find(t => t.id === p.taskId) : this.current()?.task;
    if (task && activeTask(task)) {
      task.updatedAt = new Date().toISOString();
      if (p.stage !== "ui-task" && p.stage !== "agent-task") {
        task.stage = ({ "ui-step": "执行脚本步骤", "ui-run": "执行脚本", ui_contract: "整理执行计划", case_gen: "生成测试用例", api_script: "生成接口脚本", triage: "分析失败原因" } as Record<string, string>)[p.stage] ?? String(p.stage ?? task.stage);
        if (p.title) task.detail = String(p.title).slice(0, 300);
        this.publish({ kind: "stage", data: { stage: task.stage } }, task);
      }
      this.changed();
    }
    this.emit("progress", { ...p, ...(task ? { taskId: task.id, projectId: task.projectId, env: task.env } : {}) });
  }
  recordAgentEvent(event: { method: string; params?: any }): string | undefined {
    if (typeof event.params?.threadId !== "string") return;
    const task = this.records.find(t => t.threadId === event.params.threadId && activeTask(t));
    if (!task) return;
    const item = event.params?.item;
    const detail = item?.type === "mcpToolCall" && ["item/started", "item/completed"].includes(event.method)
      ? `${event.method === "item/started" ? "调用工具" : item.status === "failed" || item.error ? "工具失败" : "工具完成"} ${item.server ?? ""}.${item.tool ?? ""}`
      : item?.type === "contextCompaction" ? "上下文压缩" : undefined;
    if (detail) { task.events = [...(task.events ?? []), { time: new Date().toISOString(), detail: detail.slice(0, 200) }].slice(-100); this.changed(); }
    return task.id;
  }
  stop(id: string) {
    const task = this.records.find(t => t.id === id);
    if (!task) throw new Error("任务不存在");
    if (!activeTask(task)) return;
    const controller = this.controllers.get(id);
    if (!controller) throw new Error("当前任务不支持停止");
    controller.abort();
  }
  enqueue<T>(channel: string, meta: Meta, fn: (context: TaskContext) => Promise<T>, external?: AbortSignal): Promise<T> {
    const now = new Date().toISOString();
    const parentContext = this.current();
    const parent = parentContext?.task;
    const task: UiTaskRecord = {
      ...meta, id: `${meta.source ?? "ui"}-${randomUUID()}`, status: "queued", startedAt: now, updatedAt: now,
      stage: "等待执行", canStop: true, ...(parent ? { parentTaskId: parent.id } : {})
    };
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, ...[external, parentContext?.signal].filter((s): s is AbortSignal => !!s)]);
    this.controllers.set(task.id, controller); this.records.unshift(task); this.changed();
    let started = false;
    let rejectQueued!: (error: Error) => void;
    const queuedCancellation = new Promise<never>((_resolve, reject) => { rejectQueued = reject; });
    const onAbort = () => {
      if (!activeTask(task)) return;
      if (!started) {
        task.status = "stopped"; task.stage = "已停止"; task.canStop = false;
        task.updatedAt = task.finishedAt = new Date().toISOString();
        this.controllers.delete(task.id);
        this.diagnostics.record({ chainId: this.chainId(task), taskId: task.id, projectId: task.projectId, env: task.env }, "complete", { status: "stopped", code: "CANCELLED" });
        this.publish({ kind: "complete", data: { status: "stopped" } }, task);
        this.changed();
        rejectQueued(new Error("任务已停止"));
      } else { task.status = "stopping"; this.changed(); }
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    const execute = async () => {
      if (signal.aborted && !started) throw new Error("任务已停止");
      started = true;
      return this.context.run({ task, signal }, async () => {
        try {
          signal.throwIfAborted(); task.status = "running"; task.stage = "准备执行"; this.changed(); this.step("validate");
          this.progress({ stage: meta.source === "ui" ? "ui-task" : "agent-task", status: "running" });
          const result = await fn({ task, signal });
          const out = result as any;
          if (out?.status !== "stopped") signal.throwIfAborted();
          const failed = out?.scriptGenerated === false || (out?.status && !["completed", "passed"].includes(out.status)) || (out?.run?.failed ?? 0) + (out?.run?.error ?? 0) > 0;
          task.status = out?.status === "stopped" ? "stopped" : failed ? "failed" : "completed";
          task.runId = out?.run?.run_id ?? task.runId;
        if (typeof out?.message === "string") task.detail = out.message.slice(0, 2000);
          return result;
        } catch (error) {
          task.status = signal.aborted ? "stopped" : "failed";
          task.detail = signal.aborted ? "任务已停止" : String((error as Error)?.message ?? error).slice(0, 300);
          this.diagnostics.record({ taskId: task.id, projectId: task.projectId, env: task.env, chainId: this.chainId(task) }, this.lastSteps.get(task.id) ?? "validate", { status: task.status, code: signal.aborted ? "CANCELLED" : (error as NodeJS.ErrnoException)?.code }, "error");
          if (signal.aborted && (error as Error)?.message !== "UI_TASK_STOPPED") throw new Error("任务已停止");
          throw error;
        } finally {
          task.updatedAt = task.finishedAt = new Date().toISOString(); task.canStop = false;
          this.step("complete", { status: task.status }, task.status === "failed" ? "error" : "ok");
          this.publish({ kind: task.status === "failed" ? "error" : "complete", data: { status: task.status } });
          signal.removeEventListener("abort", onAbort);
          this.controllers.delete(task.id); this.lastSteps.delete(task.id); this.changed();
          this.emit("progress", { taskId: task.id, projectId: task.projectId, env: task.env, stage: meta.source === "ui" ? "ui-task" : "agent-task", status: task.status });
        }
      });
    };
    // Reserve the chain tail before any callback can enqueue another task.
    const previous = this.chains.get(channel);
    const work = previous ? previous.then(execute) : Promise.resolve().then(execute);
    const tail = work.then(() => { }, () => { });
    this.chains.set(channel, tail);
    void tail.then(() => { if (this.chains.get(channel) === tail) this.chains.delete(channel); });
    return Promise.race([work, queuedCancellation]);
  }
}
