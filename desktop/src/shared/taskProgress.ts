import type { UiTaskRecord } from "./ipc.js";
export type TaskProgressData =
  | { kind: "metric"; data: { p95Ms: number | null; requestsPerSecond: number; requests: number; windowSeconds: number; samples: number; truncated: boolean } }
  | { kind: "case"; data: { caseId: string; status: "passed" | "failed" | "error" | "skipped"; duration: number } }
  | { kind: "stage"; data: { stage: string } }
  | { kind: "complete" | "error"; data: { status: UiTaskRecord["status"] } };
export type TaskProgress = TaskProgressData & { taskId: string; projectId: string; env: string; timestamp: number; seq: number };
export interface TaskSnapshot { revision: number; tasks: UiTaskRecord[] }
export interface TaskProgressSnapshot { events: TaskProgress[]; truncated: boolean }
