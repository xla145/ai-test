import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { dirname } from "node:path";

/**
 * 凭据管理（架构文档第 5、12 节）：
 * - 密钥和账号密码存系统钥匙串（Electron safeStorage 由 Keychain / Windows DPAPI / libsecret 加密），
 *   数据库只存引用（credential_ref）。
 * - 本地凭据代理只监听 127.0.0.1，并要求一次性启动 token；MCP Server 只传环境名，
 *   执行时向代理换取凭据注入引擎子进程，凭据不进入模型上下文。
 */
export interface Cipher {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

export interface EnvSecret {
  /** 鉴权头名，默认 Authorization */
  authHeader?: string;
  authToken: string;
}

/** 角色账号（多角色 UI 测试），用例里只写角色名 */
export interface RoleSecret {
  username: string;
  password: string;
}

export class SecretStore {
  private data: Record<string, string> = {};

  constructor(private readonly file: string, private readonly cipher: Cipher) {
    if (existsSync(file)) this.data = JSON.parse(readFileSync(file, "utf8"));
  }

  static ref(projectId: string, env: string): string {
    return `aitest:${projectId}:${env}`;
  }

  /** 与引擎 RoleAccount.credential_ref 一致 */
  static roleRef(projectId: string, role: string): string {
    return `aitest:${projectId}:role:${role}`;
  }

  set(ref: string, secret: EnvSecret | RoleSecret): void {
    if (!this.cipher.isEncryptionAvailable()) throw new Error("系统钥匙串不可用，拒绝明文保存凭据");
    this.data[ref] = this.cipher.encryptString(JSON.stringify(secret)).toString("base64");
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.data), { mode: 0o600 });
  }

  get(ref: string): EnvSecret | undefined {
    return this.read<EnvSecret>(ref);
  }

  getRole(projectId: string, role: string): RoleSecret | undefined {
    return this.read<RoleSecret>(SecretStore.roleRef(projectId, role));
  }

  private read<T>(ref: string): T | undefined {
    const v = this.data[ref];
    return v ? (JSON.parse(this.cipher.decryptString(Buffer.from(v, "base64"))) as T) : undefined;
  }

  /** 删除某个前缀下的全部凭据（移除项目时用） */
  deletePrefix(prefix: string): number {
    const keys = Object.keys(this.data).filter((k) => k.startsWith(prefix));
    for (const k of keys) delete this.data[k];
    if (keys.length) writeFileSync(this.file, JSON.stringify(this.data), { mode: 0o600 });
    return keys.length;
  }

  delete(ref: string): void {
    delete this.data[ref];
    writeFileSync(this.file, JSON.stringify(this.data), { mode: 0o600 });
  }
}

export interface Broker {
  url: string;
  token: string;
  close(): Promise<void>;
}

/** 运行时注入子进程的环境变量：环境 token + 角色账号（AITEST_ROLES） */
export function secretEnvFor(store: Pick<SecretStore, "get" | "getRole">, projectId: string, env: string,
  roles: string[] = []): Record<string, string> {
  const out: Record<string, string> = {};
  const secret = store.get(SecretStore.ref(projectId, env));
  if (secret) {
    out.AITEST_AUTH_TOKEN = secret.authToken;
    if (secret.authHeader) out.AITEST_AUTH_HEADER = secret.authHeader;
  }
  const creds = roles
    .map((role) => ({ role, cred: store.getRole(projectId, role) }))
    .filter((r) => r.cred)
    .map((r) => ({ role: r.role, username: r.cred!.username, password: r.cred!.password }));
  if (creds.length) out.AITEST_ROLES = JSON.stringify(creds);
  return out;
}

export interface BrokerHandlers {
  /** 桌面端为角色准备内嵌浏览器视图，返回视图初始 URL 中的标记 */
  openView?: (projectId: string, role: string) => Promise<string>;
}

export async function startSecretBroker(store: Pick<SecretStore, "get" | "getRole">, handlers: BrokerHandlers = {}): Promise<Broker> {
  const token = randomBytes(24).toString("hex");
  const expected = Buffer.from(`Bearer ${token}`);
  const server: Server = createServer((req, res) => {
    const auth = Buffer.from(req.headers.authorization ?? "");
    const authorized = auth.length === expected.length && timingSafeEqual(auth, expected);
    const route = req.url === "/secrets" || (req.url === "/views" && handlers.openView);
    if (req.method !== "POST" || !route || !authorized) {
      res.writeHead(authorized ? 404 : 401).end();
      return;
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      try {
        const payload = JSON.parse(body) as { projectId: string; env?: string; role?: string; roles?: string[] };
        const result = req.url === "/views"
          ? { marker: await handlers.openView!(payload.projectId, String(payload.role)) }
          : { env: secretEnvFor(store, payload.projectId, String(payload.env), payload.roles ?? []) };
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: (e as Error).message }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    token,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
