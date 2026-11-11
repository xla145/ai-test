import { isAbsolute, relative, resolve } from "node:path";
import type { CommandApprovalParams, Decision, FileChangeApprovalParams, McpElicitationParams } from "./codex/protocol.js";

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
/** 下载安装软件或依赖（浏览器、npm / pip 包等）需要用户确认 */
const INSTALL = /(^|[\s;&|/])((npx\s+)?playwright\s+install|npm\s+(i|install|ci|add)\b|pnpm\s+(i|install|add)\b|yarn\s+(add|install)\b|pip3?\s+install|python3?\s+-m\s+pip\s+install|brew\s+install|apt(-get)?\s+install)/;
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
  if (INSTALL.test(command)) {
    return { decision: "ask", reason: "下载安装软件或依赖" };
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

/**
 * MCP 工具调用审批：客户端自带的 MCP Server（用例库、浏览器、报告等）是内部能力，
 * 危险操作已由各自的工具与编排层把关（生产环境确认、只读 SQL 等），自动放行；
 * 第三方 Server（如 Pinky）或需要填写内容 / 打开链接的请求交给用户。
 */
export function evaluateMcpElicitation(p: McpElicitationParams, ownServers: ReadonlySet<string>): Verdict {
  const schema = p.requestedSchema as { required?: string[] } | undefined;
  if (p.mode === "url") return { decision: "ask", reason: `MCP 服务 ${p.serverName} 请求打开链接：${p.url ?? ""}` };
  if (schema?.required?.length) return { decision: "decline", reason: `MCP 服务 ${p.serverName} 需要填写内容，客户端暂不支持` };
  if (ownServers.has(p.serverName)) return { decision: "accept", reason: "客户端自带的 MCP 工具" };
  return { decision: "ask", reason: `第三方 MCP 服务 ${p.serverName} 请求执行：${p.message ?? ""}` };
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
