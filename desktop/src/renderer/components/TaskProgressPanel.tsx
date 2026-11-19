import { useEffect, useState } from "react";
import { Alert, Button, Card, Empty, Radio, Select, Space, Table, Typography } from "antd";
import type { UiTaskRecord } from "../../shared/ipc";
import type { TaskProgress, TaskProgressSnapshot } from "../../shared/taskProgress";
import { api } from "../api";
import { subscribe } from "../bridge";
import { useAction } from "../hooks";
import { mergeProgress } from "../stores/progressState";
import { useTasks } from "../stores/taskStore";
import { isUiTaskActive } from "./UiTasks";
import "../pages/PerformancePage.css";

const labels = { queued: "排队中", running: "执行中", stopping: "正在停止", stopped: "已停止", completed: "已完成", failed: "未通过" };
export function TaskProgressPanel({ projectId, source, env }: { projectId: string; source?: UiTaskRecord["source"]; env?: string }) {
  const tasks = useTasks().filter(t => t.projectId === projectId && (!source || t.source === source) && (!env || t.env === env) && (!!source || !t.parentTaskId));
  const [selected, setSelected] = useState<string>();
  const task = tasks.find(t => t.id === selected) ?? tasks[0];
  const id = task?.id;
  const [state, setState] = useState<{ id?: string; snapshot: TaskProgressSnapshot }>({ snapshot: { events: [], truncated: false } });
  const [error, setError] = useState("");
  const { run, busy } = useAction();
  useEffect(() => {
    let disposed = false;
    setError(""); setState({ id, snapshot: { events: [], truncated: false } });
    if (!id) return;
    const merge = (snapshot: TaskProgressSnapshot) => setState(old => ({ id, snapshot: mergeProgress(old.id === id ? old.snapshot : { events: [], truncated: false }, snapshot, id) }));
    const off = subscribe("event", event => {
      if (event.method !== "aitest/task-progress") return;
      const progress = event.params as TaskProgress;
      if (progress.taskId === id) merge({ events: [progress], truncated: false });
    });
    const refresh = () => api().taskProgress(id).then(value => { if (!disposed) { merge(value); setError(""); } }, () => { if (!disposed) setError("进度暂时无法同步，正在重试；后台任务不受影响。"); });
    void refresh(); const timer = setInterval(() => void refresh(), 15000);
    return () => { disposed = true; off(); clearInterval(timer); };
  }, [id]);
  if (!task) return null;
  const snapshot = state.id === id ? state.snapshot : { events: [], truncated: false };
  const cases = snapshot.events.filter((event): event is TaskProgress & { kind: "case" } => event.kind === "case");
  const metrics = snapshot.events.filter((event): event is TaskProgress & { kind: "metric" } => event.kind === "metric");
  return <Card size="small" title="执行进度" className="performance-page" extra={<Space>
    {isUiTaskActive(task) && <Button aria-label="停止当前任务" size="small" danger loading={busy} disabled={task.status === "stopping"} onClick={() => run(() => api().stopExecutionTask(task.id))}>停止</Button>}
    <Button size="small" onClick={() => run(() => api().exportDiagnostics(task.id))}>导出诊断</Button>
  </Space>}>
    <Space wrap style={{ marginBottom: 12 }}>
      <Select aria-label="查看执行任务" style={{ width: 280, maxWidth: "100%" }} value={task.id} onChange={setSelected}
        options={tasks.map(t => ({ value: t.id, label: `${t.kind} · ${t.env || "默认"} · ${labels[t.status]} · ${new Date(t.startedAt).toLocaleTimeString()}` }))} />
      <Typography.Text>{labels[task.status]}{task.stage !== labels[task.status] ? ` · ${task.stage}` : ""}</Typography.Text>
      {task.runId && <Typography.Text type="secondary">报告 {task.runId}</Typography.Text>}
    </Space>
    {error && <Alert type="warning" message={error} />}
    {snapshot.truncated && <Typography.Paragraph type="secondary">仅显示最近 120 条进度；完整结果请查看执行报告。</Typography.Paragraph>}
    {source === "performance" && <LiveMetrics rows={metrics} active={isUiTaskActive(task)} />}
    {!!cases.length && <Table size="small" rowKey="seq" pagination={{ pageSize: 8 }} dataSource={cases} columns={[
      { title: "用例", render: (_, row) => row.data.caseId }, { title: "状态", render: (_, row) => ({ passed: "通过", failed: "失败", error: "错误", skipped: "跳过" })[row.data.status] },
      { title: "耗时（秒）", render: (_, row) => row.data.duration.toFixed(3) },
    ]} />}
    {!!snapshot.events.length && <details><summary>阶段记录</summary><ul>{snapshot.events.filter(event => event.kind === "stage").slice(-10).map(event =>
      <li key={event.seq}>{new Date(event.timestamp).toLocaleTimeString()} · {event.kind === "stage" ? event.data.stage : ""}</li>)}</ul></details>}
    {!cases.length && source !== "performance" && <Typography.Text type="secondary">{task.status === "queued" ? "同通道任务依次执行，排队时也可取消。" : "阶段与逐用例结果在执行过程中自动更新；最终报告为权威结果。"}</Typography.Text>}
  </Card>;
}

type MetricEvent = TaskProgress & { kind: "metric" };
function LiveMetrics({ rows, active }: { rows: MetricEvent[]; active: boolean }) {
  const [metric, setMetric] = useState<"p95Ms" | "requestsPerSecond">("p95Ms");
  const [focused, setFocused] = useState<number>();
  const points = rows.filter(row => row.data[metric] != null && !row.data.truncated);
  const segments: MetricEvent[][] = [];
  let previousValid = false;
  for (const row of rows) {
    const valid = row.data[metric] != null && !row.data.truncated;
    if (valid) { if (!previousValid) segments.push([]); segments.at(-1)!.push(row); }
    previousValid = valid;
  }
  const title = metric === "p95Ms" ? "窗口 P95（ms）" : "窗口 RPS（请求/秒）";
  const max = Math.max(1, ...points.map(p => p.data[metric]!)) * 1.15;
  const start = points[0]?.timestamp ?? 0, end = points.at(-1)?.timestamp ?? start;
  const x = (row: MetricEvent) => 60 + (end === start ? 320 : (row.timestamp-start)/(end-start)*640);
  const y = (row: MetricEvent) => 180 - row.data[metric]! / max * 140;
  const picked = points.find(p => p.seq === focused);
  return <div className="perf-stack">
    <Radio.Group value={metric} onChange={event => { setMetric(event.target.value); setFocused(undefined); }} aria-label="实时指标">
      <Radio.Button value="p95Ms">P95 延迟</Radio.Button><Radio.Button value="requestsPerSecond">RPS 吞吐量</Radio.Button>
    </Radio.Group>
    <Typography.Text type="secondary">最近 5 秒滑动窗口（启动时按已运行时长计算）；最终全量汇总可能不同。溢出窗口不绘制。</Typography.Text>
    {!points.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={active ? "等待有效指标" : "本次未采集到有效指标"} /> : <div className="perf-chart">
      <div className="perf-chart-readout" aria-live="polite">{picked ? `${new Date(picked.timestamp).toLocaleTimeString()} · ${title} ${picked.data[metric]!.toFixed(2)}` : `${title} · 悬停或 Tab 聚焦数据点查看数值`}</div>
      <svg viewBox="0 0 760 225" role="group" aria-label={title} onMouseLeave={() => setFocused(undefined)} onMouseMove={event => {
        const box = event.currentTarget.getBoundingClientRect(), at = (event.clientX-box.left)*760/box.width;
        const nearest = points.reduce((best,row) => Math.abs(x(row)-at) < Math.abs(x(best)-at) ? row : best); setFocused(nearest.seq);
      }}>
        {[0,max/2,max].map(value => <g key={value}><line x1={60} x2={700} y1={180-value/max*140} y2={180-value/max*140} className="perf-chart-grid" /><text x={52} y={184-value/max*140} textAnchor="end" className="perf-chart-label">{value.toFixed(1)}</text></g>)}
        {segments.map(segment => <polyline key={segment[0].seq} points={segment.map(row => `${x(row)},${y(row)}`).join(" ")} className="perf-chart-line" />)}
        {picked && <line x1={x(picked)} x2={x(picked)} y1={40} y2={180} className="perf-chart-crosshair" />}
        {points.map(row => <g key={row.seq}><circle cx={x(row)} cy={y(row)} r={4} className="perf-chart-point" />
          <circle cx={x(row)} cy={y(row)} r={12} fill="transparent" tabIndex={0} className="perf-chart-hit" role="img" aria-label={`${new Date(row.timestamp).toLocaleTimeString()} ${title} ${row.data[metric]!.toFixed(2)}`} onFocus={() => setFocused(row.seq)} onBlur={() => setFocused(undefined)} />
        </g>)}
        <text x={60} y={211} className="perf-chart-label">{new Date(start).toLocaleTimeString()}</text><text x={700} y={211} textAnchor="end" className="perf-chart-label">{new Date(end).toLocaleTimeString()}</text>
      </svg>
    </div>}
    <details><summary>查看指标明细</summary><Table size="small" rowKey="seq" dataSource={rows} pagination={{ pageSize: 8 }} columns={[
      { title: "时间", render: (_,row) => new Date(row.timestamp).toLocaleTimeString() },
      { title: "P95 ms", render: (_,row) => row.data.p95Ms?.toFixed(2) ?? "—" },
      { title: "RPS", render: (_,row) => row.data.requestsPerSecond.toFixed(2) },
      { title: "窗口秒", render: (_,row) => row.data.windowSeconds.toFixed(1) },
      { title: "状态", render: (_,row) => row.data.truncated ? "窗口溢出" : "有效" },
    ]} /></details>
  </div>;
}

export function ProjectTaskSummary({ projectId }: { projectId: string }) {
  const active = useTasks().filter(t => t.projectId === projectId && !t.parentTaskId && isUiTaskActive(t));
  if (!active.length) return null;
  return <Alert type="info" showIcon message={`${active.length} 个后台任务（含排队）`} description={active.map(t => `${t.kind} · ${labels[t.status]}`).join("；")} />;
}
