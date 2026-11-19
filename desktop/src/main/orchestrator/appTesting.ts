import type {
  Platform
} from "@ai-test/mcp-servers";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appExplorePrompt
} from "../prompts.js";
import type { AgentTasksModule } from "./agentTasks.js";
import type { ProjectManagementModule } from "./projectManagement.js";
import { TaskManager } from "./taskManager.js";
import { AppDeps, CaseRow, OrchestratorDeps, ProductionConfirmRequired, RunSummary, UiFailure } from "./types.js";
export class AppTestingModule {
  constructor(private deps: OrchestratorDeps, private tasks: TaskManager, private services: { agentTask: AgentTasksModule["agentTask"]; project: ProjectManagementModule["project"]; listCases: ProjectManagementModule["listCases"]; recordAttributions: ProjectManagementModule["recordAttributions"] }) { }
  private emit(_event: string, payload: Record<string, any>) { this.tasks.progress(payload); }
  async exploreAppCase(projectId: string, env: string, platform: Platform, caseId: string, opts: { confirmProduction?: boolean } = {}) {
    const app = this.requireApp();
    if (!app.pinkyEnabled?.()) throw new Error("未启用 Pinky：请先安装 Pinky，并在「全局设置 → 运行环境」中启用");
    const envCfg = await this.appEnv(projectId, env, platform, opts.confirmProduction);
    return this.services.agentTask(projectId, "app_explore", appExplorePrompt(projectId, env, platform, caseId, envCfg.app![platform]!), undefined, 0, { env, caseIds: [caseId] });
  }

  async runAppRegression(projectId: string, env: string, platform: Platform,
    opts: { device?: string; confirmProduction?: boolean } = {}) {
    return this.tasks.enqueue(`app-device:${platform}:${opts.device ?? "default"}`, { projectId, env, kind: "App 回归", source: "app", caseIds: [] }, async ({ signal }) => {
      const app = this.requireApp();
      const project = await this.services.project(projectId);
      const envCfg = await this.appEnv(projectId, env, platform, opts.confirmProduction);
      const scripts = await this.deps.engine<{ case_id: string; framework: string }[]>(["list-scripts"]);
      const flows = new Set(scripts.filter((s) => s.framework === "maestro").map((s) => s.case_id));
      const cases = (await this.services.listCases(projectId)) as CaseRow[];
      const caseIds = cases.filter((c) => flows.has(c.id) && c.status !== "deprecated").map((c) => c.id);
      if (!caseIds.length) throw new Error("没有可执行的 App 脚本，请先用探索模式生成");

      const roles = (await this.deps.engine<{ role_name: string }[]>(["list-roles", "--project", projectId])).map((r) => r.role_name);
      const secret = this.deps.secretEnv(projectId, env, roles);
      this.emit("progress", { projectId, stage: "app-run", env, platform, cases: caseIds.length });
      signal.throwIfAborted();
      this.tasks.step("execute");
      const out = await app.runAppSuite({
        signal,
        workspace: project.workspace_path, platform, appId: envCfg.app![platform]!, caseIds, device: opts.device || undefined,
        roles: secret.AITEST_ROLES ? JSON.parse(secret.AITEST_ROLES) : [], maestroBin: app.maestroBin?.(),
      });
      signal.throwIfAborted();
      this.tasks.step("collect-results", { count: out.results.length });
      if (!out.results.length) throw new Error(`Maestro 没有产出结果：${out.errors.join("；") || "未知错误"}`);
      const file = join(mkdtempSync(join(tmpdir(), "aitest-run-")), "results.json");
      writeFileSync(file, JSON.stringify(out.results));
      const run = await this.deps.engine<RunSummary>([
        "save-run", "--project", projectId, "--env", env, "--results-file", file, "--framework", "maestro",
      ]);
      const saved = await this.deps.engine<UiFailure[]>(["list-run-results", "--run", run.run_id]);
      const failures: UiFailure[] = (Array.isArray(saved) ? saved : [])
        .filter((r) => r.status === "failed" || r.status === "error")
        .map((r) => ({ case_id: r.case_id, status: r.status, message: (r.message ?? "").slice(0, 500), failure_type: r.failure_type ?? "unknown" }));
      await this.services.recordAttributions(run.run_id, failures.map((f) => ({ case_id: f.case_id, failure_type: f.failure_type, reason: "确定性规则判定" })), "rule");
      return { run, failures, platform, report: out.outDir };
    });
  }

  async appEnv(projectId: string, env: string, platform: Platform, confirmProduction?: boolean) {
    const project = await this.services.project(projectId);
    const envCfg = project.environments[env];
    if (!envCfg) throw new Error(`项目未配置环境：${env}`);
    if (envCfg.production && !confirmProduction) throw new ProductionConfirmRequired(env);
    if (!envCfg.app?.[platform]) {
      throw new Error(`环境「${env}」没有配置${platform === "ios" ? " iOS Bundle ID" : " Android 包名"}，请在项目设置的执行环境中填写`);
    }
    return envCfg;
  }

  requireApp(): AppDeps {
    if (!this.deps.app) throw new Error("未启用 App 执行器");
    return this.deps.app;
  }
}
