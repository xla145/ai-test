import type { OrchestratorDeps, CaseRow } from "./types.js";
import type { ProjectManagementModule } from "./projectManagement.js";
export class DataManagementModule {
  constructor(private deps: OrchestratorDeps, private services: { project: ProjectManagementModule["project"] }) { }
  async prepareData(projectId: string, env: string, cases: CaseRow[], signal?: AbortSignal) {
    const ui = this.deps.ui;
    if (!ui) throw new Error("未启用 UI 执行器");
    const project = await this.services.project(projectId);
    const envCfg = project.environments[env];
    const keys = [...new Set(cases.flatMap((c) => c.data_refs ?? []))];
    if (!keys.length) return { missing: [] as string[], degraded: [] as string[] };
    const records = await this.deps.engine<{ key: string; check_script?: string; seed_script?: string }[]>(["list-test-data", "--project", projectId]);
    const auth = this.deps.secretEnv(projectId, env).AITEST_AUTH_TOKEN;
    const status = await ui.checkData(envCfg, keys, records, project.workspace_path, { authToken: auth });
    const absent = status.filter((s) => s.exists === false).map((s) => s.key);
    signal?.throwIfAborted();
    const seeded = absent.length ? await ui.seedData(envCfg, absent, records, project.workspace_path, { authToken: auth }) : [];
    const missing = seeded.filter((s) => !s.seeded).map((s) => s.key);
    const degraded = cases.filter((c) => (c.data_refs ?? []).some((k) => missing.includes(k))).map((c) => c.id);
    return { missing, degraded };
  }
}
