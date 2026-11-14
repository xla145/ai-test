import { spawn } from "node:child_process";

/** 调用 Python 引擎（engine/aitest/cli.py），返回其 JSON 输出中的 data。 */
export interface EngineOptions {
  python?: string;
  db?: string;
  /** 只传给引擎子进程的额外环境变量（如 AITEST_AUTH_TOKEN），不会出现在工具输出里 */
  env?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
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
      env: { ...process.env, ...opts.env, PYTHONIOENCODING: "utf-8" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const abort = () => { child.kill("SIGTERM"); };
    opts.signal?.addEventListener("abort", abort, { once: true });
    if (opts.signal?.aborted) abort();
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new EngineError(`引擎执行超时：${args[0]}`));
    }, opts.timeoutMs ?? 10 * 60_000);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new EngineError(`无法启动 Python 引擎（${python}）：${e.message}`));
    });
    child.on("close", () => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", abort);
      if (opts.signal?.aborted) { reject(new EngineError("请求已取消，服务端可能已处理已发送的请求")); return; }
      const line = out.trim().split("\n").pop() ?? "";
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
