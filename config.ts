/**
 * 生成 Codex 配置（写入 CODEX_HOME/config.toml）。
 * - 注册客户端自带的本地 MCP Server
 * - 可选：OpenAI 兼容的模型服务（国内模型或私有化部署）
 */
export interface McpServerEntry {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface ModelProvider {
  id: string;
  name: string;
  baseUrl: string;
  /** API key 所在的环境变量名，值不写进配置文件 */
  envKey: string;
  model: string;
}

export interface CodexConfigInput {
  mcpServers: McpServerEntry[];
  model?: string;
  provider?: ModelProvider;
  /** 默认开启网络（测试需要访问被测环境），具体白名单在审批层按环境控制 */
  networkAccess?: boolean;
}

const q = (s: string) => JSON.stringify(s); // TOML basic string 与 JSON 字符串转义兼容
const key = (s: string) => (/^[A-Za-z0-9_-]+$/.test(s) ? s : q(s));

export function buildCodexConfig(input: CodexConfigInput): string {
  const lines: string[] = ["# 由 AI 测试客户端生成，请勿手工修改", ""];
  const model = input.provider?.model ?? input.model;
  if (model) lines.push(`model = ${q(model)}`);
  if (input.provider) lines.push(`model_provider = ${q(input.provider.id)}`);
  lines.push('approval_policy = "on-request"', 'sandbox_mode = "workspace-write"', "");
  lines.push("[sandbox_workspace_write]", `network_access = ${input.networkAccess ?? true}`, "");

  if (input.provider) {
    const p = input.provider;
    lines.push(`[model_providers.${key(p.id)}]`, `name = ${q(p.name)}`, `base_url = ${q(p.baseUrl)}`,
      `env_key = ${q(p.envKey)}`, 'wire_api = "chat"', "");
  }
  for (const s of input.mcpServers) {
    lines.push(`[mcp_servers.${key(s.name)}]`, `command = ${q(s.command)}`, `args = [${s.args.map(q).join(", ")}]`);
    if (s.env && Object.keys(s.env).length) {
      lines.push(`env = { ${Object.entries(s.env).map(([k, v]) => `${key(k)} = ${q(v)}`).join(", ")} }`);
    }
    lines.push("");
  }
  return lines.join("\n");
}
