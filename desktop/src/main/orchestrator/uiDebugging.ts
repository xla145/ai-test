import type {
  LoginRecipe
} from "@ai-test/mcp-servers";
import { join } from "node:path";
import type { UiDebugCommand, UiDebugState } from "../../shared/ipc.js";
import { UiDebugSession } from "../uiDebug.js";
import { UiWorkflow } from "../uiWorkflow.js";
import type { ProjectManagementModule } from "./projectManagement.js";
import { TaskManager } from "./taskManager.js";
import { EnvironmentInfo, OrchestratorDeps } from "./types.js";
import type { UiTestingModule } from "./uiTesting.js";
export class UiDebugModule {
  session?: UiDebugSession;
  private starting = false;
  get busy() { return this.starting || !!this.session; }
  constructor(private deps: OrchestratorDeps, private tasks: TaskManager, private services: { project: ProjectManagementModule["project"]; uiTaskActive: () => boolean; requireUi: UiTestingModule["requireUi"]; uiCase: UiTestingModule["uiCase"]; uiScriptStates: UiTestingModule["uiScriptStates"] }) { }
  private emit(_event: string, payload: Record<string, any>) { this.tasks.progress(payload); }
  private async start(projectId: string, env: string, caseId: string, opts: { confirmProduction?: boolean } = {}): Promise<UiDebugState> {
    if (this.services.uiTaskActive()) throw new Error("已有 UI 任务正在执行，请等待完成后再调试");
    if (this.session) throw new Error("已有调试会话，请先结束调试");
    const ui = this.services.requireUi();
    if (!ui.createDebugBrowser) throw new Error("当前运行环境不支持内嵌浏览器调试");
    const p = await this.services.project(projectId);
    await this.services.uiCase(projectId, env, caseId, opts.confirmProduction);
    const state = (await this.services.uiScriptStates(projectId, env))[caseId];
    if (!state) throw new Error("请先生成该用例的脚本");
    const file = new UiWorkflow(p.workspace_path).stepsFile(state.path);
    const envCfg = p.environments[env] as EnvironmentInfo & { testid_attribute?: string };
    const roles = [...new Set(file.steps.map((s) => s.role ?? "default"))];
    const secretEnv = this.deps.secretEnv(projectId, env, roles.filter((r) => r !== "default"));
    const creds: { role: string; username: string; password: string }[] = JSON.parse(secretEnv.AITEST_ROLES || "[]");
    const browser = ui.createDebugBrowser(projectId, env, { baseUrl: envCfg.base_url, testIdAttribute: envCfg.testid_attribute });
    const hasDb = Boolean(envCfg.databases && Object.keys(envCfg.databases).length);
    this.session = new UiDebugSession({
      projectId, env, caseId, file, browser,
      prepareRole: async (role) => {
        const cred = creds.find((c) => c.role === role);
        await browser.newRoleContext(role, role === "default" || !cred ? {} : {
          login: envCfg.login as unknown as LoginRecipe, credentials: { username: cred.username, password: cred.password },
        });
      },
      runOptions: {
        secrets: secretEnv,
        evidenceDir: join(p.workspace_path, "evidence", "debug"),
        ...(hasDb ? {
          dbCheck: async (check: unknown) => {
            const res = await this.deps.engine<{ ok: boolean; errors: string[]; rows: unknown[] }>(
              ["db-check", "--project", projectId, "--env", env, "--spec", JSON.stringify(check)], secretEnv);
            if (!res.ok) throw new Error(`断言不成立：${res.errors.join("；")}；查询结果：${JSON.stringify(res.rows.slice(0, 5))}`);
          }
        } : {}),
      },
      emit: (s, role) => this.emit("progress", { projectId, env, stage: "ui-debug", caseId, role, state: s }),
    });
    return this.session.state();
  }

  async uiDebugCommand(command: UiDebugCommand): Promise<UiDebugState> {
    const session = this.session;
    if (!session) throw new Error("没有进行中的调试");
    const state = await session.command(command);
    if (state.phase === "stopped") this.session = undefined;
    return state;
  }

  uiDebugState(): UiDebugState | null {
    return this.session?.state() ?? null;
  }

  async uiDebugStart(projectId: string, env: string, caseId: string, opts: { confirmProduction?: boolean } = {}): Promise<UiDebugState> {
    if (this.busy) throw new Error("已有调试会话，请先结束调试");
    if (this.services.uiTaskActive()) throw new Error("已有 UI 任务正在执行，请等待完成后再调试");
    this.starting = true;
    try { return await this.start(projectId, env, caseId, opts); } finally { this.starting = false; }
  }
}
