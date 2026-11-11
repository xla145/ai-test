/**
 * 凭据代理客户端。
 *
 * 敏感信息不进入模型上下文：工具只接收环境名，执行时向桌面客户端的本地凭据代理
 * （AITEST_BROKER_URL，仅监听 127.0.0.1，带一次性 token）换取真实凭据，
 * 再以环境变量传给引擎子进程。
 */
export interface SecretResolver {
  /** 返回注入引擎 / 执行器子进程的环境变量；roles 非空时附带 AITEST_ROLES（各角色账号） */
  resolve(projectId: string, env: string, opts?: { roles?: string[] }): Promise<Record<string, string>>;
  /** 桌面端：为角色准备内嵌浏览器视图，返回视图 URL 中的标记 */
  /** env：与内嵌试跑、单步调试共用同一个角色视图（同一份登录态） */
  openView?(projectId: string, role: string, env?: string): Promise<string>;
}

export class BrokerSecretResolver implements SecretResolver {
  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async post<T>(path: string, payload: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.url.replace(/\/$/, "")}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.token}` },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`凭据代理拒绝请求：${res.status}`);
    return (await res.json()) as T;
  }

  async resolve(projectId: string, env: string, opts: { roles?: string[] } = {}): Promise<Record<string, string>> {
    const body = await this.post<{ env?: Record<string, string> }>("/secrets", { projectId, env, roles: opts.roles });
    return body.env ?? {};
  }

  async openView(projectId: string, role: string, env?: string): Promise<string> {
    const body = await this.post<{ marker: string }>("/views", { projectId, role, env });
    return body.marker;
  }
}

export class NoSecretResolver implements SecretResolver {
  async resolve(): Promise<Record<string, string>> {
    return {};
  }
}

export function secretResolverFromEnv(env: NodeJS.ProcessEnv = process.env): SecretResolver {
  if (env.AITEST_BROKER_URL && env.AITEST_BROKER_TOKEN) {
    return new BrokerSecretResolver(env.AITEST_BROKER_URL, env.AITEST_BROKER_TOKEN);
  }
  return new NoSecretResolver();
}
