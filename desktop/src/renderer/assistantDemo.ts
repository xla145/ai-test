import type { AssistantApi, AssistantConversation, AssistantOperation, AssistantReference } from "../shared/assistant";

export function createAssistantDemo(): AssistantApi {
  const conversations = new Map<string, AssistantConversation>();
  const requests = new Set<string>();
  const clone = <T,>(value: T): T => structuredClone(value);
  const now = () => new Date().toISOString();
  const get = (projectId: string, id: string) => {
    const c = conversations.get(id);
    if (!c || c.projectId !== projectId) throw new Error("当前项目中找不到该会话");
    return c;
  };
  const append = (c: AssistantConversation, content: string, references?: AssistantReference[]) => {
    c.messages.push({ id: crypto.randomUUID(), role: "assistant", content, createdAt: now(), references });
    c.updatedAt = now();
  };
  return {
    assistantConversations: async projectId => [...conversations.values()].filter(c => c.projectId === projectId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(c => ({ id: c.id, projectId, title: c.title, updatedAt: c.updatedAt, busy: c.busy })),
    assistantCreateConversation: async projectId => {
      const c: AssistantConversation = { id: crypto.randomUUID(), projectId, title: "新对话", updatedAt: now(), busy: false,
        messages: [], operations: [], notice: "演示预览：回答和结果均为合成示例，不调用模型、不发送测试请求、不写入真实项目；刷新后重置。" };
      conversations.set(c.id, c); return clone(c);
    },
    assistantConversation: async (p, id) => clone(get(p, id)),
    assistantSend: async (p, id, input) => {
      const c = get(p, id);
      if (requests.has(`${id}:${input.requestId}`)) return clone(c);
      if (c.busy) throw new Error("当前对话正在处理中");
      if (!input.text.trim()) throw new Error("请输入问题");
      if (input.mode !== "regression" && !input.consent) throw new Error("请确认本轮模型数据发送范围");
      if (input.mode === "regression" && (!input.context.env || input.context.env === "prod")) throw new Error("请选择非生产环境");
      if (input.mode === "regression" && !input.context.references.some(r => r.kind === "case" || r.kind === "definition")) throw new Error("请先在接口或用例页选择执行对象");
      requests.add(`${id}:${input.requestId}`);
      c.title = input.text.slice(0, 28); c.busy = true;
      c.messages.push({ id: crypto.randomUUID(), role: "user", content: input.text, createdAt: now(), context: clone(input.context) });
      const context = clone(input.context);
      window.setTimeout(() => {
        if (!c.busy) return;
        if (input.mode === "draft" || input.mode === "regression") {
          const draft = input.mode === "draft";
          const op: AssistantOperation = {
            id: crypto.randomUUID(), kind: draft ? "save-drafts" : "run-regression", status: "pending",
            title: draft ? "保存测试场景草稿" : "执行选中范围的接口回归", createdAt: now(), expiresAt: new Date(Date.now() + 900_000).toISOString(), context,
            summary: draft ? "演示：保存为待审核的手工场景草稿，不会直接生成或执行脚本。" : "演示：按用例角色与鉴权执行；实际运行会更新已审核接口套件，不自动调用 AI 分析。此预览不会发送请求。",
            ...(draft ? { drafts: [
              { title: "接口-必填参数缺失", priority: "P1", steps: ["移除一个必填参数", "提交请求"], expected: ["请求中不包含该参数", "返回明确校验错误，不产生业务数据"] },
              { title: "接口-重复提交", priority: "P1", steps: ["使用相同业务标识连续提交两次"], expected: ["返回符合接口幂等约定的结果；具体断言需人工核对"] },
            ] } : { caseIds: context.references.filter(r => r.kind === "case").map(r => r.id) }),
          };
          c.operations.push(op);
          append(c, draft ? "演示回答：已准备两条测试场景草稿。请检查前置条件和预期结果后再保存；这些不是已验证的执行结果。" : "演示回答：已准备回归操作。请核对项目、环境和范围后确认，确认前不会执行。", context.references);
        } else {
          append(c, input.mode === "report"
            ? "## 报告分析\n\n> 以下为合成演示，不代表真实执行结果。\n\n**先核对环境与断言，再判断是否属于业务缺陷。**\n\n### 建议排查顺序\n1. 确认测试环境的登录态仍然有效。\n2. 对照失败步骤，检查 HTTP 状态与业务码。\n3. 结合服务端日志确认根因，不直接修改预期让测试通过。\n\n| 检查项 | 查看位置 |\n| --- | --- |\n| 调用身份 | 环境登录态 / 用例角色 |\n| 失败断言 | 原始测试报告 |\n| 业务错误 | 响应业务码与服务端日志 |\n\n### 配置示例\n```json\n{\n  \"checkBusinessCode\": true,\n  \"autoTriage\": false\n}\n```\n\n尚未发起重跑。请在报告页核对证据后，再准备执行操作。"
            : "我可以结合当前页面，帮你分析报告、补充测试场景草稿，或准备需要确认的接口回归。\n\n请先在页面选择接口、用例或报告，再用“交给助手”带入上下文。草稿需要人工审核，执行结果以真实报告为准。\n\n这是演示回答，未调用模型。", context.references);
        }
        c.busy = false; c.updatedAt = now();
      }, 500);
      return clone(c);
    },
    assistantConfirm: async (p, id, operationId) => {
      const c = get(p, id); const op = c.operations.find(o => o.id === operationId);
      if (!op) throw new Error("操作不存在");
      if (op.status !== "pending") return clone(c);
      if (Date.parse(op.expiresAt) <= Date.now()) { op.status = "expired"; throw new Error("操作已过期，请重新准备"); }
      if (c.busy) throw new Error("请等待当前任务结束");
      op.status = "completed";
      op.result = "演示操作已确认；没有修改真实项目、提交代码或执行任何请求。";
      append(c, op.result); return clone(c);
    },
    assistantCancelOperation: async (p, id, operationId) => {
      const c = get(p, id); const op = c.operations.find(o => o.id === operationId);
      if (!op || op.status !== "pending") throw new Error("操作当前不能取消");
      op.status = "cancelled"; return clone(c);
    },
    assistantStop: async (p, id) => {
      const c = get(p, id); c.busy = false; append(c, "演示回复已停止。没有执行测试或修改真实项目。");
    },
  };
}
