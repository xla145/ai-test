import { DataManagementModule } from "./dataManagement.js";
import type {
  LoginRecipe,
  UiCaseResult
} from "@ai-test/mcp-servers";
import { caseHash, coverageIssues, sha256, uiRuntimeHash, writeUiScript } from "@ai-test/mcp-servers";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UiCaseGroup, UiDeriveResult, UiRunOptions, UiScriptState } from "../../shared/ipc.js";
import { deriveSteps, groupCases, scriptParams, variantLabel } from "../../shared/uiGroups.js";
import type { TurnResult } from "../codex/appServer.js";
import {
  explorePrompt,
  healPrompt,
  uiContractPrompt,
  type ExploreCaseBrief,
  type UiFailureBrief
} from "../prompts.js";
import { UiExecutionContracts } from "../uiExecutionContract.js";
import { UiWorkflow, type WorkflowReview } from "../uiWorkflow.js";
import type { AgentTasksModule } from "./agentTasks.js";
import type { ProjectManagementModule } from "./projectManagement.js";
import { TaskManager } from "./taskManager.js";
import { CaseRow, EnvironmentInfo, OrchestratorDeps, parseTriage, ProductionConfirmRequired, RunSummary, TriageItem, UiCaseFull, UiDeps, UiFailure } from "./types.js";
import { UiDebugModule } from "./uiDebugging.js";
export class UiTestingModule {
  constructor(private deps: OrchestratorDeps, private tasks: TaskManager, private services: { healUi: UiTestingModule["healUi"]; project: ProjectManagementModule["project"]; agentTask: AgentTasksModule["agentTask"]; listCases: ProjectManagementModule["listCases"]; recordAttributions: ProjectManagementModule["recordAttributions"] }) { this.data = new DataManagementModule(deps, { project: (...args) => this.services.project(...args) }); this.debug = new UiDebugModule(this.deps, this.tasks, { project: (...args) => this.services.project(...args), uiTaskActive: () => this.uiTaskActive, requireUi: () => this.requireUi(), uiCase: (...args) => this.uiCase(...args), uiScriptStates: (...args) => this.uiScriptStates(...args) }); }
  private emit(_event: string, payload: Record<string, any>) { this.tasks.progress(payload); }
  private uiTaskActive = false;

  private uiAbort?: { projectId: string; env: string; taskId: string };

  private debug: UiDebugModule;
  private data: DataManagementModule;

  private loginRoles(conditions: string[] | undefined, configured: string[], selectedRole?: string): string[] {
    if (selectedRole) return [selectedRole];
    const requiresLogin = conditions?.some(text => /已登录|登录后|登录态|需要登录|须登录|完成登录|logged in|signed in/i.test(text)
      && !/无需登录|未登录|匿名/.test(text));
    if (!requiresLogin) return [];
    const named = configured.filter(role => conditions?.some(text => text.includes(role)));
    return named.length ? named : ["default"];
  }

  /** 只读检查现有角色会话；失败时在创建 agent 线程或准备测试数据前退出。 */
  private async requireExistingLogin(projectId: string, env: string, roles: string[], config: EnvironmentInfo): Promise<void> {
    if (!roles.length) return;
    const createBrowser = this.deps.ui?.createDebugBrowser;
    if (!createBrowser) throw new Error("AUTH_REQUIRED: 当前环境无法验证 UI 登录态，请先在角色与登录中完成登录");
    const browser = createBrowser(projectId, env, { baseUrl: config.base_url });
    try {
      for (const role of [...new Set(roles)]) {
        try { await browser.newRoleContext(role, { requireLogin: true, login: config.login as unknown as LoginRecipe }); }
        catch (error) { throw new Error(`AUTH_REQUIRED: 角色「${role}」登录态无效，请先在角色与登录中完成登录。${(error as Error).message}`); }
      }
    } finally { await browser.close(); }
  }

  async withUiTask<T>(projectId: string, env: string, fn: (signal: AbortSignal) => Promise<T>, kind = "UI 执行", caseIds: string[] = []): Promise<T> {
    if (this.uiTaskActive) throw new Error("已有 UI 任务正在执行，请等待完成后再操作");
    if (this.debug.busy) throw new Error("单步调试进行中，请先结束调试");
    this.uiTaskActive = true;
    try {
      return await this.tasks.enqueue("ui:embedded", { projectId, env, kind, caseIds, source: "ui" }, async ({ task, signal }) => {
        this.uiAbort = { projectId, env, taskId: task.id };
        try { return await fn(signal); }
        catch (error) { if (signal.aborted) throw new Error("UI_TASK_STOPPED"); throw error; }
      });
    } finally { this.uiTaskActive = false; this.uiAbort = undefined; }
  }

  stopUiTask(projectId: string, env: string): void {
    const task = this.uiAbort;
    if (!task) return;
    if (task.projectId !== projectId || task.env !== env) throw new Error("当前执行的 UI 任务不属于此项目或环境");
    this.tasks.stop(task.taskId);
  }

  async exploreUiCase(projectId: string, env: string, caseId: string, opts: { confirmProduction?: boolean; selectedRole?: string } = {}) {
    return this.withUiTask(projectId, env, async (signal) => {
      const row = await this.uiCase(projectId, env, caseId, opts.confirmProduction) as UiCaseFull;
      const brief: ExploreCaseBrief = { title: row.title, steps: row.steps, expected: row.expected, preconditions: row.preconditions, data_refs: row.data_refs };
      const p = await this.services.project(projectId);
      const roles = (await this.deps.engine<{ role_name: string }[]>(["list-roles", "--project", projectId])).map((r) => r.role_name);
      if (opts.selectedRole && !roles.includes(opts.selectedRole)) throw new Error(`所选角色「${opts.selectedRole}」未配置，请重新选择登录态`);
      const empty = { threadId: "", turnId: "", status: "completed", tokens: 0 };
      if (!brief.steps?.length || !brief.expected?.length) return {
        ...empty, scriptGenerated: false,
        message: "用例缺少步骤或预期，请先补充；未调用 AI。", needsClarification: true
      };
      await this.requireExistingLogin(projectId, env, this.loginRoles(brief.preconditions, roles, opts.selectedRole), p.environments[env]);
      const contracts = new UiExecutionContracts(p.workspace_path, projectId, env, caseId, brief, roles, p.environments[env], opts.selectedRole);
      const workflow = new UiWorkflow(p.workspace_path);
      const existing = (await this.uiScriptStates(projectId, env))[caseId];
      const binding = (state: UiScriptState | undefined) => {
        if (!state || !workflow.reusable(state.path, brief)) return undefined;
        try { return { path: state.path, hash: state.hash, stepsHash: sha256(JSON.stringify(workflow.stepsFile(state.path))) }; }
        catch { return undefined; }
      };
      const before = binding(existing);
      const cached = contracts.read();
      const covered = (path: string, plan: NonNullable<typeof cached>["contract"]) => !coverageIssues(workflow.stepsFile(path).steps, { ...brief, preconditionChecks: plan.preconditionChecks }).length;
      if (cached?.contract.status === "ready" && before && covered(before.path, cached.contract) && JSON.stringify(cached.script) === JSON.stringify(before)) {
        return { ...empty, message: `已复用执行用例与脚本：${before.path}。未调用 AI；请按现有流程试跑和确认。\n中间计划：${contracts.artifactPath}`, scriptGenerated: true, reused: true };
      }
      let contract = cached?.contract;
      let converted: TurnResult | undefined;
      if (!contract) {
        converted = await this.services.agentTask(projectId, "ui_contract", uiContractPrompt(brief, roles, opts.selectedRole), signal);
        signal.throwIfAborted();
        if (converted.status !== "completed") return { ...converted, scriptGenerated: false };
        try { contract = contracts.parse(converted.message); }
        catch (e) { return { ...converted, status: "failed", scriptGenerated: false, message: `执行用例转换未通过校验，未启动浏览器：${(e as Error).message}` }; }
        contracts.save(contract);
      }
      if (contract.status !== "ready") return {
        ...(converted ?? empty), scriptGenerated: false, needsClarification: true,
        contractReused: Boolean(cached), message: `待澄清，未启动 UI 探索：${contract.issues.join("；")}`
      };
      const stillCurrent = async () => {
        const latest = await this.uiCase(projectId, env, caseId, opts.confirmProduction) as UiCaseFull;
        const latestProject = await this.services.project(projectId);
        const latestRoles = (await this.deps.engine<{ role_name: string }[]>(["list-roles", "--project", projectId])).map(r => r.role_name);
        return contracts.fingerprint === new UiExecutionContracts(p.workspace_path, projectId, env, caseId, latest, latestRoles, latestProject.environments[env], opts.selectedRole).fingerprint;
      };
      if (!await stillCurrent()) return { ...(converted ?? empty), scriptGenerated: false, message: "转换期间用例或环境已变化，请重新生成；未启动 UI 探索。" };
      // Activate a historical cache entry for the browser process without another AI conversion.
      contracts.save(contract);
      const result = await this.services.agentTask(projectId, "explore", explorePrompt(projectId, env, caseId, roles, brief, this.deps.uiLocateStrategy, contract, opts.selectedRole), signal, converted?.tokens ?? 0);
      signal.throwIfAborted();
      // 保存发生在浏览器工具中，只有本次生成、内容仍匹配的脚本才能绑定缓存。
      const after = binding((await this.uiScriptStates(projectId, env))[caseId]);
      const unchanged = await stillCurrent();
      const scriptGenerated = Boolean(unchanged && after && covered(after.path, contract) && after.stepsHash !== before?.stepsHash);
      if (scriptGenerated && result.status === "completed") contracts.save(contract, after);
      return {
        ...result, tokens: result.tokens + (converted?.tokens ?? 0), scriptGenerated, contractReused: Boolean(cached),
        message: [cached ? "中间计划命中缓存，本次未重复 AI 转换。" : `中间计划已转换并持久化（${contracts.cacheReason}）。`, `计划产物：${contracts.artifactPath}`,
        scriptGenerated ? result.message : [unchanged ? "未生成当前版本的新脚本。" : "用例或环境配置已变化，未复用本次脚本。", result.message].join("\n")].join("\n")
      };
    }, "生成脚本", [caseId]);
  }

  prepareData(...args: Parameters<DataManagementModule["prepareData"]>) { return this.data.prepareData(...args); }

  async runUiRegression(projectId: string, env: string,
    opts: UiRunOptions & { autoHeal?: boolean; headed?: boolean } = {}) {
    return this.withUiTask(projectId, env, (signal) => this.executeUiRegression(projectId, env, opts, signal), opts.mode === "validate" ? "试跑校验" : "UI 回归", opts.caseIds);
  }

  uiFingerprints(envCfg: EnvironmentInfo, cases: CaseRow[]) {
    return Object.fromEntries(cases.map(c => [c.id, sha256(JSON.stringify({ runtime: uiRuntimeHash(), environment: envCfg, case: { title: c.title, steps: c.steps, expected: c.expected, preconditions: c.preconditions, data_refs: c.data_refs, execution_mode: c.execution_mode } }))]));
  }

  async uiReviewContext(projectId: string) {
    return this.deps.engine<WorkflowReview[]>(["list-reviews", "--project", projectId]);
  }

  async executeUiRegression(projectId: string, env: string,
    opts: UiRunOptions & { autoHeal?: boolean; headed?: boolean }, signal: AbortSignal) {
    const ui = this.requireUi();
    const project = await this.services.project(projectId);
    const envCfg = project.environments[env];
    if (!envCfg) throw new Error(`项目未配置环境：${env}`);
    if (envCfg.production && !opts.confirmProduction) throw new ProductionConfirmRequired(env);
    const scripts = await this.deps.engine<{ case_id: string; path: string; framework: string }[]>(["list-scripts"]);
    const uiScripts = new Map(scripts.filter((s) => s.framework === "playwright").map((s) => [s.case_id, s.path]));
    const cases = (await this.services.listCases(projectId)) as CaseRow[];
    const workflow = new UiWorkflow(project.workspace_path);
    const projectIds = new Set(cases.map((c) => c.id));
    const context = { fingerprints: this.uiFingerprints(envCfg, cases), reviews: await this.uiReviewContext(projectId), roles: {} as Record<string, string> };
    const states = opts.mode ? workflow.states(env, Object.fromEntries([...uiScripts].filter(([id]) => projectIds.has(id))), context) : {};
    const requested = opts.caseIds ? new Set(opts.caseIds) : undefined;
    if (requested && (!requested.size || [...requested].some((id) => !projectIds.has(id) || !uiScripts.has(id)))) throw new Error("请选择当前项目中已生成脚本的用例");
    if (opts.mode === "validate" && !requested) throw new Error("试跑校验需要指定用例");
    // 内嵌浏览器只有一个可见视图：一次一条；批量试跑走无头并行
    if (opts.mode === "validate" && opts.embedded && requested!.size !== 1) throw new Error("内嵌浏览器一次只能试跑一条用例，批量试跑请使用无头并行");
    if (opts.mode === "validate" && [...requested!].some((id) => !states[id])) throw new Error("脚本文件不存在，请重新生成");
    if (opts.mode === "regression" && requested && [...requested].some((id) => states[id]?.status !== "confirmed")) throw new Error("选中的脚本尚未确认，请先完成可视化校验");
    const runnable = cases.filter((c) => uiScripts.has(c.id) && c.status !== "deprecated"
      && ["ui", "capture"].includes(c.execution_mode) && (!requested || requested.has(c.id))
      && c.lint_status !== "blocked"
      && (opts.mode !== "regression" || (states[c.id]?.status === "confirmed" && c.status === "reviewed")));
    if (requested && runnable.length !== requested.size) throw new Error("选中的用例已废弃、尚未审核或不支持 UI 执行");
    if (!runnable.length) throw new Error("没有已确认的 UI 脚本，请先在内嵌浏览器中校验并确认");
    const roles = (await this.deps.engine<{ role_name: string }[]>(["list-roles", "--project", projectId])).map((r) => r.role_name);
    if (opts.embedded && !ui.prepareEmbedded) throw new Error("当前运行环境不支持内嵌浏览器校验");
    if (opts.selectedRole && !roles.includes(opts.selectedRole)) throw new Error(`所选角色「${opts.selectedRole}」未配置，请重新选择登录态`);
    const versions = opts.mode === "validate" ? Object.fromEntries(runnable.map((c) => [c.id, workflow.hash(uiScripts.get(c.id)!)])) : {};
    if (opts.mode === "validate") {
      for (const c of runnable) context.roles[c.id] = opts.selectedRole ?? "default";
      workflow.begin(env, versions, context.fingerprints);
    }
    const roleBindings = Object.fromEntries(runnable.map(c => [c.id, opts.mode === "regression" ? states[c.id]?.executionRole ?? "default" : opts.selectedRole ?? "default"]));
    if (Object.values(roleBindings).some(role => role !== "default" && !roles.includes(role))) throw new Error("AUTH_REQUIRED: 脚本绑定的角色已删除，请重新选择角色校验");
    const loginRoles = [...Object.values(roleBindings).filter(role => role !== "default"),
      ...runnable.flatMap(c => this.loginRoles(c.preconditions, roles))];
    await this.requireExistingLogin(projectId, env, loginRoles, envCfg);
    signal.throwIfAborted();
    const { missing, degraded } = await this.prepareData(projectId, env, runnable, signal);
    signal.throwIfAborted();
    const caseIds = runnable.filter((c) => !degraded.includes(c.id)).map((c) => c.id);
    const embedded = opts.embedded ? await ui.prepareEmbedded!(projectId, env, roles, opts.selectedRole) : undefined;
    const sessionSource = !opts.embedded && ui.prepareEmbedded ? await ui.prepareEmbedded(projectId, env, roles, undefined, false) : undefined;
    const secretEnv = this.deps.secretEnv(projectId, env, roles);
    // UI 脚本中的数据库断言需要的连接配置（含密码，只注入脚本进程）
    const dbRuntime = envCfg.databases && Object.keys(envCfg.databases).length
      ? await this.deps.engine<Record<string, string>>(["db-runtime-env", "--project", projectId, "--env", env], secretEnv)
      : {};
    this.emit("progress", { projectId, stage: "ui-run", env, cases: caseIds.length });
    signal.throwIfAborted();
    const artifacts = new Map(runnable.map(c => {
      let scriptHash: string | null = null;
      try { scriptHash = workflow.hash(uiScripts.get(c.id)!); } catch { /* 缺失版本明确保留为空。 */ }
      return [c.id, {
        schema_version: 1, project_id: projectId, case_id: c.id, env,
        case_revision: caseHash(c), source_revision: null, script_hash: scriptHash,
        script_path: uiScripts.get(c.id), environment_fingerprint: sha256(JSON.stringify(envCfg)),
        role: roleBindings[c.id] ?? null, session_policy: opts.mode === "validate" ? "isolated" : opts.embedded ? "embedded" : "isolated"
      }];
    }));
    this.tasks.step("execute");
    const taskId = this.tasks.current()?.task.id;
    const out = caseIds.length ? await ui.runUiSuite({
      signal,
      workspace: project.workspace_path,
      baseUrl: envCfg.base_url,
      caseIds,
      headed: opts.headed,
      ...(!opts.embedded && opts.workers && opts.workers > 1 ? { workers: Math.min(8, Math.floor(opts.workers)) } : {}),
      ...(opts.mode === "validate" ? {} : embedded),
      defaultRole: opts.selectedRole,
      roleBindings,
      // Trials remain isolated but must restore the selected role's login.
      // Previously validation discarded the session source entirely.
      ...((embedded ?? sessionSource) ? { sessionSource: embedded ?? sessionSource } : {}),
      onProgress: (event) => this.emit("progress", { ...event, projectId, env, taskId, stage: "ui-step" }),
      env: { ...secretEnv, ...dbRuntime, ...(envCfg.login ? { AITEST_LOGIN: JSON.stringify(envCfg.login) } : {}) },
    }) : { exitCode: 0, results: [] as UiCaseResult[], errors: [], stderr: "", htmlReport: "", reportJson: "" };
    signal.throwIfAborted();
    for (const c of runnable) {
      if (!out.results.some(r => r.case_id === c.id)) out.results.push({
        case_id: c.id,
        status: degraded.includes(c.id) ? "skipped" : "error", duration: 0,
        message: degraded.includes(c.id) ? `PRECONDITION_MISSING: ${missing.join("、")}` : `执行器没有返回用例结果：${out.errors?.join("；") || out.stderr}`,
        acceptance_status: degraded.includes(c.id) ? "blocked" : "incomplete", reason_code: degraded.includes(c.id) ? "precondition_missing" : "incomplete", evidence_paths: [], reviews: []
      });
    }
    this.tasks.step("collect-results", { count: out.results.length });
    const validationIssues: Record<string, string> = {};
    const eligible: string[] = [];
    const reviewCounts: Record<string, number> = {};
    if (opts.mode === "validate") {
      for (const id of Object.keys(versions)) {
        const results = out.results.filter(r => r.case_id === id);
        let reason: string | undefined;
        if (degraded.includes(id)) reason = "测试数据未就绪，本次未执行";
        else if (out.exitCode !== 0 || out.errors?.length) reason = "执行器未正常完成，请检查运行报告后重新试跑";
        else if (out.results.some(r => !runnable.some(c => c.id === r.case_id))) reason = "执行报告包含未请求的用例，请检查脚本与用例的关联";
        else if (!results.length) reason = "本次缺少该用例的执行结果，请重新试跑";
        else if (results.some(r => r.status !== "passed")) reason = "本次用例存在失败、错误或跳过的测试，请检查报告";

        if (!reason) {
          try {
            const meta = workflow.stepsFile(uiScripts.get(id)!);
            const source = runnable.find(c => c.id === id)!;
            const issues = coverageIssues(meta.steps, { ...source, preconditionChecks: meta.preconditionChecks });
            if (meta.caseHash !== caseHash(source)) issues.unshift("脚本未绑定当前用例版本");
            if (issues.length) reason = `COVERAGE_INCOMPLETE: ${issues.join("；")}`;
          } catch { reason = "COVERAGE_INCOMPLETE: 缺少与脚本一致的结构化步骤，请重新生成"; }
        }
        reviewCounts[id] = results.reduce((n, r) => n + (r.reviews?.length ?? 0), 0);
        if (reason) validationIssues[id] = reason;
        else eligible.push(id);
      }
    }
    for (const result of out.results) {
      if (artifacts.has(result.case_id)) result.execution_context = {
        ...result.execution_context, sessions: result.execution_context?.sessions ?? [], artifact: artifacts.get(result.case_id),
      };
      if (validationIssues[result.case_id] && result.status === "passed") {
        result.acceptance_status = "incomplete";
        result.reason_code = "incomplete";
      } else if (opts.mode === "validate" && eligible.includes(result.case_id)) {
        result.acceptance_status = result.reviews?.length ? "pending_review" : "verified_pass";
      }
    }
    const file = join(mkdtempSync(join(tmpdir(), "aitest-run-")), "results.json");
    writeFileSync(file, JSON.stringify(out.results));
    const run = await this.deps.engine<RunSummary & { reviews: number }>([
      "save-run", "--project", projectId, "--env", env, "--results-file", file, "--framework", "playwright",
      "--html-report", out.htmlReport,
    ]);
    signal.throwIfAborted();
    if (opts.mode === "validate") {
      workflow.record(env, run.run_id, versions, eligible, context, validationIssues, reviewCounts);
      const fresh = workflow.states(env, Object.fromEntries([...uiScripts].filter(([id]) => id in versions)), {
        ...context, reviews: await this.uiReviewContext(projectId),
      });
      for (const [id, state] of Object.entries(fresh)) if (state.validationReason) validationIssues[id] = state.validationReason;
    }
    let heal: TriageItem[] | undefined;
    // 登录失效时失败原因已经明确，不启动自愈 agent；先让用户恢复登录态。
    const authFailure = run.failure_types?.auth > 0
      || out.results.some((result) => result.failure_type === "auth"
        || /(?:未授权|未登录|登录失效|登录前置条件|401|403|AUTH_REQUIRED)/i.test(String(result.message ?? "")));
    if (opts.autoHeal === true && run.needs_agent.length && !authFailure) {
      heal = await this.services.healUi(projectId, env, run.run_id, out.results, uiScripts, signal);
    } else if (authFailure) {
      this.emit("progress", { projectId, env, stage: "analysis", status: "skipped", reason: "auth_required", runId: run.run_id });
    }
    // 失败明细：以引擎保存后的归因为准（含规则判定），agent 结论覆盖类型并补充依据
    const saved = await this.deps.engine<UiFailure[]>(["list-run-results", "--run", run.run_id]);
    const judged = new Map((heal ?? []).map((h) => [h.case_id, h]));
    const failures: UiFailure[] = (Array.isArray(saved) ? saved : [])
      .filter((r) => r.status === "failed" || r.status === "error")
      .map((r) => {
        const h = judged.get(r.case_id);
        return {
          case_id: r.case_id, status: r.status, message: (r.message ?? "").slice(0, 500),
          failure_type: h?.failure_type ?? r.failure_type ?? "unknown", ...(h?.reason ? { reason: h.reason } : {}),
        };
      });
    return { run, heal, failures, degraded, missingData: missing, htmlReport: out.htmlReport, validationIssues, sessionId: out.sessionId };
  }

  async uiScriptStates(projectId: string, env: string): Promise<Record<string, UiScriptState>> {
    const p = await this.services.project(projectId);
    if (!p.environments[env]) throw new Error("项目未配置该环境");
    const cases = (await this.services.listCases(projectId)) as CaseRow[];
    const ids = new Set(cases.map((c) => c.id));
    const scripts = await this.deps.engine<{ case_id: string; path: string; framework: string }[]>(["list-scripts"]);
    return new UiWorkflow(p.workspace_path).states(env, Object.fromEntries(scripts.filter((s) => s.framework === "playwright" && ids.has(s.case_id)).map((s) => [s.case_id, s.path])), { fingerprints: this.uiFingerprints(p.environments[env], cases), reviews: await this.uiReviewContext(projectId) });
  }

  async uiCases(projectId: string) {
    return ((await this.services.listCases(projectId)) as UiCaseFull[])
      .filter((c) => ["ui", "capture"].includes(c.execution_mode) && c.status !== "deprecated");
  }

  async uiCaseGroups(projectId: string): Promise<UiCaseGroup[]> {
    return groupCases(await this.uiCases(projectId)).map((g) => ({
      id: g.id, label: g.label,
      cases: g.cases.map((c) => ({
        id: c.id, title: c.title, priority: c.priority ?? "", status: c.status, lint_status: c.lint_status ?? "",
        module_path: c.module_path ?? [], execution_mode: c.execution_mode, variant: variantLabel(g, c.id),
      })),
    }));
  }

  async deriveUiScripts(projectId: string, env: string, sourceCaseId: string, opts: { targetIds?: string[] } = {}): Promise<UiDeriveResult> {
    if (this.uiTaskActive || this.debug.busy) throw new Error("请等待当前 UI 任务结束后再生成");
    const p = await this.services.project(projectId);
    const states = await this.uiScriptStates(projectId, env);
    const source = states[sourceCaseId];
    if (!source) throw new Error("模板用例还没有脚本");
    // 只有结构化步骤与代码一致的脚本才能作为模板
    const file = new UiWorkflow(p.workspace_path).stepsFile(source.path);
    const group = groupCases(await this.uiCases(projectId)).find((g) => g.cases.some((c) => c.id === sourceCaseId));
    if (!group) throw new Error("用例不属于当前项目或不支持 UI 执行");
    const wanted = opts.targetIds ? new Set(opts.targetIds) : undefined;
    const out: UiDeriveResult = { derived: [], skipped: [] };
    for (const c of group.cases) {
      if (c.id === sourceCaseId || states[c.id] || (wanted && !wanted.has(c.id))) continue;
      if (c.lint_status === "blocked") { out.skipped.push({ caseId: c.id, reason: "用例被规范检查阻断" }); continue; }
      if (file.preconditionChecks?.length && JSON.stringify(c.preconditions) !== JSON.stringify(file.source?.preconditions)) {
        out.skipped.push({ caseId: c.id, reason: "前置条件不同，需绑定目标用例的原子检查计划" }); continue;
      }
      const derived = deriveSteps(file.steps, scriptParams(group, sourceCaseId), scriptParams(group, c.id));
      if (!derived.ok) { out.skipped.push({ caseId: c.id, reason: derived.reason }); continue; }
      const { path } = writeUiScript(p.workspace_path, {
        caseId: c.id, title: c.title, steps: derived.steps, baseUrl: file.baseUrl,
        caseSteps: c.steps, expected: c.expected, preconditions: c.preconditions, preconditionChecks: file.preconditionChecks, caseHash: caseHash(c), derivedFrom: sourceCaseId,
      });
      await this.deps.engine(["register-script", "--project", projectId, "--case", c.id, "--path", path]);
      out.derived.push(c.id);
    }
    this.emit("progress", { projectId, env, stage: "ui-derive", source: sourceCaseId, derived: out.derived.length });
    return out;
  }

  async confirmUiScript(projectId: string, env: string, caseId: string, hash: string): Promise<void> {
    if (this.uiTaskActive) throw new Error("请等待当前 UI 任务完成后再确认脚本");
    const p = await this.services.project(projectId);
    await this.uiCase(projectId, env, caseId, true);
    const scripts = await this.deps.engine<{ case_id: string; path: string; framework: string }[]>(["list-scripts"]);
    const script = scripts.find((s) => s.case_id === caseId && s.framework === "playwright");
    if (!script) throw new Error("用例还没有 Playwright 脚本");
    new UiWorkflow(p.workspace_path).confirm(env, caseId, script.path, hash, {
      fingerprints: this.uiFingerprints(p.environments[env], (await this.services.listCases(projectId)) as CaseRow[]),
      reviews: await this.uiReviewContext(projectId),
    });
  }

  async uiScriptDetail(projectId: string, env: string, caseId: string) {
    const p = await this.services.project(projectId);
    const states = await this.uiScriptStates(projectId, env);
    const state = states[caseId];
    return state ? new UiWorkflow(p.workspace_path).detail(state.path) : null;
  }

  uiDebugStart(...args: Parameters<UiDebugModule["uiDebugStart"]>) { return this.debug.uiDebugStart(...args); }

  uiDebugCommand(...args: Parameters<UiDebugModule["uiDebugCommand"]>) { return this.debug.uiDebugCommand(...args); }

  uiBusy(): boolean {
    return this.uiTaskActive || Boolean(this.debug.busy);
  }

  uiDebugState(...args: Parameters<UiDebugModule["uiDebugState"]>) { return this.debug.uiDebugState(...args); }

  async reviseUiScript(projectId: string, env: string, caseId: string, feedback: string, opts: { confirmProduction?: boolean } = {}) {
    return this.withUiTask(projectId, env, async (signal) => {
      await this.uiCase(projectId, env, caseId, opts.confirmProduction);
      if (!feedback.trim() || feedback.length > 8000) throw new Error("请填写修正说明（最多 8000 字）");
      const states = await this.uiScriptStates(projectId, env);
      if (!states[caseId]) throw new Error("请先生成该用例的脚本");
      return this.services.agentTask(projectId, "revise", [
        `任务：为项目 ${projectId} 的 UI 用例 ${caseId} 提出脚本修正，环境：${env}。`,
        `先调用 browser.open_project（project_id=${projectId}, env=${env}），读取用例和已登记脚本。`,
        "先在内嵌浏览器中复现当前脚本或失败步骤，结合截图、页面结构和当前脚本定位问题。",
        `用户反馈：${feedback}`,
        "不要直接覆盖现有脚本。只使用 report.propose_script_fix 提交该用例完整的新脚本，等待用户审核差异并应用。不要降低断言来掩盖产品缺陷。",
      ].join("\n"), signal);
    }, "修正脚本", [caseId]);
  }

  async uiCase(projectId: string, env: string, caseId: string, confirmProduction?: boolean) {
    const p = await this.services.project(projectId);
    if (!p.environments[env]) throw new Error("项目未配置该环境");
    if (p.environments[env].production && !confirmProduction) throw new ProductionConfirmRequired(env);
    const c = ((await this.services.listCases(projectId)) as (CaseRow & { lint_status?: string })[]).find((c) => c.id === caseId);
    if (!c || !["ui", "capture"].includes(c.execution_mode) || c.status === "deprecated" || c.lint_status === "blocked") throw new Error("用例不属于当前项目、已废弃或存在阻断问题");
    return c;
  }

  async healUi(projectId: string, env: string, runId: string, results?: UiCaseResult[], scripts?: Map<string, string>, signal?: AbortSignal) {
    const rows = results ?? (await this.deps.engine<UiCaseResult[]>(["list-run-results", "--run", runId]));
    if (rows.some(r => r.failure_type === "auth" || /(?:AUTH_REQUIRED|未授权|未登录|登录失效|登录前置条件|(?:HTTP|状态码|业务码)\s*[:：]?\s*(?:401|403)\b)/i.test(String(r.message ?? "")))) return [];
    const pending = rows.filter((r) => (r.status === "failed" || r.status === "error") && (!r.failure_type || r.failure_type === "unknown"));
    if (!pending.length) return [];
    const scriptMap = scripts ?? new Map(
      (await this.deps.engine<{ case_id: string; path: string }[]>(["list-scripts"])).map((s) => [s.case_id, s.path]),
    );
    const briefs: UiFailureBrief[] = pending.map((r) => ({
      case_id: r.case_id, message: r.message, script: scriptMap.get(r.case_id), evidence_paths: r.evidence_paths ?? [],
    }));
    const turn = await this.services.agentTask(projectId, "heal", healPrompt(projectId, env, runId, briefs), signal, 0, { env, caseIds: pending.map(c => c.case_id), runId });
    const judged = parseTriage(turn.message);
    await this.services.recordAttributions(runId, judged, "agent");
    return judged;
  }

  requireUi(): UiDeps {
    if (!this.deps.ui) throw new Error("未启用 UI 执行器");
    return this.deps.ui;
  }
}
