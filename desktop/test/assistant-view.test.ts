import { describe, expect, it } from "vitest";
import type { AssistantConversation, AssistantReference } from "../src/shared/assistant.js";
import type { UiTaskRecord } from "../src/shared/ipc.js";
import type { Project } from "../src/renderer/api.js";
import { acceptsContext, assistantMessageText, assistantPage, conversationTasks, freezeContext, freezeReferences, isTaskBusy, safeEnvironment } from "../src/renderer/assistant/assistantView.js";

const project: Project = { id: "project-one", name: "测试项目", workspace_path: "/workspace", environments: {
  production: { base_url: "https://production.invalid", production: true },
  staging: { base_url: "https://staging.invalid" },
  test: { base_url: "https://test.invalid" },
} };

describe("助手上下文隔离", () => {
  it("拒绝隐藏页面、其他项目和未选择项目的上下文", () => {
    const active = { projectId: "project-one", page: "cases" };
    expect(acceptsContext(active, { projectId: "project-one", page: "cases" })).toBe(true);
    expect(acceptsContext(active, { projectId: "project-two", page: "cases" })).toBe(false);
    expect(acceptsContext(active, { projectId: "project-one", page: "ui" })).toBe(false);
    expect(acceptsContext({ page: "cases" }, { projectId: "project-one", page: "cases" })).toBe(false);
  });
  it("发送引用复制、去重且保留跨种类同名 ID，不随页面后续选择变化", () => {
    const references: AssistantReference[] = [{ kind: "case", id: "one", label: "原始用例" }, { kind: "case", id: "one", label: "重复" },
      { kind: "run", id: "one" }, { kind: "case", id: "" }];
    const context = { page: "cases" as const, env: "test", references };
    const sent = freezeContext(context);
    references[0].label = "新的用例";
    context.env = "staging";
    references.push({ kind: "case", id: "two" });
    expect(sent).toEqual({ page: "cases", env: "test", references: [{ kind: "case", id: "one", label: "原始用例" }, { kind: "run", id: "one" }] });
    sent.references[0].label = "会话内部修改";
    expect(references[0].label).toBe("新的用例");
  });
  it("空引用与未知页面有确定的安全默认值", () => {
    expect(freezeReferences([])).toEqual([]);
    expect(freezeContext({ page: "home", references: [] })).toEqual({ page: "home", references: [] });
    expect(assistantPage("reports")).toBe("reports");
    expect(assistantPage("group")).toBe("home");
  });
});

describe("助手目标环境", () => {
  it("保留存在的非生产环境，不自动选生产或不存在环境", () => {
    expect(safeEnvironment(project, "test")).toBe("test");
    expect(safeEnvironment(project, "production")).toBe("staging");
    expect(safeEnvironment(project, "removed")).toBe("staging");
    expect(safeEnvironment(project)).toBe("staging");
  });
  it("没有可执行环境时保持未指定，不回退生产", () => {
    expect(safeEnvironment({ ...project, environments: { production: project.environments.production } })).toBe("");
    expect(safeEnvironment({ ...project, environments: {} })).toBe("");
  });
});

describe("助手任务快照", () => {
  const conversation: AssistantConversation = { id: "conversation", projectId: project.id, title: "问答", updatedAt: "2026-11-19T00:00:00Z", busy: true,
    taskId: "current", messages: [{ id: "message", role: "assistant", content: "完成", createdAt: "2026-11-19T00:00:00Z", taskId: "history" }],
    operations: [{ id: "operation", kind: "run-regression", status: "running", title: "回归", summary: "执行已选用例", createdAt: "2026-11-19T00:00:00Z", expiresAt: "2026-11-19T01:00:00Z", context: { page: "cases", references: [] }, taskId: "regression" }] };
  const task = (id: string, projectId = project.id): UiTaskRecord => ({ id, projectId, status: "running", kind: "助手", env: "test", caseIds: [], stage: "处理中", startedAt: "", updatedAt: "" });
  it("仅显示此项目此会话关联的当前、历史与回归任务", () => {
    const tasks = [task("current"), task("unrelated"), task("history"), task("regression"), task("current", "other-project")];
    expect(conversationTasks(conversation, tasks, project.id).map(item => item.id)).toEqual(["current", "history", "regression"]);
    expect(conversationTasks(conversation, tasks, "other-project")).toEqual([]);
    expect(conversationTasks(undefined, tasks, project.id)).toEqual([]);
  });
  it("排队、运行、停止中均持续轮询，结束状态不轮询", () => {
    for (const status of ["queued", "running", "stopping"] as const) expect(isTaskBusy({ ...task("one"), status })).toBe(true);
    for (const status of ["completed", "failed", "stopped"] as const) expect(isTaskBusy({ ...task("one"), status })).toBe(false);
  });
});

describe("助手发送文本", () => {
  it("空回归说明转为明确的待确认请求，问答仍要求用户输入", () => {
    expect(assistantMessageText("regression", "  ")).toBe("准备所选用例的回归操作，等待人工确认后执行。");
    expect(assistantMessageText("regression", "  仅回归所选订单用例  ")).toBe("仅回归所选订单用例");
    expect(assistantMessageText("ask", "  ")).toBe("");
    expect(assistantMessageText("draft", "  补充失败路径  ")).toBe("补充失败路径");
  });
});
