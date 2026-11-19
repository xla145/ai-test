import { EventEmitter } from "node:events";
import { TaskManager } from "./orchestrator/taskManager.js";
import type { OrchestratorDeps } from "./orchestrator/types.js";
export * from "./orchestrator/types.js";
import { ApiTestingModule } from "./orchestrator/apiTesting.js";
import { UiTestingModule } from "./orchestrator/uiTesting.js";
import { AppTestingModule } from "./orchestrator/appTesting.js";
import { PerformanceTestingModule } from "./orchestrator/performanceTesting.js";
import { AgentTasksModule } from "./orchestrator/agentTasks.js";
import { ProjectManagementModule } from "./orchestrator/projectManagement.js";
export class Orchestrator extends EventEmitter {
  readonly tasks: TaskManager;
  private readonly apiTesting: ApiTestingModule;
  private readonly uiTesting: UiTestingModule;
  private readonly appTesting: AppTestingModule;
  private readonly performanceTesting: PerformanceTestingModule;
  private readonly agentTasks: AgentTasksModule;
  private readonly projectManagement: ProjectManagementModule;
  constructor(deps: OrchestratorDeps) {
    super();
    this.tasks = new TaskManager(deps.taskFile);
    for (const event of ["progress", "task-records", "task-progress"]) this.tasks.on(event, value => this.emit(event, value));
    this.apiTesting = new ApiTestingModule(deps, this.tasks, { project: (...args) => this.projectManagement.project(...args), agentTask: (...args) => this.agentTasks.agentTask(...args), recordAttributions: (...args) => this.projectManagement.recordAttributions(...args) });
    this.uiTesting = new UiTestingModule(deps, this.tasks, { healUi: (...args) => this.healUi(...args), project: (...args) => this.projectManagement.project(...args), agentTask: (...args) => this.agentTasks.agentTask(...args), listCases: (...args) => this.projectManagement.listCases(...args), recordAttributions: (...args) => this.projectManagement.recordAttributions(...args) });
    this.appTesting = new AppTestingModule(deps, this.tasks, { agentTask: (...args) => this.agentTasks.agentTask(...args), project: (...args) => this.projectManagement.project(...args), listCases: (...args) => this.projectManagement.listCases(...args), recordAttributions: (...args) => this.projectManagement.recordAttributions(...args) });
    this.performanceTesting = new PerformanceTestingModule(deps, this.tasks, { project: (...args) => this.projectManagement.project(...args), listApiDefinitions: (...args) => this.apiTesting.listApiDefinitions(...args) });
    this.agentTasks = new AgentTasksModule(deps, this.tasks, { project: (...args) => this.projectManagement.project(...args) });
    this.projectManagement = new ProjectManagementModule(deps, this.tasks, {});
  }
  uiTasks() { return this.tasks.snapshot().tasks; }
  taskSnapshot() { return this.tasks.snapshot(); }
  taskProgress(taskId: string) { return this.tasks.progressSnapshot(taskId); }
  stopExecutionTask(taskId: string) { return this.tasks.stop(taskId); }
  recordAgentEvent(event: { method: string; params?: any }) { return this.tasks.recordAgentEvent(event); }
  stopUiTask(...args: Parameters<UiTestingModule["stopUiTask"]>) { return this.uiTesting.stopUiTask(...args); }
  listProjects(...args: Parameters<ProjectManagementModule["listProjects"]>) { return this.projectManagement.listProjects(...args); }
  project(...args: Parameters<ProjectManagementModule["project"]>) { return this.projectManagement.project(...args); }
  createProject(...args: Parameters<ProjectManagementModule["createProject"]>) { return this.projectManagement.createProject(...args); }
  moveProject(...args: Parameters<ProjectManagementModule["moveProject"]>) { return this.projectManagement.moveProject(...args); }
  projectOverview(...args: Parameters<ProjectManagementModule["projectOverview"]>) { return this.projectManagement.projectOverview(...args); }
  importExcel(...args: Parameters<ProjectManagementModule["importExcel"]>) { return this.projectManagement.importExcel(...args); }
  exportCaseTemplate(...args: Parameters<ProjectManagementModule["exportCaseTemplate"]>) { return this.projectManagement.exportCaseTemplate(...args); }
  lint(...args: Parameters<ProjectManagementModule["lint"]>) { return this.projectManagement.lint(...args); }
  listCases(...args: Parameters<ProjectManagementModule["listCases"]>) { return this.projectManagement.listCases(...args); }
  pageCases(...args: Parameters<ProjectManagementModule["pageCases"]>) { return this.projectManagement.pageCases(...args); }
  pageIssues(...args: Parameters<ProjectManagementModule["pageIssues"]>) { return this.projectManagement.pageIssues(...args); }
  updateCase(...args: Parameters<ProjectManagementModule["updateCase"]>) { return this.projectManagement.updateCase(...args); }
  applyFix(...args: Parameters<ProjectManagementModule["applyFix"]>) { return this.projectManagement.applyFix(...args); }
  tokenUsage(...args: Parameters<ProjectManagementModule["tokenUsage"]>) { return this.projectManagement.tokenUsage(...args); }
  listApiDefinitions(...args: Parameters<ApiTestingModule["listApiDefinitions"]>) { return this.apiTesting.listApiDefinitions(...args); }
  previewApiImport(...args: Parameters<ApiTestingModule["previewApiImport"]>) { return this.apiTesting.previewApiImport(...args); }
  importApiDefinitions(...args: Parameters<ApiTestingModule["importApiDefinitions"]>) { return this.apiTesting.importApiDefinitions(...args); }
  saveApiCase(...args: Parameters<ApiTestingModule["saveApiCase"]>) { return this.apiTesting.saveApiCase(...args); }
  generateDefinitionCases(...args: Parameters<ApiTestingModule["generateDefinitionCases"]>) { return this.apiTesting.generateDefinitionCases(...args); }
  previewApiParameterCases(...args: Parameters<ApiTestingModule["previewApiParameterCases"]>) { return this.apiTesting.previewApiParameterCases(...args); }
  saveApiParameterCases(...args: Parameters<ApiTestingModule["saveApiParameterCases"]>) { return this.apiTesting.saveApiParameterCases(...args); }
  listApiDebugHistory(...args: Parameters<ApiTestingModule["listApiDebugHistory"]>) { return this.apiTesting.listApiDebugHistory(...args); }
  debugApiRequest(...args: Parameters<ApiTestingModule["debugApiRequest"]>) { return this.apiTesting.debugApiRequest(...args); }
  stopApiDebug(...args: Parameters<ApiTestingModule["stopApiDebug"]>) { return this.apiTesting.stopApiDebug(...args); }
  generateApiSuite(...args: Parameters<ApiTestingModule["generateApiSuite"]>) { return this.apiTesting.generateApiSuite(...args); }
  generateCases(...args: Parameters<ApiTestingModule["generateCases"]>) { return this.apiTesting.generateCases(...args); }
  writeReviewedApiSuite(...args: Parameters<ApiTestingModule["writeReviewedApiSuite"]>) { return this.apiTesting.writeReviewedApiSuite(...args); }
  listApiTestSets(...args: Parameters<ApiTestingModule["listApiTestSets"]>) { return this.apiTesting.listApiTestSets(...args); }
  saveApiTestSet(...args: Parameters<ApiTestingModule["saveApiTestSet"]>) { return this.apiTesting.saveApiTestSet(...args); }
  runRegression(...args: Parameters<ApiTestingModule["runRegression"]>) { return this.apiTesting.runRegression(...args); }
  triage(...args: Parameters<ApiTestingModule["triage"]>) { return this.apiTesting.triage(...args); }
  exploreUiCase(...args: Parameters<UiTestingModule["exploreUiCase"]>) { return this.uiTesting.exploreUiCase(...args); }
  exploreAppCase(...args: Parameters<AppTestingModule["exploreAppCase"]>) { return this.appTesting.exploreAppCase(...args); }
  runAppRegression(...args: Parameters<AppTestingModule["runAppRegression"]>) { return this.appTesting.runAppRegression(...args); }
  scriptMap(...args: Parameters<ProjectManagementModule["scriptMap"]>) { return this.projectManagement.scriptMap(...args); }
  prepareData(...args: Parameters<UiTestingModule["prepareData"]>) { return this.uiTesting.prepareData(...args); }
  runUiRegression(...args: Parameters<UiTestingModule["runUiRegression"]>) { return this.uiTesting.runUiRegression(...args); }
  uiScriptStates(...args: Parameters<UiTestingModule["uiScriptStates"]>) { return this.uiTesting.uiScriptStates(...args); }
  uiCaseGroups(...args: Parameters<UiTestingModule["uiCaseGroups"]>) { return this.uiTesting.uiCaseGroups(...args); }
  deriveUiScripts(...args: Parameters<UiTestingModule["deriveUiScripts"]>) { return this.uiTesting.deriveUiScripts(...args); }
  confirmUiScript(...args: Parameters<UiTestingModule["confirmUiScript"]>) { return this.uiTesting.confirmUiScript(...args); }
  uiScriptDetail(...args: Parameters<UiTestingModule["uiScriptDetail"]>) { return this.uiTesting.uiScriptDetail(...args); }
  uiDebugStart(...args: Parameters<UiTestingModule["uiDebugStart"]>) { return this.uiTesting.uiDebugStart(...args); }
  uiDebugCommand(...args: Parameters<UiTestingModule["uiDebugCommand"]>) { return this.uiTesting.uiDebugCommand(...args); }
  uiBusy(...args: Parameters<UiTestingModule["uiBusy"]>) { return this.uiTesting.uiBusy(...args); }
  uiDebugState(...args: Parameters<UiTestingModule["uiDebugState"]>) { return this.uiTesting.uiDebugState(...args); }
  reviseUiScript(...args: Parameters<UiTestingModule["reviseUiScript"]>) { return this.uiTesting.reviseUiScript(...args); }
  healUi(...args: Parameters<UiTestingModule["healUi"]>) { return this.uiTesting.healUi(...args); }
  pageProposals(...args: Parameters<ProjectManagementModule["pageProposals"]>) { return this.projectManagement.pageProposals(...args); }
  pageReviews(...args: Parameters<ProjectManagementModule["pageReviews"]>) { return this.projectManagement.pageReviews(...args); }
  listProposals(...args: Parameters<ProjectManagementModule["listProposals"]>) { return this.projectManagement.listProposals(...args); }
  resolveProposal(...args: Parameters<ProjectManagementModule["resolveProposal"]>) { return this.projectManagement.resolveProposal(...args); }
  listReviews(...args: Parameters<ProjectManagementModule["listReviews"]>) { return this.projectManagement.listReviews(...args); }
  resolveReview(...args: Parameters<ProjectManagementModule["resolveReview"]>) { return this.projectManagement.resolveReview(...args); }
  listRoles(...args: Parameters<ProjectManagementModule["listRoles"]>) { return this.projectManagement.listRoles(...args); }
  addRole(...args: Parameters<ProjectManagementModule["addRole"]>) { return this.projectManagement.addRole(...args); }
  setEnvironment(...args: Parameters<ProjectManagementModule["setEnvironment"]>) { return this.projectManagement.setEnvironment(...args); }
  deleteEnvironment(...args: Parameters<ProjectManagementModule["deleteEnvironment"]>) { return this.projectManagement.deleteEnvironment(...args); }
  renameProject(...args: Parameters<ProjectManagementModule["renameProject"]>) { return this.projectManagement.renameProject(...args); }
  setProjectType(...args: Parameters<ProjectManagementModule["setProjectType"]>) { return this.projectManagement.setProjectType(...args); }
  clearCases(...args: Parameters<ProjectManagementModule["clearCases"]>) { return this.projectManagement.clearCases(...args); }
  deleteProject(...args: Parameters<ProjectManagementModule["deleteProject"]>) { return this.projectManagement.deleteProject(...args); }
  getCase(...args: Parameters<ProjectManagementModule["getCase"]>) { return this.projectManagement.getCase(...args); }
  caseTitles(...args: Parameters<ProjectManagementModule["caseTitles"]>) { return this.projectManagement.caseTitles(...args); }
  pageAttributions(...args: Parameters<ProjectManagementModule["pageAttributions"]>) { return this.projectManagement.pageAttributions(...args); }
  listAttributions(...args: Parameters<ProjectManagementModule["listAttributions"]>) { return this.projectManagement.listAttributions(...args); }
  confirmAttribution(...args: Parameters<ProjectManagementModule["confirmAttribution"]>) { return this.projectManagement.confirmAttribution(...args); }
  usageReport(...args: Parameters<ProjectManagementModule["usageReport"]>) { return this.projectManagement.usageReport(...args); }
  checkBudget(...args: Parameters<ProjectManagementModule["checkBudget"]>) { return this.projectManagement.checkBudget(...args); }
  getSettings(...args: Parameters<ProjectManagementModule["getSettings"]>) { return this.projectManagement.getSettings(...args); }
  getSettingsDetail(...args: Parameters<ProjectManagementModule["getSettingsDetail"]>) { return this.projectManagement.getSettingsDetail(...args); }
  setSettings(...args: Parameters<ProjectManagementModule["setSettings"]>) { return this.projectManagement.setSettings(...args); }
  metrics(...args: Parameters<ProjectManagementModule["metrics"]>) { return this.projectManagement.metrics(...args); }
  caseHistory(...args: Parameters<ProjectManagementModule["caseHistory"]>) { return this.projectManagement.caseHistory(...args); }
  coverage(...args: Parameters<ProjectManagementModule["coverage"]>) { return this.projectManagement.coverage(...args); }
  performanceHistory(...args: Parameters<PerformanceTestingModule["performanceHistory"]>) { return this.performanceTesting.performanceHistory(...args); }
  runPerformance(...args: Parameters<PerformanceTestingModule["runPerformance"]>) { return this.performanceTesting.runPerformance(...args); }
  stability(...args: Parameters<ProjectManagementModule["stability"]>) { return this.projectManagement.stability(...args); }
  perfCompile(...args: Parameters<PerformanceTestingModule["perfCompile"]>) { return this.performanceTesting.perfCompile(...args); }
  perfSetBaseline(...args: Parameters<PerformanceTestingModule["perfSetBaseline"]>) { return this.performanceTesting.perfSetBaseline(...args); }
  perfGetBaseline(...args: Parameters<PerformanceTestingModule["perfGetBaseline"]>) { return this.performanceTesting.perfGetBaseline(...args); }
  perfTrend(...args: Parameters<PerformanceTestingModule["perfTrend"]>) { return this.performanceTesting.perfTrend(...args); }
  exportWorkspace(...args: Parameters<ProjectManagementModule["exportWorkspace"]>) { return this.projectManagement.exportWorkspace(...args); }
  importWorkspace(...args: Parameters<ProjectManagementModule["importWorkspace"]>) { return this.projectManagement.importWorkspace(...args); }
  environmentOwner(...args: Parameters<ProjectManagementModule["environmentOwner"]>) { return this.projectManagement.environmentOwner(...args); }
  saveDatabase(...args: Parameters<ProjectManagementModule["saveDatabase"]>) { return this.projectManagement.saveDatabase(...args); }
  removeDatabase(...args: Parameters<ProjectManagementModule["removeDatabase"]>) { return this.projectManagement.removeDatabase(...args); }
  testDatabase(...args: Parameters<ProjectManagementModule["testDatabase"]>) { return this.projectManagement.testDatabase(...args); }
  queryDatabase(...args: Parameters<ProjectManagementModule["queryDatabase"]>) { return this.projectManagement.queryDatabase(...args); }
  listRuns(...args: Parameters<ProjectManagementModule["listRuns"]>) { return this.projectManagement.listRuns(...args); }
  runDetail(...args: Parameters<ProjectManagementModule["runDetail"]>) { return this.projectManagement.runDetail(...args); }
  exportReport(...args: Parameters<ProjectManagementModule["exportReport"]>) { return this.projectManagement.exportReport(...args); }
  exportCasesExcel(...args: Parameters<ProjectManagementModule["exportCasesExcel"]>) { return this.projectManagement.exportCasesExcel(...args); }
  agentTask(...args: Parameters<AgentTasksModule["agentTask"]>) { return this.agentTasks.agentTask(...args); }
}
