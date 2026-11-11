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
  /** 页面登录、接口登录换 token 时使用；只用固定 token 的角色可以为空 */
  username: string;
  password: string;
  /** 接口测试：该角色固定的鉴权头值（如 "Bearer xxx"），优先于接口登录换取 */
  token?: string;
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

  /** 被测系统数据库密码：按「项目 + 环境 + 连接名」存放 */
  static dbRef(projectId: string, env: string, name: string): string {
    return `aitest:${projectId}:${env}:db:${name}`;
  }

  setDbPassword(projectId: string, env: string, name: string, password: string): void {
    this.set(SecretStore.dbRef(projectId, env, name), { authToken: password });
  }

  dbPasswords(projectId: string, env: string): Record<string, string> {
    const prefix = `aitest:${projectId}:${env}:db:`;
    return Object.fromEntries(Object.keys(this.data).filter((k) => k.startsWith(prefix))
      .map((k) => [k.slice(prefix.length), this.read<EnvSecret>(k)?.authToken ?? ""]));
  }

  getRole(projectId: string, role: string): RoleSecret | undefined {
    return this.read<RoleSecret>(SecretStore.roleRef(projectId, role));
  }

  /** 该项目在钥匙串中保存了凭据的角色名 */
  roleNames(projectId: string): string[] {
    const prefix = SecretStore.roleRef(projectId, "");
    return Object.keys(this.data).filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length));
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

/**
 * 运行时注入子进程的环境变量：环境 token + 角色账号（AITEST_ROLES）+ 数据库密码（AITEST_DB_PASSWORDS）。
 * 子项目先找自己的凭据，没有再用大项目（parentId）的——与环境、角色的继承规则一致。
 */
/** roles 传 ["*"] 表示该项目（含大项目）保存了凭据的全部角色，用于接口多账号 */
export const ALL_ROLES = "*";

export function secretEnvFor(store: Pick<SecretStore, "get" | "getRole"> & Partial<Pick<SecretStore, "roleNames" | "dbPasswords">>,
  projectId: string, env: string, roles: string[] = [], parentId?: string): Record<string, string> {
  const out: Record<string, string> = {};
  const secret = store.get(SecretStore.ref(projectId, env)) ?? (parentId ? store.get(SecretStore.ref(parentId, env)) : undefined);
  if (secret) {
    out.AITEST_AUTH_TOKEN = secret.authToken;
    if (secret.authHeader) out.AITEST_AUTH_HEADER = secret.authHeader;
  }
  const names = roles.includes(ALL_ROLES)
    ? [...new Set([...(store.roleNames?.(projectId) ?? []), ...(parentId ? store.roleNames?.(parentId) ?? [] : [])])]
    : roles;
  const found = names
    .map((role) => ({ role, cred: store.getRole(projectId, role) ?? (parentId ? store.getRole(parentId, role) : undefined) }))
    .filter((r) => r.cred);
  const creds = found.filter((r) => r.cred!.username)
    .map((r) => ({ role: r.role, username: r.cred!.username, password: r.cred!.password }));
  if (creds.length) out.AITEST_ROLES = JSON.stringify(creds);
  // 接口多账号：角色固定 token
  const tokens = Object.fromEntries(found.filter((r) => r.cred!.token).map((r) => [r.role, r.cred!.token!]));
  if (Object.keys(tokens).length) out.AITEST_ROLE_TOKENS = JSON.stringify(tokens);
  // 数据库密码：大项目的为基础，子项目自己设置的覆盖同名连接
  const dbPasswords = { ...(parentId ? store.dbPasswords?.(parentId, env) ?? {} : {}), ...store.dbPasswords?.(projectId, env) };
  if (Object.keys(dbPasswords).length) out.AITEST_DB_PASSWORDS = JSON.stringify(dbPasswords);
  return out;
}

export interface BrokerHandlers {
  /** 子项目所属的大项目（凭据继承） */
  parentOf?: (projectId: string) => string | undefined;
  /** 桌面端为角色准备内嵌浏览器视图，返回视图初始 URL 中的标记 */
  openView?: (projectId: string, role: string, env?: string) => Promise<string>;
}

export async function startSecretBroker(store: Pick<SecretStore, "get" | "getRole"> & Partial<Pick<SecretStore, "roleNames" | "dbPasswords">>, handlers: BrokerHandlers = {}): Promise<Broker> {
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
          ? { marker: await handlers.openView!(payload.projectId, String(payload.role), payload.env) }
          : { env: secretEnvFor(store, payload.projectId, String(payload.env), payload.roles ?? [], handlers.parentOf?.(payload.projectId)) };
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
