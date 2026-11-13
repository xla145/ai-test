import {
  ApiOutlined,
  ArrowRightOutlined,
  AuditOutlined,
  CheckCircleFilled,
  ChromeOutlined,
  FileExcelOutlined,
  FileSearchOutlined,
  FolderOpenOutlined,
  MobileOutlined,
  PlayCircleOutlined,
} from "@ant-design/icons";
import { Button, Card, Empty, Flex, Progress, Skeleton, Space, Table, Tag, Tooltip, Typography, theme } from "antd";
import type { ReactNode } from "react";
import { api, type Project } from "../api";
import { useLoad } from "../hooks";
import { useNav } from "../nav";
import { visibleProjectTab } from "../projectTypes";

/** 侧栏角标与概览待办共用的计数 */
export interface ProjectTodos {
  cases: number;
  draft: number;
  reviewed: number;
  blocked: number;
  proposals: number;
  reviews: number;
  attributions: number;
}

const total = (p: Promise<{ total: number }>) => p.then((r) => r.total, () => 0);

export async function loadTodos(project: Project): Promise<ProjectTodos> {
  const id = project.id;
  const one = { page: 1, pageSize: 1 };
  const cases = (filters?: Record<string, string>) => total(api().pageCases(id, { ...one, filters }));
  const web = visibleProjectTab("ui", project.project_type);
  const [all, draft, reviewed, blocked, proposals, reviews, attributions] = await Promise.all([
    cases(),
    cases({ status: "draft" }),
    cases({ status: "reviewed" }),
    cases({ lint_status: "blocked" }),
    web ? total(api().pageProposals(id, { ...one, status: "pending" })) : 0,
    web ? total(api().pageReviews(id, { ...one, status: "pending" })) : 0,
    total(api().pageAttributions(id, { ...one, pending: true })),
  ]);
  return { cases: all, draft, reviewed, blocked, proposals, reviews, attributions };
}

interface RunRow {
  id: string;
  env: string;
  framework: "pytest" | "playwright" | string;
  started_at: string;
  total: number;
  passed: number;
  failed: number;
  pass_rate: number;
}

const FRAMEWORK: Record<string, string> = { pytest: "接口", playwright: "UI", maestro: "App" };

/** 项目概览：按工作流给出当前进度、待处理事项和最近执行，作为进入项目后的第一页 */
export function HomePage({ project, todos }: { project: Project; todos?: ProjectTodos }) {
  const { go } = useNav();
  const { token } = theme.useToken();
  const runs = useLoad(() => api().listRuns(project.id) as Promise<RunRow[]>, [project.id]);
  const recent = [...(runs.data ?? [])].sort((a, b) => b.started_at.localeCompare(a.started_at));
  const last = recent[0];
  const web = visibleProjectTab("ui", project.project_type);
  const app = visibleProjectTab("app", project.project_type);
  const envs = Object.entries(project.environments);

  const pending = todos ? [
    { n: todos.blocked, text: "条用例有阻断级规范问题，修复前不会生成脚本", key: "import", color: "red" },
    { n: todos.draft, text: "条用例待人工审核，审核后才进入回归", key: "cases", color: "gold" },
    { n: todos.proposals, text: "个 UI 脚本修改建议待合并", key: "ui", color: "blue" },
    { n: todos.reviews, text: "个 UI 断言待人工复核", key: "ui", color: "blue" },
    { n: todos.attributions, text: "个失败归因待确认", key: "ops", color: "purple" },
  ].filter((t) => t.n > 0) : [];

  return (
    <>
      <Flex className="home-header" justify="space-between" align="flex-start" gap="16px 24px" wrap>
        <div style={{ flex: "1 1 320px", minWidth: 0 }}>
          <div className="console-section-label">项目概览</div>
          <Typography.Title level={4} className="page-title" style={{ marginTop: 0 }}>{project.name}</Typography.Title>
          <Space size={6} wrap>
            {project.workspace_path && (
              <Tooltip title="在文件夹中显示">
                <Typography.Link type="secondary" className="mono" onClick={() => api().showInFolder(project.workspace_path)}>
                  <FolderOpenOutlined /> {project.workspace_path}
                </Typography.Link>
              </Tooltip>
            )}
          </Space>
        </div>
        <Space wrap>
          <Button icon={<PlayCircleOutlined />} type="primary" onClick={() => go("run")}>执行接口回归</Button>
          {web && <Button icon={<ChromeOutlined />} onClick={() => go("ui")}>UI 回归</Button>}
          {app && <Button icon={<MobileOutlined />} onClick={() => go("app")}>App 回归</Button>}
        </Space>
      </Flex>

      {/* 工作流：准备 → 审核 → 执行 → 分析，每一步给出现状与下一步入口 */}
      <div className="flow-grid" style={{ marginBottom: 24 }}>
        <FlowStep index={1} title="准备用例" loading={!todos}
          value={todos ? <>{todos.cases}<small> 条用例</small></> : null}
          hint="导入团队已有的 Excel 用例，或从 OpenAPI / 需求文档生成"
          actions={<>
            <Button size="small" icon={<FileExcelOutlined />} onClick={() => go("import")}>导入 Excel</Button>
            <Button size="small" icon={<ApiOutlined />} onClick={() => go("api")}>生成接口用例</Button>
          </>} />
        <FlowStep index={2} title="审核用例" loading={!todos}
          value={todos ? <>{todos.reviewed}<small> / {todos.cases} 已审</small></> : null}
          hint={todos?.draft ? `${todos.draft} 条待审核${todos.blocked ? `，${todos.blocked} 条阻断` : ""}` : "全部用例已审核"}
          done={!!todos && todos.cases > 0 && todos.draft === 0}
          actions={<Button size="small" icon={<AuditOutlined />} onClick={() => go("cases")}>去审核</Button>} />
        <FlowStep index={3} title="执行回归" loading={runs.loading}
          value={last ? <>{last.passed}<small> / {last.total} 通过</small></> : <small>尚未执行</small>}
          hint={last ? `最近：${FRAMEWORK[last.framework] ?? last.framework} · ${last.env} · ${new Date(last.started_at).toLocaleString()}` : "已审核的用例生成脚本后即可执行"}
          done={!!last && last.failed === 0}
          actions={<Button size="small" icon={<PlayCircleOutlined />} onClick={() => go("run")}>接口回归</Button>} />
        <FlowStep index={4} title="分析结果" loading={!todos}
          value={todos ? <>{todos.attributions}<small> 个归因待确认</small></> : null}
          hint="查看报告、确认失败归因，合并 UI 脚本修改建议"
          done={!!todos && todos.attributions === 0 && todos.proposals === 0 && todos.reviews === 0 && !!last}
          actions={<Button size="small" icon={<FileSearchOutlined />} onClick={() => go("reports")}>测试报告</Button>} />
      </div>

      <div className="split home-panels">
        <Card size="small" title="待处理" style={{ flex: "1.4 1 360px" }}>
          {!todos ? <Skeleton active paragraph={{ rows: 3 }} title={false} /> : pending.length ? (
            <div className="todo-list">
              {pending.map((t) => (
                <button key={t.text} type="button" className="todo-item" onClick={() => go(t.key)}>
                  <Tag color={t.color} bordered={false} style={{ minWidth: 36, textAlign: "center" }}>{t.n}</Tag>
                  <span style={{ flex: 1, minWidth: 0 }}>{t.text}</span>
                  <ArrowRightOutlined style={{ color: token.colorTextTertiary }} />
                </button>
              ))}
            </div>
          ) : (
            <Flex align="center" gap={8} style={{ padding: "12px 4px" }}>
              <CheckCircleFilled style={{ color: token.colorSuccess }} />
              <Typography.Text type="secondary">没有待处理事项</Typography.Text>
            </Flex>
          )}
        </Card>
        <Card size="small" title="执行环境" style={{ flex: "1 1 260px" }}
          extra={<Typography.Link onClick={() => go("settings")}>管理</Typography.Link>}>
          {envs.length ? envs.map(([name, env]) => (
            <Flex key={name} className="environment-row" gap={8} align="center">
              <Tag color={env.production ? "red" : "blue"} bordered={false} style={{ marginInlineEnd: 0 }}>{name}</Tag>
              {env.production && <Typography.Text type="danger" style={{ fontSize: 12, whiteSpace: "nowrap" }}>生产</Typography.Text>}
              <Typography.Text type="secondary" className="mono" ellipsis style={{ minWidth: 0 }}>{env.base_url}</Typography.Text>
              {project.inherited_environments?.[name] && <Tag bordered={false} style={{ marginInlineEnd: 0 }}>继承</Tag>}
            </Flex>
          )) : (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有配置被测地址">
              <Button size="small" onClick={() => go("settings")}>添加环境</Button>
            </Empty>
          )}
        </Card>
      </div>

      <Card size="small" title="最近执行" style={{ marginTop: 24 }}
        extra={recent.length > 0 && <Typography.Link onClick={() => go("reports")}>全部报告</Typography.Link>}>
        <Table<RunRow> size="small" rowKey="id" loading={runs.loading} dataSource={recent.slice(0, 5)} pagination={false}
          scroll={{ x: 520 }}
          locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有执行记录" /> }}
          onRow={() => ({ onClick: () => go("reports"), style: { cursor: "pointer" } })}
          columns={[
            { title: "类型", dataIndex: "framework", width: 70, render: (f: string) => <Tag bordered={false}>{FRAMEWORK[f] ?? f}</Tag> },
            { title: "环境", dataIndex: "env", width: 80 },
            { title: "结果", render: (_: unknown, r) => (
              <Flex align="center" gap={12} style={{ maxWidth: 320 }}>
                <Progress percent={Math.round(r.pass_rate * 100)} size="small" showInfo={false}
                  status={r.failed ? "exception" : "success"} style={{ flex: 1, margin: 0 }} />
                <span className="run-rate">{Math.round(r.pass_rate * 100)}%</span>
                <span style={{ whiteSpace: "nowrap" }}>{r.passed}/{r.total}</span>
              </Flex>
            ) },
            { title: "时间", dataIndex: "started_at", width: 200, render: (t: string) => <span style={{ whiteSpace: "nowrap" }}>{new Date(t).toLocaleString()}</span> },
          ]} />
      </Card>
    </>
  );
}

function FlowStep({ index, title, value, hint, actions, done, loading }: {
  index: number;
  title: string;
  value: ReactNode;
  hint: string;
  actions: ReactNode;
  done?: boolean;
  loading?: boolean;
}) {
  const { token } = theme.useToken();
  return (
    <Card size="small" className="flow-step">
      <Flex align="center" gap={8} style={{ marginBottom: 8 }}>
        <span className="flow-index" style={done
          ? { background: token.colorSuccessBg, color: token.colorSuccess }
          : { background: token.colorFillQuaternary, color: token.colorTextSecondary }}>
          {done ? <CheckCircleFilled /> : index}
        </span>
        <Typography.Text strong>{title}</Typography.Text>
      </Flex>
      {loading ? <Skeleton active paragraph={{ rows: 1 }} title={false} /> : (
        <>
          <div className="flow-value">{value}</div>
          <Typography.Paragraph type="secondary" ellipsis={{ rows: 2, tooltip: hint }} style={{ fontSize: 12, minHeight: 38, marginBottom: 10 }}>
            {hint}
          </Typography.Paragraph>
        </>
      )}
      <Space size={6} wrap>{actions}</Space>
    </Card>
  );
}
