import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Updater, type AutoUpdaterLike } from "../src/main/updater.js";
import { appBundleOf, isNewer, macInstallScript, parseUpdateInfo, pickMacZip } from "../src/main/updateUtils.js";

const LATEST_MAC = (version: string, zip: Buffer, name = `AIProbe-${version}-mac-arm64.zip`) => `version: ${version}
files:
  - url: ${name}
    sha512: ${createHash("sha512").update(zip).digest("base64")}
    size: ${zip.length}
  - url: AIProbe-${version}-mac-arm64.dmg
    sha512: abc
    size: 10
path: ${name}
sha512: ${createHash("sha512").update(zip).digest("base64")}
releaseDate: '2026-11-11T08:00:00.000Z'
`;

describe("update helpers", () => {
  it("compares versions", () => {
    expect(isNewer("0.3.12", "0.3.11")).toBe(true);
    expect(isNewer("0.3.10", "0.3.9")).toBe(true);
    expect(isNewer("0.4.0", "0.3.99")).toBe(true);
    expect(isNewer("0.3.11", "0.3.11")).toBe(false);
    expect(isNewer("0.3.2", "0.3.11")).toBe(false);
    expect(isNewer("v1.0.0", "1.0.0-beta")).toBe(true);
    expect(isNewer("1.0.0-beta", "1.0.0")).toBe(false);
  });

  it("parses latest-mac.yml and picks the zip for this architecture", () => {
    const info = parseUpdateInfo(LATEST_MAC("0.3.12", Buffer.from("zip")));
    expect(info.version).toBe("0.3.12");
    expect(info.files).toHaveLength(2);
    expect(pickMacZip(info, "arm64")?.url).toBe("AIProbe-0.3.12-mac-arm64.zip");
    expect(pickMacZip({ ...info, files: [{ url: "a-mac-arm64.zip", sha512: "x" }, { url: "a-mac-x64.zip", sha512: "y" }] }, "x64")?.url)
      .toBe("a-mac-x64.zip");
    expect(() => parseUpdateInfo("files: []")).toThrow("version");
  });

  it("derives the app bundle and builds a restoring install script", () => {
    expect(appBundleOf("/Applications/AIProbe.app/Contents/MacOS/AIProbe")).toBe("/Applications/AIProbe.app");
    expect(appBundleOf("/usr/bin/node")).toBeUndefined();
    const script = macInstallScript();
    expect(script).toContain('kill -0 "$PID"');
    expect(script).toContain('mv "$BACKUP" "$APP"'); // 替换失败时还原
    expect(script).toContain("xattr -dr com.apple.quarantine");
    expect(script).toContain('open "$APP"');
  });
});

describe("macOS updater", () => {
  let server: Server | undefined;
  afterEach(() => server?.close());

  async function serve(files: Record<string, Buffer | string>): Promise<string> {
    server = createServer((req, res) => {
      const path = decodeURIComponent((req.url ?? "").split("?")[0]).replace(/^\/aitest-desktop\//, "");
      const body = files[path];
      if (body === undefined) return void res.writeHead(404).end();
      res.writeHead(200, { "content-length": Buffer.byteLength(body) }).end(body);
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    const addr = server.address();
    return `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}/aitest-desktop`;
  }

  function macUpdater(feedUrl: string, overrides: Partial<ConstructorParameters<typeof Updater>[0]> = {}) {
    const dir = mkdtempSync(join(tmpdir(), "upd-"));
    const apps = join(dir, "Applications");
    mkdirSync(join(apps, "AIProbe.app", "Contents", "MacOS"), { recursive: true });
    const extract = vi.fn(async (_zip: string, dest: string) => {
      mkdirSync(join(dest, "AIProbe.app", "Contents"), { recursive: true });
    });
    const launchInstaller = vi.fn();
    const quit = vi.fn();
    const u = new Updater({
      currentVersion: "0.3.11", feedUrl, platform: "darwin", arch: "arm64",
      execPath: join(apps, "AIProbe.app", "Contents", "MacOS", "AIProbe"),
      downloadDir: join(dir, "updates"), quit, extract, launchInstaller, ...overrides,
    });
    return { u, extract, launchInstaller, quit, dir, apps };
  }

  it("downloads, verifies and installs a newer version", async () => {
    const zip = Buffer.alloc(200_000, 7);
    const feed = await serve({ "latest-mac.yml": LATEST_MAC("0.3.12", zip), "AIProbe-0.3.12-mac-arm64.zip": zip });
    const { u, extract, launchInstaller, quit, dir, apps } = macUpdater(feed);
    const states: string[] = [];
    u.on("state", (s) => states.push(s.status));

    const state = await u.check();
    expect(state).toMatchObject({ status: "downloaded", version: "0.3.12", progress: 100 });
    expect(states[0]).toBe("checking");
    expect(states).toContain("downloading");
    expect(extract).toHaveBeenCalledOnce();
    expect(readFileSync(extract.mock.calls[0][0]).equals(zip)).toBe(true);

    u.install();
    const [script, args] = launchInstaller.mock.calls[0] as [string, string[]];
    expect(readFileSync(script, "utf8")).toBe(macInstallScript());
    expect(args[1]).toBe(join(apps, "AIProbe.app"));
    expect(args[2]).toBe(join(dir, "updates", "0.3.12", "app", "AIProbe.app"));
    expect(quit).toHaveBeenCalledOnce();
  });

  it("rejects a package whose sha512 does not match", async () => {
    const zip = Buffer.from("real");
    const feed = await serve({ "latest-mac.yml": LATEST_MAC("0.3.12", zip), "AIProbe-0.3.12-mac-arm64.zip": Buffer.from("tampered") });
    const { u, extract } = macUpdater(feed);
    expect(await u.check()).toMatchObject({ status: "error", error: expect.stringContaining("校验失败") });
    expect(extract).not.toHaveBeenCalled();
    expect(() => u.install()).toThrow("还没有下载好的更新");
  });

  it("reports up to date, missing feeds and disabled states", async () => {
    const feed = await serve({ "latest-mac.yml": LATEST_MAC("0.3.11", Buffer.from("x")) });
    expect((await macUpdater(feed).u.check()).status).toBe("not-available");
    const empty = await serve({});
    expect(await macUpdater(empty).u.check()).toMatchObject({ status: "error", error: expect.stringContaining("HTTP 404") });
    const off = new Updater({ currentVersion: "1.0.0", platform: "darwin", arch: "arm64", execPath: "/x", downloadDir: "/tmp", quit: vi.fn() });
    expect(off.current).toMatchObject({ status: "disabled", reason: expect.stringContaining("没有配置更新地址") });
    expect((await off.check()).status).toBe("disabled");
  });
});

describe("Windows / Linux updater", () => {
  it("drives electron-updater and maps its events", async () => {
    const au = Object.assign(new EventEmitter(), {
      autoDownload: false, autoInstallOnAppQuit: false, logger: undefined as unknown,
      setFeedURL: vi.fn(),
      checkForUpdates: vi.fn(async () => {
        au.emit("update-available", { version: "0.3.12" });
        au.emit("download-progress", { percent: 55.4 });
        au.emit("update-downloaded", { version: "0.3.12" });
      }),
      quitAndInstall: vi.fn(),
    }) as unknown as AutoUpdaterLike & { setFeedURL: ReturnType<typeof vi.fn>; quitAndInstall: ReturnType<typeof vi.fn> };
    const u = new Updater({
      currentVersion: "0.3.11", feedUrl: "https://download.classktv.com/aitest-desktop", platform: "win32", arch: "x64",
      execPath: "C:\\\\app.exe", downloadDir: "/tmp", quit: vi.fn(), loadAutoUpdater: async () => au,
    });
    const progress: number[] = [];
    u.on("state", (s) => s.status === "downloading" && progress.push(s.progress ?? 0));
    expect(await u.check()).toMatchObject({ status: "downloaded", version: "0.3.12" });
    expect(au.setFeedURL).toHaveBeenCalledWith({ provider: "generic", url: "https://download.classktv.com/aitest-desktop" });
    expect(au.autoDownload && au.autoInstallOnAppQuit).toBe(true);
    expect(progress).toEqual([0, 55]);
    u.install();
    expect(au.quitAndInstall).toHaveBeenCalledWith(true, true);
  });
});
