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
  updateCase(caseId: string, patch: Record<string, unknown>): Promise<unknown>;
  applyFix(caseId: string, field: string, value: unknown): Promise<unknown>;
  generateApiSuite(projectId: string, openapiFile: string, enrich: boolean): Promise<unknown>;
  generateCases(projectId: string, requirementFile: string): Promise<unknown>;
  runRegression(projectId: string, env: string): Promise<unknown>;
  tokenUsage(projectId: string): Promise<{ tokens: number }>;
  setEnvSecret(projectId: string, env: string, authToken: string, authHeader?: string): Promise<void>;
  pickFile(filters?: { name: string; extensions: string[] }[]): Promise<string | null>;
  pickDirectory(): Promise<string | null>;
  openTestPage(url: string): Promise<void>;
  onApprovalRequest(cb: (req: ApprovalRequest) => void): () => void;
  respondApproval(id: string, accept: boolean): void;
  onEvent(cb: (evt: { method: string; params: unknown }) => void): () => void;
}

export const CHANNELS = {
  invoke: "aitest:invoke",
  approvalRequest: "aitest:approval-request",
  approvalResponse: "aitest:approval-response",
  event: "aitest:event",
} as const;
