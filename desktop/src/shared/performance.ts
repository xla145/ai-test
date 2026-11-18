export type PerformanceMethod = "GET" | "POST" | "PUT" | "DELETE";

export interface PerformanceScenarioStep {
  name: string;
  method: PerformanceMethod;
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
  /** 从响应中提取变量，如 {"orderId": "data.orderId"} */
  extract?: Record<string, string>;
  role?: string;
}

export interface StepMetrics {
  name: string;
  requests: number;
  p95Ms: number;
  avgMs: number;
  failureRate: number;
}

export interface DegradationResult {
  baselineId: string;
  baseline: { p95Ms: number; rps: number; failureRate: number };
  current: { p95Ms: number; rps: number; failureRate: number };
  degraded: boolean;
  details: string[];
}

export interface PerformanceOptions {
  path: string;
  /** 接口目录的稳定 ID 和启动时的定义修订；旧历史记录可缺省。 */
  definitionId?: string;
  definitionRevision?: number;
  definitionName?: string;
  /** 来自接口定义的结构化参数，路径模板本身不可在性能页改写。 */
  pathParams?: Record<string, unknown>;
  query?: Record<string, unknown>;
  timeoutSeconds?: number;
  vus: number;
  seconds: number;
  p95Ms: number;
  maxFailureRate: number;
  /** 校验常见 code + msg/message 响应，默认只把 0/200 视为业务成功。 */
  checkBusinessCode?: boolean;
  /** HTTP 方法，默认 GET */
  method?: PerformanceMethod;
  /** JSON 请求体（POST / PUT / DELETE 时使用） */
  body?: unknown;
  /** 自定义请求头（不含鉴权头，鉴权走 auth / role） */
  headers?: Record<string, string>;
  /** 是否带环境鉴权，默认 true */
  auth?: boolean;
  /** 使用指定角色的凭据（空 = 环境默认 token） */
  role?: string;
  /** 来源用例 ID（从用例派生时记录溯源） */
  caseId?: string;
  /** 二期：场景用例 ID（api_flow 场景派生） */
  scenarioId?: string;
  /** 二期：场景步骤（由引擎编译，不手动填写） */
  scenarioSteps?: PerformanceScenarioStep[];
  /** 二期：Ramp-up 秒数（0 = 不 ramp），默认 min(vus*2, 60) */
  rampUp?: number;
  /** 二期：Ramp-down 秒数，默认 10 */
  rampDown?: number;
  /** 三期：对比基线 ID */
  baselineId?: string;
}

export interface PerformanceResult {
  id: string;
  env: string;
  startedAt: string;
  finishedAt: string;
  status: "passed" | "failed" | "stopped" | "error" | "degraded";
  options: PerformanceOptions;
  requests: number | null;
  requestsPerSecond: number | null;
  failureRate: number | null;
  /** 单接口执行的失败明细；failureRate 为 HTTP 或业务失败的去重比例。 */
  httpFailureRate?: number | null;
  businessFailureRate?: number | null;
  authFailures?: number | null;
  responseValidationFailures?: number | null;
  p50Ms: number | null;
  p90Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
  avgMs: number | null;
  minMs: number | null;
  maxMs: number | null;
  dataSentBytes: number | null;
  dataReceivedBytes: number | null;
  thresholdsPassed: boolean;
  message?: string;
  reportPath: string;
  /** 二期：场景分步统计 */
  steps?: StepMetrics[];
  /** 二期：HTML 报告路径 */
  htmlReportPath?: string;
  /** 三期：退化检测 */
  degradation?: DegradationResult;
}
