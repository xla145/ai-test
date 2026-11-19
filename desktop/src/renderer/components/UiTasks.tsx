import { useState } from "react";
import { useTasks } from "../stores/taskStore";
export { TaskProvider as UiTasksProvider } from "../stores/taskStore";
import { Badge, Button, Drawer, Empty, List, Space, Tag, Typography, Alert } from "antd";
import { UnorderedListOutlined } from "@ant-design/icons";
import type { UiTaskRecord } from "../../shared/ipc";
import { api } from "../api";
import { useProjects } from "./ProjectSettings";
import { useAction } from "../hooks";

export const useUiTasks = useTasks;
export const isUiTaskActive = (task: UiTaskRecord) => task.status === "queued" || task.status === "running" || task.status === "stopping";
export const isUiExecutionTask = (task: UiTaskRecord) => (task.source ?? "ui") === "ui";

const labels = { queued: "排队中", running: "执行中", stopping: "正在停止", completed: "已完成", failed: "未通过", stopped: "已停止" };
const colors = { queued: "default", running: "processing", stopping: "warning", completed: "success", failed: "error", stopped: "default" };

export function UiTaskList({ projectId }: { projectId?: string }) {
  const tasks = useUiTasks().filter(t => !projectId || t.projectId === projectId);
  const { projects } = useProjects();
  const { run, busy } = useAction();
  return <List dataSource={tasks} locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无执行任务" /> }}
    renderItem={task => <List.Item actions={[<Button key="diagnostics" size="small" onClick={() => run(() => api().exportDiagnostics(task.id))}>导出诊断</Button>, ...(isUiTaskActive(task) ? [
      <Button key="stop" size="small" danger disabled={busy || task.status === "stopping"}
        onClick={() => run(() => api().stopExecutionTask(task.id))}>停止</Button>,
    ] : [])]}>
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
  const tasks = useUiTasks();
  const [open, setOpen] = useState(false);
  return <>
    <Button type="text" className="header-ui-tasks" aria-label="执行任务列表" title="执行任务列表" onClick={() => setOpen(true)}
      icon={<Badge count={tasks.filter(isUiTaskActive).length} size="small"><UnorderedListOutlined /></Badge>}>
      <span className="header-ui-tasks-label">任务</span>
    </Button>
    <Drawer title="执行任务" open={open} onClose={() => setOpen(false)} width={560}>
      <Typography.Paragraph type="secondary">切换页面不会中断后台任务。保留全部活跃任务及最近 100 条结束记录，重启后不会自动重放。</Typography.Paragraph>
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
