/** 渲染进程可调用的 API（preload 通过 contextBridge 暴露为 window.aitest） */
export interface ApprovalRequest {
  id: string;
  kind: "command" | "fileChange";
  reason: string;
  detail: unknown;
}

export interface AitestApi {
  listProjects(): Promise<unknown[]>;
  createProject(name: string, workspace: string, environments: Record<string, unknown>): Promise<unknown>;
  importExcel(projectId: string, file: string): Promise<unknown>;
  lint(projectId: string): Promise<unknown>;
  listCases(projectId: string, filters?: Record<string, string>): Promise<unknown[]>;
  updateCase(caseId: string, patch: Record<string, unknown>, actor?: "human" | "agent"): Promise<unknown>;
  applyFix(caseId: string, field: string, value: unknown): Promise<unknown>;
  generateApiSuite(projectId: string, openapiFile: string, enrich: boolean): Promise<unknown>;
  generateCases(projectId: string, requirementFile: string): Promise<unknown>;
  runRegression(projectId: string, env: string): Promise<unknown>;
  tokenUsage(projectId: string): Promise<{ tokens: number }>;
  setEnvSecret(projectId: string, env: string, authToken: string, authHeader?: string): Promise<void>;
  setRoleSecret(projectId: string, role: string, username: string, password: string): Promise<void>;
  listRoles(projectId: string): Promise<{ role_name: string }[]>;
  setEnvironment(projectId: string, env: string, cfg: Record<string, unknown>): Promise<unknown>;
  exploreUiCase(projectId: string, env: string, caseId: string): Promise<unknown>;
  runUiRegression(projectId: string, env: string, headed: boolean): Promise<unknown>;
  listProposals(status?: string): Promise<unknown[]>;
  resolveProposal(projectId: string, id: string, accept: boolean): Promise<unknown>;
  listReviews(status?: string): Promise<unknown[]>;
  resolveReview(id: string, passed: boolean): Promise<unknown>;
  usageReport(projectId: string, days?: number): Promise<any>;
  checkBudget(projectId: string): Promise<any>;
  getSettings(projectId: string): Promise<Record<string, unknown>>;
  setSettings(projectId: string, settings: Record<string, string | number | null>): Promise<Record<string, unknown>>;
  metrics(projectId: string): Promise<any>;
  stability(projectId: string): Promise<any>;
  listAttributions(projectId: string, pendingOnly?: boolean): Promise<any[]>;
  confirmAttribution(runId: string, caseId: string, type: string): Promise<unknown>;
  exportWorkspace(projectId: string): Promise<any>;
  importWorkspace(dir: string): Promise<any>;
  initCi(projectId: string, provider: "github" | "gitlab", toolRepo: string, env: string): Promise<string>;
  modelPresets(): Promise<any[]>;
  getModelSettings(): Promise<any>;
  setModelSettings(models: unknown, keys?: { agent?: string; vision?: string }): Promise<any>;
  checkModel(slot: "agent" | "vision"): Promise<any>;
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
