const issueKey = (projectId: string, env: string, caseId: string) => `aitest:ui:last-issue:${JSON.stringify([projectId, env, caseId])}`;
export const readIssue = (projectId: string, env: string, caseId: string): { message: string; at: string } | undefined => {
  try { const raw = localStorage.getItem(issueKey(projectId, env, caseId)); const value = raw ? JSON.parse(raw) : undefined; return typeof value?.message === "string" && typeof value?.at === "string" ? value : undefined; } catch { return undefined; }
};
export const writeIssue = (projectId: string, env: string, caseId: string, message: string) => {
  try { localStorage.setItem(issueKey(projectId, env, caseId), JSON.stringify({ message, at: new Date().toISOString() })); } catch { /* 存储不可用时保留本次内存结果 */ }
};
