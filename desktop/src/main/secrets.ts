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

export class SecretStore {
  private data: Record<string, string> = {};

  constructor(private readonly file: string, private readonly cipher: Cipher) {
    if (existsSync(file)) this.data = JSON.parse(readFileSync(file, "utf8"));
  }

  static ref(projectId: string, env: string): string {
    return `aitest:${projectId}:${env}`;
  }

  set(ref: string, secret: EnvSecret): void {
    if (!this.cipher.isEncryptionAvailable()) throw new Error("系统钥匙串不可用，拒绝明文保存凭据");
    this.data[ref] = this.cipher.encryptString(JSON.stringify(secret)).toString("base64");
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.data), { mode: 0o600 });
  }

  get(ref: string): EnvSecret | undefined {
    const v = this.data[ref];
    return v ? (JSON.parse(this.cipher.decryptString(Buffer.from(v, "base64"))) as EnvSecret) : undefined;
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

export async function startSecretBroker(store: Pick<SecretStore, "get">): Promise<Broker> {
  const token = randomBytes(24).toString("hex");
  const expected = Buffer.from(`Bearer ${token}`);
  const server: Server = createServer((req, res) => {
    const auth = Buffer.from(req.headers.authorization ?? "");
    const authorized = auth.length === expected.length && timingSafeEqual(auth, expected);
    if (req.method !== "POST" || req.url !== "/secrets" || !authorized) {
      res.writeHead(authorized ? 404 : 401).end();
      return;
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const { projectId, env } = JSON.parse(body) as { projectId: string; env: string };
        const secret = store.get(SecretStore.ref(projectId, env));
        const out: Record<string, string> = {};
        if (secret) {
          out.AITEST_AUTH_TOKEN = secret.authToken;
          if (secret.authHeader) out.AITEST_AUTH_HEADER = secret.authHeader;
        }
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ env: out }));
      } catch {
        res.writeHead(400).end();
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
