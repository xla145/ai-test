import type { TurnResult } from "../codex/appServer.js";
import { uiContractThreadConfig } from "../codex/config.js";
import type { ProjectManagementModule } from "./projectManagement.js";
import { TaskManager } from "./taskManager.js";
import { BudgetExceededError, OrchestratorDeps } from "./types.js";
export class AgentTasksModule {
  constructor(private deps: OrchestratorDeps, private tasks: TaskManager, private services: { project: ProjectManagementModule["project"] }) { }
  private emit(_event: string, payload: Record<string, any>) { this.tasks.progress(payload); }
  async agentTask(projectId: string, purpose: string, prompt: string, signal?: AbortSignal, spentTokens = 0, metadata: { env?: string; caseIds?: string[]; runId?: string } = {}): Promise<TurnResult> {
    return this.tasks.enqueue(`agent:${projectId}`, { projectId, env: metadata.env ?? this.tasks.current()?.task.env ?? "", caseIds: metadata.caseIds ?? this.tasks.current()?.task.caseIds ?? [], runId: metadata.runId, purpose, kind: ({ case_gen: "生成测试用例", api_script: "生成接口脚本", triage: "分析失败原因", ui_contract: "整理 UI 执行计划", explore: "探索 UI 用例", revise: "修正脚本", heal: "修正失败脚本", app_explore: "探索 App 用例" } as Record<string, string>)[purpose] ?? purpose, source: "agent" }, async ({ task, signal: taskSignal }) => {
      const project = await this.services.project(projectId);
      const budget = await this.deps.engine<{ allowed: boolean; month_used: number; monthly_budget: number | null; per_task_limit: number | null }>(
        ["check-budget", "--project", projectId],
      );
      if (budget.allowed === false) {
        throw new BudgetExceededError(`本月模型预算已用完（${budget.month_used}/${budget.monthly_budget} tokens），日常回归不受影响`);
      }
      const limits = [this.deps.tokenLimit, budget.per_task_limit].filter((x): x is number => typeof x === "number" && x > 0);
      const taskRemaining = limits.length ? Math.min(...limits) - spentTokens : undefined;
      const monthRemaining = budget.monthly_budget ? budget.monthly_budget - budget.month_used : undefined;
      const remaining = [taskRemaining, monthRemaining].filter((value): value is number => value !== undefined);
      const tokenLimit = remaining.length ? Math.min(...remaining) : undefined;
      if (tokenLimit !== undefined && tokenLimit <= 0) throw new BudgetExceededError("用例转换已达到单任务 token 上限；转换结果已缓存，下次可直接执行");
      taskSignal.throwIfAborted();
      const releaseThread = () => { if (task.threadId) this.deps.threadFinished?.(task.threadId); };
      try {
        const agent = await this.deps.agent();
        const threadId = await agent.startThread({
          cwd: project.workspace_path,
          approvalPolicy: "on-request",
          sandbox: purpose === "ui_contract" ? "read-only" : "workspace-write",
          ...(purpose === "ui_contract" ? { config: uiContractThreadConfig() } : {}),
        });
        task.threadId = threadId;
        this.deps.threadStarted?.(threadId, project, task.id);
        taskSignal.addEventListener("abort", releaseThread, { once: true });
        taskSignal.throwIfAborted();
        this.tasks.step("start-thread");
        this.tasks.changed();
        const session = await this.deps.engine<{ id: string }>([
          "agent-session", "--project", projectId, "--thread", threadId, "--purpose", purpose,
        ]);
        this.emit("progress", { projectId, env: "", stage: purpose, taskId: task.id, threadId });
        taskSignal.throwIfAborted();
        const result = await agent.runTurn(threadId, prompt, { tokenLimit, signal: taskSignal });
        task.tokens = result.tokens;
        task.detail = result.message?.slice(0, 2000);
        await this.deps.engine(["add-tokens", "--session", session.id, "--tokens", String(result.tokens)]);
        this.emit("progress", { projectId, env: task.env, stage: "agent-task", taskId: task.id, status: taskSignal.aborted ? "stopped" : result.status === "completed" ? "completed" : "failed", ...(result.status !== "completed" ? { error: result.status } : {}) });
        taskSignal.throwIfAborted();
        return result;
      } catch (error) {
        this.emit("progress", { projectId, env: task.env, stage: "agent-task", taskId: task.id, status: taskSignal.aborted ? "stopped" : "failed", error: String((error as Error)?.message ?? error).slice(0, 300) });
        throw error;
      } finally { taskSignal.removeEventListener("abort", releaseThread); releaseThread(); }
    }, signal);
  }
}
