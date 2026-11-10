import { EventEmitter } from "node:events";
import type { Readable, Writable } from "node:stream";

/**
 * 换行分隔的双向 JSON-RPC（Codex App Server 的 stdio 传输）。
 * 双方都可以发请求：客户端调 thread / turn 方法，服务端发审批请求。
 */
export type Id = number | string;

export interface RpcError {
  code: number;
  message: string;
  data?: unknown;
}

interface Message {
  jsonrpc?: "2.0";
  id?: Id;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: RpcError;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer?: NodeJS.Timeout;
}

export type RequestHandler = (method: string, params: unknown) => Promise<unknown>;

export class RpcRemoteError extends Error {
  constructor(public readonly error: RpcError) {
    super(error.message);
  }
}

export class JsonRpcPeer extends EventEmitter {
  private nextId = 1;
  private buffer = "";
  private pending = new Map<Id, Pending>();
  private requestHandler: RequestHandler = async (method) => {
    throw Object.assign(new Error(`未处理的请求：${method}`), { code: -32601 });
  };

  constructor(
    input: Readable,
    private readonly output: Writable,
    private readonly opts: { timeoutMs?: number; includeJsonrpcField?: boolean } = {},
  ) {
    super();
    input.setEncoding("utf8");
    input.on("data", (chunk: string) => this.onData(chunk));
    input.on("close", () => this.failAll(new Error("连接已关闭")));
  }

  onRequest(handler: RequestHandler): void {
    this.requestHandler = handler;
  }

  request<T = unknown>(method: string, params?: unknown, timeoutMs = this.opts.timeoutMs): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const entry: Pending = { resolve: resolve as (v: unknown) => void, reject };
      if (timeoutMs) {
        entry.timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`请求超时：${method}`));
        }, timeoutMs);
      }
      this.pending.set(id, entry);
      this.send({ id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    this.send({ method, params });
  }

  private send(msg: Message): void {
    const payload: Message = this.opts.includeJsonrpcField ? { jsonrpc: "2.0", ...msg } : { ...msg };
    if (payload.params === undefined) delete payload.params;
    this.output.write(JSON.stringify(payload) + "\n");
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg: Message;
      try {
        msg = JSON.parse(line);
      } catch {
        this.emit("parseError", line);
        continue;
      }
      void this.dispatch(msg);
    }
  }

  private async dispatch(msg: Message): Promise<void> {
    if (msg.method !== undefined && msg.id !== undefined) {
      try {
        const result = await this.requestHandler(msg.method, msg.params);
        this.send({ id: msg.id, result: result ?? {} });
      } catch (e) {
        const err = e as Error & { code?: number };
        this.send({ id: msg.id, error: { code: err.code ?? -32000, message: err.message } });
      }
      return;
    }
    if (msg.method !== undefined) {
      this.emit("notification", msg.method, msg.params);
      return;
    }
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (p.timer) clearTimeout(p.timer);
      if (msg.error) p.reject(new RpcRemoteError(msg.error));
      else p.resolve(msg.result);
    }
  }

  private failAll(err: Error): void {
    for (const p of this.pending.values()) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
    this.emit("close");
  }
}
