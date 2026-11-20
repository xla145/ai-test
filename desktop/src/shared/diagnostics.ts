export const DIAGNOSTIC_CHAINS = [
  { id: "performance-run", steps: ["validate", "inject-secrets", "generate-plan", "spawn", "parse-summary", "write-report", "complete"] },
  { id: "api-regression", steps: ["validate", "prepare-environment", "spawn", "collect-results", "generate-report", "complete"] },
  { id: "ui-testing", steps: ["validate", "execute", "collect-results", "complete"] },
  { id: "app-testing", steps: ["validate", "execute", "collect-results", "complete"] },
  { id: "agent", steps: ["validate", "start-thread", "execute", "complete"] },
] as const;
export interface DiagnosticEvent {
  chainId: string; stepId: string; taskId: string; projectId: string; env: string;
  timestamp: number; outcome: "ok" | "error"; data: Record<string, string | number | boolean>;
}
export interface DiagnosticExport { events: DiagnosticEvent[]; truncated: boolean }
