/** 渲染进程可调用的 API（preload 通过 contextBridge 暴露为 window.aitest） */
export interface ApprovalRequest {
  id: string;
  kind: "command" | "fileChange" | "mcp";
  reason: string;
  detail: unknown;
}

/** 分页查询：page 从 1 开始 */
export interface PageQuery {
  page: number;
  pageSize: number;
}

/** 引擎分页返回 */
export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  page_size: number;
  /** 规范问题分页附带：按级别统计（不受级别筛选影响） */
  levels?: Record<string, number>;
}

export interface CaseQuery extends PageQuery {
  /** 匹配标题、用例 ID、模块路径 */
  query?: string;
  /** execution_mode / priority / status / lint_status / type / ids / exclude_ids；值可用逗号分隔多个 */
  filters?: Record<string, string | undefined>;
}

// ---- 全局配置（不随项目） ----

/** 一个模型服务：OpenAI 兼容接口；API key 存钥匙串，不在这里 */
export interface ModelEntry {
  id: string;
  /** 显示名，如「百炼 qwen-max」 */
  name: string;
  /** 服务预设 id（openai / dashscope / deepseek / ark / private） */
  preset: string;
  /** 留空用预设地址 */
  baseUrl?: string;
  /** Midscene 模型族；留空按模型名推断 */
  visionFamily?: string;
  /** 留空用预设的默认模型 */
  model?: string;
}

export interface GeneralSettings {
  theme: "system" | "light" | "dark";
  /** 空表示 python3 */
  pythonPath?: string;
  /** 空表示内置 Codex */
  codexPath?: string;
  /** agent 单次任务 token 上限；项目可在「工程化」中设置更低的值 */
  taskTokenLimit?: number;
  /** App 回归：maestro 可执行文件，空表示 PATH 上的 maestro */
  maestroPath?: string;
  /** App 探索：启用后把 Pinky 注册给 agent（pinkyctl mcp） */
  pinkyEnabled?: boolean;
  /** pinkyctl 可执行文件，空表示 PATH 上的 pinkyctl */
  pinkyPath?: string;
  /** 自动检查更新（默认开启）：启动后与每隔 4 小时检查一次，有新版本时后台下载 */
  autoUpdate?: boolean;
}

/** 自动更新的状态 */
export interface UpdateState {
  status: "disabled" | "idle" | "checking" | "not-available" | "available" | "downloading" | "downloaded" | "error";
  /** 当前版本 */
  current: string;
  /** 新版本 */
  version?: string;
  /** 下载进度 0–100 */
  progress?: number;
  error?: string;
  /** status 为 disabled 时的原因 */
  reason?: string;
  checkedAt?: string;
  feedUrl?: string;
}

export interface GlobalSettings {
  version: 2;
  models: ModelEntry[];
  agentModelId: string;
  /** 不设置则不启用视觉定位（Midscene） */
  visionModelId?: string;
  general: GeneralSettings;
}

export interface RuntimeInfo {
  appVersion: string;
  dataDir: string;
  dbPath: string;
  python: { path: string; source: "env" | "settings" | "bundled" | "default" };
  codex: { path: string; source: "env" | "settings" | "bundled" | "default" };
  taskTokenLimit: { value: number; source: "env" | "settings" | "bundled" | "default" };
  maestro: { path: string; source: "env" | "settings" | "bundled" | "default" };
  pinky: { path: string; enabled: boolean };
  /** 生效中的环境变量覆盖（优先于全局配置） */
  envOverrides: string[];
}

export interface RuntimeCheck {
  ok: boolean;
  /** 版本输出或错误原因 */
  detail: string;
}

export interface GlobalSettingsView {
  settings: GlobalSettings;
  /** 各模型是否已在钥匙串保存 API key */
  hasKey: Record<string, boolean>;
  runtime: RuntimeInfo;
}

export interface ModelPresetInfo {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  visionModel?: string;
  visionFamily?: string;
  note: string;
}

export interface ModelCheckResult {
  ok: boolean;
  latencyMs: number;
  detail: string;
  models?: string[];
}

/** 侧栏显示的本机用户：git 全局配置优先，未配置时用系统用户名 */
export interface UserInfo {
  name: string;
  email?: string;
  source: "git" | "system";
}

/** 大项目概览 */
export interface GroupOverview {
  children: {
    id: string;
    name: string;
    workspace_path: string;
    cases: number;
    reviewed: number;
    blocked: number;
    last_run: { run_id: string; started_at: string; env: string; framework: string; total: number; passed: number; pass_rate: number | null } | null;
    month_tokens: number;
  }[];
  budget: { month_used: number; monthly_budget: number | null; allowed: boolean };
}

/** 设置的来源：子项目逐项继承大项目 */
export interface SettingsDetail {
  effective: Record<string, number | string>;
  own: Record<string, number | string>;
  inherited: Record<string, number | string>;
  parent_id: string;
  parent_name: string;
}

export interface ApiTestSet {
  name: string;
  case_ids: string[];
}

export interface ApiRunOptions {
  confirmProduction?: boolean;
  /** 省略时兼容全量脚本执行；显式空数组会拒绝执行。 */
  caseIds?: string[];
}

export type ProjectType = "web" | "app" | "api" | "multi";

export interface UiRunOptions {
  confirmProduction?: boolean;
  caseIds?: string[];
  mode?: "validate" | "regression";
  embedded?: boolean;
  /** 无头执行时并行的用例数（1–8，默认 1）；内嵌浏览器只有一个视图，始终逐条执行 */
  workers?: number;
}

/** 归组后的一条 UI 用例（列表用，详情另行读取） */
export interface UiGroupCase {
  id: string;
  title: string;
  priority: string;
  status: string;
  lint_status: string;
  execution_mode: string;
  /** 在组内与其它成员不同的参数取值，如「TAG-1002 · 已启用」 */
  variant: string;
}

/** 步骤骨架相同、只有参数不同的一组用例：共用一份脚本模板 */
export interface UiCaseGroup {
  id: string;
  label: string;
  cases: UiGroupCase[];
}

export interface UiDeriveResult {
  /** 已按参数替换生成脚本的用例 */
  derived: string[];
  /** 无法安全替换、仍需 AI 探索的用例 */
  skipped: { caseId: string; reason: string }[];
}

/** 界面展示用的脚本步骤（来自 scripts/ui/<case>.steps.json） */
export interface UiStepView {
  id: string;
  action: string;
  /** 人可读的描述，如「点击 button「停用」」 */
  description: string;
  /** 对应用例第几步（从 1 开始）；旧脚本或未声明时为空 */
  caseStep?: number;
  role?: string;
  source?: "ai" | "user" | "pick";
}

export interface UiScriptDetail {
  path: string;
  code: string;
  /** 结构化步骤；旧脚本没有 steps.json 时为空 */
  steps?: UiStepView[];
  /** spec 与 steps.json 一致；为 false 表示脚本被手工或 AI 修改过，步骤仅供参考 */
  synced: boolean;
  /** 由同组另一条用例的脚本按参数替换生成时，为模板用例 ID */
  derivedFrom?: string;
}

export interface UiDebugStepState {
  status: "running" | "passed" | "failed" | "skipped";
  error?: string;
  /** 例如视觉判定只截图不判定、调试模式跳过的数据库断言 */
  note?: string;
  durationMs?: number;
}

/** 单步调试会话状态：phase=paused 时游标指向下一步（失败时为失败步骤） */
export interface UiDebugState {
  projectId: string;
  env: string;
  caseId: string;
  phase: "running" | "paused" | "finished" | "stopped";
  cursor?: string;
  statuses: Record<string, UiDebugStepState>;
  breakpoints: string[];
  message?: string;
}

export type UiDebugCommand =
  | { type: "step" } | { type: "continue" } | { type: "pause" } | { type: "skip" } | { type: "restart" } | { type: "stop" }
  | { type: "runTo"; stepId: string } | { type: "seek"; stepId: string } | { type: "breakpoint"; stepId: string };

/** 内嵌浏览器停靠区域（窗口内 CSS 像素）；suspended 表示暂时隐藏（例如弹窗遮挡） */
export interface ViewDock { x: number; y: number; width: number; height: number; suspended?: boolean }

export interface UiScriptState {
  path: string;
  hash: string;
  status: "pending" | "confirmed";
  validatedRunId?: string;
}

export interface AitestApi {
  listProjects(): Promise<unknown[]>;
  /** opts.kind="group" 创建大项目（不需要 workspace）；opts.parent 为所属大项目 */
  createProject(name: string, workspace: string, environments: Record<string, unknown>,
    opts?: { kind?: "project" | "group"; parent?: string; projectType?: ProjectType }): Promise<unknown>;
  /** 移入大项目；parent 为空字符串表示移出 */
  moveProject(projectId: string, parent: string): Promise<unknown>;
  projectOverview(groupId: string): Promise<GroupOverview>;
  getSettingsDetail(projectId: string): Promise<SettingsDetail>;
  importExcel(projectId: string, file: string): Promise<unknown>;
  lint(projectId: string): Promise<unknown>;
  listCases(projectId: string, filters?: Record<string, string>): Promise<unknown[]>;
  pageCases(projectId: string, q: CaseQuery): Promise<Page<unknown>>;
  pageIssues(projectId: string, q: PageQuery & { level?: string }): Promise<Page<unknown>>;
  updateCase(caseId: string, patch: Record<string, unknown>, actor?: "human" | "agent"): Promise<unknown>;
  applyFix(caseId: string, field: string, value: unknown): Promise<unknown>;
  /** OpenAPI 来源：本地 JSON/YAML 文件路径或 HTTP/HTTPS 文档地址。 */
  generateApiSuite(projectId: string, openapiSource: string, enrich: boolean): Promise<unknown>;
  generateCases(projectId: string, requirementFile: string): Promise<unknown>;
  /** 生产环境需要 confirmProduction，否则主进程拒绝执行 */
  runRegression(projectId: string, env: string, opts?: ApiRunOptions): Promise<unknown>;
  writeReviewedApiSuite(projectId: string): Promise<unknown>;
  listApiTestSets(projectId: string): Promise<ApiTestSet[]>;
  saveApiTestSet(projectId: string, name: string, caseIds: string[]): Promise<ApiTestSet>;
  tokenUsage(projectId: string): Promise<{ tokens: number }>;
  setEnvSecret(projectId: string, env: string, authToken: string, authHeader?: string): Promise<void>;
  /** 留空的字段保留原值；token 为接口测试用的固定鉴权头值 */
  setRoleSecret(projectId: string, role: string, username: string, password: string, token?: string): Promise<void>;
  /** 各角色已保存的凭据种类（不含明文），inherited 表示来自大项目 */
  roleSecretStatus(projectId: string): Promise<Record<string, { account: boolean; token: boolean; inherited: boolean }>>;
  /** 子项目包含继承自大项目的角色（inherited_from 为大项目 ID） */
  listRoles(projectId: string): Promise<{ role_name: string; inherited_from?: string }[]>;
  setEnvironment(projectId: string, env: string, cfg: Record<string, unknown>): Promise<unknown>;
  /** 同时删除该环境保存在钥匙串中的 token */
  deleteEnvironment(projectId: string, env: string): Promise<unknown>;
  renameProject(projectId: string, name: string): Promise<unknown>;
  setProjectType(projectId: string, projectType: ProjectType): Promise<unknown>;
  /** 从客户端移除项目（数据库记录与凭据）；workspace 目录保留 */
  deleteProject(projectId: string): Promise<{ id: string; workspace_path: string }>;
  /** 清空用例库（含规范问题、脚本登记、UI 建议与复核）；执行记录保留 */
  clearCases(projectId: string): Promise<{ id: string; deleted: Record<string, number> }>;
  getCase(caseId: string): Promise<unknown>;
  /** 已登记的脚本：用例 ID → 脚本路径（framework：maestro / playwright / pytest） */
  scriptMap(framework: string): Promise<Record<string, string>>;
  caseTitles(projectId: string, ids: string[]): Promise<Record<string, string>>;
  exploreUiCase(projectId: string, env: string, caseId: string, opts?: { confirmProduction?: boolean }): Promise<unknown>;
  runUiRegression(projectId: string, env: string, headed: boolean, opts?: UiRunOptions): Promise<unknown>;
  uiScriptStates(projectId: string, env: string): Promise<Record<string, UiScriptState>>;
  /** UI 用例按「同脚本、不同参数」归组 */
  uiCaseGroups(projectId: string): Promise<UiCaseGroup[]>;
  /** 用模板用例的脚本，为同组还没有脚本的用例按参数替换生成脚本（不调用模型、不打开浏览器） */
  deriveUiScripts(projectId: string, env: string, sourceCaseId: string, opts?: { targetIds?: string[] }): Promise<UiDeriveResult>;
  confirmUiScript(projectId: string, env: string, caseId: string, hash: string): Promise<void>;
  uiScriptDetail(projectId: string, env: string, caseId: string): Promise<UiScriptDetail | null>;
  /** 开始单步调试（停在第一步之前）；进度通过 aitest/progress（stage=ui-debug）推送 */
  uiDebugStart(projectId: string, env: string, caseId: string, opts?: { confirmProduction?: boolean }): Promise<UiDebugState>;
  uiDebugCommand(command: UiDebugCommand): Promise<UiDebugState>;
  /** 当前调试会话（没有则为 null），页面重新进入时恢复 */
  uiDebugState(): Promise<UiDebugState | null>;
  stopUiTask(projectId: string, env: string): Promise<void>;
  reviseUiScript(projectId: string, env: string, caseId: string, feedback: string, opts?: { confirmProduction?: boolean }): Promise<unknown>;
  /** App 回归（Maestro）；device 为设备 ID，连接了多台设备时必填 */
  runAppRegression(projectId: string, env: string, platform: "android" | "ios",
    opts?: { device?: string; confirmProduction?: boolean }): Promise<unknown>;
  /** App 探索（agent 通过 Pinky 操作手机，生成 Maestro 脚本） */
  exploreAppCase(projectId: string, env: string, platform: "android" | "ios", caseId: string,
    opts?: { confirmProduction?: boolean }): Promise<unknown>;
  listProposals(status?: string): Promise<unknown[]>;
  pageProposals(projectId: string, q: PageQuery & { status?: string }): Promise<Page<unknown>>;
  resolveProposal(projectId: string, id: string, accept: boolean): Promise<unknown>;
  listReviews(status?: string): Promise<unknown[]>;
  pageReviews(projectId: string, q: PageQuery & { status?: string }): Promise<Page<unknown>>;
  resolveReview(id: string, passed: boolean): Promise<unknown>;
  usageReport(projectId: string, days?: number): Promise<any>;
  checkBudget(projectId: string): Promise<any>;
  getSettings(projectId: string): Promise<Record<string, unknown>>;
  setSettings(projectId: string, settings: Record<string, string | number | null>): Promise<Record<string, unknown>>;
  metrics(projectId: string): Promise<any>;
  stability(projectId: string): Promise<any>;
  listAttributions(projectId: string, pendingOnly?: boolean): Promise<any[]>;
  pageAttributions(projectId: string, q: PageQuery & { pending?: boolean }): Promise<Page<any>>;
  confirmAttribution(runId: string, caseId: string, type: string): Promise<unknown>;
  exportWorkspace(projectId: string): Promise<any>;
  importWorkspace(dir: string): Promise<any>;
  initCi(projectId: string, provider: "github" | "gitlab", toolRepo: string, env: string): Promise<string>;
  modelPresets(): Promise<ModelPresetInfo[]>;
  getGlobalSettings(): Promise<GlobalSettingsView>;
  /** keys：本次填写的 API key（按模型 id），留空的不修改 */
  saveGlobalSettings(settings: GlobalSettings, keys?: Record<string, string>): Promise<GlobalSettingsView>;
  /** 用已保存的配置测试某个模型的连通性 */
  checkModel(modelId: string): Promise<ModelCheckResult>;
  checkRuntime(): Promise<{ python: RuntimeCheck; codex: RuntimeCheck; maestro: RuntimeCheck; pinky: RuntimeCheck }>;
  getUserInfo(): Promise<UserInfo>;
  openDataDir(): Promise<string>;
  saveDatabase(projectId: string, env: string, name: string, cfg: Record<string, unknown>, password?: string): Promise<unknown>;
  removeDatabase(projectId: string, env: string, name: string): Promise<unknown>;
  testDatabase(projectId: string, env: string, name: string): Promise<{ ok: boolean; elapsed_ms: number }>;
  queryDatabase(projectId: string, env: string, name: string, sql: string, params?: Record<string, unknown>): Promise<{
    columns: string[]; rows: Record<string, unknown>[]; row_count: number; truncated: boolean; elapsed_ms: number;
  }>;
  hasDbPassword(projectId: string, env: string, name: string): Promise<boolean>;
  listRuns(projectId: string, framework?: "pytest" | "playwright"): Promise<any[]>;
  runDetail(runId: string): Promise<any>;
  /** 弹出保存对话框；用户取消返回 null */
  exportReport(runIds: string[], format: "html" | "xlsx"): Promise<{ path: string } | null>;
  exportCasesExcel(projectId: string, projectName: string): Promise<{ path: string; cases: number } | null>;
  readEvidenceImage(projectId: string, path: string): Promise<string>;
  openPath(path: string): Promise<void>;
  showInFolder(path: string): Promise<void>;
  pickFile(filters?: { name: string; extensions: string[] }[]): Promise<string | null>;
  pickDirectory(): Promise<string | null>;
  openTestPage(url: string): Promise<void>;
  onApprovalRequest(cb: (req: ApprovalRequest) => void): () => void;
  respondApproval(id: string, accept: boolean): void;
  onEvent(cb: (evt: { method: string; params: unknown }) => void): () => void;
  /** 内嵌浏览器视图显示 / 隐藏；docked 时视图嵌在页面占位区域内，界面不必收窄到左半屏 */
  /** shown：视图此刻是否真的在显示（停靠区被弹窗遮挡时为 false） */
  onViewChange?(cb: (v: { visible: boolean; docked?: boolean; shown?: boolean }) => void): () => void;
  /** 手动登录：在该角色的内嵌浏览器视图中打开登录页，由用户亲自登录（验证码、扫码等） */
  openRoleLogin(projectId: string, env: string, role: string): Promise<void>;
  /** 保存该角色视图的登录态到 scripts/ui/.auth/<角色>.json，供无头回归复用 */
  saveRoleLogin(projectId: string, env: string, role: string): Promise<{ cookies: number; localStorage: number; url: string; savedAt: string }>;
  /** 各角色手动登录保存的时间（ISO） */
  roleSessions(projectId: string): Promise<Record<string, string>>;
  /** 页面提供停靠区域后，内嵌浏览器嵌入该区域；传 null 恢复为右半屏 */
  dockTestView?(dock: ViewDock | null): Promise<void>;
  // ---- 自动更新 ----
  getUpdateState(): Promise<UpdateState>;
  /** 立即检查；有新版本时自动后台下载 */
  checkForUpdates(): Promise<UpdateState>;
  /** 退出并安装已下载的更新，安装后自动重新打开 */
  installUpdate(): Promise<void>;
  onUpdate(cb: (state: UpdateState) => void): () => void;
  hideTestView?(): Promise<void>;
}

export const CHANNELS = {
  invoke: "aitest:invoke",
  approvalRequest: "aitest:approval-request",
  approvalResponse: "aitest:approval-response",
  event: "aitest:event",
  view: "aitest:view",
  update: "aitest:update",
} as const;
