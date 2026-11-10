import { exec } from "node:child_process";

/**
 * 测试数据准备与时间控制（env-support，第 11 节）。
 *
 * 环境配置示例（项目 environments.<env>）：
 *   data_api:  { check: "GET /__test/data/{key}", seed: "POST /__test/data" }
 *   clock_api: { set: "POST /__test/clock" }
 * 项目级 TestData 也可提供 check_script / seed_script（在 workspace 内执行，退出码 0 表示成功）。
 * 被测环境不提供造数 / 时间偏移接口时，相关用例自动降级为手工。
 */
export interface EnvConfig {
  base_url: string;
  auth_header?: string;
  data_api?: { check?: string; seed?: string };
  clock_api?: { set?: string };
}

export interface TestDataRecord {
  key: string;
  check_script?: string;
  seed_script?: string;
}

export interface DataStatus {
  key: string;
  exists: boolean | null; // null = 无法检查
  via: "script" | "api" | "none";
  detail?: string;
}

export interface EnvSupportDeps {
  fetch?: typeof fetch;
  /** 在 workspace 内执行脚本 */
  shell?: (cmd: string, cwd: string) => Promise<{ code: number; output: string }>;
  authToken?: string;
}

const defaultShell = (cmd: string, cwd: string) =>
  new Promise<{ code: number; output: string }>((resolve) => {
    exec(cmd, { cwd, timeout: 120_000 }, (err, stdout, stderr) =>
      resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, output: (stdout + stderr).slice(-2000) }),
    );
  });

function parseEndpoint(spec: string, key?: string): { method: string; path: string } {
  const [method, path] = spec.trim().split(/\s+/, 2);
  if (!path) throw new Error(`接口配置格式应为「METHOD /path」：${spec}`);
  return { method: method.toUpperCase(), path: key ? path.replace("{key}", encodeURIComponent(key)) : path };
}

async function call(env: EnvConfig, spec: string, deps: EnvSupportDeps, key?: string, body?: unknown) {
  const { method, path } = parseEndpoint(spec, key);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (deps.authToken) headers[env.auth_header ?? "Authorization"] = deps.authToken;
  return (deps.fetch ?? fetch)(env.base_url.replace(/\/$/, "") + path, {
    method,
    headers,
    body: method === "GET" || body === undefined ? undefined : JSON.stringify(body),
  });
}

export async function checkData(env: EnvConfig, keys: string[], records: TestDataRecord[], workspace: string,
  deps: EnvSupportDeps = {}): Promise<DataStatus[]> {
  const byKey = new Map(records.map((r) => [r.key, r]));
  return Promise.all(keys.map(async (key): Promise<DataStatus> => {
    const rec = byKey.get(key);
    if (rec?.check_script) {
      const r = await (deps.shell ?? defaultShell)(rec.check_script, workspace);
      return { key, exists: r.code === 0, via: "script", detail: r.output };
    }
    if (env.data_api?.check) {
      const res = await call(env, env.data_api.check, deps, key);
      if (res.ok) return { key, exists: true, via: "api" };
      if (res.status === 404) return { key, exists: false, via: "api" };
      return { key, exists: null, via: "api", detail: `检查接口返回 ${res.status}` };
    }
    return { key, exists: null, via: "none", detail: "未配置检查方式" };
  }));
}

export async function seedData(env: EnvConfig, keys: string[], records: TestDataRecord[], workspace: string,
  deps: EnvSupportDeps = {}): Promise<{ key: string; seeded: boolean; via: string; detail?: string }[]> {
  const byKey = new Map(records.map((r) => [r.key, r]));
  const out = [];
  for (const key of keys) {
    const rec = byKey.get(key);
    if (rec?.seed_script) {
      const r = await (deps.shell ?? defaultShell)(rec.seed_script, workspace);
      out.push({ key, seeded: r.code === 0, via: "script", detail: r.output });
    } else if (env.data_api?.seed) {
      const res = await call(env, env.data_api.seed, deps, key, { key });
      out.push({ key, seeded: res.ok, via: "api", detail: res.ok ? undefined : `造数接口返回 ${res.status}` });
    } else {
      out.push({ key, seeded: false, via: "none", detail: "未配置造数方式，相关用例降级为手工" });
    }
  }
  return out;
}

/** 服务端时间偏移：不真实等待（24 小时去重、23h59m / 24h01m 边界） */
export async function setServerClock(env: EnvConfig, target: { time?: string; offset_seconds?: number },
  deps: EnvSupportDeps = {}): Promise<{ ok: boolean; detail?: string }> {
  if (!env.clock_api?.set) {
    throw new Error("被测环境未提供时间偏移接口：可改为构造带指定时间戳的上报请求，或将用例降级为手工");
  }
  const res = await call(env, env.clock_api.set, deps, undefined, target);
  return { ok: res.ok, detail: res.ok ? undefined : `时间偏移接口返回 ${res.status}` };
}
