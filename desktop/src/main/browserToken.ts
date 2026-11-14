const TOKEN_NAME = /^(?:(?:[a-z0-9]+[-_:])*(?:access[-_]?token|auth[-_]?token|token|authorization|satoken)|tokenkey)$/i;
const REFRESH_NAME = /refresh/i;

function unpack(raw: unknown): unknown {
  let value = raw;
  for (let i = 0; i < 5 && typeof value === "string"; i++) {
    const text = value;
    try { value = JSON.parse(text); } catch {
      if (/%(?:7b|22)/i.test(text)) {
        try { value = decodeURIComponent(text); continue; } catch { /* keep original */ }
      }
      break;
    }
  }
  return value;
}

/** 递归识别持久化缓存，只接受唯一的访问 token，不使用 refresh token。 */
export function browserToken(entries: [string, string][], key?: string, prefix = "Bearer "): string {
  const tokens: string[] = [];
  const visit = (name: string, raw: unknown, path: string, selected = false, depth = 0) => {
    if (depth > 8 || REFRESH_NAME.test(name)) return;
    const value = unpack(raw);
    const matched = selected || (key ? path === key : TOKEN_NAME.test(name));
    if (typeof value === "string" && matched && value.trim()) {
      const token = value.trim();
      tokens.push(prefix && token.toLowerCase().startsWith(prefix.toLowerCase()) ? token : prefix + token);
    } else if (value && typeof value === "object" && !Array.isArray(value)) {
      for (const [child, item] of Object.entries(value)) {
        visit(child, item, `${path}.${child}`, matched && (/^(?:value|v)$/i.test(child) || TOKEN_NAME.test(child)), depth + 1);
      }
    }
  };
  for (const [name, raw] of entries) visit(name, raw, name);
  const unique = [...new Set(tokens)];
  if (!unique.length) {
    const names = [...new Set(entries.map(([name]) => name))].slice(0, 12).join("、");
    throw new Error(`未找到 token。${names ? `当前存储键名：${names}。可填写键名或嵌套路径（如 store.auth.accessToken）。` : "当前页面没有浏览器存储或 cookie。"}请在登录后的页面打开一个业务功能再保存，以便识别请求中的鉴权头；如刚更新应用，请重新打开登录页。`);
  }
  if (unique.length > 1) throw new Error("检测到多个不同的 token，请填写准确的存储键名或嵌套路径后重试");
  if (/[\r\n]/.test(unique[0])) throw new Error("token 包含无效的请求头字符");
  return unique[0];
}

/** 只采集当前系统的业务请求，值已经是完整鉴权头，不再拼接前缀。 */
export function requestToken(url: string, origins: Set<string>, headers: Record<string, string>, header: string): string | undefined {
  if (!origins.has(new URL(url).origin)) return;
  const value = Object.entries(headers).find(([name]) => name.toLowerCase() === header.toLowerCase())?.[1]?.trim();
  if (!value || /^(?:Bearer\s+)?(?:undefined|null|false)$/i.test(value) || /[\r\n]/.test(value)) return;
  return value;
}

/** RuoYi 校验 token 绑定的客户端；不携带 clientid 会在已带 token 时仍返回 401。 */
export function browserClientHeaders(token: string, observed: Record<string, string> = {}): Record<string, string> {
  const client = Object.entries(observed).find(([name]) => name.toLowerCase() === "clientid")?.[1];
  if (client && !/[\r\n]/.test(client)) return { clientid: client };
  try {
    const payload = JSON.parse(Buffer.from(token.replace(/^Bearer\s+/i, "").split(".")[1], "base64url").toString("utf8"));
    if (typeof payload.clientid === "string" && payload.clientid && !/[\r\n]/.test(payload.clientid)) return { clientid: payload.clientid };
  } catch { /* 普通 token 不附加客户端请求头 */ }
  return {};
}
