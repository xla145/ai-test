import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export function isAssistantSenderUrl(actual: string, rendererFile: string, devServer?: string): boolean {
  try {
    const url = new URL(actual);
    if (devServer) {
      const expected = new URL(devServer);
      return ["http:", "https:"].includes(expected.protocol) && url.origin === expected.origin;
    }
    return url.protocol === "file:" && resolve(fileURLToPath(url)) === resolve(rendererFile);
  } catch { return false; }
}
