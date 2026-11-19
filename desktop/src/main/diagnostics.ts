import type { DiagnosticEvent, DiagnosticExport } from "../shared/diagnostics.js";
const fields = new Set(["status", "count", "durationMs", "hasToken", "exitCode", "code", "source"]);
/** Diagnostics deliberately exclude free text, paths, URLs, options, payloads and exception messages. */
export class Diagnostics {
  private events: DiagnosticEvent[] = [];
  private dropped = false;
  constructor(private capacity = 5000) {}
  record(context: Pick<DiagnosticEvent, "chainId" | "taskId" | "projectId" | "env">, stepId: string,
    data: Record<string, unknown> = {}, outcome: DiagnosticEvent["outcome"] = "ok") {
    const safe: DiagnosticEvent["data"] = {};
    for (const [key, value] of Object.entries(data)) {
      if (!fields.has(key)) continue;
      if (typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)) safe[key] = value;
      // Only symbolic status/error codes are accepted, never raw messages or credential values.
      if (typeof value === "string" && /^(queued|running|stopping|stopped|completed|failed|passed|error|ui|api|app|agent|performance|ENOENT|TIMEOUT|CANCELLED)$/.test(value)) safe[key] = value;
    }
    this.events.push({ ...context, stepId, timestamp: Date.now(), outcome, data: safe });
    if (this.events.length > this.capacity) { this.events.splice(0, this.events.length - this.capacity); this.dropped = true; }
  }
  export(taskId?: string): DiagnosticExport {
    return structuredClone({ events: this.events.filter(e => !taskId || e.taskId === taskId), truncated: this.dropped });
  }
}
