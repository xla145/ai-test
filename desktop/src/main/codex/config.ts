/**
 * 生成 Codex 配置（写入 CODEX_HOME/config.toml）：
 * - 注册客户端自带的本地 MCP Server
 * - 可选：OpenAI 兼容的模型服务（国内模型或私有化部署）
 */
export interface McpServerEntry {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  envVars?: string[];
}

export const BUILTIN_MCP_SERVERS = ["doc-parser", "case-store", "case-import", "api-runner", "report", "browser", "env-support", "app", "pinky"] as const;

/** 计划转换只做文本到 JSON，不加载 MCP 的工具定义和连接。 */
export function uiContractThreadConfig(): Record<string, unknown> {
  // 可选服务（如 Pinky）可能未注册；Codex 即使遇到 enabled=false 也要求有效的 transport。
  // 覆盖只作用于转换线程，禁用的服务不会启动进程。
  return Object.fromEntries(BUILTIN_MCP_SERVERS.flatMap(name => [
    [`mcp_servers.${name}.enabled`, false],
    [`mcp_servers.${name}.command`, process.execPath],
    [`mcp_servers.${name}.args`, []],
  ]));
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
  /** 测试需要访问被测环境；具体放行哪些环境由审批层按白名单控制 */
  networkAccess?: boolean;
}

const q = (s: string) => JSON.stringify(s); // TOML basic string 与 JSON 字符串转义兼容
const key = (s: string) => (/^[A-Za-z0-9_-]+$/.test(s) ? s : q(s));

export function buildCodexConfig(input: CodexConfigInput): string {
  const lines: string[] = ["# 由 AIProbe 生成，请勿手工修改", ""];
  const model = input.provider?.model ?? input.model;
  if (model) lines.push(`model = ${q(model)}`);
  if (input.provider) lines.push(`model_provider = ${q(input.provider.id)}`);
  // 按实际模型上下文比例压缩，不给不同供应商硬编码统一的上下文长度。
  // 轮内压缩仍使用 Codex 的模型默认阈值；这里额外允许轮结束后提前压缩。
  lines.push('model_post_turn_compact_threshold_percent = 80');
  lines.push('approval_policy = "on-request"', 'sandbox_mode = "workspace-write"', "");
  lines.push("[features]", "memories = true", "");
  lines.push("[memories]", "generate_memories = true", "use_memories = true");
  // 兼容自定义供应商：后台记忆任务也用已配置的 agent 模型，避免请求默认 OpenAI 模型。
  if (model) lines.push(`extract_model = ${q(model)}`, `consolidation_model = ${q(model)}`);
  lines.push("");
  lines.push("[sandbox_workspace_write]", `network_access = ${input.networkAccess ?? true}`, "");

  if (input.provider) {
    const p = input.provider;
    lines.push(
      `[model_providers.${key(p.id)}]`,
      `name = ${q(p.name)}`,
      `base_url = ${q(p.baseUrl)}`,
      `env_key = ${q(p.envKey)}`,
      'wire_api = "responses"',
      "",
    );
  }
  for (const s of input.mcpServers) {
    lines.push(`[mcp_servers.${key(s.name)}]`, `command = ${q(s.command)}`, `args = [${s.args.map(q).join(", ")}]`);
    if (s.envVars?.length) lines.push(`env_vars = [${s.envVars.map(q).join(", ")}]`);
    if (s.env && Object.keys(s.env).length) {
      lines.push(`env = { ${Object.entries(s.env).map(([k, v]) => `${key(k)} = ${q(v)}`).join(", ")} }`);
    }
    lines.push("");
  }
  return lines.join("\n");
}
