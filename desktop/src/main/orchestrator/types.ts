import type {
  checkData as CheckData,
  LoginRecipe,
  Platform,
  runAppSuite as RunAppSuite,
  runUiSuite as RunUiSuite,
  seedData as SeedData
} from "@ai-test/mcp-servers";
import type { PageQuery, ProjectType } from "../../shared/ipc.js";
import type { TurnResult } from "../codex/appServer.js";
import type { ThreadStartParams } from "../codex/protocol.js";
import { type DebugBrowser } from "../uiDebug.js";

export const opt = (flag: string, v: string | undefined): string[] => (v ? [flag, v] : []);

export const pageArgs = (q: PageQuery) => ["--page", String(q.page), "--page-size", String(q.pageSize)];

export const filterArgs = (filters: Record<string, string | undefined>) =>
  Object.entries(filters).flatMap(([k, v]) => opt(`--${k.replace(/_/g, "-")}`, v));

export type EngineCall = <T = unknown>(args: string[], env?: Record<string, string>, opts?: { signal?: AbortSignal; onProgress?: (event: import("@ai-test/mcp-servers").EngineProgress) => void }) => Promise<T>;

export interface AgentEngine {
  startThread(params: ThreadStartParams): Promise<string>;
  runTurn(threadId: string, text: string, opts?: { tokenLimit?: number; signal?: AbortSignal }): Promise<TurnResult>;
}

export interface DatabaseInfo {
  type: "mysql" | "postgresql" | "sqlite";
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  path?: string;
  readonly?: boolean;
}

export interface EnvironmentInfo {
  base_url: string;
  api_crypto?: { protocol?: string; public_key_file?: string; private_key_file?: string; headers?: Record<string, unknown> };
  databases?: Record<string, DatabaseInfo>;
  auth_header?: string;
  production?: boolean;
  login?: Record<string, string>;
  /** 移动端 App：各平台的包名（Android）/ Bundle ID（iOS） */
  app?: Partial<Record<Platform, string>>;
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
  project_type?: ProjectType;
  /** 继承自大项目的环境：环境名 → 定义它的大项目 ID */
  inherited_environments?: Record<string, string>;
}

export interface UiDeps {
  runUiSuite: typeof RunUiSuite;
  checkData: typeof CheckData;
  seedData: typeof SeedData;
  prepareEmbedded?: (projectId: string, env: string, roles: string[], selectedRole?: string, show?: boolean) => Promise<{ cdpEndpoint: string; viewMarkers: Record<string, string> }>;
  /** 单步调试：连接内嵌浏览器的会话（BrowserSession） */
  createDebugBrowser?: (projectId: string, env: string, opts: { baseUrl: string; testIdAttribute?: string }) => DebugBrowser & {
    newRoleContext(role: string, opts?: { requireLogin?: boolean; login?: LoginRecipe; credentials?: { username: string; password: string } }): Promise<unknown>;
  };
}

export interface CaseRow {
  id: string;
  title: string;
  execution_mode: string;
  status: string;
  data_refs: string[];
  preconditions?: string[];
  steps?: string[];
  expected?: string[];
  lint_status?: string;
}

export interface UiCaseFull extends CaseRow {
  module_path?: string[];
  priority?: string;
  steps?: string[];
  expected?: string[];
  preconditions?: string[];
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

export interface UiFailure {
  case_id: string;
  status: string;
  failure_type: string;
  message: string;
  /** agent 给出的判断依据（自愈时） */
  reason?: string;
}

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
  /** App 执行器（Maestro）与工具状态 */
  app?: AppDeps;
  /** 单次 agent 任务的 token 上限 */
  tokenLimit?: number;
  uiLocateStrategy?: "dom-first" | "midscene-first";
  /** 可选的本地任务快照；未提供时保持测试/临时编排器的内存行为。 */
  taskFile?: string;
  threadStarted?: (threadId: string, project: ProjectInfo, taskId: string) => void;
  threadFinished?: (threadId: string) => void;
}

export interface AppDeps {
  runAppSuite: typeof RunAppSuite;
  /** maestro 可执行文件（全局设置） */
  maestroBin?: () => string | undefined;
  /** 是否已在全局设置中启用 Pinky（agent 通过它操作手机） */
  pinkyEnabled?: () => boolean;
}

export class BudgetExceededError extends Error { }

export const ATTRIBUTION_TYPES = new Set(["product_bug", "script_error", "environment", "data", "auth", "model"]);

export function parseTriage(message: string): TriageItem[] {
  const fenced = message.match(/```(?:json)?\s*(\[[\s\S]*?\])\s*```/);
  const raw = fenced?.[1] ?? message.slice(message.indexOf("["), message.lastIndexOf("]") + 1);
  try {
    const items = JSON.parse(raw) as TriageItem[];
    return Array.isArray(items) ? items.filter((i) => i && typeof i.case_id === "string" && i.case_id.trim()
      && (ATTRIBUTION_TYPES.has(i.failure_type) || i.failure_type === "unknown")
      && (i.reason === undefined || typeof i.reason === "string")
      && (i.suggestion === undefined || typeof i.suggestion === "string")) : [];
  } catch {
    return [];
  }
}
