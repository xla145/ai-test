import type { RuntimeCheck } from "./ipc.js";
export const EXECUTORS = [
  { id: "python", name: "Python 引擎", kind: "command" },
  { id: "codex", name: "Codex Agent", kind: "command" },
  { id: "pytest", name: "pytest 回归", kind: "python" },
  { id: "playwright", name: "Playwright 浏览器", kind: "package" },
  { id: "midscene", name: "Midscene 视觉定位", kind: "package" },
  { id: "k6", name: "k6 性能测试", kind: "command" },
  { id: "maestro", name: "Maestro App 回归", kind: "command" },
  { id: "pinky", name: "Pinky App 探索", kind: "command" },
] as const;
export type ExecutorId = typeof EXECUTORS[number]["id"];
export type RuntimeChecks = Record<"python" | "codex" | "maestro" | "pinky", RuntimeCheck> & Partial<Record<ExecutorId, RuntimeCheck>>;
