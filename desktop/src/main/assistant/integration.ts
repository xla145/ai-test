import { AssistantService } from "./service.js";
import type { AssistantApi, AssistantDraft } from "../../shared/assistant.js";
import type { Orchestrator, EngineCall } from "../orchestrator.js";
import type { DirectStore } from "../directStore.js";
import type { ChatMessage } from "./model.js";

interface Options {
  orchestrator: Orchestrator;
  store: DirectStore;
  engine: EngineCall;
  file: string;
  complete: (projectId: string, messages: ChatMessage[], signal: AbortSignal) => Promise<{ text: string; tokens: number }>;
}
export function createAssistant({ orchestrator: orch, store, engine, file, complete }: Options): AssistantApi {
  try { return new AssistantService({
    tasks: orch.tasks,
    project: id => orch.project(id),
    listCases: async id => store.listCases(id) as Record<string, any>[],
    listDefinitions: id => orch.listApiDefinitions(id),
    listRuns: async id => store.listRuns(id, 100) as Record<string, any>[],
    runDetail: id => orch.runDetail(id),
    complete,
    saveDraft: (projectId: string, draft: AssistantDraft) => engine(["create-case", "--project", projectId, "--json", JSON.stringify({
      title: draft.title, priority: draft.priority, steps: draft.steps, expected: draft.expected,
      type: "api", execution_mode: "manual", category: "功能测试", status: "draft",
      module_path: ["助手建议"], preconditions: [], requirement_ids: [],
    })]),
    runRegression: async (projectId, env, caseIds, signal) => {
      signal.throwIfAborted();
      const project = await orch.project(projectId);
      if (!project.environments[env] || project.environments[env].production) throw new Error("助手仅允许在明确选择的非生产环境执行");
      const available = new Map((store.listCases(projectId) as Record<string, any>[]).map(c => [c.id, c]));
      if (!caseIds.length || caseIds.some(id => {
        const c = available.get(id);
        return !c || c.status !== "reviewed" || c.execution_mode !== "api" || c.lint_status === "blocked" || c.api_needs_review || !(c.api || c.api_flow?.length);
      })) throw new Error("选中用例的审核或规范检查状态已变化，请重新准备回归");
      await orch.writeReviewedApiSuite(projectId);
      signal.throwIfAborted();
      return orch.runRegression(projectId, env, { caseIds, autoTriage: false, preferEnvToken: false, checkBusinessCode: true });
    },
  }, file); } catch {
    const unavailable = async (): Promise<never> => { throw new Error("助手会话历史无法读取，已禁止助手操作；请备份并检查本地 assistant-conversations.json，其他测试功能不受影响"); };
    return { assistantConversations: unavailable, assistantCreateConversation: unavailable, assistantConversation: unavailable,
      assistantSend: unavailable, assistantConfirm: unavailable, assistantCancelOperation: unavailable, assistantStop: unavailable };
  }
}
