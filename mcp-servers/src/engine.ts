import { EngineProgressParser, type EngineProgress } from "./engineProgress.js";
export type { EngineProgress } from "./engineProgress.js";
import { spawn, execFile } from "node:child_process";

/** 调用 Python 引擎（engine/aitest/cli.py），返回其 JSON 输出中的 data。 */
export interface EngineOptions {
  python?: string;
  db?: string;
  /** 只传给引擎子进程的额外环境变量（如 AITEST_AUTH_TOKEN），不会出现在工具输出里 */
  env?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
  onProgress?: (event: EngineProgress) => void;
}

export class EngineError extends Error {}

export function engineOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): EngineOptions {
  return {
    python: env.AITEST_PYTHON || "python3",
    db: env.AITEST_DB,
    timeoutMs: env.AITEST_ENGINE_TIMEOUT_MS ? Number(env.AITEST_ENGINE_TIMEOUT_MS) : 10 * 60_000,
  };
}

export function runEngine<T = unknown>(args: string[], opts: EngineOptions = {}): Promise<T> {
  if (opts.signal?.aborted) return Promise.reject(new EngineError("请求已取消，服务端可能已处理已发送的请求"));
  const python = opts.python ?? "python3";
  const fullArgs = ["-m", "aitest", ...(opts.db ? ["--db", opts.db] : []), ...args];
  return new Promise((resolve, reject) => {
    const child = spawn(python, fullArgs, {
      env: { ...process.env, ...opts.env, ...(opts.onProgress ? { AITEST_PROGRESS: "1" } : {}), PYTHONIOENCODING: "utf-8" },
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let force: ReturnType<typeof setTimeout> | undefined;
    const killTree = (signal: NodeJS.Signals) => {
      if (!child.pid) return;
      if (process.platform === "win32") { execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], () => {}); }
      else { try { process.kill(-child.pid, signal); } catch { child.kill(signal); } }
    };
    const abort = () => { killTree("SIGTERM"); if (!force) { force = setTimeout(() => killTree("SIGKILL"), 2000); force.unref(); } };
    opts.signal?.addEventListener("abort", abort, { once: true });
    if (opts.signal?.aborted) abort();
    let out = "", lastLine = "";
    let err = "";
    const timer = setTimeout(() => {
      killTree("SIGKILL");
      reject(new EngineError(`引擎执行超时：${args[0]}`));
    }, opts.timeoutMs ?? 10 * 60_000);
    const progress = new EngineProgressParser(event => opts.onProgress?.(event));
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d: string) => {
      out += d;
      if (out.length > 32 * 1024 * 1024) { killTree("SIGKILL"); reject(new EngineError("引擎单行输出超过 32 MiB 限制")); return; }
      const lines = out.split("\n"); out = lines.pop() ?? "";
      for (const line of lines) if (line.trim()) lastLine = line;
    });
    child.stderr.on("data", (d: string) => { err = (err + d).slice(-8000); progress.feed(d); });
    child.on("error", (e) => {
      clearTimeout(timer);
      if (force) clearTimeout(force);
      opts.signal?.removeEventListener("abort", abort);
      reject(new EngineError(`无法启动 Python 引擎（${python}）：${e.message}`));
    });
    child.on("close", () => {
      clearTimeout(timer);
      if (force) clearTimeout(force);
      opts.signal?.removeEventListener("abort", abort);
      if (opts.signal?.aborted) { killTree("SIGKILL"); reject(new EngineError("请求已取消，服务端可能已处理已发送的请求")); return; }
      const line = out.trim() || lastLine.trim();
      let parsed: { ok: boolean; data?: T; error?: string };
      try {
        parsed = JSON.parse(line);
      } catch {
        const missingModule = err.match(/ModuleNotFoundError: No module named ['"]([^'"\r\n]+)['"]/);
        if (missingModule) {
          reject(new EngineError(`Python 引擎缺少模块 ${missingModule[1]}（解释器：${python}）。开发环境请在仓库根目录运行 npm run prepare:engine -w desktop，并重新启动应用；自定义 Python 请安装 engine/pyproject.toml 中的依赖。`));
          return;
        }
        reject(new EngineError(`引擎输出无法解析：${line.slice(0, 500)} ${err.slice(-500)}`));
        return;
      }
      if (parsed.ok) resolve(parsed.data as T);
      else reject(new EngineError(parsed.error ?? "未知错误"));
    });
  });
}
