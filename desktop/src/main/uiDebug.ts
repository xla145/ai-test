import type { StepsFile, UiStep } from "@ai-test/mcp-servers";
import type { UiDebugCommand, UiDebugState, UiDebugStepState } from "../shared/ipc.js";

/** 调试会话依赖的浏览器能力（BrowserSession 的子集，测试时可替换） */
export interface DebugBrowser {
  runStep(step: UiStep, opts?: Record<string, unknown>): Promise<{ note?: string; evidence?: string }>;
  resetCaptures(): void;
  close(): Promise<void>;
}

export interface DebugSessionInit {
  projectId: string;
  env: string;
  caseId: string;
  file: StepsFile;
  browser: DebugBrowser;
  /** 每个角色首次执行前调用（打开视图并登录） */
  prepareRole: (role: string) => Promise<void>;
  runOptions: Record<string, unknown>;
  emit: (state: UiDebugState, role?: string) => void;
}

/**
 * 单步调试：按 steps.json 逐步回放到内嵌浏览器。
 * 失败时停在失败步骤，页面保持现场；调试结果不作为校验依据（确认仍需一次完整试跑）。
 */
export class UiDebugSession {
  readonly projectId: string;
  readonly env: string;
  readonly caseId: string;
  private steps: (UiStep & { id: string })[];
  private cursor = 0;
  private statuses: Record<string, UiDebugStepState> = {};
  private breakpoints = new Set<string>();
  private phase: UiDebugState["phase"] = "paused";
  private pauseRequested = false;
  private running?: Promise<void>;
  private prepared = new Set<string>();
  private message?: string;

  constructor(private init: DebugSessionInit) {
    this.projectId = init.projectId;
    this.env = init.env;
    this.caseId = init.caseId;
    this.steps = init.file.steps.map((st, i) => ({ ...st, id: st.id ?? `S${i + 1}` }));
    if (!this.steps.length) throw new Error("脚本没有步骤");
  }

  state(): UiDebugState {
    return {
      projectId: this.projectId, env: this.env, caseId: this.caseId, phase: this.phase,
      cursor: this.steps[this.cursor]?.id, statuses: { ...this.statuses }, breakpoints: [...this.breakpoints],
      ...(this.message ? { message: this.message } : {}),
    };
  }

  get busy(): boolean { return Boolean(this.running); }

  private publish(role?: string) { this.init.emit(this.state(), role); }

  async command(cmd: UiDebugCommand): Promise<UiDebugState> {
    if (this.phase === "stopped") throw new Error("调试已结束");
    switch (cmd.type) {
      case "pause":
        if (this.running) this.pauseRequested = true;
        return this.state();
      case "breakpoint":
        if (!this.steps.some((s) => s.id === cmd.stepId)) throw new Error("步骤不存在");
        if (this.breakpoints.has(cmd.stepId)) this.breakpoints.delete(cmd.stepId); else this.breakpoints.add(cmd.stepId);
        this.publish();
        return this.state();
      case "stop":
        this.pauseRequested = true;
        await this.running?.catch(() => undefined);
        this.phase = "stopped";
        this.init.browser.resetCaptures();
        await this.init.browser.close().catch(() => undefined);
        this.publish();
        return this.state();
    }
    // 以下命令会执行步骤：同一时间只允许一个
    if (this.running) throw new Error("正在执行，请先暂停");
    switch (cmd.type) {
      case "step":
        this.start(async () => { await this.runOne(); });
        break;
      case "skip": {
        const st = this.steps[this.cursor];
        if (!st) throw new Error("已执行到最后一步");
        this.statuses[st.id] = { status: "skipped" };
        this.cursor++;
        this.phase = this.cursor >= this.steps.length ? "finished" : "paused";
        this.message = undefined;
        this.publish();
        break;
      }
      case "continue":
        this.start(() => this.runLoop());
        break;
      case "runTo": {
        const target = this.indexOf(cmd.stepId);
        if (target < this.cursor) throw new Error("目标步骤已执行过，请先「从此步开始」或「从头开始」");
        this.start(() => this.runLoop(target));
        break;
      }
      case "seek": {
        // 只移动游标，不执行前面的步骤：适合用户已手动把页面操作到对应状态
        this.cursor = this.indexOf(cmd.stepId);
        for (const st of this.steps.slice(this.cursor)) delete this.statuses[st.id];
        this.phase = "paused";
        this.message = undefined;
        this.publish();
        break;
      }
      case "restart":
        this.cursor = 0;
        this.statuses = {};
        this.message = undefined;
        this.init.browser.resetCaptures();
        this.phase = "paused";
        this.publish();
        break;
    }
    return this.state();
  }

  /** 等待当前执行结束（测试用） */
  async idle(): Promise<void> { await this.running; }

  private indexOf(stepId: string): number {
    const i = this.steps.findIndex((s) => s.id === stepId);
    if (i < 0) throw new Error("步骤不存在");
    return i;
  }

  private start(fn: () => Promise<void>) {
    if (this.cursor >= this.steps.length) throw new Error("已执行到最后一步，可「从头开始」");
    this.pauseRequested = false;
    this.phase = "running";
    this.message = undefined;
    this.publish();
    this.running = fn()
      .catch((e) => { this.phase = "paused"; this.message = (e as Error).message; })
      .finally(() => {
        this.running = undefined;
        if (this.phase === "running") this.phase = this.cursor >= this.steps.length ? "finished" : "paused";
        if (this.phase !== "stopped") this.publish();
      });
  }

  /** 执行游标处的一步；失败返回 false，游标停在失败步骤 */
  private async runOne(): Promise<boolean> {
    const st = this.steps[this.cursor];
    const role = st.role ?? "default";
    this.statuses[st.id] = { status: "running" };
    this.publish(role);
    const started = Date.now();
    try {
      if (!this.prepared.has(role)) {
        await this.init.prepareRole(role);
        this.prepared.add(role);
      }
      const out = await this.init.browser.runStep(st, this.init.runOptions);
      this.statuses[st.id] = { status: "passed", durationMs: Date.now() - started, ...(out.note ? { note: out.note } : {}) };
      this.cursor++;
      return true;
    } catch (e) {
      this.statuses[st.id] = { status: "failed", durationMs: Date.now() - started, error: (e as Error).message.slice(0, 2000) };
      this.phase = "paused";
      this.message = `${st.id} 执行失败，页面已保留现场：可在右侧浏览器检查后重试、跳过或修正脚本`;
      return false;
    }
  }

  /** 连续执行：遇到断点（起点除外）、失败、暂停或到达 until（含）时停下 */
  private async runLoop(until?: number): Promise<void> {
    let first = true;
    while (this.cursor < this.steps.length && !this.pauseRequested) {
      const st = this.steps[this.cursor];
      if (!first && this.breakpoints.has(st.id)) {
        this.message = `停在断点 ${st.id}`;
        return;
      }
      first = false;
      if (!(await this.runOne())) return;
      if (until !== undefined && this.cursor > until) return;
    }
    if (this.pauseRequested && this.cursor < this.steps.length) this.message = "已暂停";
  }
}
