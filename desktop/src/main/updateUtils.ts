import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import yaml from "js-yaml";

/**
 * 自动更新的纯函数部分：解析 electron-builder 生成的 latest*.yml、比较版本、选择安装包、校验 sha512、
 * 生成 macOS 替换脚本。与 Electron 无关，便于测试。
 */
export interface UpdateFile {
  url: string;
  sha512: string;
  size?: number;
}

export interface UpdateInfo {
  version: string;
  files: UpdateFile[];
  path?: string;
  sha512?: string;
  releaseDate?: string;
  releaseNotes?: string;
}

export function parseUpdateInfo(text: string): UpdateInfo {
  const raw = yaml.load(text) as Record<string, any> | undefined;
  if (!raw || typeof raw.version !== "string") throw new Error("更新信息无效：缺少 version");
  const files: UpdateFile[] = Array.isArray(raw.files)
    ? raw.files.filter((f: any) => f && typeof f.url === "string" && typeof f.sha512 === "string")
    : [];
  if (!files.length && typeof raw.path === "string" && typeof raw.sha512 === "string") files.push({ url: raw.path, sha512: raw.sha512 });
  return {
    version: raw.version, files, path: raw.path, sha512: raw.sha512,
    releaseDate: raw.releaseDate ? String(raw.releaseDate) : undefined,
    releaseNotes: typeof raw.releaseNotes === "string" ? raw.releaseNotes : undefined,
  };
}

/** a 是否比 b 新（主.次.修订，忽略预发布后缀之外的差异；预发布版本低于同号正式版） */
export function isNewer(a: string, b: string): boolean {
  const parse = (v: string) => {
    const [main, pre] = v.trim().replace(/^v/, "").split("-", 2);
    return { nums: main.split(".").map((x) => Number.parseInt(x, 10) || 0), pre: pre ?? "" };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d) return d > 0;
  }
  if (x.pre === y.pre) return false;
  if (!x.pre) return true;
  if (!y.pre) return false;
  return x.pre > y.pre;
}

/** macOS：选当前架构的 zip（artifactName 为 AIProbe-<版本>-mac-<arch>.zip），找不到再取任一 zip */
export function pickMacZip(info: UpdateInfo, arch: string): UpdateFile | undefined {
  const zips = info.files.filter((f) => f.url.endsWith(".zip"));
  const archName = arch === "x64" ? "x64" : arch;
  return zips.find((f) => f.url.includes(`-${archName}.zip`)) ?? (zips.length === 1 ? zips[0] : undefined);
}

/** electron-builder 的 sha512 为 base64 */
export function sha512Base64(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash("sha512");
    createReadStream(file).on("data", (d) => h.update(d)).on("error", reject).on("end", () => resolve(h.digest("base64")));
  });
}

/** 由 Contents/MacOS/<可执行文件> 推出 .app 路径 */
export function appBundleOf(execPath: string): string | undefined {
  const m = /^(.*?\.app)\/Contents\/MacOS\//.exec(execPath);
  return m?.[1];
}

/**
 * macOS 替换脚本：等当前进程退出 → 旧应用改名备份 → 新应用移到原位置 → 失败则还原 → 去掉隔离属性 → 重新打开。
 * 没有开发者证书时无法使用 Squirrel.Mac，由客户端自己完成替换。
 */
export function macInstallScript(): string {
  return [
    "#!/bin/bash",
    'PID="$1"; APP="$2"; NEW="$3"; LOG="$4"',
    'exec >>"$LOG" 2>&1',
    'echo "$(date) 开始更新：$NEW → $APP"',
    'for _ in $(seq 1 120); do kill -0 "$PID" 2>/dev/null || break; sleep 0.5; done',
    'BACKUP="$APP.old-$$"',
    'if mv "$APP" "$BACKUP" && mv "$NEW" "$APP"; then',
    '  rm -rf "$BACKUP"',
    '  echo "更新完成"',
    "else",
    '  echo "替换失败，还原旧版本"',
    '  [ -d "$BACKUP" ] && [ ! -d "$APP" ] && mv "$BACKUP" "$APP"',
    "fi",
    'xattr -dr com.apple.quarantine "$APP" 2>/dev/null',
    'open "$APP"',
    "",
  ].join("\n");
}
