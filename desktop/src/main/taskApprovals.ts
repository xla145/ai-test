import type { ApprovalContext } from "./approval.js";
import type { ProjectInfo } from "./orchestrator/types.js";
/** Thread-scoped policy: never fall back to whichever project was clicked most recently. */
export class TaskApprovals {
  private contexts = new Map<string, ApprovalContext>();
  bind(threadId: string, project: ProjectInfo) {
    const hosts = (production: boolean) => Object.values(project.environments ?? {}).flatMap(env => {
      if (!!env.production !== production) return [];
      try { return [new URL(env.base_url).hostname]; } catch { return []; }
    });
    this.contexts.set(threadId, { workspace: project.workspace_path, allowedHosts: hosts(false), productionHosts: hosts(true) });
  }
  get(threadId: string) { return this.contexts.get(threadId); }
  release(threadId: string) { this.contexts.delete(threadId); }
}
