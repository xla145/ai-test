import { useAssistantPageContext } from "../assistant/AssistantContext";
import { useTasks } from "../stores/taskStore";
import { TaskProgressPanel } from "../components/TaskProgressPanel";
import { CheckCircleOutlined, CloseCircleOutlined, DownOutlined, ExclamationCircleOutlined, StopOutlined, WarningOutlined } from "@ant-design/icons";
import { Alert, Button, Card, Checkbox, Collapse, Descriptions, Empty, Form, Input, InputNumber, Radio, Select, Space, Table, Tabs, Tag, Tooltip, Typography } from "antd";
import { useEffect, useState } from "react";
import { api, type Project } from "../api";
import type { PerformanceResult } from "../../shared/performance";
import type { ApiDefinition, ApiRequest } from "../../shared/apiWorkspace";
import { bindPerformanceDefinition, performanceDefinitionIssue, performanceRequestFromDefinition } from "../../shared/performanceSource";
import { JsonField } from "./api/RequestEditor";
import { useNav } from "../nav";
import { PageHeader } from "../components/PageHeader";
import { useAction, useLoad } from "../hooks";
import { performanceSeriesKey, performanceSeriesLabel, performanceTargetKey, performanceTrend } from "./performanceView";
import "./PerformancePage.css";

const ms = (v?: number | null) => v == null ? "—" : `${v.toFixed(1)} ms`;
const rate = (v?: number | null) => v == null ? "—" : `${(v * 100).toFixed(2)}%`;
const time = (s: string) => new Date(s).toLocaleString("zh-CN", {
  month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
});
const STATUS = {
  passed: { label: "通过", color: "success", icon: <CheckCircleOutlined /> },
  failed: { label: "未达标", color: "error", icon: <CloseCircleOutlined /> },
  degraded: { label: "性能退化", color: "warning", icon: <WarningOutlined /> },
  stopped: { label: "已中止", color: "default", icon: <StopOutlined /> },
  error: { label: "执行错误", color: "error", icon: <ExclamationCircleOutlined /> },
};
function Status({ value }: { value: PerformanceResult["status"] }) {
  const s = STATUS[value];
  return <Tag color={s?.color} icon={s?.icon}>{s?.label ?? value}</Tag>;
}

export function PerformancePage({ project }: { project: Project }) {
  return <div className="page-frame section-page performance-page">
    <PageHeader title="性能测试" description="从当前项目的接口列表选择测试目标，复用请求配置，仅补充负载与性能门槛。真实执行使用本地 k6，不调用模型。" />
<div className="page-scroll-body">
    <PerformancePanel key={project.id} project={project} />
  </div>
</div>;
}

function PerformancePanel({ project }: { project: Project }) {
  const envs = Object.keys(project.environments);
  const [env, setEnv] = useState(envs.find(e => !project.environments[e].production) ?? "");
  const activeEnv = envs.includes(env) ? env : "";
  const { go } = useNav();
  const [loadError, setLoadError] = useState("");
  const definitions = useLoad(async () => {
    try { const rows = await api().listApiDefinitions(project.id); setLoadError(""); return rows; }
    catch (e) { setLoadError((e as Error).message); return [] as ApiDefinition[]; }
  }, [project.id]);
  const [selection, setSelection] = useState<{ definition: ApiDefinition; request: ApiRequest }>();
  const [invalid, setInvalid] = useState<Record<string, boolean>>({});
  const [editorKey, setEditorKey] = useState(0);
  const selectDefinition = (definition: ApiDefinition) => {
    setSelection({ definition, request: performanceRequestFromDefinition(definition) });
    setInvalid({}); setEditorKey(n => n + 1);
  };
  useEffect(() => {
    if (!selection && definitions.data?.length) {
      const available = definitions.data.filter(d => !performanceDefinitionIssue(d));
      const first = available.find(d => d.method === "GET" && !d.path.includes("{")) ?? available[0];
      if (first) selectDefinition(first);
    }
  }, [definitions.data, selection]);
  const selected = definitions.data?.find(d => d.id === selection?.definition.id);
  const request = selection?.request;
  useAssistantPageContext({ projectId: project.id, page: "performance", env: activeEnv, references: selected ? [{ kind: "definition", id: selected.id, label: selected.summary }] : [] });
  const stale = !!selection && (!selected || selected.revision !== selection.definition.revision || !!performanceDefinitionIssue(selected));
  const setRequest = (patch: Partial<ApiRequest>) => setSelection(s => s ? { ...s, request: { ...s.request, ...patch } } : s);
  const valid = !Object.values(invalid).some(Boolean);
  const [vus, setVus] = useState(5);
  const [seconds, setSeconds] = useState(10);
  const [p95Ms, setP95Ms] = useState(1000);
  const [maxFailureRate, setMaxFailureRate] = useState(0.01);
  const [checkBusinessCode, setCheckBusinessCode] = useState(true);
  const [useRamp, setUseRamp] = useState(false);
  const [rampUp, setRampUp] = useState(10);
  const [rampDown, setRampDown] = useState(10);
  const history = useLoad(() => api().performanceHistory(project.id), [project.id]);
  const latestTask = useTasks().find(task => task.source === "performance" && task.projectId === project.id);
  useEffect(() => {
    if (latestTask && ["completed", "failed", "stopped"].includes(latestTask.status)) void history.reload();
  }, [latestTask?.id, latestTask?.status, history.reload]);
  const { busy, run } = useAction();
  const preview = !window.desktopHost;
  const total = seconds + (useRamp ? rampUp + rampDown : 0);

  const start = () => run(async () => {
    if (!activeEnv || project.environments[activeEnv].production) throw new Error("请选择非生产环境");
    if (!selected || !selection || !request || stale) throw new Error("请重新从接口列表选择测试目标");
    if (!valid) throw new Error("请修正请求参数中的 JSON 格式错误");
    if (total > 300) throw new Error("总时长不能超过 300 秒，请缩短升压、稳态或降压时间");
    const options = bindPerformanceDefinition(selected, {
      definitionId: selection.definition.id, definitionRevision: selection.definition.revision,
      path: selected.path, method: undefined, pathParams: request.path_params, query: request.query,
      headers: request.headers as Record<string, string>, body: request.body,
      auth: request.auth, role: request.auth === false ? "" : request.role,
      timeoutSeconds: request.timeout, vus, seconds, p95Ms, maxFailureRate, checkBusinessCode,
      ...(useRamp ? { rampUp, rampDown } : {}),
    });
    try {
      await api().runPerformance(project.id, activeEnv, options);
    } finally { await history.reload(); }
  }, "性能任务已结束");

  return <div className="perf-stack">
    <TaskProgressPanel projectId={project.id} source="performance" env={activeEnv} />
    {preview && <Alert showIcon type="info" message="演示预览 · 数据均为合成样本，不是真实压测结果"
      description="可查看不同结果、展开详情、切换趋势和试设基线。不会运行 k6、发送请求或写入真实项目；刷新页面重置演示基线。" />}
    {!activeEnv && <Alert showIcon type="warning" message="请先在项目设置中添加非生产环境" />}
    <Tabs items={[
      { key: "single", label: "接口压测", children: <div className="perf-stack">
        <Card size="small" title="新建性能任务" extra={<Space>
          <Button size="small" onClick={() => void definitions.reload()} loading={definitions.loading}>刷新接口</Button>
          <Button size="small" type="link" onClick={() => go("api")}>管理接口</Button>
        </Space>}>
          {loadError && <Alert type="error" showIcon message="接口列表加载失败" description={loadError} style={{ marginBottom: 12 }} />}
          {!definitions.loading && !definitions.data?.length && <Empty description="当前项目还没有接口，请先到接口测试导入接口文档">
            <Button type="primary" onClick={() => go("api")}>去导入接口</Button>
          </Empty>}
          <Form layout="vertical" onFinish={start} className="perf-form">
            <div className="perf-source-row">
              <Form.Item label="环境" htmlFor="perf-env" className="perf-source-env"><Select id="perf-env" size="middle" value={activeEnv || undefined} onChange={setEnv}
                placeholder="环境" options={envs.map(e => ({ value: e, label: project.environments[e].production ? `${e}（生产）` : e, disabled: !!project.environments[e].production }))} /></Form.Item>
              <Form.Item label="接口" htmlFor="perf-definition" className="perf-source-def"><Select id="perf-definition" size="middle" showSearch optionFilterProp="label"
                loading={definitions.loading} value={selected?.id} placeholder="搜索接口名称、方法、路径或模块"
                onSelect={id => { const d = definitions.data?.find(d => d.id === id); if (d) selectDefinition(d); }}
                options={(definitions.data ?? []).map(d => ({ value: d.id,
                  label: `${d.module || "未分组"} · ${d.summary || "未命名接口"} · ${d.method} ${d.path}${performanceDefinitionIssue(d) ? `（${performanceDefinitionIssue(d)}）` : ""}`,
                  disabled: !!performanceDefinitionIssue(d),
                }))} /></Form.Item>
            </div>
            {selected && <div className="perf-source-summary">
              <Tag>{selected.method}</Tag><Typography.Text code className="mono">{selected.path}</Typography.Text>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>来源 {selected.source} · 修订 {selection?.definition.revision} · 路由只读</Typography.Text>
            </div>}
            {stale && <Alert type="warning" showIcon message="接口已更新或移除，请重新选择并确认参数" style={{ marginBottom: 8 }} />}
            {selected && request && <Collapse ghost size="small" className="perf-params-collapse" items={[{
              key: "params", label: <span>请求参数与鉴权 <DownOutlined style={{ fontSize: 10 }} /></span>,
              children: <>
                <Tabs key={`${selected.id}:${editorKey}`} size="small" items={[
                  { key: "path", label: "路径参数", children: <JsonField label="性能路径参数" object rows={3} value={request.path_params ?? {}}
                    onChange={path_params => setRequest({ path_params })} onValidity={ok => setInvalid(s => ({ ...s, path: !ok }))} /> },
                  { key: "query", label: "Query", children: <JsonField label="性能 Query 参数" object rows={3} value={request.query ?? {}}
                    onChange={query => setRequest({ query })} onValidity={ok => setInvalid(s => ({ ...s, query: !ok }))} /> },
                  { key: "headers", label: "Headers", children: <JsonField label="性能请求头" object rows={3} value={request.headers ?? {}}
                    onChange={headers => setRequest({ headers })} onValidity={ok => setInvalid(s => ({ ...s, headers: !ok }))} /> },
                  { key: "body", label: "Body", children: <JsonField label="性能请求体" rows={4} value={request.body ?? null}
                    onChange={body => setRequest({ body })} onValidity={ok => setInvalid(s => ({ ...s, body: !ok }))} /> },
                ]} />
                <Space wrap style={{ marginTop: 8 }}>
                  <Radio.Group id="perf-auth" value={request.auth !== false} onChange={e => setRequest({ auth: e.target.value })} size="small">
                    <Radio.Button value={true}>使用环境凭据</Radio.Button><Radio.Button value={false}>不鉴权</Radio.Button>
                  </Radio.Group>
                  {request.auth !== false && <Input aria-label="角色" value={request.role ?? ""} onChange={e => setRequest({ role: e.target.value })} placeholder="角色（空 = 默认）" allowClear style={{ width: 160 }} />}
                  <Checkbox checked={checkBusinessCode} onChange={e => setCheckBusinessCode(e.target.checked)}>校验业务码</Checkbox>
                </Space>
                <Typography.Paragraph type="secondary" className="perf-parameter-note">参数来自接口定义，可调整为本次压测数据，不改接口目录。业务码 401/403 不记为通过。</Typography.Paragraph>
              </>,
            }]} />}
            <div className="perf-load-row">
              <Form.Item label="VU" htmlFor="perf-vus"><InputNumber id="perf-vus" min={1} max={100} precision={0} value={vus} onChange={v => setVus(v ?? 1)} style={{ width: 80 }} /></Form.Item>
              <Form.Item label="稳态秒" htmlFor="perf-seconds"><InputNumber id="perf-seconds" min={1} max={300} precision={0} value={seconds} onChange={v => setSeconds(v ?? 1)} style={{ width: 80 }} /></Form.Item>
              <Form.Item label="P95 ms" htmlFor="perf-p95"><InputNumber id="perf-p95" min={1} value={p95Ms} onChange={v => setP95Ms(v ?? 1000)} style={{ width: 90 }} /></Form.Item>
              <Form.Item label="失败率 %" htmlFor="perf-fail"><InputNumber id="perf-fail" min={0} max={99} step={0.1} value={maxFailureRate * 100} onChange={v => setMaxFailureRate((v ?? 1) / 100)} style={{ width: 80 }} /></Form.Item>
              <Form.Item label="负载">
                <Radio.Group aria-label="负载模式" value={useRamp} onChange={e => setUseRamp(e.target.value)} size="small">
                  <Radio.Button value={false}>固定</Radio.Button><Radio.Button value={true}>阶梯</Radio.Button>
                </Radio.Group>
              </Form.Item>
              {useRamp && <>
                <Form.Item label="升压秒"><InputNumber aria-label="升压秒数" min={0} max={120} precision={0} value={rampUp} onChange={v => setRampUp(v ?? 0)} style={{ width: 72 }} /></Form.Item>
                <Form.Item label="降压秒"><InputNumber aria-label="降压秒数" min={0} max={60} precision={0} value={rampDown} onChange={v => setRampDown(v ?? 0)} style={{ width: 72 }} /></Form.Item>
              </>}
              <Typography.Text type={total > 300 ? "danger" : "secondary"} className="perf-load-total">{total}s / 300s</Typography.Text>
            </div>
            <div className="perf-run-actions">
              <Button type="primary" htmlType="submit" loading={busy} disabled={!activeEnv || !selected || stale || !valid || definitions.loading || total > 300}>开始测试</Button>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>{preview ? "浏览器只预览配置。" : "仅允许非生产环境，≤ 100 VU。"}</Typography.Text>
            </div>
          </Form>
        </Card>
        <Card size="small" title={`历史结果${history.data ? ` · ${history.data.length} 条` : ""}`}
          extra={<Button size="small" onClick={() => void history.reload()} loading={history.loading}>刷新结果</Button>}>
          <Table<PerformanceResult> size="small" rowKey="id" loading={history.loading} dataSource={history.data ?? []}
            pagination={{ pageSize: 8, size: "small" }} scroll={{ x: 760 }} locale={{ emptyText: "尚无性能执行记录" }}
            expandable={{ expandedRowRender: r => <PerformanceDetail result={r} /> }}
            columns={[
              { title: "时间", dataIndex: "startedAt", width: 100, render: time },
              { title: "接口", width: 180, ellipsis: true, render: (_, r) => <Tooltip title={`${r.options.method ?? "GET"} ${r.options.path}`}><Tag className="perf-method-tag">{r.options.method ?? "GET"}</Tag>{r.options.definitionName || r.options.path}</Tooltip> },
              { title: "状态", dataIndex: "status", width: 90, render: v => <Status value={v} /> },
              { title: "请求", dataIndex: "requests", width: 56, render: v => v ?? "—" },
              { title: "P95", dataIndex: "p95Ms", width: 76, render: ms },
              { title: "失败率", dataIndex: "failureRate", width: 72, render: rate },
              { title: "RPS", dataIndex: "requestsPerSecond", width: 60, render: v => v == null ? "—" : v.toFixed(1) },
              { title: "", width: 72, render: (_, r) => <Button size="small" type="link" disabled={busy || r.status !== "passed" || !r.thresholdsPassed}
                onClick={() => run(() => api().perfSetBaseline(project.id, performanceTargetKey(r.options), r.id), preview ? "演示基线已设置（刷新重置）" : "已设为基线")}>基线</Button> },
            ]} />
          <Typography.Text type="secondary">展开行可查看 P50 / P90 / P99、门槛、失败原因与退化详情。</Typography.Text>
        </Card>
      </div> },
      { key: "trend", label: "趋势分析", children: <PerformanceTrends rows={history.data ?? []} loading={history.loading} /> },
    ]} />
  </div>;
}

function PerformanceDetail({ result: r }: { result: PerformanceResult }) {
  return <div className="perf-stack">
    {r.message && <Alert showIcon type={r.status === "failed" || r.status === "error" ? "warning" : "info"} message={r.message} />}
    <Descriptions size="small" column={{ xs: 1, sm: 2, md: 3 }} items={[
      { key: "target", label: "目标", children: <><Tag>{r.options.method ?? "GET"}</Tag><span className="mono">{r.options.path}</span></> },
      { key: "env", label: "环境", children: r.env },
      { key: "load", label: "负载", children: `${r.options.vus} VU / ${r.options.seconds}s` },
      { key: "p50", label: "P50", children: ms(r.p50Ms) }, { key: "p90", label: "P90", children: ms(r.p90Ms) },
      { key: "p99", label: "P99", children: ms(r.p99Ms) }, { key: "avg", label: "平均耗时", children: ms(r.avgMs) },
      { key: "p95", label: "P95 门槛", children: `< ${r.options.p95Ms} ms` },
      { key: "fail", label: "失败率门槛", children: `≤ ${rate(r.options.maxFailureRate)}` },
      { key: "http-fail", label: "HTTP 失败率", children: rate(r.httpFailureRate) },
      { key: "business-fail", label: "业务失败率", children: rate(r.businessFailureRate) },
      { key: "auth-fail", label: "未授权请求", children: r.authFailures == null ? "—" : `${r.authFailures} 次` },
      { key: "validation-fail", label: "响应验证失败", children: r.responseValidationFailures == null ? "—" : `${r.responseValidationFailures} 次` },
      { key: "sent", label: "发送量", children: r.dataSentBytes == null ? "—" : `${(r.dataSentBytes / 1024).toFixed(1)} KiB` },
      { key: "received", label: "接收量", children: r.dataReceivedBytes == null ? "—" : `${(r.dataReceivedBytes / 1024).toFixed(1)} KiB` },
      { key: "ramp", label: "升压 / 稳态 / 降压", children: `${r.options.rampUp ?? 0} / ${r.options.seconds} / ${r.options.rampDown ?? 0} 秒` },
    ]} />
    {!!r.degradation?.details.length && <Alert type="warning" showIcon message="相对基线退化" description={r.degradation.details.join("；")} />}
    {!!r.steps?.length && <Table size="small" rowKey="name" pagination={false} dataSource={r.steps} columns={[
      { title: "步骤", dataIndex: "name" }, { title: "请求数", dataIndex: "requests" },
      { title: "P95", dataIndex: "p95Ms", render: ms }, { title: "失败率", dataIndex: "failureRate", render: rate },
    ]} />}
  </div>;
}

function PerformanceTrends({ rows, loading }: { rows: PerformanceResult[]; loading: boolean }) {
  const [env, setEnv] = useState("");
  const [series, setSeries] = useState("");
  const [metric, setMetric] = useState<"p95Ms" | "requestsPerSecond">("p95Ms");
  const envs = [...new Set(rows.map(r => r.env))];
  const activeEnv = envs.includes(env) ? env : envs[0];
  const groups = [...new Map(rows.filter(r => r.env === activeEnv && r.p95Ms != null
    && ["passed", "failed", "degraded"].includes(r.status))
    .map(r => [performanceSeriesKey(r), r] as const)).entries()];
  // 优先展示有多次执行的目标，而不是默认选择只有一条记录的新目标。
  const activeSeries = groups.some(([key]) => key === series) ? series
    : [...groups].sort(([a], [b]) => performanceTrend(rows, b).length - performanceTrend(rows, a).length)[0]?.[0] ?? "";
  const points = performanceTrend(rows, activeSeries);
  if (!rows.length) return <Card loading={loading}><Empty description="尚无执行记录，完成测试后可查看趋势" /></Card>;
  return <div className="perf-stack" style={{ opacity: loading ? 0.6 : 1 }}>
    <div className="perf-trend-filters">
      <Select aria-label="趋势环境" value={activeEnv} onChange={e => { setEnv(e); setSeries(""); }} options={envs.map(value => ({ value, label: value }))} />
      <Select aria-label="趋势目标及负载" value={activeSeries || undefined} onChange={setSeries} placeholder="选择同一目标及负载"
        options={groups.map(([value, r]) => ({ value, label: performanceSeriesLabel(r) }))} />
      <Radio.Group aria-label="趋势指标" value={metric} onChange={e => setMetric(e.target.value)}>
        <Radio.Button value="p95Ms">P95 延迟</Radio.Button><Radio.Button value="requestsPerSecond">RPS 吞吐量</Radio.Button>
      </Radio.Group>
    </div>
    <Typography.Text type="secondary">最近 20 次完整执行，按时间从左到右排列。只比较相同环境、目标及负载；中止和执行错误不计入趋势。</Typography.Text>
    <PerformanceChart key={`${activeSeries}:${metric}`} rows={points} metric={metric} />
    <Table<PerformanceResult> rowKey="id" size="small" pagination={false} scroll={{ x: 480 }} dataSource={points} columns={[
      { title: "执行时间", dataIndex: "startedAt", render: time }, { title: "P95", dataIndex: "p95Ms", render: ms },
      { title: "RPS", dataIndex: "requestsPerSecond", render: v => v == null ? "—" : v.toFixed(2) },
      { title: "失败率", dataIndex: "failureRate", render: rate }, { title: "状态", dataIndex: "status", render: v => <Status value={v} /> },
    ]} />
  </div>;
}

function PerformanceChart({ rows, metric }: { rows: PerformanceResult[]; metric: "p95Ms" | "requestsPerSecond" }) {
  const [active, setActive] = useState<number | null>(null);
  const points = rows.filter(r => typeof r[metric] === "number" && Number.isFinite(r[metric]));
  const title = metric === "p95Ms" ? "P95 延迟趋势" : "RPS 吞吐量趋势";
  const format = (v: number) => metric === "p95Ms" ? ms(v) : `${v.toFixed(2)} 请求/秒`;
  if (!points.length) return <Card size="small" title={title}><Empty description="暂无可比较的数据" /></Card>;
  const W = 760, H = 260, left = 65, right = 35, top = 38, bottom = 40;
  const width = W - left - right, height = H - top - bottom;
  const start = Date.parse(points[0].startedAt), end = Date.parse(points.at(-1)!.startedAt);
  const max = Math.max(...points.map(r => r[metric]!), 1) * 1.15;
  const x = (i: number) => left + (end === start ? width / 2 : (Date.parse(points[i].startedAt) - start) / (end - start) * width);
  const y = (v: number) => top + height * (1 - v / max);
  const selectedIndex = active != null && active < points.length ? active : null;
  const readout = selectedIndex == null ? null : points[selectedIndex];
  return <Card size="small" title={title}>
    <div className="perf-chart">
      <div className="perf-chart-readout" aria-live="polite">{readout
        ? `${time(readout.startedAt)} · ${format(readout[metric]!)} · ${STATUS[readout.status].label}` : "悬停或用 Tab 聚焦数据点查看详情；下表提供完整数据。"}</div>
      <svg viewBox={`0 0 ${W} ${H}`} role="group" aria-label={title} onMouseLeave={() => setActive(null)}
        onMouseMove={e => {
          const bounds = e.currentTarget.getBoundingClientRect();
          const at = (e.clientX - bounds.left) * W / bounds.width;
          const nearest = points.reduce((best, _, i) => Math.abs(x(i) - at) < Math.abs(x(best) - at) ? i : best, 0);
          setActive(nearest);
        }}>
        {[0, max / 2, max].map(v => <g key={v}>
          <line x1={left} x2={W - right} y1={y(v)} y2={y(v)} className="perf-chart-grid" />
          <text x={left - 8} y={y(v) + 4} textAnchor="end" className="perf-chart-label">{v.toFixed(metric === "p95Ms" ? 0 : 1)}</text>
        </g>)}
        <text x={left - 8} y={top - 12} textAnchor="end" className="perf-chart-label">{metric === "p95Ms" ? "ms" : "RPS"}</text>
        <polyline points={points.map((r, i) => `${x(i)},${y(r[metric]!)}`).join(" ")} className="perf-chart-line" />
        {selectedIndex != null && <line x1={x(selectedIndex)} x2={x(selectedIndex)} y1={top} y2={H - bottom} className="perf-chart-crosshair" />}
        {points.map((r, i) => <g key={r.id}>
          <circle cx={x(i)} cy={y(r[metric]!)} r={4} className="perf-chart-point" />
          <circle cx={x(i)} cy={y(r[metric]!)} r={12} fill="transparent" tabIndex={0} role="img"
            aria-label={`${time(r.startedAt)} ${format(r[metric]!)} ${STATUS[r.status].label}`}
            onFocus={() => setActive(i)} onBlur={() => setActive(null)} className="perf-chart-hit" />
          {(i === 0 || i === points.length - 1 || (points.length > 4 && i === Math.floor(points.length / 2)))
            && <text x={x(i)} y={H - 12} textAnchor="middle" className="perf-chart-label">{time(r.startedAt)}</text>}
        </g>)}
      </svg>
    </div>
  </Card>;
}
