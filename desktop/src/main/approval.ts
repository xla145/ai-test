import { isAbsolute, relative, resolve } from "node:path";
import type { CommandApprovalParams, Decision, FileChangeApprovalParams } from "./codex/protocol.js";

/**
 * 审批策略（架构文档第 4 节「沙箱与审批」）：
 * - workspace 内的普通读写、执行测试：自动放行
 * - 写入 workspace 外、删除文件、访问生产环境、访问白名单外的地址：弹窗由用户审批
 */
export interface ApprovalContext {
  workspace: string;
  /** 允许访问的被测环境主机（按项目环境配置） */
  allowedHosts: string[];
  /** 生产环境主机：默认只读并强制审批 */
  productionHosts: string[];
}

export type Verdict = { decision: Decision; reason: string } | { decision: "ask"; reason: string };

const DESTRUCTIVE = /(^|[\s;&|])(rm|rmdir|del|rd|shred|mkfs|dd|git\s+(reset\s+--hard|clean|push\s+--force|push\s+-f))\b/;
const WRITE_HTTP = /\b(curl|wget|http|httpie)\b.*(-X\s*(POST|PUT|PATCH|DELETE)|--data|-d\s)/i;

export function isInside(root: string, p: string): boolean {
  const rel = relative(resolve(root), resolve(root, p));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function hostsIn(command: string): string[] {
  return [...command.matchAll(/https?:\/\/([^\s/:'"]+)/g)].map((m) => m[1].toLowerCase());
}

const matchesHost = (host: string, list: string[]) =>
  list.some((h) => host === h.toLowerCase() || host.endsWith("." + h.toLowerCase()));

export function evaluateCommand(p: CommandApprovalParams, ctx: ApprovalContext): Verdict {
  const command = Array.isArray(p.command) ? p.command.join(" ") : (p.command ?? "");
  if (p.cwd && !isInside(ctx.workspace, p.cwd)) {
    return { decision: "ask", reason: `在 workspace 外执行命令：${p.cwd}` };
  }
  if (DESTRUCTIVE.test(command)) {
    return { decision: "ask", reason: "命令包含删除或不可逆操作" };
  }
  for (const host of hostsIn(command)) {
    if (matchesHost(host, ctx.productionHosts)) {
      if (WRITE_HTTP.test(command)) return { decision: "ask", reason: `对生产环境 ${host} 发起写操作` };
      return { decision: "ask", reason: `访问生产环境 ${host}` };
    }
    if (!matchesHost(host, ctx.allowedHosts) && host !== "localhost" && host !== "127.0.0.1") {
      return { decision: "ask", reason: `访问白名单外的地址 ${host}` };
    }
  }
  return { decision: "accept", reason: "workspace 内的普通命令" };
}

export function evaluateFileChange(p: FileChangeApprovalParams, ctx: ApprovalContext): Verdict {
  if (p.grantRoot && !isInside(ctx.workspace, p.grantRoot)) {
    return { decision: "ask", reason: `申请写入 workspace 外的目录：${p.grantRoot}` };
  }
  const outside = (p.changes ?? []).filter((c) => !isInside(ctx.workspace, c.path));
  if (outside.length) {
    return { decision: "ask", reason: `写入 workspace 外的文件：${outside.map((c) => c.path).join(", ")}` };
  }
  if ((p.changes ?? []).some((c) => c.kind === "delete")) {
    return { decision: "ask", reason: "删除文件" };
  }
  if (!p.changes) {
    return { decision: "ask", reason: p.reason ?? "未提供变更明细的文件修改" };
  }
  return { decision: "accept", reason: "workspace 内的文件修改" };
}
