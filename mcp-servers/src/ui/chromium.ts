import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { chromium } from "playwright-core";

/**
 * 选择执行 UI 脚本用的浏览器：
 * 1. 显式配置的 AITEST_CHROMIUM_PATH；
 * 2. Playwright 自带的浏览器（无头模式优先用 headless shell）——返回 undefined，交给 Playwright 默认处理；
 * 3. 自带浏览器只装了完整版时，直接用它；
 * 4. 都没有时退回系统安装的 Chrome / Edge / Chromium，免去单独下载。
 * 什么都找不到时返回 undefined，由 Playwright 给出「浏览器未安装」的错误。
 */
export interface BrowserChoice {
  executablePath?: string;
  source: "configured" | "bundled" | "bundled-full" | "system" | "missing";
}

export interface ChooseOptions {
  headless?: boolean;
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  exists?: (path: string) => boolean;
  /** Playwright 自带完整版 Chromium 的路径（测试时注入） */
  bundled?: () => string;
}

export function systemBrowserCandidates(platform: NodeJS.Platform, env: Record<string, string | undefined>): string[] {
  if (platform === "darwin") {
    const apps = ["Google Chrome.app/Contents/MacOS/Google Chrome", "Microsoft Edge.app/Contents/MacOS/Microsoft Edge", "Chromium.app/Contents/MacOS/Chromium"];
    return [...apps.map((a) => join("/Applications", a)), ...apps.map((a) => join(env.HOME ?? homedir(), "Applications", a))];
  }
  if (platform === "win32") {
    const roots = [env.PROGRAMFILES, env["PROGRAMFILES(X86)"], env.LOCALAPPDATA].filter(Boolean) as string[];
    return roots.flatMap((r) => [join(r, "Google", "Chrome", "Application", "chrome.exe"), join(r, "Microsoft", "Edge", "Application", "msedge.exe")]);
  }
  return ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/microsoft-edge", "/snap/bin/chromium"];
}

/** 由完整版路径推出同一版本的 headless shell 目录（…/chromium-1243/… → …/chromium_headless_shell-1243） */
function headlessShellDir(full: string): string | undefined {
  for (let dir = dirname(full); dir !== dirname(dir); dir = dirname(dir)) {
    const m = basename(dir).match(/^chromium-(\d+)$/);
    if (m) return join(dirname(dir), `chromium_headless_shell-${m[1]}`);
  }
  return undefined;
}

export function chooseBrowser(opts: ChooseOptions = {}): BrowserChoice {
  const env = opts.env ?? process.env;
  const exists = opts.exists ?? existsSync;
  if (env.AITEST_CHROMIUM_PATH) return { executablePath: env.AITEST_CHROMIUM_PATH, source: "configured" };
  let full = "";
  try { full = (opts.bundled ?? (() => chromium.executablePath()))(); } catch { /* 未知平台等 */ }
  const headless = opts.headless ?? true;
  const shell = full ? headlessShellDir(full) : undefined;
  if (full && (headless ? shell && exists(shell) : exists(full))) return { source: "bundled" };
  if (full && exists(full)) return { executablePath: full, source: "bundled-full" };
  const system = systemBrowserCandidates(opts.platform ?? process.platform, env).find((p) => exists(p));
  return system ? { executablePath: system, source: "system" } : { source: "missing" };
}
