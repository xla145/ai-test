/**
 * 凭据代理客户端。
 *
 * 敏感信息不进入模型上下文：工具只接收环境名，执行时向桌面客户端的本地凭据代理
 * （AITEST_BROKER_URL，仅监听 127.0.0.1，带一次性 token）换取真实凭据，
 * 再以环境变量传给引擎子进程。
 */
export interface SecretResolver {
  resolve(projectId: string, env: string): Promise<Record<string, string>>;
}

export class BrokerSecretResolver implements SecretResolver {
  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async resolve(projectId: string, env: string): Promise<Record<string, string>> {
    const res = await this.fetchImpl(`${this.url.replace(/\/$/, "")}/secrets`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.token}` },
      body: JSON.stringify({ projectId, env }),
    });
    if (!res.ok) throw new Error(`凭据代理拒绝请求：${res.status}`);
    const body = (await res.json()) as { env?: Record<string, string> };
    return body.env ?? {};
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
