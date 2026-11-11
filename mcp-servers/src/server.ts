import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { runEngine, type EngineOptions } from "./engine.js";
import type { SecretResolver } from "./secrets.js";
import { engineEnvFor, SERVERS, getServer } from "./servers.js";
import { BrowserSession } from "./ui/browser.js";
import type { VisionAgentFactory } from "./ui/midscene.js";
import { UI_SERVERS, type UiToolContext } from "./ui/tools.js";
import { APP_SERVER, appTools } from "./app/tools.js";

export interface CreateOptions {
  engine: EngineOptions;
  secrets: SecretResolver;
  /** 测试注入点 */
  run?: typeof runEngine;
  /** UI 服务：内嵌浏览器的 CDP 地址（桌面端）；不给则自行启动 Chromium */
  cdpEndpoint?: string;
  session?: BrowserSession;
  vision?: VisionAgentFactory;
  headless?: boolean;
  /** app 服务：maestro 可执行文件 */
  maestroBin?: string;
}

export const ALL_SERVER_NAMES = [...SERVERS.map((s) => s.name), ...UI_SERVERS.map((s) => s.name), APP_SERVER.name];

const text = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data ?? null, null, 2) }] });
const failure = (e: unknown) => ({ isError: true, content: [{ type: "text" as const, text: (e as Error).message }] });

export function createServer(name: string, opts: CreateOptions): McpServer {
  const run = opts.run ?? runEngine;
  const ui = UI_SERVERS.find((s) => s.name === name);
  const server = new McpServer({ name: `aitest-${name}`, version: "0.2.0" });

  if (name === APP_SERVER.name) {
    const ctx = {
      engine: ((args: string[], env?: Record<string, string>) => run(args, { ...opts.engine, env: { ...opts.engine.env, ...env } })) as UiToolContext["engine"],
      secrets: opts.secrets,
      maestroBin: opts.maestroBin,
    };
    for (const tool of appTools(ctx)) {
      server.registerTool(tool.name, { description: tool.description, inputSchema: tool.input }, async (input: Record<string, unknown>) => {
        try {
          return text(await tool.handler(input));
        } catch (e) {
          return failure(e);
        }
      });
    }
    return server;
  }

  if (ui) {
    const ctx: UiToolContext = {
      engine: (args, env) => run(args, { ...opts.engine, env: { ...opts.engine.env, ...env } }),
      secrets: opts.secrets,
      session: opts.session ?? new BrowserSession({ cdpEndpoint: opts.cdpEndpoint, headless: opts.headless }),
      vision: opts.vision,
      cdpEndpoint: opts.cdpEndpoint,
    };
    for (const tool of ui.tools(ctx)) {
      server.registerTool(tool.name, { description: tool.description, inputSchema: tool.input }, async (input: Record<string, unknown>) => {
        try {
          return text(await tool.handler(input));
        } catch (e) {
          return failure(e);
        }
      });
    }
    server.server.onclose = () => void ctx.session.close();
    return server;
  }

  const def = getServer(name);
  for (const tool of def.tools) {
    server.registerTool(tool.name, { description: tool.description, inputSchema: tool.input }, async (input: Record<string, unknown>) => {
      try {
        const secretEnv = await engineEnvFor(tool, input, opts.secrets);
        const args = await tool.toArgs(input);
        return text(await run(args, { ...opts.engine, env: { ...opts.engine.env, ...secretEnv } }));
      } catch (e) {
        return failure(e);
      }
    });
  }
  return server;
}
