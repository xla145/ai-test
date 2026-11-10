import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runEngine } from "@ai-test/mcp-servers";
import { app, BrowserWindow, dialog, ipcMain, safeStorage, WebContentsView } from "electron";
import { evaluateCommand, evaluateFileChange, type ApprovalContext, type Verdict } from "./approval.js";
import { CodexAppServer } from "./codex/appServer.js";
import { buildCodexConfig } from "./codex/config.js";
import type { Decision } from "./codex/protocol.js";
import { Orchestrator } from "./orchestrator.js";
import { SecretStore, startSecretBroker, type Broker } from "./secrets.js";
import { CHANNELS, type ApprovalRequest } from "../shared/ipc.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const CDP_PORT = Number(process.env.AITEST_CDP_PORT || 9333);

// 内嵌浏览器：开启远程调试端口，Playwright 通过 connectOverCDP 连接（二期 UI 测试）
app.commandLine.appendSwitch("remote-debugging-port", String(CDP_PORT));
app.commandLine.appendSwitch("remote-debugging-address", "127.0.0.1");

const paths = {
  data: () => app.getPath("userData"),
  db: () => process.env.AITEST_DB || join(app.getPath("userData"), "aitest.db"),
  codexHome: () => join(app.getPath("userData"), "codex"),
  codexBin: () => process.env.AITEST_CODEX_BIN || join(process.resourcesPath, "bin", process.platform === "win32" ? "codex.exe" : "codex"),
  engineDir: () => (app.isPackaged ? join(process.resourcesPath, "engine") : join(repoRoot, "engine")),
  mcpEntry: () => (app.isPackaged ? join(process.resourcesPath, "mcp-servers", "index.js") : join(repoRoot, "mcp-servers", "dist", "index.js")),
  python: () => process.env.AITEST_PYTHON || "python3",
};

let mainWindow: BrowserWindow | undefined;
let testView: WebContentsView | undefined;
let broker: Broker | undefined;
let codex: CodexAppServer | undefined;
let secretStore: SecretStore;
let approvalContext: ApprovalContext = { workspace: "", allowedHosts: [], productionHosts: [] };
const pendingApprovals = new Map<string, (accept: boolean) => void>();

const engineEnv = () => ({ PYTHONPATH: paths.engineDir() });
const engine = <T,>(args: string[], env: Record<string, string> = {}) =>
  runEngine<T>(args, { python: paths.python(), db: paths.db(), env: { ...engineEnv(), ...env } });

/** 规则判定为 ask 时弹到界面由用户决定 */
async function decide(kind: ApprovalRequest["kind"], verdict: Verdict, detail: unknown): Promise<Decision> {
  if (verdict.decision !== "ask") return verdict.decision;
  if (!mainWindow) return "decline";
  const id = randomUUID();
  const req: ApprovalRequest = { id, kind, reason: verdict.reason, detail };
  mainWindow.webContents.send(CHANNELS.approvalRequest, req);
  const accept = await new Promise<boolean>((r) => pendingApprovals.set(id, r));
  return accept ? "accept" : "decline";
}

async function getCodex(): Promise<CodexAppServer> {
  if (codex) return codex;
  if (!broker) throw new Error("凭据代理未启动");
  const codexHome = paths.codexHome();
  mkdirSync(codexHome, { recursive: true });
  const servers = ["doc-parser", "case-store", "case-import", "api-runner", "report"];
  const mcpEnv = {
    ELECTRON_RUN_AS_NODE: "1",
    AITEST_DB: paths.db(),
    AITEST_PYTHON: paths.python(),
    PYTHONPATH: paths.engineDir(),
    AITEST_BROKER_URL: broker.url,
    AITEST_BROKER_TOKEN: broker.token,
  };
  writeFileSync(
    join(codexHome, "config.toml"),
    buildCodexConfig({
      model: process.env.AITEST_MODEL,
      mcpServers: servers.map((name) => ({ name, command: process.execPath, args: [paths.mcpEntry(), name], env: mcpEnv })),
    }),
  );
  codex = new CodexAppServer({
    binary: paths.codexBin(),
    codexHome,
    approvals: {
      command: (p) => decide("command", evaluateCommand(p, approvalContext), p),
      fileChange: (p) => decide("fileChange", evaluateFileChange(p, approvalContext), p),
    },
  });
  codex.on("event", (evt) => mainWindow?.webContents.send(CHANNELS.event, evt));
  codex.on("exit", () => (codex = undefined));
  await codex.start();
  return codex;
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    title: "AI 测试客户端",
    webPreferences: { preload: join(here, "../preload/index.cjs"), contextIsolation: true, sandbox: true },
  });
  const dev = process.env.AITEST_DEV_SERVER;
  if (dev) void mainWindow.loadURL(dev);
  else void mainWindow.loadFile(join(here, "../renderer/index.html"));
  mainWindow.on("resize", layoutTestView);
}

/** 被测页面放在独立的 WebContentsView 中，用户可实时看到 agent / 脚本的操作 */
function layoutTestView(): void {
  if (!mainWindow || !testView) return;
  const [w, h] = mainWindow.getContentSize();
  testView.setBounds({ x: Math.floor(w * 0.5), y: 48, width: Math.ceil(w * 0.5), height: h - 48 });
}

async function openTestPage(url: string): Promise<void> {
  if (!mainWindow) return;
  if (!testView) {
    // 每个角色 / 项目可使用独立 session partition（二期：多角色）
    testView = new WebContentsView({ webPreferences: { partition: "persist:aitest-default", sandbox: true } });
    mainWindow.contentView.addChildView(testView);
    layoutTestView();
  }
  await testView.webContents.loadURL(url);
}

function registerIpc(orch: Orchestrator): void {
  const handlers: Record<string, (...a: any[]) => unknown> = {
    listProjects: () => orch.listProjects(),
    createProject: (name: string, ws: string, envs) => orch.createProject(name, ws, envs),
    importExcel: (p: string, f: string) => orch.importExcel(p, f),
    lint: (p: string) => orch.lint(p),
    listCases: (p: string, filters) => orch.listCases(p, filters),
    updateCase: (c: string, patch) => orch.updateCase(c, patch),
    applyFix: (c: string, field: string, value: unknown) => orch.applyFix(c, field, value),
    generateApiSuite: async (p: string, f: string, enrich: boolean) => {
      await setApprovalContext(orch, p);
      return orch.generateApiSuite(p, f, enrich);
    },
    generateCases: async (p: string, f: string) => {
      await setApprovalContext(orch, p);
      return orch.generateCases(p, f);
    },
    runRegression: async (p: string, env: string) => {
      await setApprovalContext(orch, p);
      return orch.runRegression(p, env);
    },
    tokenUsage: (p: string) => orch.tokenUsage(p),
    setEnvSecret: (p: string, env: string, authToken: string, authHeader?: string) =>
      secretStore.set(SecretStore.ref(p, env), { authToken, authHeader }),
    pickFile: async (filters) => {
      const r = await dialog.showOpenDialog(mainWindow!, { properties: ["openFile"], filters });
      return r.canceled ? null : r.filePaths[0];
    },
    pickDirectory: async () => {
      const r = await dialog.showOpenDialog(mainWindow!, { properties: ["openDirectory", "createDirectory"] });
      return r.canceled ? null : r.filePaths[0];
    },
    openTestPage: (url: string) => openTestPage(url),
  };
  ipcMain.handle(CHANNELS.invoke, async (_e, method: string, ...args: unknown[]) => {
    const fn = handlers[method];
    if (!fn) throw new Error(`未知方法：${method}`);
    return fn(...args);
  });
  ipcMain.on(CHANNELS.approvalResponse, (_e, id: string, accept: boolean) => {
    pendingApprovals.get(id)?.(accept);
    pendingApprovals.delete(id);
  });
}

async function setApprovalContext(orch: Orchestrator, projectId: string): Promise<void> {
  const p = await orch.project(projectId);
  const hosts = (prod: boolean) =>
    Object.values(p.environments)
      .filter((e) => Boolean(e.production) === prod)
      .map((e) => new URL(e.base_url).hostname);
  approvalContext = { workspace: p.workspace_path, allowedHosts: hosts(false), productionHosts: hosts(true) };
}

app.whenReady().then(async () => {
  secretStore = new SecretStore(join(paths.data(), "secrets.json"), safeStorage);
  broker = await startSecretBroker(secretStore);
  const orch = new Orchestrator({
    engine,
    agent: getCodex,
    secretEnv: (projectId, env) => {
      const s = secretStore.get(SecretStore.ref(projectId, env));
      return s ? { AITEST_AUTH_TOKEN: s.authToken, ...(s.authHeader ? { AITEST_AUTH_HEADER: s.authHeader } : {}) } : {};
    },
    tokenLimit: Number(process.env.AITEST_TOKEN_LIMIT || 200_000),
  });
  orch.on("progress", (p) => mainWindow?.webContents.send(CHANNELS.event, { method: "aitest/progress", params: p }));
  registerIpc(orch);
  createWindow();
});

app.on("window-all-closed", () => {
  codex?.stop();
  void broker?.close();
  if (process.platform !== "darwin") app.quit();
});
