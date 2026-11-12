// 预加载脚本必须是 CommonJS（沙箱模式）
import { contextBridge, ipcRenderer } from "electron";

const invoke = (method: string, ...args: unknown[]) => ipcRenderer.invoke("aitest:invoke", method, ...args);

function subscribe<T>(channel: string, cb: (v: T) => void): () => void {
  const listener = (_e: unknown, v: T) => cb(v);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const methods = [
  "listProjects", "createProject", "importExcel", "lint", "listCases", "updateCase", "applyFix",
  "generateApiSuite", "generateCases", "runRegression", "tokenUsage", "setEnvSecret",
  "writeReviewedApiSuite", "listApiTestSets", "saveApiTestSet",
  "setProjectType",
  "pickFile", "pickDirectory", "openTestPage",
  "setRoleSecret", "listRoles", "setEnvironment", "exploreUiCase", "runUiRegression",
  "uiScriptStates", "uiCaseGroups", "deriveUiScripts", "confirmUiScript", "reviseUiScript", "uiScriptDetail", "dockTestView", "uiDebugStart", "uiDebugCommand", "uiDebugState", "stopUiTask", "openRoleLogin", "saveRoleLogin", "roleSessions",
  "listProposals", "resolveProposal", "listReviews", "resolveReview",
  "usageReport", "checkBudget", "getSettings", "setSettings", "metrics", "stability", "listAttributions",
  "confirmAttribution", "exportWorkspace", "importWorkspace", "initCi", "modelPresets", "getGlobalSettings",
  "saveGlobalSettings", "checkModel", "checkRuntime", "getUserInfo", "openDataDir", "hideTestView",
  "runAppRegression", "exploreAppCase",
  "getUpdateState", "checkForUpdates", "installUpdate",
  "moveProject", "projectOverview", "getSettingsDetail",
  "deleteEnvironment", "renameProject", "deleteProject", "clearCases", "getCase", "caseTitles", "scriptMap", "roleSecretStatus",
  "pageCases", "pageIssues", "pageProposals", "pageReviews", "pageAttributions",
  "saveDatabase", "removeDatabase", "testDatabase", "queryDatabase", "hasDbPassword",
  "listRuns", "runDetail", "exportReport", "exportCasesExcel", "readEvidenceImage", "openPath", "showInFolder",
] as const;

const api: Record<string, unknown> = Object.fromEntries(methods.map((m) => [m, (...a: unknown[]) => invoke(m, ...a)]));
api.onApprovalRequest = (cb: (v: unknown) => void) => subscribe("aitest:approval-request", cb);
api.respondApproval = (id: string, accept: boolean) => ipcRenderer.send("aitest:approval-response", id, accept);
api.onEvent = (cb: (v: unknown) => void) => subscribe("aitest:event", cb);
api.onViewChange = (cb: (v: unknown) => void) => subscribe("aitest:view", cb);
api.onUpdate = (cb: (v: unknown) => void) => subscribe("aitest:update", cb);

contextBridge.exposeInMainWorld("aitest", api);
