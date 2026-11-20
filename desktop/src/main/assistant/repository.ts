import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AssistantConversation } from "../../shared/assistant.js";

export interface StoredConversation {
  conversation: AssistantConversation;
  requests: Record<string, string>;
  operations: Record<string, { fingerprint: string; saved: number }>;
  jobId?: string;
}
interface Store { version: 1; conversations: StoredConversation[] }

/** Synchronous atomic commits keep acknowledgement and execution authorization together. */
export class AssistantRepository {
  private state: Store = { version: 1, conversations: [] };
  constructor(private readonly file?: string) {
    if (!file || !existsSync(file)) return;
    const state = JSON.parse(readFileSync(file, "utf8")) as Store;
    if (state.version !== 1 || !Array.isArray(state.conversations)
      || state.conversations.some(r => !r?.conversation?.id || !r.conversation.projectId
        || !Array.isArray(r.conversation.messages) || !Array.isArray(r.conversation.operations)
        || !r.requests || !r.operations)) throw new Error("助手会话历史损坏，禁止恢复执行");
    this.state = state;
    const recovered = structuredClone(state);
    let changed = false;
    for (const row of recovered.conversations) {
      const c = row.conversation;
      if (c.busy || row.jobId || c.operations.some(o => o.status === "running")) {
        changed = true;
        c.busy = false;
        delete c.taskId;
        delete row.jobId;
        c.notice = "应用重启，任务未确认完成（PROCESS_RESTARTED）；不会自动重放。";
        c.updatedAt = new Date().toISOString();
        for (const op of c.operations) if (op.status === "running") {
          op.status = "failed";
          op.result = `应用重启，执行结果未确认；已记录成功保存 ${row.operations[op.id]?.saved ?? 0} 条，不自动重试。`;
        }
      }
    }
    if (changed) this.commit(recovered.conversations);
  }
  all(): StoredConversation[] { return structuredClone(this.state.conversations); }
  get(projectId: string, id: string): StoredConversation {
    const row = this.state.conversations.find(r => r.conversation.id === id && r.conversation.projectId === projectId);
    if (!row) throw new Error("会话不存在或不属于当前项目");
    return structuredClone(row);
  }
  put(row: StoredConversation): void {
    const rows = this.all();
    const index = rows.findIndex(r => r.conversation.id === row.conversation.id);
    if (index < 0) rows.push(structuredClone(row)); else rows[index] = structuredClone(row);
    this.commit(rows);
  }
  private commit(conversations: StoredConversation[]): void {
    const next: Store = { version: 1, conversations };
    if (this.file) {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      const temp = `${this.file}.${randomUUID()}.tmp`;
      let fd: number | undefined;
      try {
        fd = openSync(temp, "wx", 0o600);
        writeFileSync(fd, JSON.stringify(next));
        fsyncSync(fd);
        closeSync(fd); fd = undefined;
        renameSync(temp, this.file);
      } catch {
        if (fd !== undefined) closeSync(fd);
        try { unlinkSync(temp); } catch { /* no temporary file */ }
        throw new Error("助手会话保存失败；未授权启动操作");
      }
    }
    this.state = structuredClone(next);
  }
}
