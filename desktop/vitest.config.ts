import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@ai-test/mcp-servers": fileURLToPath(new URL("../mcp-servers/src/lib.ts", import.meta.url)) },
  },
  test: { include: ["test/**/*.test.ts"] },
});
