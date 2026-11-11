import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { checkData as CheckData, runUiSuite as RunUiSuite, seedData as SeedData, UiCaseResult } from "@ai-test/mcp-servers";
import {
  apiScriptPrompt,
  caseGenerationPrompt,
  explorePrompt,
  healPrompt,
  triagePrompt,
  type FailureBrief,
  type UiFailureBrief,
} from "./prompts.js";
import type { TurnResult } from "./codex/appServer.js";
import type { ThreadStartParams } from "./codex/protocol.js";
import type { CaseQuery, Page, PageQuery } from "../shared/ipc.js";

const opt = (flag: string, v: string | undefined): string[] => (v ? [flag, v] : []);
const pageArgs = (q: PageQuery) => ["--page", String(q.page), "--page-size", String(q.pageSize)];
/** { execution_mode: "ui,capture" } → ["--execution-mode", "ui,capture"] */
const filterArgs = (filters: Record<string, string | undefined>) =>
  Object.entries(filters).flatMap(([k, v]) => opt(`--${k.replace(/_/g, "-")}`, v));

/**
 * 编排层（架构文档第 3 节）：界面只和编排层通信；编排层驱动 Codex，凭据、审批和调度都留在这里。
 * 回归执行由编排层直接调度 pytest，不经过 Codex；只有失败用例才回到 agent。
 */
export type EngineCall = <T = unknown>(args: string[], env?: Record<string, string>) => Promise<T>;

export interface AgentEngine {
  startThread(params: ThreadStartParams): Promise<string>;
  runTurn(threadId: string, text: string, opts?: { tokenLimit?: number }): Promise<TurnResult>;
}

export interface EnvironmentInfo {
  base_url: string;
  auth_header?: string;
  production?: boolean;
  login?: Record<string, string>;
  data_api?: { check?: string; seed?: string };
  clock_api?: { set?: string };
}

export interface ProjectInfo {
  id: string;
  name: string;
  workspace_path: string;
  /** 生效的环境（子项目含继承自大项目的） */
  environments: Record<string, EnvironmentInfo>;
  /** 两层项目："group" 为大项目，只存放共享配置 */
  kind?: "project" | "group";
  parent_id?: string;
}

/** UI 执行相关依赖（来自 @ai-test/mcp-servers，测试时可替换） */
export interface UiDeps {
  runUiSuite: typeof RunUiSuite;
  checkData: typeof CheckData;
  seedData: typeof SeedData;
}

interface CaseRow {
  id: string;
  title: string;
  execution_mode: string;
  status: string;
  data_refs: string[];
}

export interface RunSummary {
  run_id: string;
  total: number;
  passed: number;
  failed: number;
  error: number;
  skipped: number;
  pass_rate: number;
  failure_types: Record<string, number>;
  needs_agent: string[];
}

/** UI 回归中失败用例的明细（规则判定 + agent 自愈结论合并） */
export interface UiFailure {
  case_id: string;
  status: string;
  failure_type: string;
  message: string;
  /** agent 给出的判断依据（自愈时） */
  reason?: string;
}

/** 生产环境的执行需要界面二次确认 */
export class ProductionConfirmRequired extends Error {
  constructor(env: string) {
    super(`「${env}」是生产环境，需要确认后才能执行`);
    this.name = "ProductionConfirmRequired";
  }
}

export interface TriageItem {
  case_id: string;
  failure_type: string;
  reason?: string;
  suggestion?: string;
}

export interface OrchestratorDeps {
  engine: EngineCall;
  agent: () => Promise<AgentEngine>;
  /** 取环境凭据与角色账号（来自钥匙串），只注入子进程 */
  secretEnv: (projectId: string, env: string, roles?: string[]) => Record<string, string>;
  ui?: UiDeps;
  /** 单次 agent 任务的 token 上限 */
  tokenLimit?: number;
}

export class Orchestrator extends EventEmitter {
  constructor(private readonly deps: OrchestratorDeps) {
    super();
  }

  listProjects(): Promise<ProjectInfo[]> {
    return this.deps.engine<ProjectInfo[]>(["list-projects"]);
  }

  async project(projectId: string): Promise<ProjectInfo> {
    const p = (await this.listProjects()).find((x) => x.id === projectId);
    if (!p) throw new Error(`项目不存在：${projectId}`);
    return p;
  }

  createProject(name: string, workspace: string, environments: ProjectInfo["environments"] = {},
    opts: { kind?: "project" | "group"; parent?: string } = {}) {
    return this.deps.engine<ProjectInfo>([
      "init-project", "--name", name, ...(opts.kind === "group" ? ["--kind", "group"] : ["--workspace", workspace]),
      "--environments", JSON.stringify(environments), ...(opts.parent ? ["--parent", opts.parent] : []),
    ]);
  }

  /** 移入大项目；parent 为空字符串表示移出成为独立项目 */
  moveProject(projectId: string, parent: string) {
    return this.deps.engine(["update-project", "--project", projectId, "--parent", parent]);
  }

  projectOverview(groupId: string) {
    return this.deps.engine(["project-overview", "--project", groupId]);
  }

  importExcel(projectId: string, file: string) {
    return this.deps.engine(["import-excel", "--project", projectId, "--file", file]);
  }

  /** 规范检查只返回统计；问题明细用 pageIssues 分页读取 */
  lint(projectId: string) {
    return this.deps.engine(["lint", "--project", projectId]);
  }

  listCases(projectId: string, filters: Record<string, string> = {}) {
    return this.deps.engine<unknown[]>(["list-cases", "--project", projectId, ...filterArgs(filters)]);
  }

  pageCases(projectId: string, q: CaseQuery) {
    return this.deps.engine<Page<unknown>>([
      "list-cases", "--project", projectId, ...opt("--query", q.query), ...filterArgs(q.filters ?? {}), ...pageArgs(q),
    ]);
  }

  pageIssues(projectId: string, q: PageQuery & { level?: string }) {
    return this.deps.engine<Page<unknown>>(["list-issues", "--project", projectId, ...opt("--level", q.level), ...pageArgs(q)]);
  }

  /** 界面上的修改记为人工介入（计入「人工介入次数」） */
  updateCase(caseId: string, patch: Record<string, unknown>, actor: "human" | "agent" = "human") {
    return this.deps.engine(["update-case", "--case", caseId, "--json", JSON.stringify(patch), "--actor", actor]);
  }

  applyFix(caseId: string, field: string, value: unknown) {
    return this.deps.engine(["apply-fix", "--case", caseId, "--field", field, "--value", JSON.stringify(value)]);
  }

  tokenUsage(projectId: string) {
    return this.deps.engine<{ tokens: number }>(["token-usage", "--project", projectId]);
  }

  /** 接口测试主线：OpenAPI → 基线用例 → 脚本（确定性，不耗模型）；enrich=true 时让 agent 补充业务场景 */
  async generateApiSuite(projectId: string, openapiFile: string, enrich = false) {
    const generated = await this.deps.engine(["generate-api-cases", "--project", projectId, "--openapi", openapiFile]);
    let agent: TurnResult | undefined;
    if (enrich) agent = await this.agentTask(projectId, "api_script", apiScriptPrompt(projectId, openapiFile));
    const suite = await this.deps.engine(["write-api-suite", "--project", projectId]);
    return { generated, suite, agent };
  }

  /** 需求文档 → 用例（agent 任务） */
  generateCases(projectId: string, requirementFile: string) {
    return this.agentTask(projectId, "case_gen", caseGenerationPrompt(projectId, requirementFile));
  }

  /** 回归：直接跑脚本，不消耗大模型；失败且无法确定类型时才调 agent 归因 */
  async runRegression(projectId: string, env: string, opts: { autoTriage?: boolean; confirmProduction?: boolean } = {}) {
    const project = await this.project(projectId);
    const envCfg = project.environments[env];
    if (!envCfg) throw new Error(`项目未配置环境：${env}`);
    if (envCfg.production && !opts.confirmProduction) throw new ProductionConfirmRequired(env);
    this.emit("progress", { projectId, stage: "run", env });
    const run = await this.deps.engine<RunSummary>(
      ["run-api-suite", "--project", projectId, "--env", env],
      this.deps.secretEnv(projectId, env),
    );
    let triage: TriageItem[] | undefined;
    if (opts.autoTriage !== false && run.needs_agent.length) {
      triage = await this.triage(projectId, run.run_id);
    }
    return { run, triage };
  }

  async triage(projectId: string, runId: string): Promise<TriageItem[]> {
    const failures = await this.deps.engine<FailureBrief[]>(["summarize-failures", "--run", runId]);
    const unknown = failures.filter((f) => f.failure_type === "unknown");
    const settled: TriageItem[] = failures
      .filter((f) => f.failure_type !== "unknown")
      .map((f) => ({ case_id: f.case_id, failure_type: f.failure_type ?? "unknown", reason: "确定性规则判定" }));
    await this.recordAttributions(runId, settled, "rule");
    if (!unknown.length) return settled;
    const turn = await this.agentTask(projectId, "triage", triagePrompt(projectId, runId, unknown));
    const judged = parseTriage(turn.message);
    await this.recordAttributions(runId, judged, "agent");
    return [...settled, ...judged];
  }

  // ------------------------------------------------------------------ UI 测试（二期）

  /** 探索模式：agent 在内嵌浏览器里走通用例并生成确定性脚本 */
  exploreUiCase(projectId: string, env: string, caseId: string) {
    return this.agentTask(projectId, "explore", explorePrompt(projectId, env, caseId));
  }

  /** 执行前检查用例依赖的测试数据；缺失则造数，仍缺失的用例降级为手工（本次不执行） */
  async prepareData(projectId: string, env: string, cases: CaseRow[]) {
    const ui = this.requireUi();
    const project = await this.project(projectId);
    const envCfg = project.environments[env];
    const keys = [...new Set(cases.flatMap((c) => c.data_refs ?? []))];
    if (!keys.length) return { missing: [] as string[], degraded: [] as string[] };
    const records = await this.deps.engine<{ key: string; check_script?: string; seed_script?: string }[]>(["list-test-data", "--project", projectId]);
    const auth = this.deps.secretEnv(projectId, env).AITEST_AUTH_TOKEN;
    const status = await ui.checkData(envCfg, keys, records, project.workspace_path, { authToken: auth });
    const absent = status.filter((s) => s.exists === false).map((s) => s.key);
    const seeded = absent.length ? await ui.seedData(envCfg, absent, records, project.workspace_path, { authToken: auth }) : [];
    const missing = seeded.filter((s) => !s.seeded).map((s) => s.key);
    const degraded = cases.filter((c) => (c.data_refs ?? []).some((k) => missing.includes(k))).map((c) => c.id);
    return { missing, degraded };
  }

  /** UI 回归：直接跑 Playwright 脚本，不调用模型；失败且无法确定原因时进入自愈 */
  async runUiRegression(projectId: string, env: string,
    opts: { autoHeal?: boolean; headed?: boolean; confirmProduction?: boolean } = {}) {
    const ui = this.requireUi();
    const project = await this.project(projectId);
    const envCfg = project.environments[env];
    if (!envCfg) throw new Error(`项目未配置环境：${env}`);
    if (envCfg.production && !opts.confirmProduction) throw new ProductionConfirmRequired(env);
    const scripts = await this.deps.engine<{ case_id: string; path: string; framework: string }[]>(["list-scripts"]);
    const uiScripts = new Map(scripts.filter((s) => s.framework === "playwright").map((s) => [s.case_id, s.path]));
    const cases = (await this.listCases(projectId)) as CaseRow[];
    const runnable = cases.filter((c) => uiScripts.has(c.id) && c.status !== "deprecated");
    if (!runnable.length) throw new Error("没有可执行的 UI 脚本，请先在探索模式生成");
    const { missing, degraded } = await this.prepareData(projectId, env, runnable);
    const caseIds = runnable.filter((c) => !degraded.includes(c.id)).map((c) => c.id);

    const roles = (await this.deps.engine<{ role_name: string }[]>(["list-roles", "--project", projectId])).map((r) => r.role_name);
    this.emit("progress", { projectId, stage: "ui-run", env, cases: caseIds.length });
    const out = await ui.runUiSuite({
      workspace: project.workspace_path,
      baseUrl: envCfg.base_url,
      caseIds,
      headed: opts.headed,
      env: { ...this.deps.secretEnv(projectId, env, roles), ...(envCfg.login ? { AITEST_LOGIN: JSON.stringify(envCfg.login) } : {}) },
    });
    const file = join(mkdtempSync(join(tmpdir(), "aitest-run-")), "results.json");
    writeFileSync(file, JSON.stringify(out.results));
    const run = await this.deps.engine<RunSummary & { reviews: number }>([
      "save-run", "--project", projectId, "--env", env, "--results-file", file, "--framework", "playwright",
    ]);
    let heal: TriageItem[] | undefined;
    if (opts.autoHeal !== false && run.needs_agent.length) {
      heal = await this.healUi(projectId, env, run.run_id, out.results, uiScripts);
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
    return { run, heal, failures, degraded, missingData: missing, htmlReport: out.htmlReport };
  }

  async healUi(projectId: string, env: string, runId: string, results?: UiCaseResult[], scripts?: Map<string, string>) {
    const rows = results ?? (await this.deps.engine<UiCaseResult[]>(["list-run-results", "--run", runId]));
    const pending = rows.filter((r) => (r.status === "failed" || r.status === "error") && (!r.failure_type || r.failure_type === "unknown"));
    if (!pending.length) return [];
    const scriptMap = scripts ?? new Map(
      (await this.deps.engine<{ case_id: string; path: string }[]>(["list-scripts"])).map((s) => [s.case_id, s.path]),
    );
    const briefs: UiFailureBrief[] = pending.map((r) => ({
      case_id: r.case_id, message: r.message, script: scriptMap.get(r.case_id), evidence_paths: r.evidence_paths ?? [],
    }));
    const turn = await this.agentTask(projectId, "heal", healPrompt(projectId, env, runId, briefs));
    const judged = parseTriage(turn.message);
    await this.recordAttributions(runId, judged, "agent");
    return judged;
  }

  pageProposals(projectId: string, q: PageQuery & { status?: string }) {
    return this.deps.engine<Page<unknown>>(["list-proposals", "--project", projectId, ...opt("--status", q.status), ...pageArgs(q)]);
  }

  pageReviews(projectId: string, q: PageQuery & { status?: string }) {
    return this.deps.engine<Page<unknown>>(["list-reviews", "--project", projectId, ...opt("--status", q.status), ...pageArgs(q)]);
  }

  listProposals(status?: string) {
    return this.deps.engine(["list-proposals", ...(status ? ["--status", status] : [])]);
  }

  resolveProposal(projectId: string, id: string, accept: boolean) {
    return this.deps.engine(["resolve-proposal", "--project", projectId, "--id", id, ...(accept ? ["--accept"] : [])]);
  }

  listReviews(status?: string) {
    return this.deps.engine(["list-reviews", ...(status ? ["--status", status] : [])]);
  }

  resolveReview(id: string, passed: boolean) {
    return this.deps.engine(["resolve-review", "--id", id, ...(passed ? ["--passed"] : [])]);
  }

  listRoles(projectId: string) {
    return this.deps.engine<{ role_name: string }[]>(["list-roles", "--project", projectId]);
  }

  addRole(projectId: string, role: string) {
    return this.deps.engine(["add-role", "--project", projectId, "--role", role]);
  }

  setEnvironment(projectId: string, env: string, cfg: EnvironmentInfo) {
    return this.deps.engine(["set-environment", "--project", projectId, "--env", env, "--json", JSON.stringify(cfg)]);
  }

  deleteEnvironment(projectId: string, env: string) {
    return this.deps.engine(["delete-environment", "--project", projectId, "--env", env]);
  }

  renameProject(projectId: string, name: string) {
    return this.deps.engine(["update-project", "--project", projectId, "--name", name]);
  }

  /** 从客户端移除项目：删除数据库记录，workspace 目录保留 */
  deleteProject(projectId: string) {
    return this.deps.engine(["delete-project", "--project", projectId]);
  }

  getCase(caseId: string) {
    return this.deps.engine(["get-case", "--case", caseId]);
  }

  /** 按 ID 取用例标题（界面上用标题代替 ID 显示） */
  async caseTitles(projectId: string, ids: string[]): Promise<Record<string, string>> {
    const unique = [...new Set(ids.filter(Boolean))];
    if (!unique.length) return {};
    const rows = await this.deps.engine<{ id: string; title: string }[]>(["list-cases", "--project", projectId, "--ids", unique.join(",")]);
    return Object.fromEntries(rows.map((r) => [r.id, r.title]));
  }

  // ------------------------------------------------------------------ 三期：自愈与工程化

  /** 归因落库，等待人工确认（用于统计归因准确率）；非法类型忽略 */
  private async recordAttributions(runId: string, items: TriageItem[], source: "rule" | "agent") {
    for (const it of items) {
      if (!ATTRIBUTION_TYPES.has(it.failure_type)) continue;
      await this.deps.engine([
        "set-attribution", "--run", runId, "--case", it.case_id, "--type", it.failure_type, "--source", source,
        ...(it.reason ? ["--reason", it.reason] : []),
      ]);
    }
  }

  pageAttributions(projectId: string, q: PageQuery & { pending?: boolean }) {
    return this.deps.engine<Page<unknown>>([
      "list-attributions", "--project", projectId, ...(q.pending ? ["--pending"] : []), ...pageArgs(q),
    ]);
  }

  listAttributions(projectId: string, pendingOnly = true) {
    return this.deps.engine(["list-attributions", "--project", projectId, ...(pendingOnly ? ["--pending"] : [])]);
  }

  confirmAttribution(runId: string, caseId: string, failureType: string) {
    return this.deps.engine(["confirm-attribution", "--run", runId, "--case", caseId, "--type", failureType]);
  }

  usageReport(projectId: string, days = 30) {
    return this.deps.engine(["usage-report", "--project", projectId, "--days", String(days)]);
  }

  checkBudget(projectId: string) {
    return this.deps.engine(["check-budget", "--project", projectId]);
  }

  getSettings(projectId: string) {
    return this.deps.engine<Record<string, unknown>>(["get-settings", "--project", projectId]);
  }

  /** 生效值、本项目设置的值、继承自大项目的值 */
  getSettingsDetail(projectId: string) {
    return this.deps.engine(["get-settings", "--project", projectId, "--detail"]);
  }

  /** null / 空字符串表示清除本项目的设置（子项目恢复继承大项目的值）；undefined 表示不修改 */
  async setSettings(projectId: string, settings: Record<string, string | number | null | undefined>) {
    for (const [key, value] of Object.entries(settings)) {
      if (value === undefined) continue;
      await this.deps.engine(["set-setting", "--project", projectId, "--key", key, "--value", value === null ? "" : String(value)]);
    }
    return this.getSettings(projectId);
  }

  metrics(projectId: string) {
    return this.deps.engine(["metrics", "--project", projectId]);
  }

  stability(projectId: string) {
    return this.deps.engine(["stability", "--project", projectId]);
  }

  /** 团队共享：导出项目元数据与用例到 workspace 并提交 git */
  exportWorkspace(projectId: string) {
    return this.deps.engine(["export-workspace", "--project", projectId, "--commit"]);
  }

  importWorkspace(workspace: string) {
    return this.deps.engine(["import-workspace", "--workspace", workspace]);
  }

  private requireUi(): UiDeps {
    if (!this.deps.ui) throw new Error("未启用 UI 执行器");
    return this.deps.ui;
  }

  /** 一个任务 = 一个 Codex thread；记录 AgentSession 与 token 用量 */
  private async agentTask(projectId: string, purpose: string, prompt: string): Promise<TurnResult> {
    const project = await this.project(projectId);
    const budget = await this.deps.engine<{ allowed: boolean; month_used: number; monthly_budget: number | null; per_task_limit: number | null }>(
      ["check-budget", "--project", projectId],
    );
    if (budget.allowed === false) {
      throw new BudgetExceededError(`本月模型预算已用完（${budget.month_used}/${budget.monthly_budget} tokens），日常回归不受影响`);
    }
    const limits = [this.deps.tokenLimit, budget.per_task_limit].filter((x): x is number => typeof x === "number" && x > 0);
    const tokenLimit = limits.length ? Math.min(...limits) : undefined;
    const agent = await this.deps.agent();
    const threadId = await agent.startThread({
      cwd: project.workspace_path,
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    });
    const session = await this.deps.engine<{ id: string }>([
      "agent-session", "--project", projectId, "--thread", threadId, "--purpose", purpose,
    ]);
    this.emit("progress", { projectId, stage: purpose, threadId });
    const result = await agent.runTurn(threadId, prompt, { tokenLimit });
    await this.deps.engine(["add-tokens", "--session", session.id, "--tokens", String(result.tokens)]);
    return result;
  }
}

export class BudgetExceededError extends Error {}

const ATTRIBUTION_TYPES = new Set(["product_bug", "script_error", "environment"]);

/** 从 agent 最终回复中取出 JSON 数组 */
export function parseTriage(message: string): TriageItem[] {
  const fenced = message.match(/```(?:json)?\s*(\[[\s\S]*?\])\s*```/);
  const raw = fenced?.[1] ?? message.slice(message.indexOf("["), message.lastIndexOf("]") + 1);
  try {
    const items = JSON.parse(raw) as TriageItem[];
    return Array.isArray(items) ? items.filter((i) => i && typeof i.case_id === "string") : [];
  } catch {
    return [];
  }
}
