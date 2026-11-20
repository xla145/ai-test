import type { PerformanceOptions, PerformanceResult } from "../../shared/performance.js";
import { bindPerformanceDefinition } from "../../shared/performanceSource.js";
import { runPerformance as executePerformance, listPerformance, performancePlan, readPerformanceResult } from "../performance.js";
import type { ApiTestingModule } from "./apiTesting.js";
import type { ProjectManagementModule } from "./projectManagement.js";
import { TaskManager } from "./taskManager.js";
import { OrchestratorDeps } from "./types.js";
export class PerformanceTestingModule {
  constructor(private deps: OrchestratorDeps, private tasks: TaskManager, private services: { project: ProjectManagementModule["project"]; listApiDefinitions: ApiTestingModule["listApiDefinitions"] }) { }
  private emit(_event: string, payload: Record<string, any>) { this.tasks.progress(payload); }
  async performanceHistory(projectId: string) {
    return listPerformance((await this.services.project(projectId)).workspace_path);
  }

  async runPerformance(projectId: string, env: string, options: PerformanceOptions) {
    return this.tasks.enqueue(`performance:${projectId}`, { projectId, env, kind: "k6 性能测试", caseIds: [], source: "performance" }, async ({ task, signal }) => {
      const p = await this.services.project(projectId);
      const config = p.environments[env];
      if (!config) throw new Error("未配置环境");
      if (config.production) throw new Error("性能测试不允许在生产环境执行");
      if (options.definitionId) {
        const definition = (await this.services.listApiDefinitions(projectId)).find(d => d.id === options.definitionId);
        if (!definition) throw new Error("接口不属于当前项目或已删除，请重新从接口列表选择");
        options = bindPerformanceDefinition(definition, options);
      } else if (!options.scenarioSteps?.length) {
        throw new Error("请从当前项目的接口列表选择性能测试目标");
      }
      performancePlan(config.base_url, options);
      const method = options.method ?? "GET";
      // Inject auth credentials so k6 can authenticate — tokens never written to the script file.
      this.tasks.step("inject-secrets");
      const secrets = options.auth !== false ? this.deps.secretEnv(projectId, env, options.role ? [options.role] : []) : undefined;
      if (options.auth !== false) {
        let authenticated = Boolean(secrets?.AITEST_AUTH_TOKEN?.trim());
        if (options.role && secrets?.AITEST_ROLE_TOKENS) {
          try {
            const tokens = JSON.parse(secrets.AITEST_ROLE_TOKENS) as Record<string, unknown>;
            authenticated = typeof tokens[options.role] === "string" && Boolean(String(tokens[options.role]).trim());
          } catch { authenticated = false; }
        }
        if (!authenticated) throw new Error("AUTH_REQUIRED: 当前性能测试目标没有可用登录态，请先手动登录并保存接口 token；已停止执行，未启动压测或 agent。");
      }
      // Merge crypto headers from env config into the options so the script carries them.
      const cryptoHeaders = (config.api_crypto?.headers ?? {}) as Record<string, string>;
      const merged: PerformanceOptions = Object.keys(cryptoHeaders).length
        ? { ...options, headers: { ...cryptoHeaders, ...options.headers } } : options;
      try {
        const result = await executePerformance(p.workspace_path, env, config.base_url, merged, signal, secrets, { onProgress: event => this.tasks.publish(event, task), onStep: (step, data) => this.tasks.step(step, data) });
        task.runId = result.id;
        task.detail = result.message ?? `${method} · 请求 ${result.requests ?? "—"} · P95 ${result.p95Ms ?? "—"} ms`;
        this.emit("progress", { projectId, env, taskId: task.id, stage: "agent-task", status: result.status === "passed" ? "completed" : result.status === "stopped" ? "stopped" : "failed" });
        return result;
      } catch (error) {
        this.emit("progress", { projectId, env, taskId: task.id, stage: "agent-task", status: signal.aborted ? "stopped" : "failed", error: String((error as Error).message) });
        throw error;
      }
    });
  }

  async perfCompile(projectId: string, caseId: string) {
    return this.deps.engine<{ steps: Array<{ name: string; method: string; path: string; body?: unknown; headers?: Record<string, string>; extract?: Record<string, string>; role?: string }> }>(
      ["perf-compile", "--case", caseId]);
  }

  async perfSetBaseline(projectId: string, targetKey: string, resultId: string) {
    const project = await this.services.project(projectId);
    const result = readPerformanceResult(project.workspace_path, resultId);
    if (!result) throw new Error("当前项目中找不到该性能执行记录");
    if (result.status !== "passed" || !result.thresholdsPassed || !Number.isFinite(result.requests) || !(result.requests! > 0)) {
      throw new Error("只能将已完整执行且通过门槛的结果设为基线");
    }
    const expectedTarget = result.options.scenarioId ? `scenario:${result.options.scenarioId}` : `${result.options.method ?? "GET"}:${result.options.path}`;
    if (targetKey !== expectedTarget) throw new Error("基线必须属于同一测试目标");
    await this.deps.engine(["perf-save-baseline", "--project", projectId, "--target", targetKey, "--result", resultId]);
  }

  async perfGetBaseline(projectId: string, targetKey: string): Promise<PerformanceResult | null> {
    const project = await this.services.project(projectId);
    const record = await this.deps.engine<{ result_id: string } | null>(["perf-get-baseline", "--project", projectId, "--target", targetKey]);
    return record ? readPerformanceResult(project.workspace_path, record.result_id) : null;
  }

  async perfTrend(projectId: string, targetPath?: string) {
    const p = await this.services.project(projectId);
    return this.deps.engine<Array<{ id: string; startedAt: string; p95Ms: number | null; requestsPerSecond: number | null; failureRate: number | null; status: string }>>(
      ["perf-trend", "--workspace", p.workspace_path, ...(targetPath ? ["--path", targetPath] : [])]);
  }
}
