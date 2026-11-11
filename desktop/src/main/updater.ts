import { execFile, spawn } from "node:child_process";
import { accessSync, constants, createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { UpdateState } from "../shared/ipc.js";
import { appBundleOf, isNewer, macInstallScript, parseUpdateInfo, pickMacZip, sha512Base64 } from "./updateUtils.js";

/**
 * 自动更新：发布流水线把安装包与 latest*.yml 上传到下载站（R2 + 自定义域名），客户端定期检查。
 * - Windows（NSIS）/ Linux（AppImage）：electron-updater，后台下载（Windows 只下载变化的块），重启时安装。
 * - macOS：没有开发者证书时 Squirrel.Mac 无法使用，由客户端自己下载 zip、校验 sha512、解压，
 *   重启时用脚本替换 .app 并重新打开。
 */
export interface UpdaterOptions {
  currentVersion: string;
  /** 更新地址（latest*.yml 所在目录）；没有则不启用 */
  feedUrl?: string;
  /** 不启用的原因（开发模式、非 AppImage 等） */
  disabledReason?: string;
  platform: NodeJS.Platform;
  arch: string;
  execPath: string;
  /** macOS：下载与解压目录 */
  downloadDir: string;
  quit: () => void;
  fetchImpl?: typeof fetch;
  /** macOS 解压 zip（默认 ditto，保留签名与符号链接） */
  extract?: (zip: string, dest: string) => Promise<void>;
  /** macOS 启动替换脚本（默认 bash 后台运行） */
  launchInstaller?: (script: string, args: string[]) => void;
  /** Windows / Linux：electron-updater 的 autoUpdater（测试时可注入） */
  loadAutoUpdater?: () => Promise<AutoUpdaterLike>;
}

/** electron-updater 中用到的部分 */
export interface AutoUpdaterLike extends EventEmitter {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  logger: unknown;
  setFeedURL(options: { provider: "generic"; url: string }): void;
  checkForUpdates(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

const ditto = (zip: string, dest: string) => new Promise<void>((resolve, reject) =>
  execFile("/usr/bin/ditto", ["-x", "-k", zip, dest], (err) => (err ? reject(err) : resolve())));

export class Updater extends EventEmitter {
  private state: UpdateState;
  private auto?: AutoUpdaterLike;
  private macApp?: string;

  constructor(private readonly opts: UpdaterOptions) {
    super();
    const reason = opts.disabledReason ?? (opts.feedUrl ? undefined : "安装包中没有配置更新地址");
    this.state = reason
      ? { status: "disabled", current: opts.currentVersion, reason }
      : { status: "idle", current: opts.currentVersion, feedUrl: opts.feedUrl };
  }

  get current(): UpdateState {
    return this.state;
  }

  private set(next: Partial<UpdateState>) {
    this.state = { ...this.state, ...next };
    this.emit("state", this.state);
  }

  /** 检查更新；有新版本时自动在后台下载 */
  async check(): Promise<UpdateState> {
    if (this.state.status === "disabled" || ["checking", "downloading"].includes(this.state.status)) return this.state;
    if (this.state.status === "downloaded") return this.state;
    this.set({ status: "checking", error: undefined });
    try {
      if (this.opts.platform === "darwin") await this.checkMac();
      else await this.checkAuto();
    } catch (e) {
      this.set({ status: "error", error: (e as Error).message, checkedAt: new Date().toISOString() });
    }
    return this.state;
  }

  /** 重启并安装已下载的更新 */
  install(): void {
    if (this.state.status !== "downloaded") throw new Error("还没有下载好的更新");
    if (this.opts.platform === "darwin") return this.installMac();
    this.auto!.quitAndInstall(true, true);
  }

  // ---------------------------------------------------------------- Windows / Linux

  private async checkAuto() {
    if (!this.auto) {
      const au = await (this.opts.loadAutoUpdater ?? loadElectronUpdater)();
      au.logger = null;
      au.autoDownload = true;
      au.autoInstallOnAppQuit = true;
      au.setFeedURL({ provider: "generic", url: this.opts.feedUrl! });
      au.on("update-available", (info: { version: string }) => this.set({ status: "downloading", version: info.version, progress: 0 }));
      au.on("update-not-available", () => this.set({ status: "not-available", checkedAt: new Date().toISOString() }));
      au.on("download-progress", (p: { percent: number }) => this.set({ status: "downloading", progress: Math.round(p.percent) }));
      au.on("update-downloaded", (info: { version: string }) =>
        this.set({ status: "downloaded", version: info.version, progress: 100, checkedAt: new Date().toISOString() }));
      au.on("error", (e: Error) => this.set({ status: "error", error: e?.message ?? String(e), checkedAt: new Date().toISOString() }));
      this.auto = au;
    }
    await this.auto.checkForUpdates();
  }

  // ---------------------------------------------------------------- macOS

  private async checkMac() {
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    const base = this.opts.feedUrl!.replace(/\/$/, "");
    const res = await fetchImpl(`${base}/latest-mac.yml?t=${Date.now()}`, { cache: "no-store" } as RequestInit);
    if (!res.ok) throw new Error(`读取更新信息失败：HTTP ${res.status}`);
    const info = parseUpdateInfo(await res.text());
    const checkedAt = new Date().toISOString();
    if (!isNewer(info.version, this.opts.currentVersion)) return this.set({ status: "not-available", checkedAt });
    const file = pickMacZip(info, this.opts.arch);
    if (!file) throw new Error(`新版本 ${info.version} 没有适用于 ${this.opts.arch} 的安装包`);

    this.set({ status: "downloading", version: info.version, progress: 0 });
    const dir = join(this.opts.downloadDir, info.version);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const zip = join(dir, file.url.split("/").pop()!);
    const dl = await fetchImpl(/^https?:\/\//.test(file.url) ? file.url : `${base}/${encodeURI(file.url)}`);
    if (!dl.ok || !dl.body) throw new Error(`下载失败：HTTP ${dl.status}`);
    const total = Number(dl.headers.get("content-length")) || file.size || 0;
    let received = 0;
    let lastPct = -1;
    const body = Readable.fromWeb(dl.body as any);
    body.on("data", (chunk: Buffer) => {
      received += chunk.length;
      const pct = total ? Math.floor((received / total) * 100) : 0;
      if (pct !== lastPct) {
        lastPct = pct;
        this.set({ progress: pct });
      }
    });
    await pipeline(body, createWriteStream(`${zip}.part`));
    renameSync(`${zip}.part`, zip);
    if ((await sha512Base64(zip)) !== file.sha512) {
      rmSync(dir, { recursive: true, force: true });
      throw new Error("更新包校验失败（sha512 不一致），已丢弃");
    }
    const out = join(dir, "app");
    mkdirSync(out, { recursive: true });
    await (this.opts.extract ?? ditto)(zip, out);
    const app = readdirSync(out).find((f) => f.endsWith(".app"));
    if (!app) throw new Error("更新包中没有找到应用");
    this.macApp = join(out, app);
    this.set({ status: "downloaded", progress: 100, checkedAt });
  }

  private installMac() {
    const target = appBundleOf(this.opts.execPath);
    if (!target || !this.macApp || !existsSync(this.macApp)) throw new Error("找不到要替换的应用");
    try {
      accessSync(dirname(target), constants.W_OK);
    } catch {
      throw new Error(`没有写入 ${dirname(target)} 的权限（如在磁盘映像中直接运行）。请把应用拖到「应用程序」后再更新`);
    }
    const script = join(this.opts.downloadDir, "install.sh");
    writeFileSync(script, macInstallScript(), { mode: 0o755 });
    const args = [String(process.pid), target, this.macApp, join(this.opts.downloadDir, "install.log")];
    (this.opts.launchInstaller ?? ((s, a) => spawn("/bin/bash", [s, ...a], { detached: true, stdio: "ignore" }).unref()))(script, args);
    this.opts.quit();
  }
}

async function loadElectronUpdater(): Promise<AutoUpdaterLike> {
  // electron-updater 是 CommonJS 包
  const mod: any = await import("electron-updater");
  return (mod.autoUpdater ?? mod.default?.autoUpdater) as AutoUpdaterLike;
}
