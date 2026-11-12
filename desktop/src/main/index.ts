import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { userInfo } from "node:os";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BrowserSession, checkData, initCi, runAppSuite, runEngine, runUiSuite, seedData } from "@ai-test/mcp-servers";
import yaml from "js-yaml";
import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell, WebContentsView } from "electron";
import { evaluateCommand, evaluateFileChange, evaluateMcpElicitation, isInside, type ApprovalContext, type Verdict } from "./approval.js";
import { CodexAppServer } from "./codex/appServer.js";
import { buildCodexConfig } from "./codex/config.js";
import type { Decision } from "./codex/protocol.js";
import { AGENT_KEY_ENV, checkModel, codexProvider, midsceneEnv, PRESETS, type ModelSettings } from "./models.js";
import {
  activeModels,
  DEFAULT_SETTINGS,
  DEFAULT_TASK_TOKEN_LIMIT,
  migrate,
  modelKeyRef,
  usageOf,
  validateGlobal,
  type GlobalSettings,
} from "./settings.js";
import { readEvidenceImage } from "./evidence.js";
import { Orchestrator } from "./orchestrator.js";
import { Updater } from "./updater.js";
import { SecretStore, secretEnvFor, startSecretBroker, type Broker } from "./secrets.js";
import { CHANNELS, type ApprovalRequest, type RuntimeCheck, type RuntimeInfo, type UserInfo, type UiDebugCommand, type ViewDock } from "../shared/ipc.js";
import type { UiRunOptions } from "../shared/ipc.js";

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

type Source = RuntimeInfo["python"]["source"];

/** codex 查找顺序：AITEST_CODEX_BIN → 全局配置 → 随安装包附带（开发时为 scripts/fetch-codex.sh 下载到的
 *  .release/codex）→ PATH 上的 codex */
function codexBin(): { path: string; source: Source } {
  if (process.env.AITEST_CODEX_BIN) return { path: process.env.AITEST_CODEX_BIN, source: "env" };
  const configured = loadSettings().general.codexPath;
  if (configured) return { path: configured, source: "settings" };
  const root = app.isPackaged ? join(process.resourcesPath, "codex") : join(repoRoot, ".release", "codex");
  const bundled = join(root, "bin", process.platform === "win32" ? "codex.exe" : "codex");
  return existsSync(bundled) ? { path: bundled, source: "bundled" } : { path: "codex", source: "default" };
}

/** Python：AITEST_PYTHON → 全局配置 → python3 */
function python(): { path: string; source: Source } {
  if (process.env.AITEST_PYTHON) return { path: process.env.AITEST_PYTHON, source: "env" };
  const configured = loadSettings().general.pythonPath;
  return configured ? { path: configured, source: "settings" } : { path: "python3", source: "default" };
}

/** maestro：AITEST_MAESTRO → 全局配置 → PATH 上的 maestro */
function maestroBin(): { path: string; source: Source } {
  if (process.env.AITEST_MAESTRO) return { path: process.env.AITEST_MAESTRO, source: "env" };
  const configured = loadSettings().general.maestroPath;
  return configured ? { path: configured, source: "settings" } : { path: "maestro", source: "default" };
}

function pinky(): { path: string; enabled: boolean } {
  const g = loadSettings().general;
  return { path: g.pinkyPath || "pinkyctl", enabled: Boolean(g.pinkyEnabled) };
}

/** agent 单次任务 token 上限：AITEST_TOKEN_LIMIT → 全局配置 → 默认值 */
function taskTokenLimit(): { value: number; source: Source } {
  const env = Number(process.env.AITEST_TOKEN_LIMIT);
  if (env > 0) return { value: env, source: "env" };
  const configured = loadSettings().general.taskTokenLimit;
  return configured ? { value: configured, source: "settings" } : { value: DEFAULT_TASK_TOKEN_LIMIT, source: "default" };
}

const paths = {
  data: () => app.getPath("userData"),
  db: () => process.env.AITEST_DB || join(app.getPath("userData"), "aitest.db"),
  codexHome: () => join(app.getPath("userData"), "codex"),
  codexBin: () => codexBin().path,
  engineDir: () => (app.isPackaged ? join(process.resourcesPath, "engine") : join(repoRoot, "engine")),
  // 开发和打包模式都加载预先准备的纯 Python 依赖，避免依赖全局 Python 环境。
  enginePythonPath: () =>
    (app.isPackaged
      ? [join(process.resourcesPath, "engine"), join(process.resourcesPath, "engine-deps")]
      : [join(repoRoot, "engine"), join(repoRoot, ".release", "engine-deps")]).join(delimiter),
  // MCP Server 由 Codex 以独立进程启动，必须是 asar 之外的真实文件
  mcpEntry: () => unpacked(join(dirname(require.resolve("@ai-test/mcp-servers/package.json")), "dist", "index.js")),
  python: () => python().path,
};

let mainWindow: BrowserWindow | undefined;
let updater: Updater | undefined;
/** 被测页面视图：每个「项目 + 角色」一个独立 session partition，Playwright 经 CDP 连接后按 URL 标记找到它 */
const testViews = new Map<string, WebContentsView>();
let visibleView: WebContentsView | undefined;
/** 页面提供的停靠区域（UI 测试工作台）；为空时视图占右半屏，界面收窄到左半屏 */
let viewDock: ViewDock | null = null;
/** 视图实际是否在显示（停靠区被遮挡或过小时为 false），变化时通知界面 */
let viewShown = false;
let broker: Broker | undefined;
let codex: CodexAppServer | undefined;
let secretStore: SecretStore;
let approvalContext: ApprovalContext = { workspace: "", allowedHosts: [], productionHosts: [] };
const pendingApprovals = new Map<string, (accept: boolean) => void>();

const engineEnv = () => ({ PYTHONPATH: paths.enginePythonPath() });

// ---- 全局配置（模型、运行环境、外观）：存 userData/settings.json，模型 API key 存钥匙串 ----
const settingsFile = () => join(app.getPath("userData"), "settings.json");

function loadSettings(): GlobalSettings {
  try {
    return existsSync(settingsFile()) ? migrate(JSON.parse(readFileSync(settingsFile(), "utf8"))) : migrate(DEFAULT_SETTINGS);
  } catch {
    return migrate(DEFAULT_SETTINGS);
  }
}

const loadModelSettings = (): ModelSettings => activeModels(loadSettings());

/** 保存全局配置；keys 为本次填写的 API key（按模型 id），删除的模型同时删除其 key */
function saveSettings(next: GlobalSettings, keys: Record<string, string> = {}): void {
  const s = migrate(next);
  const errors = validateGlobal(s);
  if (errors.length) throw new Error(errors.join("；"));
  const prev = loadSettings();
  for (const m of prev.models) if (!s.models.some((x) => x.id === m.id)) secretStore.delete(modelKeyRef(m.id));
  for (const [id, key] of Object.entries(keys)) if (key && s.models.some((m) => m.id === id)) secretStore.set(modelKeyRef(id), { authToken: key });
  writeFileSync(settingsFile(), JSON.stringify(s, null, 2));
  // 配置变化后重启 Codex，下一个 agent 任务按新配置启动
  codex?.stop();
  codex = undefined;
}

const keyOf = (id?: string) => (id ? secretStore.get(modelKeyRef(id))?.authToken ?? "" : "");
const modelKey = (slot: "agent" | "vision") => {
  const s = loadSettings();
  return keyOf(slot === "agent" ? s.agentModelId : s.visionModelId);
};

function runtimeInfo(): RuntimeInfo {
  const envOverrides = ["AITEST_PYTHON", "AITEST_CODEX_BIN", "AITEST_TOKEN_LIMIT", "AITEST_DB", "AITEST_MAESTRO"].filter((k) => process.env[k]);
  return {
    appVersion: app.getVersion(), dataDir: paths.data(), dbPath: paths.db(),
    python: python(), codex: codexBin(), taskTokenLimit: taskTokenLimit(), maestro: maestroBin(), pinky: pinky(), envOverrides,
  };
}

/** 运行 `<bin> --version` 检查可用性；能启动但不支持 --version 的程序也视为已安装 */
function versionOf(bin: string): Promise<RuntimeCheck> {
  return new Promise((done) => {
    execFile(bin, ["--version"], { timeout: 15_000, windowsHide: true }, (err, stdout, stderr) => {
      const out = `${stdout}${stderr}`.trim().split(/\r?\n/)[0] ?? "";
      if (!err) return done({ ok: true, detail: out });
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "EACCES") return done({ ok: false, detail: `找不到 ${bin}` });
      done(out ? { ok: true, detail: `已安装（${out.slice(0, 80)}）` } : { ok: false, detail: err.message });
    });
  });
}
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
  const servers = ["doc-parser", "case-store", "case-import", "api-runner", "report", "browser", "env-support", "app"];
  const models = loadModelSettings();
  const vision = models.vision ? midsceneEnv(models, modelKey("vision")) : {};
  const { MIDSCENE_MODEL_API_KEY: visionKey, ...visionConfig } = vision;
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
      mcpServers: [
        ...servers.map((name) => ({
          name, command: process.execPath, args: [paths.mcpEntry(), name],
          ...(name === "browser" ? { envVars: ["MIDSCENE_MODEL_API_KEY"] } : {}),
          env: name === "browser" ? { ...mcpEnv, ...visionConfig, MIDSCENE_RUN_DIR: join(paths.data(), "midscene") } : name === "app" ? { ...mcpEnv, AITEST_MAESTRO: maestroBin().path } : mcpEnv,
        })),
        // App 探索：Pinky 操作手机，关键步骤在 Pinky 中由用户确认
        ...(pinky().enabled ? [{ name: "pinky", command: pinky().path, args: ["mcp"] }] : []),
      ],
    }),
  );
  codex = new CodexAppServer({
    binary: paths.codexBin(),
    codexHome,
    // agent 模型的 key 只注入 Codex 进程（对应配置中的 env_key）
    env: { ...(modelKey("agent") ? { [AGENT_KEY_ENV]: modelKey("agent") } : {}),
      ...(visionKey !== undefined ? { MIDSCENE_MODEL_API_KEY: visionKey } : {}) },
    approvals: {
      command: (p) => decide("command", evaluateCommand(p, approvalContext), p),
      fileChange: (p) => decide("fileChange", evaluateFileChange(p, approvalContext), p),
      mcpElicitation: (p) => decide("mcp", evaluateMcpElicitation(p, new Set(servers)), { 服务: p.serverName, 说明: p.message ?? p.url ?? "" }),
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
    title: "AIProbe",
    webPreferences: { preload: join(here, "../preload/index.cjs"), contextIsolation: true, sandbox: true },
  });
  const dev = process.env.AITEST_DEV_SERVER;
  if (dev) void mainWindow.loadURL(dev);
  else void mainWindow.loadFile(join(here, "../renderer/index.html"));
  mainWindow.on("resize", layoutTestView);
}

/** 被测页面放在独立的 WebContentsView 中，用户可实时看到 agent / 脚本的操作 */
/**
 * 被测页面按桌面宽度渲染：视图比 1280 窄时整体缩小显示，页面仍按 1280 宽布局。
 * 否则后台系统会切成手机布局（菜单收起），AI 探索绕路，录下的定位也和无头回归（默认 1280 宽）不一致。
 */
const DESKTOP_WIDTH = 1280;
const viewZoom = new WeakMap<WebContentsView, number>();

function applyZoom(view: WebContentsView, width: number): void {
  if (width <= 0) return;
  const zoom = Math.max(0.25, Math.min(1, width / DESKTOP_WIDTH));
  if (viewZoom.get(view) === zoom) return;
  viewZoom.set(view, zoom);
  view.webContents.setZoomFactor(zoom);
}

/** 缩放按站点记忆：跳到新站点后重新应用 */
function keepZoom(view: WebContentsView): void {
  view.webContents.on("did-navigate", () => {
    const zoom = viewZoom.get(view);
    if (zoom) view.webContents.setZoomFactor(zoom);
  });
}

function layoutTestView(): void {
  if (!mainWindow || !visibleView) return;
  const before = viewShown;
  const [w, h] = mainWindow.getContentSize();
  if (viewDock) {
    const x = Math.max(0, Math.round(viewDock.x)), y = Math.max(0, Math.round(viewDock.y));
    const width = Math.max(0, Math.min(Math.round(viewDock.width), w - x)), height = Math.max(0, Math.min(Math.round(viewDock.height), h - y));
    // 停靠区被弹窗遮挡或过小时暂时隐藏，避免视图盖住界面
    viewShown = !viewDock.suspended && width >= 120 && height >= 80;
    visibleView.setBounds({ x, y, width, height });
    applyZoom(visibleView, width);
  } else {
    viewShown = true;
    visibleView.setBounds({ x: Math.floor(w * 0.5), y: 0, width: Math.ceil(w * 0.5), height: h });
    applyZoom(visibleView, Math.ceil(w * 0.5));
  }
  visibleView.setVisible(viewShown);
  if (before !== viewShown) notifyView();
}

function notifyView(): void {
  mainWindow?.webContents.send(CHANNELS.view, { visible: Boolean(visibleView), docked: Boolean(viewDock), shown: Boolean(visibleView) && viewShown });
}

function showView(view: WebContentsView): void {
  if (!mainWindow) return;
  for (const v of testViews.values()) if (v !== view) v.setVisible(false);
  if (!mainWindow.contentView.children.includes(view)) mainWindow.contentView.addChildView(view);
  const changed = visibleView !== view;
  visibleView = view;
  layoutTestView();
  if (changed) notifyView();
}

function hideTestView(): void {
  for (const v of testViews.values()) v.setVisible(false);
  visibleView = undefined;
  viewShown = false;
  notifyView();
}

function dockTestView(dock: ViewDock | null): void {
  const wasDocked = Boolean(viewDock);
  viewDock = dock;
  layoutTestView();
  if (wasDocked !== Boolean(dock)) notifyView();
}

/** 为角色准备视图；用页面标记连接现有页面，不跳转，以保留登录态和调试现场。 */
async function openRoleView(projectId: string, role: string, env?: string): Promise<string> {
  if (!mainWindow) throw new Error("主窗口未就绪");
  const key = env ? `${projectId}:${env}:${role}` : `${projectId}:${role}`;
  let view = testViews.get(key);
  const marker = `aitest-view=${randomUUID()}`;
  if (!view) {
    const partition = `persist:aitest-${Buffer.from(key).toString("hex")}`;
    view = new WebContentsView({ webPreferences: { partition, sandbox: true } });
    keepZoom(view);
    testViews.set(key, view);
    // 首次创建时加载空白文档；已有视图绝不重置，保留 sessionStorage 与内存状态。
    await view.webContents.loadURL(`data:text/html,<title>${encodeURIComponent(role)}</title>`);
  }
  showView(view);
  await view.webContents.executeJavaScript(`window.__aitestViewMarker = ${JSON.stringify(marker)}`);
  return marker;
}

// ---- 手动登录：用户在角色视图里亲自登录（验证码、扫码等），登录态供探索 / 调试 / 试跑 / 回归复用 ----

const ROLE_NAME = /^(?!\.{1,2}$)[^\\/:*?"<>|\u0000-\u001f]{1,64}$/;

async function roleLoginTarget(orch: Orchestrator, projectId: string, env: string, role: string) {
  if (!ROLE_NAME.test(role) || role === "default") throw new Error("角色名不合法");
  const project = (await orch.listProjects()).find((p) => p.id === projectId);
  const cfg = project?.environments[env];
  if (!project || !cfg) throw new Error("项目或环境不存在");
  return { project, cfg, key: `${projectId}:${env}:${role}`, file: join(project.workspace_path, "scripts", "ui", ".auth", `${role}.json`) };
}

async function openRoleLogin(orch: Orchestrator, projectId: string, env: string, role: string): Promise<void> {
  if (orch.uiBusy()) throw new Error("内嵌浏览器正在执行 UI 任务或调试，请结束后再登录");
  const { cfg } = await roleLoginTarget(orch, projectId, env, role);
  await openRoleView(projectId, role, env);
  const view = testViews.get(`${projectId}:${env}:${role}`)!;
  // 已登录时打开首页即可看到登录结果；配置了登录页地址时直接打开登录页
  await view.webContents.loadURL(new URL(cfg.login?.url ?? "/", cfg.base_url).href).catch(() => undefined);
}

const SAME_SITE = { no_restriction: "None", lax: "Lax", strict: "Strict", unspecified: "Lax" } as const;

/** 把角色视图的 cookie 与当前页面的 localStorage 导出为 Playwright storageState（无头回归使用） */
async function saveRoleLogin(orch: Orchestrator, projectId: string, env: string, role: string) {
  if (orch.uiBusy()) throw new Error("内嵌浏览器正在执行 UI 任务或调试，请结束后再保存");
  const { key, file } = await roleLoginTarget(orch, projectId, env, role);
  const view = testViews.get(key);
  const url = view?.webContents.getURL() ?? "";
  if (!view || !/^https?:/.test(url)) throw new Error("请先点击「打开登录页」并在内嵌浏览器中完成登录");
  const cookies = await view.webContents.session.cookies.get({});
  const local = JSON.parse(await view.webContents.executeJavaScript("JSON.stringify(Object.entries(localStorage))")) as [string, string][];
  const state = {
    cookies: cookies.map((c) => ({
      name: c.name, value: c.value, domain: c.domain ?? new URL(url).hostname, path: c.path ?? "/",
      expires: c.expirationDate ?? -1, httpOnly: Boolean(c.httpOnly), secure: Boolean(c.secure), sameSite: SAME_SITE[c.sameSite ?? "unspecified"],
    })),
    origins: local.length ? [{ origin: new URL(url).origin, localStorage: local.map(([name, value]) => ({ name, value })) }] : [],
  };
  if (!state.cookies.length && !state.origins.length) throw new Error("没有检测到登录信息（cookie 和 localStorage 都为空），请确认已登录成功");
  mkdirSync(dirname(file), { recursive: true });
  // 登录态等同凭据：无论 workspace 的 .gitignore 怎么写，都不能被脚本登记时的 git add 提交
  const ignore = join(dirname(file), ".gitignore");
  if (!existsSync(ignore)) writeFileSync(ignore, "*\n");
  writeFileSync(file, JSON.stringify(state, null, 2), { mode: 0o600 });
  return { cookies: state.cookies.length, localStorage: local.length, url, savedAt: new Date().toISOString() };
}

/** 各角色手动登录保存的时间 */
async function roleSessions(orch: Orchestrator, projectId: string): Promise<Record<string, string>> {
  const project = (await orch.listProjects()).find((p) => p.id === projectId);
  const dir = project && join(project.workspace_path, "scripts", "ui", ".auth");
  if (!dir || !existsSync(dir)) return {};
  return Object.fromEntries(readdirSync(dir).filter((f) => f.endsWith(".json"))
    .map((f) => [f.slice(0, -5), statSync(join(dir, f)).mtime.toISOString()]));
}

async function openTestPage(url: string, scope?: { projectId: string; env: string }): Promise<void> {
  if (scope) {
    await openRoleView(scope.projectId, "default", scope.env);
    await testViews.get(`${scope.projectId}:${scope.env}:default`)!.webContents.loadURL(url);
    return;
  }
  const key = "manual:default";
  let view = testViews.get(key);
  if (!view) {
    view = new WebContentsView({ webPreferences: { partition: "persist:aitest-manual", sandbox: true } });
    keepZoom(view);
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
    listProjects: async () => rememberParents(await orch.listProjects()),
    createProject: async (name: string, ws: string, envs, opts?: Parameters<Orchestrator["createProject"]>[3]) => {
      const out = await orch.createProject(name, ws, envs, opts);
      await refreshParents(orch);
      return out;
    },
    moveProject: async (p: string, parent: string) => {
      const out = await orch.moveProject(p, parent);
      await refreshParents(orch);
      return out;
    },
    projectOverview: (g: string) => orch.projectOverview(g),
    getSettingsDetail: (p: string) => orch.getSettingsDetail(p),
    importExcel: (p: string, f: string) => orch.importExcel(p, f),
    lint: (p: string) => orch.lint(p),
    listCases: (p: string, filters) => orch.listCases(p, filters),
    pageCases: (p: string, q) => orch.pageCases(p, q),
    pageIssues: (p: string, q) => orch.pageIssues(p, q),
    pageProposals: (p: string, q) => orch.pageProposals(p, q),
    pageReviews: (p: string, q) => orch.pageReviews(p, q),
    pageAttributions: (p: string, q) => orch.pageAttributions(p, q),
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
    writeReviewedApiSuite: (p: string) => orch.writeReviewedApiSuite(p),
    listApiTestSets: (p: string) => orch.listApiTestSets(p),
    saveApiTestSet: (p: string, name: string, ids: string[]) => orch.saveApiTestSet(p, name, ids),
    runRegression: async (p: string, env: string, opts) => {
      await setApprovalContext(orch, p);
      return orch.runRegression(p, env, opts);
    },
    tokenUsage: (p: string) => orch.tokenUsage(p),
    setEnvSecret: (p: string, env: string, authToken: string, authHeader?: string) =>
      secretStore.set(SecretStore.ref(p, env), { authToken, authHeader }),
    // 留空的字段保留原值：只补接口 token 时不必重新输入账号密码
    setRoleSecret: async (p: string, role: string, username: string, password: string, token?: string) => {
      await orch.addRole(p, role);
      const prev = secretStore.getRole(p, role);
      const next = {
        username: username || prev?.username || "",
        password: password || prev?.password || "",
        ...(token !== undefined ? (token ? { token } : {}) : prev?.token ? { token: prev.token } : {}),
      };
      // 只登记角色名（用于手动登录的角色）：不存空凭据，脚本也不会用空账号去登录
      if (!next.username && !next.token) return;
      secretStore.set(SecretStore.roleRef(p, role), next);
    },
    /** 各角色已保存哪些凭据（不返回明文）：账号密码 / 接口 token，以及是否继承自大项目 */
    roleSecretStatus: (p: string) => {
      const parent = projectParents.get(p);
      const status: Record<string, { account: boolean; token: boolean; inherited: boolean }> = {};
      for (const [pid, inherited] of [...(parent ? [[parent, true] as const] : []), [p, false] as const]) {
        for (const role of secretStore.roleNames(pid)) {
          const s = secretStore.getRole(pid, role);
          status[role] = { account: Boolean(s?.username), token: Boolean(s?.token), inherited };
        }
      }
      return status;
    },
    listRoles: (p: string) => orch.listRoles(p),
    setEnvironment: (p: string, env: string, cfg) => orch.setEnvironment(p, env, cfg),
    deleteEnvironment: async (p: string, env: string) => {
      const out = await orch.deleteEnvironment(p, env);
      secretStore.delete(SecretStore.ref(p, env));
      return out;
    },
    renameProject: (p: string, name: string) => orch.renameProject(p, name),
    setProjectType: (p: string, type: Parameters<Orchestrator["setProjectType"]>[1]) => orch.setProjectType(p, type),
    clearCases: (p: string) => orch.clearCases(p),
    deleteProject: async (p: string) => {
      const out = await orch.deleteProject(p);
      // 该项目的环境 token 与角色账号一并从钥匙串删除
      secretStore.deletePrefix(`aitest:${p}:`);
      await refreshParents(orch);
      return out;
    },
    getCase: (c: string) => orch.getCase(c),
    scriptMap: (framework: string) => orch.scriptMap(framework),
    caseTitles: (p: string, ids: string[]) => orch.caseTitles(p, ids),
    exploreUiCase: async (p: string, env: string, caseId: string, opts?: { confirmProduction?: boolean }) => {
      await setApprovalContext(orch, p);
      return orch.exploreUiCase(p, env, caseId, opts);
    },
    runAppRegression: async (p: string, env: string, platform: "android" | "ios", opts?: { device?: string; confirmProduction?: boolean }) => {
      await setApprovalContext(orch, p);
      return orch.runAppRegression(p, env, platform, opts ?? {});
    },
    exploreAppCase: async (p: string, env: string, platform: "android" | "ios", caseId: string, opts?: { confirmProduction?: boolean }) => {
      await setApprovalContext(orch, p);
      return orch.exploreAppCase(p, env, platform, caseId, opts ?? {});
    },
    runUiRegression: async (p: string, env: string, headed: boolean, opts?: UiRunOptions) => {
      await setApprovalContext(orch, p);
      return orch.runUiRegression(p, env, { ...opts, headed });
    },
    uiScriptStates: (p: string, env: string) => orch.uiScriptStates(p, env),
    uiCaseGroups: (p: string) => orch.uiCaseGroups(p),
    deriveUiScripts: (p: string, env: string, id: string, opts?: { targetIds?: string[] }) => orch.deriveUiScripts(p, env, id, opts),
    confirmUiScript: (p: string, env: string, id: string, hash: string) => orch.confirmUiScript(p, env, id, hash),
    uiScriptDetail: (p: string, env: string, id: string) => orch.uiScriptDetail(p, env, id),
    uiDebugStart: (p: string, env: string, id: string, opts?: { confirmProduction?: boolean }) => orch.uiDebugStart(p, env, id, opts),
    uiDebugCommand: (command: UiDebugCommand) => orch.uiDebugCommand(command),
    uiDebugState: () => orch.uiDebugState(),
    stopUiTask: (p: string, env: string) => orch.stopUiTask(p, env),
    reviseUiScript: async (p: string, env: string, id: string, feedback: string, opts?: { confirmProduction?: boolean }) => {
      await setApprovalContext(orch, p);
      return orch.reviseUiScript(p, env, id, feedback, opts);
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
    getGlobalSettings: () => globalSettingsView(),
    saveGlobalSettings: (next: GlobalSettings, keys?: Record<string, string>) => {
      saveSettings(next, keys);
      return globalSettingsView();
    },
    checkModel: (id: string) => {
      const s = loadSettings();
      const m = s.models.find((x) => x.id === id);
      if (!m) throw new Error("模型不存在，请先保存");
      return checkModel(m, usageOf(s, id), keyOf(id));
    },
    checkRuntime: async () => {
      const [py, cx, ma, pk] = await Promise.all([
        versionOf(paths.python()), versionOf(paths.codexBin()), versionOf(maestroBin().path), versionOf(pinky().path),
      ]);
      return { python: py, codex: cx, maestro: ma, pinky: pk };
    },
    openDataDir: () => shell.openPath(paths.data()),
    getUserInfo: () => localUser(),
    getUpdateState: () => updater?.current,
    checkForUpdates: () => updater?.check(),
    installUpdate: () => updater?.install(),
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
    openTestPage: (url: string, scope?: { projectId: string; env: string }) => openTestPage(url, scope),
    dockTestView: (dock: ViewDock | null) => dockTestView(dock),
    openRoleLogin: (p: string, env: string, role: string) => openRoleLogin(orch, p, env, role),
    saveRoleLogin: (p: string, env: string, role: string) => saveRoleLogin(orch, p, env, role),
    roleSessions: (p: string) => roleSessions(orch, p),
    hideTestView: () => hideTestView(),
    // ---- 被测系统数据库 ----
    saveDatabase: async (p: string, env: string, name: string, cfg, password?: string) => {
      const out = await orch.saveDatabase(p, env, name, cfg);
      // 与连接配置存在同一个项目上（继承来的环境存到大项目）
      if (password) secretStore.setDbPassword(out.ownerId, env, name, password);
      return out;
    },
    removeDatabase: (p: string, env: string, name: string) => orch.removeDatabase(p, env, name),
    testDatabase: (p: string, env: string, name: string) => orch.testDatabase(p, env, name),
    queryDatabase: (p: string, env: string, name: string, sql: string, params?: Record<string, unknown>) =>
      orch.queryDatabase(p, env, name, sql, params ?? {}),
    hasDbPassword: (p: string, env: string, name: string) => {
      const parent = projectParents.get(p);
      return name in { ...(parent ? secretStore.dbPasswords(parent, env) : {}), ...secretStore.dbPasswords(p, env) };
    },
    readEvidenceImage: async (projectId: string, path: string) => readEvidenceImage((await orch.project(projectId)).workspace_path, path),
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

const gitConfig = (key: string) => new Promise<string>((done) =>
  execFile("git", ["config", "--global", key], { timeout: 5_000, windowsHide: true }, (err, out) => done(err ? "" : out.trim())));

/** 本机用户：git 全局配置的 user.name / user.email，未配置时用系统用户名 */
async function localUser(): Promise<UserInfo> {
  const [name, email] = await Promise.all([gitConfig("user.name"), gitConfig("user.email")]);
  if (name) return { name, ...(email ? { email } : {}), source: "git" };
  let system = "";
  try {
    system = userInfo().username;
  } catch {
    // 个别环境下取不到系统用户
  }
  return { name: system || "本机用户", ...(email ? { email } : {}), source: "system" };
}

function globalSettingsView() {
  const settings = loadSettings();
  return {
    settings,
    hasKey: Object.fromEntries(settings.models.map((m) => [m.id, Boolean(keyOf(m.id))])),
    runtime: runtimeInfo(),
  };
}

/** 子项目 → 大项目：凭据按「先子项目、后大项目」查找时使用；项目列表变化时刷新 */
const projectParents = new Map<string, string>();

function rememberParents<T extends { id: string; parent_id?: string }[]>(projects: T): T {
  projectParents.clear();
  for (const p of projects) if (p.parent_id) projectParents.set(p.id, p.parent_id);
  return projects;
}

async function refreshParents(orch: Orchestrator): Promise<void> {
  rememberParents(await orch.listProjects());
}

/**
 * 更新地址：AITEST_UPDATE_URL 优先，否则读安装包内 electron-builder 写入的 app-update.yml（publish.url）。
 * 开发模式、非 AppImage 的 Linux 不启用。
 */
function createUpdater(): Updater {
  let feedUrl = process.env.AITEST_UPDATE_URL;
  let disabledReason: string | undefined;
  if (!feedUrl) {
    try {
      const cfg = yaml.load(readFileSync(join(process.resourcesPath, "app-update.yml"), "utf8")) as { url?: string } | undefined;
      feedUrl = cfg?.url;
    } catch {
      // 开发模式或旧安装包没有 app-update.yml
    }
  }
  if (!app.isPackaged && !process.env.AITEST_UPDATE_URL) disabledReason = "开发模式不检查更新";
  else if (process.platform === "linux" && !process.env.APPIMAGE) disabledReason = "Linux 仅 AppImage 支持自动更新";
  const u = new Updater({
    currentVersion: app.getVersion(), feedUrl, disabledReason,
    platform: process.platform, arch: process.arch, execPath: process.execPath,
    downloadDir: join(app.getPath("userData"), "updates"),
    quit: () => app.quit(),
  });
  u.on("state", (s) => mainWindow?.webContents.send(CHANNELS.update, s));
  return u;
}

/** 启动 15 秒后检查一次，之后每 4 小时一次（全局设置可关闭） */
function scheduleUpdateChecks(u: Updater): void {
  const auto = () => loadSettings().general.autoUpdate !== false;
  setTimeout(() => auto() && void u.check(), 15_000);
  setInterval(() => auto() && void u.check(), 4 * 60 * 60_000);
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
  broker = await startSecretBroker(secretStore, { openView: openRoleView, parentOf: (id) => projectParents.get(id) });
  const orch = new Orchestrator({
    engine,
    agent: getCodex,
    secretEnv: (projectId, env, roles) => secretEnvFor(secretStore, projectId, env, roles, projectParents.get(projectId)),
    ui: { runUiSuite, checkData, seedData, prepareEmbedded: async (projectId, env, roles) => {
      const viewMarkers: Record<string, string> = {};
      for (const role of [...new Set(["default", ...roles])]) viewMarkers[role] = await openRoleView(projectId, role, env);
      showView(testViews.get(`${projectId}:${env}:default`)!);
      return { cdpEndpoint: `http://127.0.0.1:${CDP_PORT}`, viewMarkers };
    }, createDebugBrowser: (projectId, env, opts) => new BrowserSession({
      cdpEndpoint: `http://127.0.0.1:${CDP_PORT}`, openView: (role) => openRoleView(projectId, role, env), reuseExistingSession: true, ...opts,
    }) },
    app: { runAppSuite, maestroBin: () => maestroBin().path, pinkyEnabled: () => pinky().enabled },
    // 每次 agent 任务时读取，全局配置修改后立即生效
    get tokenLimit() {
      return taskTokenLimit().value;
    },
  });
  await refreshParents(orch).catch(() => undefined);
  orch.on("progress", (p) => {
    if ((p.stage === "ui-step" || p.stage === "ui-debug") && p.role) {
      const view = testViews.get(`${p.projectId}:${p.env}:${p.role}`);
      if (view) showView(view);
    }
    mainWindow?.webContents.send(CHANNELS.event, { method: "aitest/progress", params: p });
  });
  registerIpc(orch);
  createWindow();
  updater = createUpdater();
  scheduleUpdateChecks(updater);
});

app.on("window-all-closed", () => {
  codex?.stop();
  void broker?.close();
  if (process.platform !== "darwin") app.quit();
});
