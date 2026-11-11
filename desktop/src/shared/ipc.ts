/** 渲染进程可调用的 API（preload 通过 contextBridge 暴露为 window.aitest） */
export interface ApprovalRequest {
  id: string;
  kind: "command" | "fileChange";
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
  /** execution_mode / priority / status / lint_status / type；值可用逗号分隔多个 */
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

export interface AitestApi {
  listProjects(): Promise<unknown[]>;
  /** opts.kind="group" 创建大项目（不需要 workspace）；opts.parent 为所属大项目 */
  createProject(name: string, workspace: string, environments: Record<string, unknown>,
    opts?: { kind?: "project" | "group"; parent?: string }): Promise<unknown>;
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
  generateApiSuite(projectId: string, openapiFile: string, enrich: boolean): Promise<unknown>;
  generateCases(projectId: string, requirementFile: string): Promise<unknown>;
  /** 生产环境需要 confirmProduction，否则主进程拒绝执行 */
  runRegression(projectId: string, env: string, opts?: { confirmProduction?: boolean }): Promise<unknown>;
  tokenUsage(projectId: string): Promise<{ tokens: number }>;
  setEnvSecret(projectId: string, env: string, authToken: string, authHeader?: string): Promise<void>;
  setRoleSecret(projectId: string, role: string, username: string, password: string): Promise<void>;
  /** 子项目包含继承自大项目的角色（inherited_from 为大项目 ID） */
  listRoles(projectId: string): Promise<{ role_name: string; inherited_from?: string }[]>;
  setEnvironment(projectId: string, env: string, cfg: Record<string, unknown>): Promise<unknown>;
  /** 同时删除该环境保存在钥匙串中的 token */
  deleteEnvironment(projectId: string, env: string): Promise<unknown>;
  renameProject(projectId: string, name: string): Promise<unknown>;
  /** 从客户端移除项目（数据库记录与凭据）；workspace 目录保留 */
  deleteProject(projectId: string): Promise<{ id: string; workspace_path: string }>;
  getCase(caseId: string): Promise<unknown>;
  caseTitles(projectId: string, ids: string[]): Promise<Record<string, string>>;
  exploreUiCase(projectId: string, env: string, caseId: string): Promise<unknown>;
  runUiRegression(projectId: string, env: string, headed: boolean, opts?: { confirmProduction?: boolean }): Promise<unknown>;
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
  checkRuntime(): Promise<{ python: RuntimeCheck; codex: RuntimeCheck }>;
  getUserInfo(): Promise<UserInfo>;
  openDataDir(): Promise<string>;
  pickFile(filters?: { name: string; extensions: string[] }[]): Promise<string | null>;
  pickDirectory(): Promise<string | null>;
  openTestPage(url: string): Promise<void>;
  onApprovalRequest(cb: (req: ApprovalRequest) => void): () => void;
  respondApproval(id: string, accept: boolean): void;
  onEvent(cb: (evt: { method: string; params: unknown }) => void): () => void;
  /** 内嵌浏览器视图显示 / 隐藏（界面据此收窄到左半屏） */
  onViewChange?(cb: (v: { visible: boolean }) => void): () => void;
  hideTestView?(): Promise<void>;
}

export const CHANNELS = {
  invoke: "aitest:invoke",
  approvalRequest: "aitest:approval-request",
  approvalResponse: "aitest:approval-response",
  event: "aitest:event",
  view: "aitest:view",
} as const;
