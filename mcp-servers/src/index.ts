#!/usr/bin/env node
/**
 * 用法：aitest-mcp <server>
 *   server: doc-parser | case-store | case-import | api-runner | report
 * 环境变量：AITEST_PYTHON、AITEST_DB、AITEST_BROKER_URL、AITEST_BROKER_TOKEN
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { engineOptionsFromEnv } from "./engine.js";
import { secretResolverFromEnv } from "./secrets.js";
import { createServer } from "./server.js";
import { SERVERS } from "./servers.js";


async function main() {
  const name = process.argv[2];
  if (!name || name === "--list") {
    for (const s of SERVERS) console.log(`${s.name}\t${s.description}\t${s.tools.map((t) => t.name).join(", ")}`);
    process.exit(name ? 0 : 1);
  }
  const server = createServer(name, { engine: engineOptionsFromEnv(), secrets: secretResolverFromEnv() });
  await server.connect(new StdioServerTransport());
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
