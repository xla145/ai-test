// Vite 负责页面热更新；主进程 / preload 变更则重新编译并重启 Electron。
import { spawn } from "node:child_process";
import { watch } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import waitOn from "wait-on";

const require = createRequire(import.meta.url);
const cwd = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const intentionalStops = new WeakSet();
let electron;
let compiler;
let timer;
let building = false;
let pending = false;
let stopping = false;

function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  intentionalStops.add(child);
  return new Promise((done) => {
    child.once("exit", done);
    child.kill("SIGTERM");
  });
}

async function buildAndLaunch() {
  if (stopping) return;
  if (building) { pending = true; return; }
  building = true;
  pending = false;
  try {
    // 主进程读取 MCP 包 dist 中的类型和代码，先更新依赖以免使用旧声明。
    console.log("[desktop] 正在编译 MCP 依赖…");
    compiler = spawn(process.execPath, [require.resolve("typescript/bin/tsc"), "-p", "../mcp-servers/tsconfig.json", "--noEmitOnError"],
      { cwd, stdio: "inherit" });
    const dependencyCode = await new Promise((done, reject) => {
      compiler.once("error", reject);
      compiler.once("exit", done);
    });
    if (stopping || pending || dependencyCode !== 0) return;
    console.log("[desktop] 正在编译主进程和 preload…");
    compiler = spawn(process.execPath, [require.resolve("typescript/bin/tsc"), "-p", "tsconfig.main.json", "--noEmitOnError"],
      { cwd, stdio: "inherit" });
    const code = await new Promise((done, reject) => {
      compiler.once("error", reject);
      compiler.once("exit", done);
    });
    if (stopping || pending || code !== 0) return;
    await waitOn({ resources: ["tcp:localhost:5173"], timeout: 30_000 });
    if (stopping || pending) return;
    await stop(electron);
    if (stopping) return;
    console.log("[desktop] 正在启动 Electron（已更新主进程和 preload）");
    const env = { ...process.env, AITEST_DEV_SERVER: "http://localhost:5173" };
    delete env.ELECTRON_RUN_AS_NODE; // 从其它 Electron 工具启动时仍需运行桌面壳。
    const child = spawn(require("electron"), ["."], { cwd, stdio: "inherit", env });
    electron = child;
    child.once("error", (error) => { console.error(error); void shutdown(1); });
    child.once("exit", (exitCode) => {
      if (!intentionalStops.has(child) && !stopping) void shutdown(exitCode ?? 1);
    });
  } catch (error) {
    console.error("[desktop] 启动失败：", error);
  } finally {
    building = false;
    if (pending && !stopping) void buildAndLaunch();
  }
}

function schedule() {
  if (stopping) return;
  clearTimeout(timer);
  if (building) { pending = true; return; }
  timer = setTimeout(() => void buildAndLaunch(), 500);
}

const watchers = ["src/main", "src/preload", "src/shared", "../mcp-servers/src"].map((path) =>
  watch(resolve(cwd, path), { recursive: true }, (_event, file) => {
    if (!file || /\.(?:ts|cts)$/.test(file)) schedule();
  }));
watchers.push(watch(resolve(cwd, "tsconfig.main.json"), schedule));
watchers.push(watch(resolve(cwd, "../mcp-servers/tsconfig.json"), schedule));

async function shutdown(code) {
  if (stopping) return;
  stopping = true;
  clearTimeout(timer);
  watchers.forEach((watcher) => watcher.close());
  await Promise.all([stop(compiler), stop(electron)]);
  process.exit(code);
}

process.once("SIGINT", () => void shutdown(0));
process.once("SIGTERM", () => void shutdown(0));
void buildAndLaunch();
