#!/usr/bin/env node
/**
 * 用法：aitest-mcp <server>
 *   server: doc-parser | case-store | case-import | api-runner | report | browser | env-support | app
 * 环境变量：AITEST_PYTHON、AITEST_DB、AITEST_BROKER_URL、AITEST_BROKER_TOKEN、
 *          AITEST_CDP_ENDPOINT（连接内嵌浏览器）、AITEST_MIDSCENE=1（启用视觉工具）、AITEST_MAESTRO（maestro 路径）
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { engineOptionsFromEnv } from "./engine.js";
import { secretResolverFromEnv } from "./secrets.js";
import { ALL_SERVER_NAMES, createServer } from "./server.js";
import { SERVERS } from "./servers.js";
import { midsceneFactory } from "./ui/midscene.js";
import { UI_SERVERS } from "./ui/tools.js";

async function main() {
  const name = process.argv[2];
  if (!name || name === "--list" || !ALL_SERVER_NAMES.includes(name)) {
    for (const s of SERVERS) console.log(`${s.name}\t${s.description}\t${s.tools.map((t) => t.name).join(", ")}`);
    for (const s of UI_SERVERS) console.log(`${s.name}\t${s.description}`);
    process.exit(name === "--list" ? 0 : 1);
  }
  const server = createServer(name, {
    engine: engineOptionsFromEnv(),
    secrets: secretResolverFromEnv(),
    cdpEndpoint: process.env.AITEST_CDP_ENDPOINT || undefined,
    vision: process.env.AITEST_MIDSCENE ? midsceneFactory() : undefined,
    headless: !process.env.AITEST_HEADED,
    maestroBin: process.env.AITEST_MAESTRO || undefined,
  });
  await server.connect(new StdioServerTransport());
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
