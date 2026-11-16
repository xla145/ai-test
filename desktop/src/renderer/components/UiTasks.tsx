import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { Badge, Button, Drawer, Empty, List, Space, Tag, Typography, Alert } from "antd";
import { UnorderedListOutlined } from "@ant-design/icons";
import type { UiTaskRecord } from "../../shared/ipc";
import { api } from "../api";
import { useProjects } from "./ProjectSettings";
import { useAction } from "../hooks";

const Context = createContext<UiTaskRecord[]>([]);
export const useUiTasks = () => useContext(Context);
export const isUiTaskActive = (task: UiTaskRecord) => task.status === "running" || task.status === "stopping";
export const isUiExecutionTask = (task: UiTaskRecord) => (task.source ?? "ui") === "ui";

/** 主进程快照是事实来源，页面挂载和事件丢失不会影响任务恢复。 */
export function UiTasksProvider({ children }: { children: ReactNode }) {
  const [tasks, setTasks] = useState<UiTaskRecord[]>([]);
  useEffect(() => {
    let disposed = false;
    let pending = false;
    const refresh = async () => {
      if (pending) return;
      pending = true;
      try { const value = await api().uiTasks(); if (!disposed) setTasks(value); }
      catch { /* 下次轮询恢复 */ }
      finally { pending = false; }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 1000);
    const off = api().onEvent(e => { if (e.method === "aitest/progress") void refresh(); });
    return () => { disposed = true; clearInterval(timer); off(); };
  }, []);
  return <Context.Provider value={tasks}>{children}</Context.Provider>;
}
const labels = { running: "执行中", stopping: "正在停止", completed: "已完成", failed: "未通过", stopped: "已停止" };
const colors = { running: "processing", stopping: "warning", completed: "success", failed: "error", stopped: "default" };

export function UiTaskList({ projectId }: { projectId?: string }) {
  const tasks = useUiTasks().filter(t => isUiExecutionTask(t) && (!projectId || t.projectId === projectId));
  const { projects } = useProjects();
  const { run, busy } = useAction();
  return <List dataSource={tasks} locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无 UI 任务" /> }}
    renderItem={task => <List.Item actions={isUiTaskActive(task) ? [
      <Button key="stop" size="small" danger disabled={busy || task.status === "stopping"}
        onClick={() => run(() => api().stopUiTask(task.projectId, task.env))}>停止</Button>,
    ] : []}>
      <List.Item.Meta title={<Space wrap><Typography.Text strong>{task.kind}</Typography.Text><Tag color={colors[task.status]}>{labels[task.status]}</Tag></Space>}
        description={<Space direction="vertical" size={3} style={{ width: "100%" }}>
          <span>{projects.find(p => p.id === task.projectId)?.name ?? task.projectId} · {task.env} · {new Date(task.startedAt).toLocaleTimeString()}</span>
          {task.caseIds.length > 0 && <Typography.Text type="secondary">用例：{task.caseIds.join("、")}</Typography.Text>}
          {isUiTaskActive(task) && <Typography.Text>{task.stage}</Typography.Text>}
          {task.detail && <Typography.Paragraph style={{ margin: 0, whiteSpace: "pre-wrap" }} ellipsis={{ rows: 3, expandable: true, symbol: "展开" }}>{task.detail}</Typography.Paragraph>}
          {task.runId && <Typography.Text type="secondary">报告编号：{task.runId}（可在测试报告中查看）</Typography.Text>}
        </Space>} />
    </List.Item>} />;
}

export function UiTasksButton() {
  const tasks = useUiTasks().filter(isUiExecutionTask);
  const [open, setOpen] = useState(false);
  return <>
    <Button type="text" className="header-ui-tasks" aria-label="UI 任务列表" title="UI 任务列表" onClick={() => setOpen(true)}
      icon={<Badge count={tasks.filter(isUiTaskActive).length} size="small"><UnorderedListOutlined /></Badge>}>
      <span className="header-ui-tasks-label">任务</span>
    </Button>
    <Drawer title="UI 任务" open={open} onClose={() => setOpen(false)} width={560}>
      <Typography.Paragraph type="secondary">切换页面不会中断后台任务。保留本次启动期间最近 100 条任务。</Typography.Paragraph>
      <UiTaskList />
    </Drawer>
  </>;
}

export function UiTaskBanner({ projectId, env }: { projectId: string; env: string }) {
  const task = useUiTasks().filter(isUiExecutionTask).find(isUiTaskActive);
  if (!task) return null;
  return <Alert style={{ marginBottom: 12 }} type="info" showIcon message={`${task.kind} · ${labels[task.status]}`}
    description={task.projectId === projectId && task.env === env ? task.detail || task.stage : `其他项目或环境正在执行 UI 任务（${task.env}），请在任务列表中查看。`} />;
}
