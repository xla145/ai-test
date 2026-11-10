/**
 * Codex App Server 协议适配层。
 *
 * 协议仍属实验性（架构文档第 15 节）：所有方法名与载荷形状集中在这里，
 * 升级 codex 二进制时只需改本文件；必要时可整体替换为 Codex SDK 实现。
 */
export const CLIENT_INFO = { name: "aitest_desktop", title: "AI 测试客户端", version: "0.1.0" };

export const Methods = {
  initialize: "initialize",
  initialized: "initialized",
  threadStart: "thread/start",
  threadResume: "thread/resume",
  turnStart: "turn/start",
  turnInterrupt: "turn/interrupt",
} as const;

export const Notifications = {
  threadStarted: "thread/started",
  turnStarted: "turn/started",
  turnCompleted: "turn/completed",
  itemStarted: "item/started",
  itemCompleted: "item/completed",
  agentMessageDelta: "item/agentMessage/delta",
  tokenUsageUpdated: "thread/tokenUsage/updated",
} as const;

/** 服务端发给客户端、需要客户端回复决定的审批请求 */
export const ServerRequests = {
  commandApproval: "item/commandExecution/requestApproval",
  fileChangeApproval: "item/fileChange/requestApproval",
} as const;

export type Decision = "accept" | "decline";

export interface ThreadStartParams {
  cwd: string;
  model?: string;
  approvalPolicy?: "untrusted" | "on-request" | "on-failure" | "never";
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  baseInstructions?: string;
}

export interface CommandApprovalParams {
  threadId: string;
  turnId: string;
  itemId: string;
  command?: string | string[];
  cwd?: string;
  reason?: string;
}

export interface FileChangeApprovalParams {
  threadId: string;
  turnId: string;
  itemId: string;
  reason?: string;
  /** 部分版本会附带变更文件列表 */
  changes?: { path: string; kind?: string }[];
  grantRoot?: string;
}

export function threadIdOf(result: unknown): string {
  const r = result as { thread?: { id?: string }; threadId?: string };
  const id = r?.thread?.id ?? r?.threadId;
  if (!id) throw new Error("thread/start 返回中缺少 thread id");
  return id;
}

export function turnIdOf(result: unknown): string {
  const r = result as { turn?: { id?: string }; turnId?: string };
  const id = r?.turn?.id ?? r?.turnId;
  if (!id) throw new Error("turn/start 返回中缺少 turn id");
  return id;
}

/** 从 tokenUsage 通知中取本次累计 token 数（兼容不同字段名） */
export function totalTokensOf(params: unknown): number {
  const p = params as Record<string, any>;
  const usage = p?.tokenUsage ?? p?.usage ?? p;
  const total = usage?.total ?? usage;
  return Number(total?.totalTokens ?? total?.total_tokens ?? (total?.inputTokens ?? 0) + (total?.outputTokens ?? 0)) || 0;
}
