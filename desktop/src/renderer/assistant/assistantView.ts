import type { AssistantContext, AssistantConversation, AssistantMode, AssistantPage, AssistantReference } from "../../shared/assistant";
import type { UiTaskRecord } from "../../shared/ipc";
import type { Project } from "../api";

const pages = new Set<string>(["home", "cases", "import", "api", "run", "performance", "ui", "app", "reports", "ops", "db", "settings"]);
export const assistantPage = (page: string): AssistantPage => pages.has(page) ? page as AssistantPage : "home";
export const referenceKey = (reference: AssistantReference) => `${reference.kind}:${reference.id}`;

/** Take a detached, deterministic copy: a later page selection cannot change a sent context. */
export function freezeReferences(references: readonly AssistantReference[]): AssistantReference[] {
  const seen = new Set<string>();
  return references.filter(reference => {
    const key = referenceKey(reference);
    if (!reference.id || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map(reference => ({ kind: reference.kind, id: reference.id, ...(reference.label ? { label: reference.label } : {}) }));
}
export function freezeContext(context: AssistantContext): AssistantContext {
  return { page: context.page, ...(context.env ? { env: context.env } : {}), references: freezeReferences(context.references) };
}
export function safeEnvironment(project: Project, preferred?: string): string {
  if (preferred && project.environments[preferred] && !project.environments[preferred].production) return preferred;
  return Object.keys(project.environments).find(env => !project.environments[env].production) ?? "";
}
export function conversationTasks(conversation: AssistantConversation | undefined, tasks: readonly UiTaskRecord[], projectId: string): UiTaskRecord[] {
  if (!conversation || conversation.projectId !== projectId) return [];
  const ids = new Set([conversation.taskId, ...conversation.messages.map(message => message.taskId), ...conversation.operations.map(operation => operation.taskId)].filter(Boolean));
  return tasks.filter(task => task.projectId === projectId && ids.has(task.id));
}
export const isTaskBusy = (task: UiTaskRecord) => ["queued", "running", "stopping"].includes(task.status);
export const acceptsContext = (active: { projectId?: string; page: string }, input: { projectId: string; page: string }) => !!active.projectId && active.projectId === input.projectId && active.page === input.page;

/** Regression still needs a nonempty auditable user message, but never model consent. */
export function assistantMessageText(mode: AssistantMode, text: string): string {
  return text.trim() || (mode === "regression" ? "准备所选用例的回归操作，等待人工确认后执行。" : "");
}
