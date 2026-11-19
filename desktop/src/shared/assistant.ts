export type AssistantMode = "ask" | "report" | "draft" | "regression";
export type AssistantPage = "home" | "cases" | "import" | "api" | "run" | "performance" | "ui" | "app" | "reports" | "ops" | "db" | "settings";
export interface AssistantReference {
  kind: "case" | "definition" | "run";
  id: string;
  label?: string;
}
export interface AssistantContext {
  page: AssistantPage;
  env?: string;
  references: AssistantReference[];
}
export interface AssistantDraft {
  title: string;
  priority: "P0" | "P1" | "P2" | "P3";
  steps: string[];
  expected: string[];
}
export interface AssistantMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
  context?: AssistantContext;
  references?: AssistantReference[];
  taskId?: string;
}
export interface AssistantOperation {
  id: string;
  kind: "save-drafts" | "run-regression";
  status: "pending" | "running" | "completed" | "failed" | "cancelled" | "expired";
  title: string;
  summary: string;
  createdAt: string;
  expiresAt: string;
  context: AssistantContext;
  caseIds?: string[];
  drafts?: AssistantDraft[];
  taskId?: string;
  runId?: string;
  result?: string;
}
export interface AssistantConversationSummary {
  id: string;
  projectId: string;
  title: string;
  updatedAt: string;
  busy: boolean;
}
export interface AssistantConversation extends AssistantConversationSummary {
  messages: AssistantMessage[];
  operations: AssistantOperation[];
  taskId?: string;
  notice?: string;
}
export interface AssistantSendInput {
  requestId: string;
  text: string;
  mode: AssistantMode;
  context: AssistantContext;
  consent: boolean;
}
export interface AssistantApi {
  assistantConversations(projectId: string): Promise<AssistantConversationSummary[]>;
  assistantCreateConversation(projectId: string): Promise<AssistantConversation>;
  assistantConversation(projectId: string, conversationId: string): Promise<AssistantConversation>;
  assistantSend(projectId: string, conversationId: string, input: AssistantSendInput): Promise<AssistantConversation>;
  assistantConfirm(projectId: string, conversationId: string, operationId: string): Promise<AssistantConversation>;
  assistantCancelOperation(projectId: string, conversationId: string, operationId: string): Promise<AssistantConversation>;
  assistantStop(projectId: string, conversationId: string): Promise<void>;
}
