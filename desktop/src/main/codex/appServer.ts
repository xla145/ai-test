import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import type { Readable, Writable } from "node:stream";
import { JsonRpcPeer } from "./jsonrpc.js";
import {
  CLIENT_INFO,
  Methods,
  Notifications,
  ServerRequests,
  threadIdOf,
  totalTokensOf,
  turnIdOf,
  type CommandApprovalParams,
  type Decision,
  type FileChangeApprovalParams,
  type ThreadStartParams,
} from "./protocol.js";

/**
 * Codex App Server 客户端：以子进程启动平台对应的 codex 二进制（锁定版本），
 * 通过 stdio 双向 JSON-RPC 通信。一个测试任务 = 一个 thread。
 */
export interface ApprovalHandler {
  command(p: CommandApprovalParams): Promise<Decision>;
  fileChange(p: FileChangeApprovalParams): Promise<Decision>;
}

export interface AppServerOptions {
  binary: string;
  /** CODEX_HOME：放置客户端生成的 config.toml（MCP Server 注册、模型配置） */
  codexHome: string;
  env?: Record<string, string>;
  approvals: ApprovalHandler;
  requestTimeoutMs?: number;
}

export interface TurnResult {
  threadId: string;
  turnId: string;
  status: string;
  message: string;
  tokens: number;
}

export interface Transport {
  stdin: Writable;
  stdout: Readable;
  kill(): void;
}

export class CodexAppServer extends EventEmitter {
  private peer?: JsonRpcPeer;
  private transport?: Transport;
  private readonly tokens = new Map<string, number>();
  private readonly messages = new Map<string, string>();
  private readonly turnWaiters = new Map<string, (status: string) => void>();
  /** turn/completed 可能先于 turn/start 的返回被处理，先暂存 */
  private readonly completedTurns = new Map<string, string>();

  constructor(private readonly opts: AppServerOptions) {
    super();
  }

  /** 默认以子进程启动；测试时可注入 transport */
  async start(transport?: Transport): Promise<void> {
    if (!transport) {
      const child: ChildProcess = spawn(this.opts.binary, ["app-server"], {
        env: { ...process.env, ...this.opts.env, CODEX_HOME: this.opts.codexHome },
        stdio: ["pipe", "pipe", "pipe"],
      });
      child.stderr?.on("data", (d) => this.emit("log", String(d)));
      child.on("exit", (code) => this.emit("exit", code));
      transport = { stdin: child.stdin!, stdout: child.stdout!, kill: () => child.kill() };
    }
    this.transport = transport;
    this.peer = new JsonRpcPeer(transport.stdout, transport.stdin, { timeoutMs: this.opts.requestTimeoutMs ?? 60_000 });
    this.peer.on("notification", (method: string, params: unknown) => this.onNotification(method, params));
    this.peer.onRequest((method, params) => this.onServerRequest(method, params));
    await this.peer.request(Methods.initialize, { clientInfo: CLIENT_INFO });
    this.peer.notify(Methods.initialized);
  }

  stop(): void {
    this.transport?.kill();
  }

  async startThread(params: ThreadStartParams): Promise<string> {
    const res = await this.rpc().request(Methods.threadStart, params);
    const id = threadIdOf(res);
    this.tokens.set(id, 0);
    return id;
  }

  /** 发送一轮输入并等待完成；tokenLimit 为单次任务上限，超出则中断 */
  async runTurn(threadId: string, text: string, opts: { tokenLimit?: number } = {}): Promise<TurnResult> {
    const startTokens = this.tokens.get(threadId) ?? 0;
    this.messages.set(threadId, "");
    const res = await this.rpc().request(Methods.turnStart, { threadId, input: [{ type: "text", text }] }, 0);
    const turnId = turnIdOf(res);
    const done = new Promise<string>((resolve) => {
      const early = this.completedTurns.get(turnId);
      if (early !== undefined) {
        this.completedTurns.delete(turnId);
        resolve(early);
      } else {
        this.turnWaiters.set(turnId, resolve);
      }
    });

    let interrupted = false;
    const onUsage = (tid: string, total: number) => {
      if (tid === threadId && opts.tokenLimit && !interrupted && total - startTokens > opts.tokenLimit) {
        interrupted = true;
        this.emit("budgetExceeded", { threadId, turnId, used: total - startTokens, limit: opts.tokenLimit });
        void this.rpc().request(Methods.turnInterrupt, { threadId, turnId }).catch(() => undefined);
      }
    };
    this.on("tokens", onUsage);
    try {
      const status = await done;
      return {
        threadId,
        turnId,
        status: interrupted ? "interrupted_budget" : status,
        message: this.messages.get(threadId) ?? "",
        tokens: (this.tokens.get(threadId) ?? 0) - startTokens,
      };
    } finally {
      this.off("tokens", onUsage);
    }
  }

  threadTokens(threadId: string): number {
    return this.tokens.get(threadId) ?? 0;
  }

  private rpc(): JsonRpcPeer {
    if (!this.peer) throw new Error("Codex App Server 尚未启动");
    return this.peer;
  }

  private onNotification(method: string, params: unknown): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p = (params ?? {}) as any;
    switch (method) {
      case Notifications.agentMessageDelta: {
        const tid = p.threadId as string | undefined;
        if (tid) this.messages.set(tid, (this.messages.get(tid) ?? "") + (p.delta ?? ""));
        break;
      }
      case Notifications.itemCompleted: {
        const item = p.item ?? {};
        if (item.type === "agentMessage" && p.threadId && typeof item.text === "string") {
          this.messages.set(p.threadId, item.text);
        }
        break;
      }
      case Notifications.tokenUsageUpdated: {
        if (p.threadId) {
          const total = totalTokensOf(p);
          this.tokens.set(p.threadId, total);
          this.emit("tokens", p.threadId, total);
        }
        break;
      }
      case Notifications.turnCompleted: {
        const turnId = p.turn?.id ?? p.turnId;
        const status = p.turn?.status ?? p.status ?? "completed";
        const waiter = turnId && this.turnWaiters.get(turnId);
        if (waiter) {
          this.turnWaiters.delete(turnId);
          waiter(status);
        } else if (turnId) {
          this.completedTurns.set(turnId, status);
        }
        break;
      }
    }
    this.emit("event", { method, params });
  }

  private async onServerRequest(method: string, params: unknown): Promise<unknown> {
    if (method === ServerRequests.commandApproval) {
      return { decision: await this.opts.approvals.command(params as CommandApprovalParams) };
    }
    if (method === ServerRequests.fileChangeApproval) {
      return { decision: await this.opts.approvals.fileChange(params as FileChangeApprovalParams) };
    }
    throw Object.assign(new Error(`不支持的服务端请求：${method}`), { code: -32601 });
  }
}
