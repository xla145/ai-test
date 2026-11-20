import { AssistantPanel } from "../assistant/AssistantPanel";
import { useAssistantContext } from "../assistant/AssistantContext";
import { navigateAssistantReference } from "../assistantNavigation";
import { useNav } from "../nav";
import type { Project } from "../api";
import { CheckCircleFilled, CloseOutlined, LoadingOutlined, PauseCircleOutlined, UserOutlined, StopOutlined, ToolOutlined, WarningFilled } from "@ant-design/icons";
import { Alert, Badge, Button, Segmented, Tooltip, Typography } from "antd";
import { useEffect, useMemo, useRef, useState } from "react";
import type { UiTaskRecord } from "../../shared/ipc";
import { api } from "../api";
import { useAction } from "../hooks";
import { isUiTaskActive, useUiTasks } from "./UiTasks";
import { useProjects } from "./ProjectSettings";

interface ActivityItem { time: string; method: string; detail: string }

const statusLabel: Record<UiTaskRecord["status"], string> = {
  queued: "排队中", running: "执行中", stopping: "正在停止", completed: "已完成", failed: "未通过", stopped: "已停止",
};

const sourceLabel: Record<NonNullable<UiTaskRecord["source"]>, string> = {
  api: "接口", app: "App", ui: "UI", agent: "Agent", performance: "性能测试",
};

function TaskIcon({ status }: { status: UiTaskRecord["status"] }) {
  if (status === "completed") return <CheckCircleFilled className="agent-process-icon success" />;
  if (status === "failed") return <WarningFilled className="agent-process-icon error" />;
  if (status === "stopped") return <PauseCircleOutlined className="agent-process-icon muted" />;
  return <LoadingOutlined spin={status === "running"} className={`agent-process-icon ${status === "stopping" ? "warning" : "running"}`} />;
}

export function AgentProcessDock({ activity, onClearActivity, open, onOpenChange, project, page }: {
  project?: Project; page: string;
  activity: ActivityItem[]; onClearActivity: () => void; open: boolean; onOpenChange: (open: boolean) => void;
}) {
  const tasks = useUiTasks();
  const [tab, setTab] = useState("chat");
  const assistant = useAssistantContext();
  const { go } = useNav();
  useEffect(() => {
    if (assistant.requestVersion > 0) { setTab("chat"); onOpenChange(true); }
  }, [assistant.requestVersion, onOpenChange]);
  const { projects } = useProjects();
  const [showAll, setShowAll] = useState(false);
  const [anchor, setAnchor] = useState({ right: 24, bottom: 24 });
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLElement>(null);
  const { run, busy } = useAction();
  const active = tasks.filter(task => isUiTaskActive(task) && !task.parentTaskId);
  const latest = activity[activity.length - 1];
  const recent = useMemo(() => activity.slice(showAll ? -200 : -6).reverse(), [activity, showAll]);
  const recentTasks = [...tasks.filter(isUiTaskActive), ...tasks.filter((task) => !isUiTaskActive(task)).slice(0, 4)];

  // WebContentsView 位于 DOM 之上：入口固定在可操作区域的右下角，面板展开时由 BrowserDock 暂停相交视图。
  useEffect(() => {
    let view = { visible: false, docked: false };
    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const inset = window.innerWidth <= 600 ? 16 : 24;
        const dock = [...document.querySelectorAll<HTMLElement>('.browser-dock')]
          .find(box => box.getClientRects().length && box.getBoundingClientRect().width > 0);
        const workspaceEdge = view.visible
          ? dock?.getBoundingClientRect().left ?? document.querySelector<HTMLElement>('.app-shell')?.getBoundingClientRect().right ?? window.innerWidth / 2
          : window.innerWidth;
        const right = Math.max(inset, Math.min(window.innerWidth - 64, window.innerWidth - workspaceEdge + inset));
        const bottom = inset;
        setAnchor((old) => old.right === right && old.bottom === bottom ? old : { right, bottom });
      });
    };
    const off = api().onViewChange?.((value) => { view = { visible: value.visible, docked: !!value.docked }; measure(); });
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    measure();
    return () => { off?.(); cancelAnimationFrame(frame); window.removeEventListener('resize', measure); window.removeEventListener('scroll', measure, true); };
  }, []);

  useEffect(() => {
    if (!open) return;
    panel.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !document.querySelector('.ant-modal-wrap:not([style*="display: none"])')) {
        event.preventDefault(); onOpenChange(false); trigger.current?.focus();
      }
    };
    const onPointer = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest(".assistant-popup")) return;
      if (event.target instanceof Node && !panel.current?.contains(event.target) && !trigger.current?.contains(event.target)) onOpenChange(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('pointerdown', onPointer); };
  }, [open, onOpenChange]);

  return <>
    <Tooltip title={active.length ? `执行中（${active.length}）· 打开 AI 助手` : "打开 AI 助手"} placement="left">
      <button ref={trigger} type="button" style={anchor} className={`agent-process-trigger ${active.length ? "is-active" : ""}`} aria-label="打开 AI 助手" aria-expanded={open} aria-controls={open ? 'agent-process-panel' : undefined}
        onClick={() => onOpenChange(!open)}>
        <Badge count={active.length || undefined} size="small" offset={[-2, 2]}>
          <span className="agent-process-avatar"><UserOutlined /></span>
        </Badge>
        {active.length > 0 && <span className="agent-process-pulse" aria-hidden="true" />}
      </button>
    </Tooltip>

    {open && <section ref={panel} id="agent-process-panel" tabIndex={-1} role="dialog" aria-modal="false" className="agent-process-panel" style={{
      right: anchor.right, width: `min(460px, calc(100vw - ${anchor.right + 16}px))`,
      height: tab === "chat" ? `min(680px, calc(100vh - ${anchor.bottom + 76}px))` : undefined,
      ...(anchor.bottom > window.innerHeight / 2
        ? { top: window.innerHeight - anchor.bottom + 12, maxHeight: anchor.bottom - 28 }
        : { bottom: anchor.bottom + 60, maxHeight: `min(620px, calc(100vh - ${anchor.bottom + 76}px))` }),
    }} aria-label="AI 测试助手">
      <header className="agent-process-head">
        <div className="agent-process-heading">
          <span className="agent-process-heading-icon"><UserOutlined /></span>
          <div><Typography.Text strong>AI 测试助手</Typography.Text><Typography.Text type="secondary">{project?.name ?? "请选择项目"}{window.desktopHost ? "" : " · 演示预览"}</Typography.Text></div>
        </div>
        <div className="agent-process-head-actions">
          {tab === "process" && activity.length > 0 && <Button type="text" size="small" onClick={onClearActivity}>清空记录</Button>}
          <Button type="text" size="small" aria-label="关闭 AI 助手" title={tab === "process" ? "关闭面板后任务继续执行" : undefined} icon={<CloseOutlined />} onClick={() => { onOpenChange(false); trigger.current?.focus(); }} />
        </div>
      </header>

      <div style={{ padding: "0 16px 10px" }}><Segmented block aria-label="助手视图" value={tab} onChange={value => setTab(String(value))}
        options={[{ label: "对话", value: "chat" }, { label: `执行过程${active.length ? ` · ${active.length}` : ""}`, value: "process" }]} /></div>
      {tab === "chat" ? (project ? <AssistantPanel key={project.id} project={project} page={page}
        onNavigate={reference => navigateAssistantReference(project.id, reference, go)} />
        : <div className="agent-process-empty">选择一个具体项目后，即可分析报告、补充用例或准备回归。</div>) : <div className="agent-process-body">
        <div className="agent-process-summary">
          <div><span className="agent-process-summary-label">执行任务</span><strong>{active.length ? `${active.length} 个执行中` : "当前无执行任务"}</strong></div>
          <div><span className="agent-process-summary-label">最近活动</span><strong>{latest?.time ?? "—"}</strong></div>
        </div>

        {recentTasks.length > 0 && <div className="agent-process-section">
          <div className="agent-process-section-title"><span>执行任务</span><span>本次启动 · 最近 {recentTasks.length} 项</span></div>
          <div className="agent-process-task-list">
            {recentTasks.map((task) => <div className="agent-process-task" key={task.id}>
              <TaskIcon status={task.status} />
              <div className="agent-process-task-copy"><div className="agent-process-task-title">{task.kind}<span className={`agent-process-task-source ${task.source ?? "ui"}`}>{sourceLabel[task.source ?? "ui"]}</span><span className={`agent-process-task-status ${task.status}`}>{statusLabel[task.status]}</span></div><div className="agent-process-task-meta">{projects.find((p) => p.id === task.projectId)?.name ?? task.projectId}{task.env ? ` · ${task.env}` : ""}</div><div className="agent-process-task-stage">{task.stage}</div>{task.persistenceError && <Alert type="warning" message={task.persistenceError} />}
                {task.detail && <details className="agent-process-task-detail"><summary>查看任务详情</summary><p>{task.detail}</p></details>}{task.tokens !== undefined && <div className="agent-process-task-meta">{task.tokens.toLocaleString()} tokens</div>}{task.events?.length ? <details className="agent-process-task-detail"><summary>工具过程（{task.events.length}）</summary>{task.events.map((event, i) => <p key={i}>{new Date(event.time).toLocaleTimeString()} · {event.detail}</p>)}</details> : null}{task.runId && <div className="agent-process-task-meta">报告：{task.runId}</div>}</div>
              {task.canStop !== false && isUiTaskActive(task) && <Button danger type="text" size="small" disabled={busy || task.status === "stopping"} aria-label={`停止${task.kind}`} icon={<StopOutlined />} onClick={() => run(() => api().stopExecutionTask(task.id))} />}
            </div>)}
          </div>
        </div>}

        <div className="agent-process-section">
          <div className="agent-process-section-title"><span>最近活动</span><ToolOutlined /></div>
          {recent.length ? <div className="agent-process-events">{recent.map((event, i) => <div className="agent-process-event" key={`${event.time}-${i}`}><span className="agent-process-event-dot" /><div><div className="agent-process-event-text">{event.detail}</div><div className="agent-process-event-time">{event.time}</div></div></div>)}</div>
            : <div className="agent-process-empty"><UserOutlined /><span>Agent 暂无执行记录</span><small>启动用例生成、探索或回归后，这里会显示实时过程</small></div>}
          {activity.length > 6 && <Button type="link" size="small" className="agent-process-more" onClick={() => setShowAll(!showAll)}>{showAll ? '收起记录' : `查看全部 ${activity.length} 条活动`}</Button>}
        </div>
      </div>
      }
    </section>}
  </>;
}
