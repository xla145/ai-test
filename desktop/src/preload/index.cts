// 预加载脚本必须是 CommonJS（沙箱模式）
import { contextBridge, ipcRenderer } from "electron";
import type { AitestApi } from "../shared/ipc.js" with { "resolution-mode": "import" };

const invoke = (method: string, ...args: unknown[]) => ipcRenderer.invoke("aitest:invoke", method, ...args);

function subscribe<T>(channel: string, cb: (v: T) => void): () => void {
  const listener = (_e: unknown, v: T) => cb(v);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const methods = [
  "assistantConversations", "assistantCreateConversation", "assistantConversation", "assistantSend", "assistantConfirm", "assistantCancelOperation", "assistantStop",
  "listApiDefinitions", "previewApiImport", "importApiDefinitions", "saveApiCase", "generateDefinitionCases", "previewApiParameterCases", "saveApiParameterCases", "debugApiRequest", "stopApiDebug", "listApiDebugHistory",
  "listProjects", "createProject", "importExcel", "exportCaseTemplate", "lint", "listCases", "updateCase", "applyFix",
  "generateApiSuite", "generateCases", "runRegression", "tokenUsage", "setEnvSecret", "openApiLogin", "saveApiLogin",
  "writeReviewedApiSuite", "listApiTestSets", "saveApiTestSet",
  "setProjectType",
  "pickFile", "pickDirectory", "openTestPage",
  "setRoleSecret", "listRoles", "setEnvironment", "exploreUiCase", "runUiRegression",
  "taskSnapshot", "taskProgress", "exportDiagnostics", "stopExecutionTask", "uiTasks", "uiScriptStates", "uiCaseGroups", "deriveUiScripts", "confirmUiScript", "reviseUiScript", "uiScriptDetail", "dockTestView", "uiDebugStart", "uiDebugCommand", "uiDebugState", "stopUiTask", "openRoleLogin", "saveRoleLogin", "roleSessions",
  "listProposals", "resolveProposal", "listReviews", "resolveReview",
  "usageReport", "checkBudget", "getSettings", "setSettings", "metrics", "coverage", "caseHistory", "runPerformance", "performanceHistory", "stability", "listAttributions",
  "perfCompile", "perfSetBaseline", "perfGetBaseline", "perfTrend",
  "confirmAttribution", "exportWorkspace", "importWorkspace", "initCi", "modelPresets", "getGlobalSettings",
  "saveGlobalSettings", "checkModel", "checkRuntime", "getUserInfo", "openDataDir", "hideTestView",
  "runAppRegression", "exploreAppCase",
  "getUpdateState", "checkForUpdates", "installUpdate",
  "moveProject", "projectOverview", "getSettingsDetail",
  "deleteEnvironment", "renameProject", "deleteProject", "clearCases", "getCase", "caseTitles", "scriptMap", "roleSecretStatus",
  "pageCases", "pageIssues", "pageProposals", "pageReviews", "pageAttributions",
  "saveDatabase", "removeDatabase", "testDatabase", "queryDatabase", "hasDbPassword",
  "listRuns", "runDetail", "exportReport", "exportCasesExcel", "readEvidenceImage", "openPath", "showInFolder",
] as const satisfies readonly (keyof AitestApi)[];

const invoked = Object.fromEntries(methods.map((m) => [m, (...a: unknown[]) => invoke(m, ...a)])) as
  Record<(typeof methods)[number], (...args: unknown[]) => Promise<unknown>>;
// 对齐接口声明中的每个方法；漏加 preload 时在编译期失败，而不是等用户点击才报错。
const api = {
  ...invoked,
  onApprovalRequest: (cb: (v: unknown) => void) => subscribe("aitest:approval-request", cb),
  respondApproval: (id: string, accept: boolean) => ipcRenderer.send("aitest:approval-response", id, accept),
  onEvent: (cb: (v: unknown) => void) => subscribe("aitest:event", cb),
  onViewChange: (cb: (v: unknown) => void) => subscribe("aitest:view", cb),
  onUpdate: (cb: (v: unknown) => void) => subscribe("aitest:update", cb),
} satisfies Record<keyof AitestApi, unknown>;

contextBridge.exposeInMainWorld("aitest", api);
contextBridge.exposeInMainWorld("desktopHost", { platform: process.platform });
