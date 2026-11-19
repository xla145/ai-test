import type { CaseQuery, Page, PageQuery, ProjectType } from "../../shared/ipc.js";
import { TaskManager } from "./taskManager.js";
import { ATTRIBUTION_TYPES, DatabaseInfo, EnvironmentInfo, filterArgs, opt, OrchestratorDeps, pageArgs, ProjectInfo, TriageItem } from "./types.js";

export class ProjectManagementModule {
  constructor(private deps: OrchestratorDeps, private tasks: TaskManager, private services: {}) { }
  private emit(_event: string, payload: Record<string, any>) { this.tasks.progress(payload); }
  listProjects(): Promise<ProjectInfo[]> {
    return this.deps.engine<ProjectInfo[]>(["list-projects"]);
  }

  async project(projectId: string): Promise<ProjectInfo> {
    const p = (await this.listProjects()).find((x) => x.id === projectId);
    if (!p) throw new Error(`项目不存在：${projectId}`);
    return p;
  }

  createProject(name: string, workspace: string, environments: ProjectInfo["environments"] = {},
    opts: { kind?: "project" | "group"; parent?: string; projectType?: ProjectType } = {}) {
    return this.deps.engine<ProjectInfo>([
      "init-project", "--name", name, ...(opts.kind === "group" ? ["--kind", "group"] : ["--workspace", workspace]),
      "--environments", JSON.stringify(environments), ...(opts.parent ? ["--parent", opts.parent] : []),
      ...(opts.kind !== "group" && opts.projectType ? ["--project-type", opts.projectType] : []),
    ]);
  }

  moveProject(projectId: string, parent: string) {
    return this.deps.engine(["update-project", "--project", projectId, "--parent", parent]);
  }

  projectOverview(groupId: string) {
    return this.deps.engine(["project-overview", "--project", groupId]);
  }

  importExcel(projectId: string, file: string) {
    return this.deps.engine(["import-excel", "--project", projectId, "--file", file]);
  }

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

  updateCase(caseId: string, patch: Record<string, unknown>, actor: "human" | "agent" = "human") {
    return this.deps.engine(["update-case", "--case", caseId, "--json", JSON.stringify(patch), "--actor", actor]);
  }

  applyFix(caseId: string, field: string, value: unknown) {
    return this.deps.engine(["apply-fix", "--case", caseId, "--field", field, "--value", JSON.stringify(value)]);
  }

  tokenUsage(projectId: string) {
    return this.deps.engine<{ tokens: number }>(["token-usage", "--project", projectId]);
  }

  async scriptMap(framework: string): Promise<Record<string, string>> {
    const rows = await this.deps.engine<{ case_id: string; path: string; framework: string }[]>(["list-scripts"]);
    return Object.fromEntries(rows.filter((r) => r.framework === framework).map((r) => [r.case_id, r.path]));
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

  setProjectType(projectId: string, projectType: ProjectType) {
    return this.deps.engine(["update-project", "--project", projectId, "--project-type", projectType]);
  }

  clearCases(projectId: string) {
    return this.deps.engine(["clear-cases", "--project", projectId]);
  }

  deleteProject(projectId: string) {
    return this.deps.engine(["delete-project", "--project", projectId]);
  }

  getCase(caseId: string) {
    return this.deps.engine(["get-case", "--case", caseId]);
  }

  async caseTitles(projectId: string, ids: string[]): Promise<Record<string, string>> {
    const unique = [...new Set(ids.filter(Boolean))];
    if (!unique.length) return {};
    const rows = await this.deps.engine<{ id: string; title: string }[]>(["list-cases", "--project", projectId, "--ids", unique.join(",")]);
    return Object.fromEntries(rows.map((r) => [r.id, r.title]));
  }

  async recordAttributions(runId: string, items: TriageItem[], source: "rule" | "agent") {
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

  getSettingsDetail(projectId: string) {
    return this.deps.engine(["get-settings", "--project", projectId, "--detail"]);
  }

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

  caseHistory(caseId: string) { return this.deps.engine<any[]>(["case-history", "--case", caseId]); }

  coverage(projectId: string, env?: string) {
    return this.deps.engine(["coverage", "--project", projectId, ...(env ? ["--env", env] : [])]);
  }

  stability(projectId: string) {
    return this.deps.engine(["stability", "--project", projectId]);
  }

  exportWorkspace(projectId: string) {
    return this.deps.engine(["export-workspace", "--project", projectId, "--commit"]);
  }

  importWorkspace(workspace: string) {
    return this.deps.engine(["import-workspace", "--workspace", workspace]);
  }

  async environmentOwner(projectId: string, env: string): Promise<{ ownerId: string; envCfg: EnvironmentInfo }> {
    const p = await this.project(projectId);
    const ownerId = p.inherited_environments?.[env] ?? projectId;
    const envCfg = (ownerId === projectId ? p : await this.project(ownerId)).environments[env];
    if (!envCfg) throw new Error(`项目未配置环境：${env}`);
    return { ownerId, envCfg };
  }

  async saveDatabase(projectId: string, env: string, name: string, cfg: DatabaseInfo) {
    if (!/^[A-Za-z_][\w-]*$/.test(name)) throw new Error("连接名只能包含字母、数字、下划线和连字符，且以字母开头");
    const { ownerId, envCfg } = await this.environmentOwner(projectId, env);
    const clean = Object.fromEntries(Object.entries(cfg).filter(([, v]) => v !== undefined && v !== "")) as unknown as DatabaseInfo;
    await this.setEnvironment(ownerId, env, { ...envCfg, databases: { ...envCfg.databases, [name]: clean } });
    return { ownerId };
  }

  async removeDatabase(projectId: string, env: string, name: string) {
    const { ownerId, envCfg } = await this.environmentOwner(projectId, env);
    const { [name]: _removed, ...rest } = envCfg.databases ?? {};
    await this.setEnvironment(ownerId, env, { ...envCfg, databases: rest });
    return { ownerId };
  }

  testDatabase(projectId: string, env: string, name: string) {
    return this.deps.engine(["db-test", "--project", projectId, "--env", env, "--conn", name], this.deps.secretEnv(projectId, env));
  }

  queryDatabase(projectId: string, env: string, name: string, sql: string, params: Record<string, unknown> = {}, limit = 200) {
    return this.deps.engine([
      "db-query", "--project", projectId, "--env", env, "--conn", name, "--sql", sql,
      "--params", JSON.stringify(params), "--limit", String(limit),
    ], this.deps.secretEnv(projectId, env));
  }

  listRuns(projectId: string, framework?: "pytest" | "playwright", limit = 100) {
    return this.deps.engine(["list-runs", "--project", projectId, "--limit", String(limit), ...(framework ? ["--framework", framework] : [])]);
  }

  runDetail(runId: string) {
    return this.deps.engine(["run-detail", "--run", runId]);
  }

  exportReport(runIds: string[], format: "html" | "xlsx" | "json", out?: string) {
    if (!runIds.length) throw new Error("请选择要导出的执行记录");
    return this.deps.engine<{ path: string }>([
      "export-report", ...runIds.flatMap((id) => ["--run", id]), "--format", format, ...(out ? ["--out", out] : []),
    ]);
  }

  exportCasesExcel(projectId: string, out: string) {
    return this.deps.engine<{ path: string; cases: number }>(["export-excel", "--project", projectId, "--out", out]);
  }
}
