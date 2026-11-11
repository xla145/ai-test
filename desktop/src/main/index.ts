import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkData, initCi, runEngine, runUiSuite, seedData } from "@ai-test/mcp-servers";
import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell, WebContentsView } from "electron";
import { evaluateCommand, evaluateFileChange, isInside, type ApprovalContext, type Verdict } from "./approval.js";
import { CodexAppServer } from "./codex/appServer.js";
import { buildCodexConfig } from "./codex/config.js";
import type { Decision } from "./codex/protocol.js";
import {
  AGENT_KEY_ENV,
  checkModel,
  codexProvider,
  DEFAULT_MODEL_SETTINGS,
  midsceneEnv,
  PRESETS,
  validateSettings,
  type ModelSettings,
} from "./models.js";
import { Orchestrator } from "./orchestrator.js";
import { SecretStore, secretEnvFor, startSecretBroker, type Broker } from "./secrets.js";
import { CHANNELS, type ApprovalRequest } from "../shared/ipc.js";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const unpacked = (p: string) => p.replace(/app\.asar([\\/])/, "app.asar.unpacked$1");
const repoRoot = resolve(here, "../../..");
const CDP_PORT = Number(process.env.AITEST_CDP_PORT || 9333);

// 固定数据目录：包名 @ai-test/desktop 不能直接作为目录名，打包后会落到 ~/.config 根目录
app.setName("aitest-desktop");
app.setPath("userData", join(app.getPath("appData"), "aitest-desktop"));

// 内嵌浏览器：开启远程调试端口，Playwright 通过 connectOverCDP 连接（二期 UI 测试）
app.commandLine.appendSwitch("remote-debugging-port", String(CDP_PORT));
app.commandLine.appendSwitch("remote-debugging-address", "127.0.0.1");

const paths = {
  data: () => app.getPath("userData"),
  db: () => process.env.AITEST_DB || join(app.getPath("userData"), "aitest.db"),
  codexHome: () => join(app.getPath("userData"), "codex"),
  // 优先使用随安装包附带的 codex 二进制，其次 AITEST_CODEX_BIN，最后 PATH 上的 codex
  codexBin: () => {
    if (process.env.AITEST_CODEX_BIN) return process.env.AITEST_CODEX_BIN;
    const bundled = join(process.resourcesPath, "bin", process.platform === "win32" ? "codex.exe" : "codex");
    return app.isPackaged && existsSync(bundled) ? bundled : "codex";
  },
  engineDir: () => (app.isPackaged ? join(process.resourcesPath, "engine") : join(repoRoot, "engine")),
  // 安装包内附带引擎的纯 Python 依赖（openpyxl、httpx、pytest 等），用户只需要 Python 3.10+
  enginePythonPath: () =>
    app.isPackaged ? [join(process.resourcesPath, "engine"), join(process.resourcesPath, "engine-deps")].join(delimiter) : join(repoRoot, "engine"),
  // MCP Server 由 Codex 以独立进程启动，必须是 asar 之外的真实文件
  mcpEntry: () => unpacked(join(dirname(require.resolve("@ai-test/mcp-servers/package.json")), "dist", "index.js")),
  python: () => process.env.AITEST_PYTHON || "python3",
};

let mainWindow: BrowserWindow | undefined;
/** 被测页面视图：每个「项目 + 角色」一个独立 session partition，Playwright 经 CDP 连接后按 URL 标记找到它 */
const testViews = new Map<string, WebContentsView>();
let visibleView: WebContentsView | undefined;
let broker: Broker | undefined;
let codex: CodexAppServer | undefined;
let secretStore: SecretStore;
let approvalContext: ApprovalContext = { workspace: "", allowedHosts: [], productionHosts: [] };
const pendingApprovals = new Map<string, (accept: boolean) => void>();

const engineEnv = () => ({ PYTHONPATH: paths.enginePythonPath() });

// ---- 模型设置（国内模型 / 私有化部署）：配置存 userData/settings.json，API key 存钥匙串 ----
const MODEL_KEY_REF = { agent: "aitest:model:agent", vision: "aitest:model:vision" } as const;
const settingsFile = () => join(app.getPath("userData"), "settings.json");

function loadModelSettings(): ModelSettings {
  try {
    return existsSync(settingsFile()) ? { ...DEFAULT_MODEL_SETTINGS, ...JSON.parse(readFileSync(settingsFile(), "utf8")).models } : DEFAULT_MODEL_SETTINGS;
  } catch {
    return DEFAULT_MODEL_SETTINGS;
  }
}

function saveModelSettings(models: ModelSettings): void {
  const errors = validateSettings(models);
  if (errors.length) throw new Error(errors.join("；"));
  writeFileSync(settingsFile(), JSON.stringify({ models }, null, 2));
  // 配置变化后重启 Codex，下一个 agent 任务按新配置启动
  codex?.stop();
  codex = undefined;
}

const modelKey = (slot: "agent" | "vision") => secretStore.get(MODEL_KEY_REF[slot])?.authToken ?? "";
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
  const servers = ["doc-parser", "case-store", "case-import", "api-runner", "report", "browser", "env-support"];
  const models = loadModelSettings();
  const vision = models.vision ? midsceneEnv(models, modelKey("vision")) : {};
  const mcpEnv: Record<string, string> = {
    // browser 服务经 CDP 连接内嵌浏览器；AITEST_MIDSCENE=1 时启用 Midscene 视觉工具
    AITEST_CDP_ENDPOINT: `http://127.0.0.1:${CDP_PORT}`,
    ...(process.env.AITEST_MIDSCENE ? { AITEST_MIDSCENE: "1" } : {}),
    ELECTRON_RUN_AS_NODE: "1",
    AITEST_DB: paths.db(),
    AITEST_PYTHON: paths.python(),
    PYTHONPATH: paths.enginePythonPath(),
    AITEST_BROKER_URL: broker.url,
    AITEST_BROKER_TOKEN: broker.token,
  };
  writeFileSync(
    join(codexHome, "config.toml"),
    buildCodexConfig({
      ...codexProvider(models),
      model: codexProvider(models).model ?? process.env.AITEST_MODEL,
      // 视觉模型的配置只给 browser 服务（Midscene 在其中运行）
      mcpServers: servers.map((name) => ({
        name, command: process.execPath, args: [paths.mcpEntry(), name], env: name === "browser" ? { ...mcpEnv, ...vision } : mcpEnv,
      })),
    }),
  );
  codex = new CodexAppServer({
    binary: paths.codexBin(),
    codexHome,
    // agent 模型的 key 只注入 Codex 进程（对应配置中的 env_key）
    env: modelKey("agent") ? { [AGENT_KEY_ENV]: modelKey("agent") } : {},
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
  if (!mainWindow || !visibleView) return;
  const [w, h] = mainWindow.getContentSize();
  visibleView.setBounds({ x: Math.floor(w * 0.5), y: 0, width: Math.ceil(w * 0.5), height: h });
}

function showView(view: WebContentsView): void {
  if (!mainWindow) return;
  for (const v of testViews.values()) v.setVisible(v === view);
  if (!mainWindow.contentView.children.includes(view)) mainWindow.contentView.addChildView(view);
  visibleView = view;
  layoutTestView();
  mainWindow.webContents.send(CHANNELS.view, { visible: true });
}

function hideTestView(): void {
  for (const v of testViews.values()) v.setVisible(false);
  visibleView = undefined;
  mainWindow?.webContents.send(CHANNELS.view, { visible: false });
}

/** 为角色准备视图（多角色：Electron session partition 隔离登录态），返回初始 URL 中的标记 */
async function openRoleView(projectId: string, role: string): Promise<string> {
  if (!mainWindow) throw new Error("主窗口未就绪");
  const key = `${projectId}:${role}`;
  let view = testViews.get(key);
  const marker = `aitest-view=${randomUUID()}`;
  if (!view) {
    const partition = `persist:aitest-${projectId}-${Buffer.from(role).toString("hex")}`;
    view = new WebContentsView({ webPreferences: { partition, sandbox: true } });
    testViews.set(key, view);
  }
  showView(view);
  await view.webContents.loadURL(`data:text/html,<title>${encodeURIComponent(role)}</title>#${marker}`);
  return marker;
}

async function openTestPage(url: string): Promise<void> {
  const key = "manual:default";
  let view = testViews.get(key);
  if (!view) {
    view = new WebContentsView({ webPreferences: { partition: "persist:aitest-manual", sandbox: true } });
    testViews.set(key, view);
  }
  showView(view);
  await view.webContents.loadURL(url);
}

/** 只允许打开项目 workspace 内的文件，或用户刚通过保存对话框导出的文件 */
const exportedFiles = new Set<string>();
async function assertOpenable(orch: Orchestrator, target: string): Promise<string> {
  const p = resolve(target);
  if (exportedFiles.has(p)) return p;
  const projects = await orch.listProjects();
  if (projects.some((x) => isInside(x.workspace_path, p))) return p;
  throw new Error("只能打开项目 workspace 内的文件");
}

async function saveAs(defaultName: string, filters: { name: string; extensions: string[] }[]): Promise<string | null> {
  const r = await dialog.showSaveDialog(mainWindow!, { defaultPath: join(app.getPath("documents"), defaultName), filters });
  if (r.canceled || !r.filePath) return null;
  exportedFiles.add(resolve(r.filePath));
  return r.filePath;
}

function registerIpc(orch: Orchestrator): void {
  const handlers: Record<string, (...a: any[]) => unknown> = {
    listProjects: () => orch.listProjects(),
    createProject: (name: string, ws: string, envs) => orch.createProject(name, ws, envs),
    importExcel: (p: string, f: string) => orch.importExcel(p, f),
    lint: (p: string) => orch.lint(p),
    listCases: (p: string, filters) => orch.listCases(p, filters),
    updateCase: (c: string, patch, actor?: "human" | "agent") => orch.updateCase(c, patch, actor ?? "human"),
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
    setRoleSecret: async (p: string, role: string, username: string, password: string) => {
      await orch.addRole(p, role);
      secretStore.set(SecretStore.roleRef(p, role), { username, password });
    },
    listRoles: (p: string) => orch.listRoles(p),
    setEnvironment: (p: string, env: string, cfg) => orch.setEnvironment(p, env, cfg),
    exploreUiCase: async (p: string, env: string, caseId: string) => {
      await setApprovalContext(orch, p);
      return orch.exploreUiCase(p, env, caseId);
    },
    runUiRegression: async (p: string, env: string, headed: boolean) => {
      await setApprovalContext(orch, p);
      return orch.runUiRegression(p, env, { headed });
    },
    listProposals: (status?: string) => orch.listProposals(status),
    // ---- 三期 ----
    usageReport: (p: string, days?: number) => orch.usageReport(p, days),
    checkBudget: (p: string) => orch.checkBudget(p),
    getSettings: (p: string) => orch.getSettings(p),
    setSettings: (p: string, settings) => orch.setSettings(p, settings),
    metrics: (p: string) => orch.metrics(p),
    stability: (p: string) => orch.stability(p),
    listAttributions: (p: string, pendingOnly?: boolean) => orch.listAttributions(p, pendingOnly ?? true),
    confirmAttribution: (runId: string, caseId: string, type: string) => orch.confirmAttribution(runId, caseId, type),
    exportWorkspace: (p: string) => orch.exportWorkspace(p),
    importWorkspace: (dir: string) => orch.importWorkspace(dir),
    initCi: async (p: string, provider: "github" | "gitlab", toolRepo: string, env: string) => {
      const project = await orch.project(p);
      return initCi(project.workspace_path, provider, toolRepo, env);
    },
    modelPresets: () => PRESETS,
    getModelSettings: () => ({ ...loadModelSettings(), hasAgentKey: Boolean(modelKey("agent")), hasVisionKey: Boolean(modelKey("vision")) }),
    setModelSettings: (models: ModelSettings, keys?: { agent?: string; vision?: string }) => {
      if (keys?.agent) secretStore.set(MODEL_KEY_REF.agent, { authToken: keys.agent });
      if (keys?.vision) secretStore.set(MODEL_KEY_REF.vision, { authToken: keys.vision });
      saveModelSettings(models);
      return loadModelSettings();
    },
    checkModel: (slot: "agent" | "vision") => {
      const models = loadModelSettings();
      const cfg = slot === "agent" ? models.agent : models.vision;
      if (!cfg) throw new Error("未配置视觉模型");
      return checkModel(cfg, slot, modelKey(slot));
    },
    resolveProposal: (p: string, id: string, accept: boolean) => orch.resolveProposal(p, id, accept),
    listReviews: (status?: string) => orch.listReviews(status),
    resolveReview: (id: string, passed: boolean) => orch.resolveReview(id, passed),
    pickFile: async (filters) => {
      const r = await dialog.showOpenDialog(mainWindow!, { properties: ["openFile"], filters });
      return r.canceled ? null : r.filePaths[0];
    },
    pickDirectory: async () => {
      const r = await dialog.showOpenDialog(mainWindow!, { properties: ["openDirectory", "createDirectory"] });
      return r.canceled ? null : r.filePaths[0];
    },
    openTestPage: (url: string) => openTestPage(url),
    hideTestView: () => hideTestView(),
    // ---- 被测系统数据库 ----
    saveDatabase: async (p: string, env: string, name: string, cfg, password?: string) => {
      const out = await orch.saveDatabase(p, env, name, cfg);
      if (password) secretStore.setDbPassword(p, env, name, password);
      return out;
    },
    removeDatabase: (p: string, env: string, name: string) => orch.removeDatabase(p, env, name),
    testDatabase: (p: string, env: string, name: string) => orch.testDatabase(p, env, name),
    queryDatabase: (p: string, env: string, name: string, sql: string, params?: Record<string, unknown>) =>
      orch.queryDatabase(p, env, name, sql, params ?? {}),
    hasDbPassword: (p: string, env: string, name: string) => name in secretStore.dbPasswords(p, env),
    // ---- 测试报告 ----
    listRuns: (p: string, framework?: "pytest" | "playwright") => orch.listRuns(p, framework),
    runDetail: (runId: string) => orch.runDetail(runId),
    exportReport: async (runIds: string[], format: "html" | "xlsx") => {
      const ext = format === "html" ? "html" : "xlsx";
      const out = await saveAs(`测试报告-${runIds[0]}.${ext}`, [{ name: format === "html" ? "HTML 报告" : "Excel", extensions: [ext] }]);
      return out ? orch.exportReport(runIds, format, out) : null;
    },
    exportCasesExcel: async (p: string, name: string) => {
      const out = await saveAs(`${name}-用例.xlsx`, [{ name: "Excel", extensions: ["xlsx"] }]);
      return out ? orch.exportCasesExcel(p, out) : null;
    },
    openPath: async (target: string) => {
      const p = await assertOpenable(orch, target);
      // Playwright 报告是目录，打开其中的 index.html
      const file = existsSync(join(p, "index.html")) ? join(p, "index.html") : p;
      if (!existsSync(file)) throw new Error(`文件不存在：${file}`);
      const err = await shell.openPath(file);
      if (err) throw new Error(err);
    },
    showInFolder: async (target: string) => shell.showItemInFolder(await assertOpenable(orch, target)),
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
  broker = await startSecretBroker(secretStore, { openView: openRoleView });
  const orch = new Orchestrator({
    engine,
    agent: getCodex,
    secretEnv: (projectId, env, roles) => secretEnvFor(secretStore, projectId, env, roles),
    ui: { runUiSuite, checkData, seedData },
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
