import { closeSync, openSync, readSync, statSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import type { TaskProgressData } from "../shared/taskProgress.js";
type Metric = Extract<TaskProgressData, { kind: "metric" }>;
/** Sliding window over actual sample timestamps. An overflow is explicit, never a silently biased P95. */
export class PerformanceMetrics {
  private samples: { time: number; value: number }[] = [];
  private requests: { time: number; value: number }[] = [];
  private overflowUntil = 0;
  constructor(private startedAt: number, private windowMs = 5000, private capacity = 10000) {}
  accept(line: string) {
    try {
      const point = JSON.parse(line);
      if (point.type !== "Point" || !["http_req_duration", "http_reqs"].includes(point.metric)) return;
      const time = Date.parse(point.data?.time), value = point.data?.value;
      if (!Number.isFinite(time) || typeof value !== "number" || !Number.isFinite(value) || value < 0) return;
      const rows = point.metric === "http_reqs" ? this.requests : this.samples;
      rows.push({ time, value });
      if (rows.length > this.capacity) { const dropped = rows.shift()!; this.overflowUntil = Math.max(this.overflowUntil, dropped.time + this.windowMs); }
    } catch { /* partial/corrupt/unrelated lines do not invalidate the final report */ }
  }
  snapshot(now: number): Metric {
    const since = now - this.windowMs;
    this.samples = this.samples.filter(s => s.time > since && s.time <= now);
    this.requests = this.requests.filter(s => s.time > since && s.time <= now);
    const sorted = this.samples.map(s => s.value).sort((a,b) => a-b);
    const seconds = Math.max(0.001, Math.min(this.windowMs, now - this.startedAt) / 1000);
    const requests = this.requests.reduce((sum, r) => sum + r.value, 0);
    const truncated = now < this.overflowUntil;
    return { kind: "metric", data: { p95Ms: sorted.length && !truncated ? sorted[Math.max(0, Math.ceil(sorted.length * .95)-1)] : null,
      requestsPerSecond: requests / seconds, requests, samples: sorted.length, windowSeconds: seconds, truncated } };
  }
}
/** Reads bounded chunks and preserves UTF-8 / partial lines, including a final drain at process close. */
export class JsonLinesTail {
  private offset = 0;
  private pending = "";
  private decoder = new StringDecoder("utf8");
  private dropping = false;
  constructor(private file: string, private accept: (line: string) => void) {}
  read(final = false) {
    let fd: number;
    try { fd = openSync(this.file, "r"); } catch { return; }
    try {
      if (statSync(this.file).size < this.offset) { this.offset = 0; this.pending = ""; this.decoder = new StringDecoder("utf8"); this.dropping = false; }
      const buffer = Buffer.allocUnsafe(64 * 1024);
      let read = 0, total = 0;
      do {
        read = readSync(fd, buffer, 0, buffer.length, this.offset); this.offset += read; total += read;
        if (read) this.feed(this.decoder.write(buffer.subarray(0, read)));
      } while (read && (final || total < 1024 * 1024));
      if (final) { this.feed(this.decoder.end()); if (this.pending && !this.dropping) this.accept(this.pending); this.pending = ""; }
    } finally { closeSync(fd); }
  }
  private feed(text: string) {
    for (const part of text.split(/(?<=\n)/)) {
      if (!this.dropping) this.pending += part;
      if (this.pending.length > 65536) { this.pending = ""; this.dropping = true; }
      if (part.endsWith("\n")) { if (!this.dropping && this.pending.trim()) this.accept(this.pending); this.pending = ""; this.dropping = false; }
    }
  }
}
