import { EvidenceImage } from "../components/EvidenceImage";
import {
  ApiOutlined,
  ChromeOutlined,
  ExportOutlined,
  FileExcelOutlined,
  FileTextOutlined,
  FolderOpenOutlined,
  ReloadOutlined,
} from "@ant-design/icons";
import {
  Button,
  Card,
  Col,
  Descriptions,
  Drawer,
  Dropdown,
  Empty,
  Progress,
  Row,
  Segmented,
  Space,
  Statistic,
  Table,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import { useState } from "react";
import { api, type Project } from "../api";
import { FAILURE, LabelTag } from "../components/labels";
import { PageHeader } from "../components/PageHeader";
import { useAction, useLoad } from "../hooks";

interface RunRow {
  id: string;
  env: string;
  mode: string;
  started_at: string;
  framework: "pytest" | "playwright";
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  pass_rate: number;
  html_report?: string;
  junit?: string;
}

interface ResultRow {
  case_id: string;
  title: string;
  module: string;
  priority: string;
  status: string;
  duration: number;
  message: string;
  failure_type?: string;
  attribution_confirmed: boolean;
  attribution_reason: string;
  evidence_paths: string[];
  reviews: { description: string; ai_verdict: string; status: string }[];
}

const STATUS = {
  passed: { text: "通过", color: "success" },
  failed: { text: "失败", color: "error" },
  error: { text: "错误", color: "error" },
  skipped: { text: "跳过", color: "default" },
} as Record<string, { text: string; color: string }>;

const MODE: Record<string, string> = { regression: "回归", explore: "探索", heal: "自愈" };
const fmt = (iso: string) => new Date(iso).toLocaleString("zh-CN", { hour12: false });
const isImage = (p: string) => /\.(png|jpe?g|webp)$/i.test(p);

export function ReportsPage({ project }: { project: Project }) {
  const [framework, setFramework] = useState<"all" | "pytest" | "playwright">("all");
  const runs = useLoad(() => api().listRuns(project.id, framework === "all" ? undefined : framework) as Promise<RunRow[]>, [project.id, framework]);
  const [selected, setSelected] = useState<string[]>([]);
  const [open, setOpen] = useState<RunRow>();
  const { busy, run } = useAction();

  const exportRuns = (ids: string[], format: "html" | "xlsx") => run(async () => {
    const out = await api().exportReport(ids, format);
    if (out) await api().showInFolder(out.path).catch(() => undefined);
    return out;
  }, undefined);

  const exportMenu = (ids: string[]) => ({
    items: [
      { key: "html", icon: <FileTextOutlined />, label: "HTML 汇总报告（单文件，含截图）" },
      { key: "xlsx", icon: <FileExcelOutlined />, label: "Excel 结果明细" },
    ],
    onClick: ({ key }: { key: string }) => exportRuns(ids, key as "html" | "xlsx"),
  });

  return (
    <>
      <PageHeader
        title="测试报告"
        description="每次回归的执行记录。可查看明细、打开 Playwright 报告，或导出可直接发给别人的汇总报告（可合并多次执行，例如接口 + UI）。"
        extra={<>
          <Segmented value={framework} onChange={(v) => { setFramework(v as typeof framework); setSelected([]); }}
            options={[{ label: "全部", value: "all" }, { label: "接口", value: "pytest" }, { label: "UI", value: "playwright" }]} />
          <Button icon={<ReloadOutlined />} onClick={() => runs.reload()} />
          <Dropdown menu={exportMenu(selected)} disabled={!selected.length}>
            <Button type="primary" icon={<ExportOutlined />} loading={busy}>
              导出{selected.length > 1 ? `（合并 ${selected.length} 次）` : selected.length ? "" : "（先勾选执行记录）"}
            </Button>
          </Dropdown>
        </>}
      />
      <Table<RunRow>
        rowKey="id"
        loading={runs.loading}
        dataSource={runs.data}
        locale={{ emptyText: <Empty description="还没有执行记录，在「接口回归」或「UI 测试」中执行一次回归" /> }}
        rowSelection={{ selectedRowKeys: selected, onChange: (k) => setSelected(k as string[]) }}
        pagination={{ pageSize: 15, showTotal: (t) => `${t} 次执行` }}
        onRow={(r) => ({ onDoubleClick: () => setOpen(r) })}
        columns={[
          { title: "时间", dataIndex: "started_at", width: 180, render: (v: string, r) => <a onClick={() => setOpen(r)}>{fmt(v)}</a> },
          { title: "类型", dataIndex: "framework", width: 90, render: (v: string) =>
            v === "playwright" ? <Tag icon={<ChromeOutlined />} color="geekblue" bordered={false}>UI</Tag> : <Tag icon={<ApiOutlined />} color="cyan" bordered={false}>接口</Tag> },
          { title: "环境", dataIndex: "env", width: 90 },
          { title: "模式", dataIndex: "mode", width: 70, render: (v: string) => MODE[v] ?? v },
          { title: "通过率", dataIndex: "pass_rate", render: (v: number, r) => (
            <Space style={{ width: "100%" }}>
              <Progress percent={Math.round(v * 100)} size="small" style={{ width: 140, margin: 0 }} status={r.failed ? "exception" : "success"} />
              <Typography.Text type="secondary">{r.passed}/{r.total - r.skipped}</Typography.Text>
            </Space>
          ) },
          { title: "失败", dataIndex: "failed", width: 70, render: (v: number) => v ? <Typography.Text type="danger">{v}</Typography.Text> : 0 },
          { title: "", width: 130, render: (_: unknown, r) => (
            <Space size={0}>
              <Dropdown menu={exportMenu([r.id])}><Button type="link" size="small">导出</Button></Dropdown>
              {r.html_report && (
                <Tooltip title="打开 Playwright HTML 报告（含 trace）">
                  <Button type="link" size="small" onClick={() => run(() => api().openPath(r.html_report!))}>报告</Button>
                </Tooltip>
              )}
            </Space>
          ) },
        ]}
      />
      {open && <RunDrawer project={project} run={open} onClose={() => setOpen(undefined)} onExport={(f) => exportRuns([open.id], f)} busy={busy} />}
    </>
  );
}

function RunDrawer({ project, run: r, onClose, onExport, busy }: {
  project: Project; run: RunRow; onClose: () => void; onExport: (f: "html" | "xlsx") => void; busy: boolean;
}) {
  const detail = useLoad(() => api().runDetail(r.id), [r.id]);
  const { run } = useAction();
  const [onlyFailed, setOnlyFailed] = useState(r.failed > 0);
  const d = detail.data;
  const resolvePath = (p: string) => (/^([A-Za-z]:)?[\\/]/.test(p) ? p : `${project.workspace_path}/${p}`);
  const rows: ResultRow[] = (d?.results ?? []).filter((x: ResultRow) => !onlyFailed || ["failed", "error"].includes(x.status));

  return (
    <Drawer
      open
      width={860}
      onClose={onClose}
      title={<Space>{r.framework === "playwright" ? "UI" : "接口"}{MODE[r.mode] ?? r.mode}<Typography.Text type="secondary" className="mono">{r.id}</Typography.Text></Space>}
      extra={<Space>
        {r.html_report && <Button icon={<ChromeOutlined />} onClick={() => run(() => api().openPath(r.html_report!))}>Playwright 报告</Button>}
        {(r.html_report || r.junit) && (
          <Button icon={<FolderOpenOutlined />} onClick={() => run(() => api().showInFolder((r.html_report || r.junit)!))}>所在文件夹</Button>
        )}
        <Button icon={<FileExcelOutlined />} loading={busy} onClick={() => onExport("xlsx")}>导出 Excel</Button>
        <Button type="primary" icon={<FileTextOutlined />} loading={busy} onClick={() => onExport("html")}>导出 HTML 报告</Button>
      </Space>}
    >
      {!d ? <Card loading /> : (
        <>
          <Descriptions size="small" column={3} items={[
            { key: "t", label: "时间", children: fmt(d.run.started_at) },
            { key: "e", label: "环境", children: d.run.base_url ? <Tooltip title={d.run.base_url}>{d.run.env}</Tooltip> : d.run.env },
            { key: "d", label: "耗时", children: `${d.summary.duration.toFixed(1)} 秒` },
          ]} />
          <Row gutter={[16, 16]} style={{ margin: "16px 0 24px" }}>
            <Col xs={12} md={6}><Card size="small"><Statistic title="通过率" value={(d.summary.pass_rate * 100).toFixed(1)} suffix="%" /></Card></Col>
            <Col xs={12} md={6}><Card size="small"><Statistic title="通过" value={d.summary.passed} valueStyle={{ color: "var(--console-success)" }} /></Card></Col>
            <Col xs={12} md={6}><Card size="small"><Statistic title="失败" value={d.summary.failed} valueStyle={{ color: d.summary.failed ? "var(--console-error)" : undefined }} /></Card></Col>
            <Col xs={12} md={6}><Card size="small"><Statistic title="待复核" value={d.summary.pending_reviews} /></Card></Col>
          </Row>
          {Object.keys(d.summary.failure_types).length > 0 && (
            <div style={{ marginBottom: 12 }}><Space wrap>
              <Typography.Text type="secondary">失败归因：</Typography.Text>
              {Object.entries(d.summary.failure_types as Record<string, number>).map(([k, n]) => (
                <Tag key={k} color={FAILURE[k]?.color} bordered={false}>{FAILURE[k]?.text ?? k} {n}</Tag>
              ))}
            </Space></div>
          )}
          <Segmented size="small" style={{ marginBottom: 8, display: "flex", width: "fit-content" }} value={onlyFailed ? "failed" : "all"} onChange={(v) => setOnlyFailed(v === "failed")}
            options={[{ label: `只看失败 ${d.summary.failed}`, value: "failed" }, { label: `全部 ${d.summary.total}`, value: "all" }]} />
          <Table<ResultRow>
            size="small"
            rowKey="case_id"
            dataSource={rows}
            pagination={{ pageSize: 20, size: "small", hideOnSinglePage: true }}
            expandable={{
              rowExpandable: (x) => !!(x.message || x.evidence_paths.length || x.reviews.length),
              expandedRowRender: (x) => (
                <Space direction="vertical" style={{ width: "100%" }}>
                  {x.attribution_reason && <Typography.Text>{x.attribution_reason}</Typography.Text>}
                  {x.message && <pre className="mono" style={{ whiteSpace: "pre-wrap", margin: 0, maxHeight: 240, overflow: "auto" }}>{x.message}</pre>}
                  {x.evidence_paths.length > 0 && (
                    <Space wrap>
                      {x.evidence_paths.filter(isImage).map((p) => <EvidenceImage key={p} projectId={project.id} path={p} width={180} />)}
                      {x.evidence_paths.filter((p) => !isImage(p)).map((p) => (
                        <Button key={p} size="small" icon={<FolderOpenOutlined />} onClick={() => run(() => api().showInFolder(resolvePath(p)))}>
                          {p.split(/[\\/]/).pop()}
                        </Button>
                      ))}
                    </Space>
                  )}
                  {x.reviews.map((v, i) => (
                    <Typography.Text key={i} type="secondary">AI 判定：{v.description}（{v.ai_verdict === "pass" ? "通过" : v.ai_verdict === "fail" ? "不通过" : "未判定"}，{v.status === "pending" ? "待复核" : "已复核"}）</Typography.Text>
                  ))}
                </Space>
              ),
            }}
            columns={[
              { title: "用例", dataIndex: "title", render: (t: string, x) => <>{t}<div><Typography.Text type="secondary" style={{ fontSize: 12 }}>{x.module || x.case_id}</Typography.Text></div></> },
              { title: "等级", dataIndex: "priority", width: 60 },
              { title: "结果", dataIndex: "status", width: 70, render: (v: string) => <Tag color={STATUS[v]?.color} bordered={false}>{STATUS[v]?.text ?? v}</Tag> },
              { title: "归因", dataIndex: "failure_type", width: 150, render: (v: string, x) => ["failed", "error"].includes(x.status) && (
                <Space size={4}><LabelTag map={FAILURE} value={v || "unknown"} />{x.attribution_confirmed && <Tag bordered={false}>已确认</Tag>}</Space>
              ) },
              { title: "耗时", dataIndex: "duration", width: 70, align: "right", render: (v: number) => `${(v || 0).toFixed(1)}s` },
            ]}
          />
        </>
      )}
    </Drawer>
  );
}
