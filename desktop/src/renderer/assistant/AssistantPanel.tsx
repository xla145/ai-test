import { AssistantMarkdown } from "./AssistantMarkdown";
import { DownOutlined, EnvironmentOutlined, HistoryOutlined, PlusOutlined, SendOutlined } from "@ant-design/icons";
import { Dropdown, Popover } from "antd";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { AssistantConversation, AssistantConversationSummary, AssistantMode, AssistantOperation, AssistantReference, AssistantSendInput } from "../../shared/assistant";
import type { UiTaskRecord } from "../../shared/ipc";
import { api, type Project } from "../api";
import { subscribe } from "../bridge";
import { useAssistantContext } from "./AssistantContext";
import { assistantMessageText, assistantPage, conversationTasks, freezeContext, freezeReferences, isTaskBusy, referenceKey, safeEnvironment } from "./assistantView";
import "./AssistantPanel.css";

export interface AssistantPanelProps {
  project: Project;
  page: string;
  onNavigate?: (reference: AssistantReference) => void;
}
const modeLabels: Record<AssistantMode, string> = { ask: "问答", report: "报告解读", draft: "用例草稿", regression: "回归执行" };
const statusLabels: Record<UiTaskRecord["status"], string> = { queued: "排队中", running: "执行中", stopping: "正在停止", completed: "已完成", failed: "未通过", stopped: "已停止" };
const operationLabels: Record<AssistantOperation["status"], string> = { pending: "待确认", running: "执行中", completed: "已完成", failed: "失败", cancelled: "已取消", expired: "已过期" };
const roleLabels = { user: "你", assistant: "助手", system: "系统" };
const pageLabels = { home: "项目总览", cases: "测试用例", import: "需求导入", api: "接口工作台", run: "测试执行", performance: "性能测试", ui: "界面测试", app: "应用测试", reports: "测试报告", ops: "运维", db: "数据库", settings: "设置" };
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const sortHistory = (items: AssistantConversationSummary[]) => [...items].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
const formatTime = (value: string) => {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString("zh-CN") : "时间未知";
};

/** A project key invalidates every in-flight request before another project's panel can render. */
export function AssistantPanel(props: AssistantPanelProps) {
  return <ProjectAssistantPanel key={props.project.id} {...props} />;
}

function ProjectAssistantPanel({ project, page, onNavigate }: AssistantPanelProps) {
  const { current, draftRequest, requestVersion, clearRequest } = useAssistantContext();
  const inputId = useId();
  const [history, setHistory] = useState<AssistantConversationSummary[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string>();
  const [conversation, setConversation] = useState<AssistantConversation>();
  const [tasks, setTasks] = useState<UiTaskRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [command, setCommand] = useState<string>();
  const [error, setError] = useState("");
  const [readError, setReadError] = useState("");
  const [snapshotError, setSnapshotError] = useState("");
  const [text, setText] = useState("");
  const [mode, setMode] = useState<AssistantMode>("ask");
  const [env, setEnv] = useState(() => safeEnvironment(project));
  const [references, setReferences] = useState<AssistantReference[]>([]);
  const [consent, setConsent] = useState(false);
  const alive = useRef(true);
  const scope = useRef({ id: undefined as string | undefined, generation: 0 });
  const readVersion = useRef(0);
  const historyVersion = useRef(0);
  const commandLock = useRef(false);
  const consumedRequest = useRef(0);
  const appliedContext = useRef("");
  const pendingSend = useRef<{ conversationId: string; signature: string; input: AssistantSendInput }>();
  const textarea = useRef<HTMLTextAreaElement>(null);
  const transcript = useRef<HTMLDivElement>(null);
  const followMessages = useRef(true);
  const composition = useRef(false);
  const valid = useCallback((id: string | undefined, generation: number) => alive.current && scope.current.id === id && scope.current.generation === generation, []);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; scope.current.generation++; readVersion.current++; historyVersion.current++; };
  }, []);

  const adopt = useCallback((value: AssistantConversation) => {
    if (value.projectId !== project.id || value.id !== scope.current.id) throw new Error("助手返回的项目或会话不匹配，已忽略结果");
    setConversation(value);
    setHistory(previous => sortHistory([{ id: value.id, projectId: value.projectId, title: value.title,
      updatedAt: value.updatedAt, busy: value.busy }, ...previous.filter(item => item.id !== value.id)]));
  }, [project.id]);

  const refresh = useCallback(async (id: string, generation: number) => {
    const version = ++readVersion.current;
    // A snapshot failure must not hide a successfully recovered conversation (and vice versa).
    const [result, snapshot] = await Promise.allSettled([api().assistantConversation(project.id, id), api().taskSnapshot()]);
    if (!valid(id, generation) || version !== readVersion.current) return;
    if (result.status === "fulfilled") {
      try { adopt(result.value); setReadError(""); } catch (cause) { setReadError(errorText(cause)); }
    } else setReadError(`读取会话失败：${errorText(result.reason)}`);
    if (snapshot.status === "fulfilled") {
      setTasks(snapshot.value.tasks.filter(task => task.projectId === project.id));
      setSnapshotError("");
    } else setSnapshotError(`任务状态暂不可用：${errorText(snapshot.reason)}`);
    setLoading(false);
  }, [project.id, valid, adopt]);

  const selectConversation = useCallback((id: string, resetDraft = true) => {
    const generation = ++scope.current.generation;
    scope.current.id = id;
    followMessages.current = true;
    readVersion.current++;
    setSelectedId(id); setConversation(undefined); setTasks([]); setError(""); setReadError(""); setSnapshotError("");
    setConsent(false); if (resetDraft) setText(""); setLoading(true);
    void refresh(id, generation);
  }, [refresh]);

  const loadHistory = useCallback(async () => {
    const version = ++historyVersion.current;
    setHistoryLoading(true); setError("");
    try {
      const items = sortHistory((await api().assistantConversations(project.id)).filter(item => item.projectId === project.id));
      if (!alive.current || historyVersion.current !== version) return;
      setHistory(items);
      if (!scope.current.id && items[0]) selectConversation(items[0].id, false);
    } catch (cause) {
      if (alive.current && historyVersion.current === version) setError(`恢复历史失败：${errorText(cause)}`);
    } finally { if (alive.current && historyVersion.current === version) setHistoryLoading(false); }
  }, [project.id, selectConversation]);
  useEffect(() => { void loadHistory(); }, [loadHistory]);

  const pageContext = current?.projectId === project.id && current.page === page ? current : undefined;
  const contextSignature = JSON.stringify({ page, env: pageContext?.env, references: pageContext?.references ?? [] });
  const environmentsSignature = JSON.stringify(project.environments);
  useEffect(() => {
    const signature = `${contextSignature}:${environmentsSignature}`;
    if (appliedContext.current === signature) return;
    appliedContext.current = signature;
    const context = JSON.parse(contextSignature) as { env?: string; references: AssistantReference[] };
    setReferences(freezeReferences(context.references));
    setEnv(safeEnvironment(project, context.env));
    setConsent(false);
  }, [contextSignature, environmentsSignature]);

  useEffect(() => {
    if (!draftRequest || draftRequest.projectId !== project.id || draftRequest.page !== page || consumedRequest.current === requestVersion) return;
    consumedRequest.current = requestVersion;
    setReferences(freezeReferences(draftRequest.references));
    setEnv(safeEnvironment(project, draftRequest.env));
    setText(draftRequest.text ?? "");
    setMode(draftRequest.mode ?? "ask");
    setConsent(false);
    clearRequest(requestVersion);
    textarea.current?.focus();
  }, [draftRequest, requestVersion, clearRequest, project, page]);

  useEffect(() => {
    if (followMessages.current && transcript.current) transcript.current.scrollTop = transcript.current.scrollHeight;
  }, [conversation?.id, conversation?.messages.length, conversation?.operations.length]);

  const relatedTasks = useMemo(() => conversationTasks(conversation, tasks, project.id), [conversation, tasks, project.id]);
  const busy = !!conversation?.busy || relatedTasks.some(isTaskBusy);
  useEffect(() => {
    if (!selectedId || !busy) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const generation = scope.current.generation;
    const poll = async () => {
      await refresh(selectedId, generation);
      if (!disposed) timer = setTimeout(() => void poll(), 1000);
    };
    timer = setTimeout(() => void poll(), 1000);
    return () => { disposed = true; clearTimeout(timer); };
  }, [selectedId, busy, refresh]);

  useEffect(() => {
    if (!selectedId) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const generation = scope.current.generation;
    const off = subscribe("event", event => {
      if (!(event.method.startsWith("aitest/assistant") || event.method === "aitest/task-records")) return;
      if (timer !== undefined) return;
      timer = setTimeout(() => { timer = undefined; void refresh(selectedId, generation); }, 100);
    });
    return () => { off(); if (timer !== undefined) clearTimeout(timer); };
  }, [selectedId, refresh]);

  const newConversation = async () => {
    if (commandLock.current) return;
    commandLock.current = true; setCommand("create"); setError("");
    const { id, generation } = scope.current;
    try {
      const created = await api().assistantCreateConversation(project.id);
      if (!valid(id, generation)) return;
      if (created.projectId !== project.id) throw new Error("新会话的项目不匹配");
      scope.current = { id: created.id, generation: generation + 1 }; readVersion.current++;
      setSelectedId(created.id); setConsent(false); setText(""); setTasks([]); setLoading(false); adopt(created);
    } catch (cause) { if (valid(id, generation)) setError(errorText(cause)); }
    finally { if (alive.current) { commandLock.current = false; setCommand(undefined); } }
  };

  const changeOperation = async (operation: AssistantOperation, confirm: boolean) => {
    const { id, generation } = scope.current;
    if (!id || commandLock.current) return;
    commandLock.current = true; setCommand(operation.id); setError("");
    try {
      const result = await (confirm ? api().assistantConfirm(project.id, id, operation.id) : api().assistantCancelOperation(project.id, id, operation.id));
      if (!valid(id, generation)) return;
      readVersion.current++; adopt(result);
      await refresh(id, generation);
    } catch (cause) { if (valid(id, generation)) setError(errorText(cause)); }
    finally { if (alive.current) { commandLock.current = false; setCommand(undefined); } }
  };

  const stop = async () => {
    const { id, generation } = scope.current;
    if (!id || commandLock.current) return;
    commandLock.current = true; setCommand("stop"); setError("");
    try { await api().assistantStop(project.id, id); if (valid(id, generation)) await refresh(id, generation); }
    catch (cause) { if (valid(id, generation)) setError(errorText(cause)); }
    finally { if (alive.current) { commandLock.current = false; setCommand(undefined); } }
  };

  const production = !!env && !!project.environments[env]?.production;
  const hasCases = references.some(reference => reference.kind === "case" || reference.kind === "definition");
  const tooLong = text.length > 6000;
  const canSend = !command && !busy && !loading && !historyLoading && !tooLong && (mode === "regression" ? !!env && hasCases : !!text.trim() && consent) && !production;
  const send = async () => {
    if (!canSend || commandLock.current) return;
    // These copies are the only context used by this send, even if a page publishes new references while awaiting the ack.
    const frozen = freezeContext({ page: assistantPage(page), env: env || undefined, references });
    const content = { text: assistantMessageText(mode, text), mode, context: frozen, consent: mode === "regression" ? false : consent };
    const signature = JSON.stringify(content);
    commandLock.current = true; followMessages.current = true; setCommand("send"); setError("");
    let { id, generation } = scope.current;
    try {
      if (!id) {
        const created = await api().assistantCreateConversation(project.id);
        if (!valid(id, generation)) return;
        if (created.projectId !== project.id) throw new Error("新会话的项目不匹配");
        id = created.id; generation++;
        scope.current = { id, generation }; readVersion.current++;
        setSelectedId(id); setConsent(false); adopt(created);
      }
      const input = pendingSend.current?.conversationId === id && pendingSend.current.signature === signature
        ? pendingSend.current.input : { ...content, requestId: crypto.randomUUID() };
      pendingSend.current = { conversationId: id, signature, input };
      const acknowledged = await api().assistantSend(project.id, id, input);
      if (!valid(id, generation)) return;
      readVersion.current++; adopt(acknowledged); pendingSend.current = undefined; setText(""); setConsent(false);
      // The send is an ack, not a streamed reply. Read this exact conversation only after the ack.
      await refresh(id, generation);
    } catch (cause) { if (valid(id, generation)) setError(`发送失败：${errorText(cause)}`); }
    finally { if (alive.current) { commandLock.current = false; setCommand(undefined); } }
  };

  const referenceButton = (reference: AssistantReference) => <button key={referenceKey(reference)} type="button" className="assistant-reference-link"
    disabled={!onNavigate} onClick={() => onNavigate?.({ ...reference })} title={reference.id}>{reference.kind === "run" ? "报告" : reference.kind === "case" ? "用例" : "接口"} · {reference.label || reference.id}</button>;

  return <section className="assistant-panel" aria-label={`${project.name}的测试助手`} aria-busy={loading || !!command}>
    <header className="assistant-toolbar">
      <span className="assistant-conversation-title" title={conversation?.title}>{conversation?.title || "新对话"}</span>
      <Popover trigger="click" placement="bottomRight" arrow={false} open={historyOpen} onOpenChange={open => { setHistoryOpen(open); if (open) void loadHistory(); }}
        getPopupContainer={trigger => trigger.closest<HTMLElement>(".assistant-panel") ?? trigger.parentElement!}
        content={<div className="assistant-history" aria-label="助手会话历史">
          <div className="assistant-history-heading">最近对话{historyLoading ? " · 读取中…" : ""}</div>
          {history.length ? history.map(item => <button key={item.id} type="button" className={`assistant-history-item${item.id === selectedId ? " is-selected" : ""}`}
            aria-current={item.id === selectedId ? "true" : undefined} disabled={!!command} title={item.title}
            onClick={() => { selectConversation(item.id); setHistoryOpen(false); }}><span>{item.title || "未命名对话"}</span>{item.busy && <small>执行中</small>}</button>)
            : <p className="assistant-muted">{historyLoading ? "正在读取…" : "暂无历史对话"}</p>}
        </div>}>
        <button type="button" className="assistant-icon-button" disabled={!!command} aria-label="选择历史对话" title="历史对话"><HistoryOutlined /></button>
      </Popover>
      <button type="button" className="assistant-icon-button" disabled={!!command || historyLoading} onClick={() => void newConversation()} aria-label="新建助手对话" title="新对话"><PlusOutlined /></button>
    </header>
    <div className="assistant-scroll" ref={transcript} onScroll={event => { const box = event.currentTarget; followMessages.current = box.scrollHeight - box.scrollTop - box.clientHeight < 64; }}>
      {(error || readError) && <div className="assistant-alert assistant-alert-error" role="alert"><span>{error || readError}</span><button type="button" className="assistant-button" disabled={!!command}
        onClick={() => { setError(""); if (selectedId) void refresh(selectedId, scope.current.generation); else void loadHistory(); }}>重新读取</button></div>}
      {snapshotError && <p className="assistant-alert" role="status">{snapshotError}</p>}
      {conversation?.notice && <p className="assistant-alert" role="status">{conversation.notice}</p>}
      <div className="assistant-messages" role="log" aria-label="助手消息记录" aria-live="polite" aria-relevant="additions text">
        {loading ? <p className="assistant-empty" role="status">正在读取会话…</p> : !conversation?.messages.length && <div className="assistant-empty">
          <strong>想从哪里开始？</strong>
          <div className="assistant-suggestions">{[
            { mode: "ask" as const, label: "检查测试盲点", text: "请结合当前上下文，帮我识别测试中可能遗漏的边界和失败路径。" },
            { mode: "report" as const, label: "解读最近报告", text: "请解读最近的测试报告，区分已确认事实与需要进一步验证的问题。" },
            { mode: "draft" as const, label: "补充用例草稿", text: "请根据当前上下文补充可供人工复核的测试用例草稿。" },
          ].map(suggestion => <button key={suggestion.mode} type="button" onClick={() => { setMode(suggestion.mode); setText(suggestion.text); setConsent(false); textarea.current?.focus(); }}>{suggestion.label}</button>)}</div>
        </div>}
        {conversation?.messages.map(message => <article className={`assistant-message assistant-message-${message.role}`} key={message.id} aria-label={`${roleLabels[message.role]}的消息`}>
          {message.role === "assistant" ? <AssistantMarkdown content={message.content} /> : <div className="assistant-text">{message.content}</div>}
          <details className="assistant-message-meta"><summary>详情</summary>
            <div className="assistant-muted">{roleLabels[message.role]} · <time dateTime={message.createdAt}>{formatTime(message.createdAt)}</time></div>
            {message.context && <div className="assistant-muted">发送时上下文：{pageLabels[message.context.page]}{message.context.env ? ` · ${message.context.env}` : ""}</div>}
            <div className="assistant-links">{freezeReferences([...(message.context?.references ?? []), ...(message.references ?? [])]).map(referenceButton)}</div>
          </details>
        </article>)}
      </div>

      {relatedTasks.length > 0 && <details className="assistant-task-section" open={busy || undefined}><summary>任务记录 · {relatedTasks.length}</summary>{relatedTasks.map(task => <article key={task.id} className="assistant-task">
        <div className="assistant-card-title"><strong>{task.kind}</strong><span>{statusLabels[task.status]}</span></div>
        <div className="assistant-text">{task.stage}</div>{task.detail && <details><summary>查看任务详情</summary><div className="assistant-text">{task.detail}</div></details>}
        <div className="assistant-muted">环境：{task.env || "未指定"}{task.tokens !== undefined ? ` · 已记录 ${task.tokens.toLocaleString()} tokens` : ""}</div>
        {task.persistenceError && <p className="assistant-alert" role="status">{task.persistenceError}</p>}
        {task.runId && <div className="assistant-links">{referenceButton({ kind: "run", id: task.runId, label: "查看测试报告" })}</div>}
      </article>)}</details>}
      {busy && <div className="assistant-running" role="status"><p>处理中，完成后展示完整回复。任务状态每秒更新。</p>
        <button type="button" className="assistant-button assistant-danger" disabled={!!command || relatedTasks.some(task => task.status === "stopping")} onClick={() => void stop()}>{command === "stop" ? "正在请求停止…" : "停止当前任务"}</button></div>}

      {!!conversation?.operations.length && <section className="assistant-operations" aria-label="待确认操作和操作历史"><h3>操作与草稿</h3>{conversation.operations.map(operation => {
        const expired = operation.status === "pending" && Date.parse(operation.expiresAt) <= Date.now();
        const unsafeEnv = operation.kind === "run-regression" && (!operation.context.env || !project.environments[operation.context.env] || project.environments[operation.context.env].production);
        return <article key={operation.id} className="assistant-operation">
          <div className="assistant-card-title"><strong>{operation.title}</strong><span>{expired ? "已过期" : operationLabels[operation.status]}</span></div>
          <p className="assistant-text">{operation.summary}</p>
          <div className="assistant-muted">{operation.kind === "save-drafts" ? "保存草稿，不会自动运行，须人工复核后使用。" : "仅执行此卡片中列出的用例，沿用每条用例的鉴权，不自动选择角色。"}</div>
          <div className="assistant-muted">固定环境：{operation.context.env || "未指定"} · {operation.status === "pending" ? `确认截止：${formatTime(operation.expiresAt)}` : `创建于：${formatTime(operation.createdAt)}`}</div>
          <div className="assistant-links">{operation.context.references.map(referenceButton)}</div>
          {operation.caseIds?.length ? <details><summary>回归用例（{operation.caseIds.length}）</summary><ul>{operation.caseIds.map(id => <li key={id}>{referenceButton({ kind: "case", id })}</li>)}</ul></details> : null}
          {operation.drafts?.map((draft, index) => <details key={index} className="assistant-draft"><summary>{draft.priority} · {draft.title}（待人工复核）</summary>
            <h4>步骤</h4><ol>{draft.steps.map((step, i) => <li key={i} className="assistant-text">{step}</li>)}</ol>
            <h4>预期结果</h4><ol>{draft.expected.map((expected, i) => <li key={i} className="assistant-text">{expected}</li>)}</ol>
          </details>)}
          {operation.result && <p className="assistant-text">{operation.result}</p>}
          {operation.runId && <div className="assistant-links">{referenceButton({ kind: "run", id: operation.runId, label: "查看回归报告" })}</div>}
          {operation.status === "pending" && <div className="assistant-operation-actions"><button type="button" className="assistant-button assistant-primary" disabled={!!command || busy || expired || !!unsafeEnv}
            onClick={() => void changeOperation(operation, true)}>{operation.kind === "save-drafts" ? "确认保存草稿" : "确认执行回归"}</button>
            <button type="button" className="assistant-button" disabled={!!command || expired} onClick={() => void changeOperation(operation, false)}>取消操作</button></div>}
          {operation.status === "pending" && unsafeEnv && <p className="assistant-alert">该操作的环境不可用或为生产环境，不能执行。请取消并重新发起。</p>}
        </article>;
      })}</section>}
    </div>

    <form className="assistant-composer" onSubmit={event => { event.preventDefault(); void send(); }}>
      {references.length > 0 && <div className="assistant-context-tags" aria-label="本次发送的上下文引用">{references.map(reference => <span className="assistant-context-tag" key={referenceKey(reference)}>
        <span title={reference.id}>{reference.label || reference.id}</span><button type="button" disabled={!!command} aria-label={`移除引用${reference.label || reference.id}`}
          onClick={() => { setReferences(previous => previous.filter(item => referenceKey(item) !== referenceKey(reference))); setConsent(false); }}>×</button></span>)}</div>}
      <label className="assistant-visually-hidden" htmlFor={inputId}>{mode === "regression" ? "回归补充说明（可选）" : "输入问题或需求"}</label>
      <textarea ref={textarea} id={inputId} value={text} rows={2} maxLength={6000} disabled={!!command} placeholder={mode === "regression" ? "为所选用例准备回归，确认后才执行…" : "输入问题，或引用页面内容…"}
        onChange={event => setText(event.target.value)} onCompositionStart={() => { composition.current = true; }} onCompositionEnd={() => { composition.current = false; }}
        onKeyDown={event => {
          if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && !composition.current && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) {
            event.preventDefault(); void send();
          }
        }} />
      <div className="assistant-input-tools">
        <Dropdown trigger={["click"]} placement="topLeft" getPopupContainer={trigger => trigger.closest<HTMLElement>(".assistant-panel") ?? trigger.parentElement!}
          menu={{ selectable: true, selectedKeys: [mode], items: Object.entries(modeLabels).map(([key, label]) => ({ key, label })), onClick: ({ key }) => setMode(key as AssistantMode) }}>
          <button type="button" className="assistant-tool-button" aria-label={`选择助手模式，当前${modeLabels[mode]}`} disabled={!!command}>{modeLabels[mode]}<DownOutlined /></button>
        </Dropdown>
        <Dropdown trigger={["click"]} placement="topLeft" getPopupContainer={trigger => trigger.closest<HTMLElement>(".assistant-panel") ?? trigger.parentElement!}
          menu={{ selectable: true, selectedKeys: [env], items: [{ key: "", label: "未指定环境" }, ...Object.entries(project.environments).map(([key, config]) => ({ key, disabled: config.production, label: `${key}${config.production ? "（生产，禁止执行）" : ""}` }))],
            onClick: ({ key }) => { setEnv(key); setConsent(false); } }}>
          <button type="button" className={`assistant-tool-button assistant-environment${env ? " has-environment" : ""}`} aria-label={`选择目标环境，当前${env || "未指定"}`} title={env || "选择环境"} disabled={!!command}>
            <EnvironmentOutlined />{env && <span>{env}</span>}
          </button>
        </Dropdown>
        <span className="assistant-tools-spacer" />
        <button type="submit" className="assistant-send-button" aria-label={mode === "regression" ? "创建待确认回归操作" : "发送消息"} title="Ctrl / ⌘ + Enter 发送" disabled={!canSend}>
          {command === "send" ? "发送中…" : mode === "regression" ? "准备回归" : "发送"}<SendOutlined />
        </button>
      </div>
      {mode === "regression" ? <div className="assistant-footnote"><span>不调用模型，确认后执行</span><Popover trigger="click" placement="topRight" arrow={false}
          getPopupContainer={trigger => trigger.closest<HTMLElement>(".assistant-panel") ?? trigger.parentElement!}
          content={<p className="assistant-disclosure">请选择非生产环境并引用至少一个用例或接口。仅创建待确认操作卡，确认后才执行；沿用每条用例的鉴权，不会擅自选择角色。</p>}>
          <button type="button" className="assistant-details-button" aria-label="查看回归执行说明">详情</button>
        </Popover></div>
        : <div className="assistant-consent-row"><label className="assistant-consent"><input type="checkbox" checked={consent} disabled={!!command} onChange={event => setConsent(event.target.checked)} />
          <span>同意本轮向模型发送内容</span></label>
          <Popover trigger="click" placement="topRight" arrow={false} getPopupContainer={trigger => trigger.closest<HTMLElement>(".assistant-panel") ?? trigger.parentElement!}
            content={<div className="assistant-disclosure"><strong>模型数据发送告知</strong><p>本次问题、最近会话历史及引用对象的有限摘要将发送至已配置的模型服务。未选择对象时会附带当前项目的少量用例与报告摘要；报告解读会使用最近报告并说明来源。脱敏处理不能保证移除所有敏感信息，请勿发送凭据或敏感数据。</p><p>每轮发送前均需明确勾选。生成的用例仅为待人工复核草稿；确认保存也不会自动运行。</p></div>}>
            <button type="button" className="assistant-details-button" aria-label="查看模型数据发送详情">详情</button>
          </Popover></div>}
      {tooLong && <p className="assistant-inline-warning" role="alert">超过 6000 字符，请缩短后发送。</p>}
      {mode === "draft" && <p className="assistant-footnote">草稿待人工复核，不会自动运行。</p>}
    </form>
  </section>;
}
