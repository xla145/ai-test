import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { EXECUTORS, type ExecutorId } from "../shared/executors.js";
import type { RuntimeCheck } from "../shared/ipc.js";
import { k6Executable } from "./performance.js";
const require = createRequire(import.meta.url);
export interface ExecutorRuntime { python: string; codex: string; maestro: string; pinky: string; pinkyEnabled: boolean; pythonEnv: Record<string, string> }
export function checkCommand(command: string, args: string[], env?: Record<string, string>): Promise<RuntimeCheck> {
  return new Promise(resolve => {
    execFile(command, args, { timeout: 15000, windowsHide: true, maxBuffer: 64 * 1024, env: { ...process.env, ...env } }, (error, out, stderr) => {
      resolve(error ? { ok: false, detail: (error as NodeJS.ErrnoException).code === "ENOENT" ? "未找到可执行文件" : "检测失败或超时，请检查安装与配置" }
        : { ok: true, detail: (out || stderr).trim().split(/\r?\n/)[0].slice(0, 200) || "可用" });
    });
  });
}
export async function checkExecutors(runtime: ExecutorRuntime, command = checkCommand,
  packageCheck: (id: "playwright" | "midscene") => RuntimeCheck = id => {
    try {
      if (id === "midscene") { require.resolve("@midscene/web"); return { ok: true, detail: "组件已安装；使用前仍需配置视觉模型" }; }
      const { chromium } = require("playwright-core");
      return existsSync(chromium.executablePath()) ? { ok: true, detail: "Chromium 可用" } : { ok: false, detail: "缺少无头 Chromium；内嵌 Electron 浏览器不受此检查影响" };
    } catch { return { ok: false, detail: "未找到运行组件" }; }
  }): Promise<Record<ExecutorId, RuntimeCheck>> {
  const checks = await Promise.all(EXECUTORS.map(async definition => {
    const id = definition.id;
    if (id === "playwright" || id === "midscene") return [id, packageCheck(id)] as const;
    if (id === "pytest") return [id, await command(runtime.python, ["-m", "pytest", "--version"], runtime.pythonEnv)] as const;
    if (id === "pinky" && !runtime.pinkyEnabled) return [id, { ok: false, detail: "未启用 Pinky" }] as const;
    return [id, await command(id === "k6" ? k6Executable() : runtime[id], ["--version"])] as const;
  }));
  return Object.fromEntries(checks) as Record<ExecutorId, RuntimeCheck>;
}
