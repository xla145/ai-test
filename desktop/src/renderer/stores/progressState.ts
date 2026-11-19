import type { TaskProgress, TaskProgressSnapshot } from "../../shared/taskProgress";
export function mergeProgress(state: TaskProgressSnapshot, incoming: TaskProgressSnapshot, taskId: string): TaskProgressSnapshot {
  const events = [...new Map([...state.events, ...incoming.events].filter(e => e.taskId === taskId).map(e => [e.seq, e])).values()].sort((a,b) => a.seq-b.seq);
  return { events: events.slice(-120), truncated: state.truncated || incoming.truncated || events.length > 120 };
}
