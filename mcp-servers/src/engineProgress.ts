export interface EngineProgress { kind: "case"; data: { caseId: string; status: "passed" | "failed" | "error" | "skipped"; duration: number } }
export class EngineProgressParser {
  private pending = "";
  private dropping = false;
  constructor(private receive: (event: EngineProgress) => void) {}
  feed(text: string) {
    for (const part of text.split(/(?<=\n)/)) {
      if (!this.dropping) this.pending += part;
      if (this.pending.length > 65536) { this.pending = ""; this.dropping = true; }
      if (!part.endsWith("\n")) continue;
      if (!this.dropping && this.pending.startsWith("AITEST_PROGRESS:")) {
        try {
          const value = JSON.parse(this.pending.slice(16)), data = value.data;
          if (value.kind === "case" && typeof data?.caseId === "string" && ["passed", "failed", "error", "skipped"].includes(data.status)
            && typeof data.duration === "number" && Number.isFinite(data.duration) && data.duration >= 0)
            this.receive({ kind: "case", data: { caseId: data.caseId.slice(0, 500), status: data.status, duration: data.duration } });
        } catch { /* unrelated stderr cannot corrupt the final JSON response */ }
      }
      this.pending = ""; this.dropping = false;
    }
  }
}
