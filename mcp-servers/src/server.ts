import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { runEngine, type EngineOptions } from "./engine.js";
import type { SecretResolver } from "./secrets.js";
import { engineEnvFor, getServer } from "./servers.js";

export interface CreateOptions {
  engine: EngineOptions;
  secrets: SecretResolver;
  /** 测试注入点 */
  run?: typeof runEngine;
}

export function createServer(name: string, opts: CreateOptions): McpServer {
  const def = getServer(name);
  const server = new McpServer({ name: `aitest-${def.name}`, version: "0.1.0" });
  const run = opts.run ?? runEngine;
  for (const tool of def.tools) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.input },
      async (input: Record<string, unknown>) => {
        try {
          const secretEnv = await engineEnvFor(tool, input, opts.secrets);
          const data = await run(tool.toArgs(input), { ...opts.engine, env: { ...opts.engine.env, ...secretEnv } });
          return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
        } catch (e) {
          return { isError: true, content: [{ type: "text" as const, text: (e as Error).message }] };
        }
      },
    );
  }
  return server;
}
