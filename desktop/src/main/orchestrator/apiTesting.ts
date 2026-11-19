import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApiCaseDraft, ApiCaseGenerationOptions, ApiCaseGenerationPreview, ApiDebugResult, ApiDefinition, ApiImportPreview } from "../../shared/apiWorkspace.js";
import type { ApiRunOptions, ApiTestSet } from "../../shared/ipc.js";
import type { TurnResult } from "../codex/appServer.js";
import {
  apiScriptPrompt,
  caseGenerationPrompt,
  triagePrompt,
  type FailureBrief
} from "../prompts.js";
import type { AgentTasksModule } from "./agentTasks.js";
import type { ProjectManagementModule } from "./projectManagement.js";
import { TaskManager } from "./taskManager.js";
import { opt, OrchestratorDeps, parseTriage, ProductionConfirmRequired, RunSummary, TriageItem } from "./types.js";
export class ApiTestingModule {
  constructor(private deps: OrchestratorDeps, private tasks: TaskManager, private services: { project: ProjectManagementModule["project"]; agentTask: AgentTasksModule["agentTask"]; recordAttributions: ProjectManagementModule["recordAttributions"] }) { }
  private emit(_event: string, payload: Record<string, any>) { this.tasks.progress(payload); }
  private apiDebugTasks = new Map<string, AbortController>();

  async apiWorkspace<T>(projectId: string, action: string, payload?: unknown, env?: Record<string, string>, signal?: AbortSignal): Promise<T> {
    const dir = mkdtempSync(join(tmpdir(), "aiprobe-api-"));
    try {
      const file = join(dir, "request.json");
      writeFileSync(file, JSON.stringify(payload ?? {}), { mode: 0o600 });
      return await this.deps.engine<T>(["api-workspace", "--project", projectId, "--action", action, "--file", file], env, ...(signal ? [{ signal }] : []));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  listApiDefinitions(projectId: string) { return this.apiWorkspace<ApiDefinition[]>(projectId, "list"); }

  previewApiImport(projectId: string, source: string) { return this.apiWorkspace<ApiImportPreview>(projectId, "preview", { source }); }

  importApiDefinitions(projectId: string, preview: ApiImportPreview) {
    return this.apiWorkspace<{ definitions: ApiDefinition[] }>(projectId, "import", preview);
  }

  saveApiCase(projectId: string, draft: ApiCaseDraft) { return this.apiWorkspace(projectId, "save-case", draft); }

  generateDefinitionCases(projectId: string, ids: string[]) {
    return this.apiWorkspace<{ generated: number; skipped: number }>(projectId, "generate", { ids });
  }

  previewApiParameterCases(projectId: string, draft: ApiCaseDraft, options: ApiCaseGenerationOptions) {
    return this.apiWorkspace<ApiCaseGenerationPreview>(projectId, "preview-parameter-cases", { draft, options });
  }

  saveApiParameterCases(projectId: string, draft: ApiCaseDraft, options: ApiCaseGenerationOptions, keys: string[]) {
    return this.apiWorkspace<{ generated: number; skipped: number }>(projectId, "save-parameter-cases", { draft, options, keys });
  }

  listApiDebugHistory(projectId: string) { return this.apiWorkspace<ApiDebugResult[]>(projectId, "history"); }

  async debugApiRequest(projectId: string, env: string, request: ApiCaseDraft, opts: { confirmProduction?: boolean } = {}) {
    const project = await this.services.project(projectId);
    const config = project.environments[env];
    if (!config) throw new Error("请先配置并选择执行环境");
    if (config.production && !opts.confirmProduction) throw new ProductionConfirmRequired(env);
    const key = `${projectId}:${env}`;
    if (this.apiDebugTasks.has(key)) throw new Error("当前项目和环境已有接口调试正在执行");
    const controller = new AbortController();
    this.apiDebugTasks.set(key, controller);
    try {
      return await this.apiWorkspace<ApiDebugResult>(projectId, "debug", { env, request, confirmProduction: opts.confirmProduction },
        this.deps.secretEnv(projectId, env, ["*"]), controller.signal);
    } finally { this.apiDebugTasks.delete(key); }
  }

  stopApiDebug(projectId: string, env: string): void {
    this.apiDebugTasks.get(`${projectId}:${env}`)?.abort();
  }

  async generateApiSuite(projectId: string, openapiFile: string, enrich = false) {
    const generated = await this.deps.engine(["generate-api-cases", "--project", projectId, "--openapi", openapiFile]);
    let agent: TurnResult | undefined;
    if (enrich) agent = await this.services.agentTask(projectId, "api_script", apiScriptPrompt(projectId, openapiFile));
    const suite = await this.deps.engine(["write-api-suite", "--project", projectId]);
    return { generated, suite, agent };
  }

  generateCases(projectId: string, requirementFile: string) {
    return this.services.agentTask(projectId, "case_gen", caseGenerationPrompt(projectId, requirementFile));
  }

  writeReviewedApiSuite(projectId: string) {
    return this.deps.engine(["write-api-suite", "--project", projectId, "--reviewed-only"]);
  }

  listApiTestSets(projectId: string) {
    return this.deps.engine<ApiTestSet[]>(["list-api-test-sets", "--project", projectId]);
  }

  saveApiTestSet(projectId: string, name: string, caseIds: string[]) {
    if (!caseIds.length) throw new Error("请至少选择一条接口用例");
    return this.deps.engine<ApiTestSet>(["save-api-test-set", "--project", projectId, "--name", name,
      "--case-ids", JSON.stringify(caseIds)]);
  }

  async runRegression(projectId: string, env: string, opts: ApiRunOptions = {}) {
    return this.tasks.enqueue(`api:${projectId}`, { projectId, env, kind: "接口回归", caseIds: opts.caseIds ?? [], source: "api" }, async ({ task, signal }) => {
      if (opts.caseIds !== undefined && !opts.caseIds.length) throw new Error("请至少选择一条接口用例");
      const project = await this.services.project(projectId);
      const envCfg = project.environments[env];
      if (!envCfg) throw new Error(`项目未配置环境：${env}`);
      if (envCfg.production && !opts.confirmProduction) throw new ProductionConfirmRequired(env);
      this.emit("progress", { projectId, stage: "run", env });
      // 接口多账号：注入全部角色的凭据（账号密码与固定 token），流程中每步按角色鉴权
      this.tasks.step("prepare-environment");
      const apiSecrets = this.deps.secretEnv(projectId, env, ["*"]);
      const preferEnvToken = opts.preferEnvToken ?? Boolean(apiSecrets.AITEST_AUTH_TOKEN?.trim());
      this.tasks.step("spawn");
      const run = await this.deps.engine<RunSummary>(
        ["run-api-suite", "--project", projectId, "--env", env,
          ...opt("--case-ids", opts.caseIds === undefined ? undefined : JSON.stringify(opts.caseIds))],
        {
          ...apiSecrets, ...(opts.selectedRole ? { AITEST_API_SELECTED_ROLE: opts.selectedRole } : {}),
          ...(!opts.selectedRole ? { AITEST_API_PREFER_ENV_TOKEN: preferEnvToken ? "1" : "0" } : {}),
          ...(opts.checkBusinessCode !== undefined ? { AITEST_API_CHECK_BUSINESS_CODE: opts.checkBusinessCode ? "1" : "0" } : {})
        },
        { signal, onProgress: event => this.tasks.publish(event, task) },
      );
      this.tasks.step("collect-results", { count: run.total });
      this.tasks.step("generate-report");
      let triage: TriageItem[] | undefined;
      let analysis: { status: "completed" | "failed" | "skipped"; error?: string } | undefined;
      // 鉴权失败属于执行前置条件问题，先提示用户修复登录态；不要把同一批
      // 失败交给 agent 归因，避免在明确的登录失效上浪费模型 token。
      const authFailure = (run.failure_types?.auth ?? 0) > 0;
      if (opts.autoTriage !== false && run.needs_agent.length && !authFailure) {
        try {
          triage = await this.triage(projectId, run.run_id, env, signal);
          analysis = { status: "completed" };
        } catch (error) {
          // AI 分析失败不能覆盖已经完成的确定性接口报告；调用方仍应看到原始 run。
          analysis = { status: "failed", error: String((error as Error)?.message ?? error).slice(0, 300) };
          this.emit("progress", { projectId, env, stage: "analysis", status: "failed", error: analysis.error, runId: run.run_id });
        }
      } else if (authFailure) {
        analysis = { status: "skipped", error: "检测到登录态失效或请求未授权，已跳过 AI 失败归因；请先修复登录态后重试。" };
        this.emit("progress", { projectId, env, stage: "analysis", status: "skipped", reason: "auth_required", runId: run.run_id });
      }
      signal.throwIfAborted();
      return { run, triage, analysis };
    });
  }

  async triage(projectId: string, runId: string, env?: string, signal?: AbortSignal): Promise<TriageItem[]> {
    const failures = await this.deps.engine<FailureBrief[]>(["summarize-failures", "--run", runId]);
    if (failures.some(f => f.failure_type === "auth" || /(?:AUTH_REQUIRED|未授权|未登录|登录失效|(?:HTTP|状态码|业务码)\s*[:：]?\s*(?:401|403)\b)/i.test(f.message))) {
      return failures.filter(f => f.failure_type && f.failure_type !== "unknown").map(f => ({ case_id: f.case_id, failure_type: f.failure_type ?? "unknown", reason: "确定性规则判定" }));
    }
    const unknown = failures.filter((f) => f.failure_type === "unknown");
    const settled: TriageItem[] = failures
      .filter((f) => f.failure_type !== "unknown")
      .map((f) => ({ case_id: f.case_id, failure_type: f.failure_type ?? "unknown", reason: "确定性规则判定" }));
    await this.services.recordAttributions(runId, settled, "rule");
    if (!unknown.length) return settled;
    const turn = await this.services.agentTask(projectId, "triage", triagePrompt(projectId, runId, unknown), signal, 0, { env, caseIds: unknown.map(c => c.case_id), runId });
    if (turn.status !== "completed") throw new Error(`AI 归因未完成：${turn.status}`);
    const wanted = new Set(unknown.map(f => f.case_id));
    const parsed = parseTriage(turn.message).filter(item => wanted.has(item.case_id));
    if (!parsed.length) throw new Error("AI 未返回有效的失败归因，原始失败仍待分析");
    // 同一用例只接受一个结论；冲突或缺失保留 unknown，不能污染其他运行的用例。
    const judged = unknown.map(failure => {
      const matches = parsed.filter(item => item.case_id === failure.case_id);
      return matches.length === 1 ? matches[0] : { case_id: failure.case_id, failure_type: "unknown", reason: matches.length ? "AI 返回了重复或冲突结论，需人工核对" : "AI 未提供此用例的归因" };
    });
    await this.services.recordAttributions(runId, judged, "agent");
    return [...settled, ...judged];
  }
}
