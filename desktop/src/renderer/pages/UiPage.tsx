import { CheckOutlined, CloseOutlined, CompassOutlined, UserAddOutlined } from "@ant-design/icons";
import {
  Alert,
  Badge,
  Button,
  Card,
  Empty,
  Form,
  Image,
  Input,
  List,
  Row,
  Col,
  Space,
  Statistic,
  Switch,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import { useState } from "react";
import { api, envOwner, type Project, type TestCase } from "../api";
import { CaseLink, CaseTitles } from "../components/CaseLink";
import { DiffView } from "../components/DiffView";
import { EnvSelect, RunButton, useEnvChoice } from "../components/EnvPicker";
import { FAILURE, LabelTag, LINT, MODE } from "../components/labels";
import { useProjects } from "../components/ProjectSettings";
import { PageHeader } from "../components/PageHeader";
import { useAction, useLoad, usePaged } from "../hooks";

interface Proposal { id: string; case_id: string; script_path: string; diff: string; reason: string; status: string }
interface Review { id: string; case_id: string; kind: string; description: string; ai_verdict: string; evidence_paths: string[]; status: string }
interface UiFailure { case_id: string; status: string; failure_type: string; message: string; reason?: string }
interface UiRunResult {
  run: { run_id: string; total: number; passed: number; failed: number; error: number; reviews: number };
  heal?: { case_id: string; failure_type: string; reason?: string }[];
  /** 失败明细（规则判定 + agent 自愈结论） */
  failures?: UiFailure[];
  degraded: string[];
  missingData: string[];
  htmlReport: string;
}

export function UiPage({ project }: { project: Project }) {
  const envs = Object.keys(project.environments);
  const [env, setEnv] = useEnvChoice(project);
  const [headed, setHeaded] = useState(true);
  const [result, setResult] = useState<UiRunResult>();
  const { busy, run } = useAction();
  // 只看当前项目的待处理项，按页读取
  const proposals = usePaged<Proposal>(
    (q) => api().pageProposals(project.id, { ...q, status: "pending" }) as Promise<{ items: Proposal[]; total: number }>,
    [project.id], 5);
  const reviews = usePaged<Review>(
    (q) => api().pageReviews(project.id, { ...q, status: "pending" }) as Promise<{ items: Review[]; total: number }>,
    [project.id], 10);

  if (!envs.length) return <Empty description="项目还没有配置执行环境" />;
  const failed = result ? result.run.failed + result.run.error : 0;

  return (
    <>
      <PageHeader
        title="UI 测试"
        description="探索一次生成确定性 Playwright 脚本，回归直接执行；页面改版导致的失败由 agent 给出脚本修改建议，确认后才合并。"
        extra={<>
          <EnvSelect project={project} value={env} onChange={setEnv} width={180} />
          <Space><Switch size="small" checked={headed} onChange={setHeaded} />可视化执行</Space>
          <RunButton project={project} env={env} loading={busy}
            onRun={(confirmProduction) => run(async () => {
              setResult((await api().runUiRegression(project.id, env, headed, { confirmProduction })) as UiRunResult);
              await Promise.all([proposals.reload(), reviews.reload()]);
            })}>
            执行 UI 回归
          </RunButton>
        </>}
      />
      {result && (
        <>
          <div className="stat-grid" style={{ marginBottom: 16 }}>
            <Card size="small"><Statistic title="总数" value={result.run.total} /></Card>
            <Card size="small"><Statistic title="通过" value={result.run.passed} valueStyle={{ color: "#3f8600" }} /></Card>
            <Card size="small"><Statistic title="失败" value={failed} valueStyle={{ color: failed ? "#cf1322" : undefined }} /></Card>
            <Card size="small"><Statistic title="待人工复核" value={result.run.reviews} /></Card>
            <Card size="small"><Statistic title="降级手工" value={result.degraded.length} /></Card>
          </div>
          {result.missingData.length > 0 && (
            <Alert style={{ marginBottom: 16 }} type="warning" showIcon
              message={`缺少测试数据且无法造数：${result.missingData.join("、")}`} description="依赖这些数据的用例本次未执行，已降级为手工。" />
          )}
          <UiRunDetail project={project} result={result} />
        </>
      )}
      <Tabs
        type="card"
        items={[
          { key: "proposals", label: <Badge count={proposals.total} size="small" offset={[10, 0]}>脚本修改建议</Badge>,
            children: <Proposals project={project} paged={proposals} /> },
          { key: "reviews", label: <Badge count={reviews.total} size="small" offset={[10, 0]}>人工复核</Badge>,
            children: <Reviews project={project} paged={reviews} /> },
          { key: "cases", label: "UI 用例", children: <UiCases project={project} env={env} /> },
          { key: "roles", label: "角色与登录", children: <Roles project={project} env={env} /> },
        ]}
      />
    </>
  );
}

/** UI 回归的失败明细与降级用例 */
function UiRunDetail({ project, result }: { project: Project; result: UiRunResult }) {
  const failures = result.failures ?? (result.heal ?? []).map((h) => ({ ...h, status: "failed", message: "" }));
  const rows = [
    ...failures.map((f) => ({ ...f, key: `f:${f.case_id}` })),
    ...result.degraded.map((id) => ({ key: `d:${id}`, case_id: id, status: "degraded", failure_type: "", message: "依赖的测试数据缺失且无法造数，本次未执行", reason: undefined as string | undefined })),
  ];
  if (!rows.length) return null;
  return (
    <Card size="small" title="失败与降级明细" style={{ marginBottom: 16 }}
      extra={<Typography.Text type="secondary">归因在「工程化 → 失败归因」确认</Typography.Text>}>
      <CaseTitles projectId={project.id} ids={rows.map((r) => r.case_id)}>
        <Table size="small" rowKey="key" dataSource={rows} scroll={{ x: 680 }}
          pagination={{ defaultPageSize: 10, size: "small", hideOnSinglePage: true, showTotal: (t) => `共 ${t} 条` }}
          columns={[
            { title: "用例", dataIndex: "case_id", width: 220, render: (id: string) => <CaseLink id={id} /> },
            { title: "结果", dataIndex: "status", width: 90, render: (s: string) =>
              s === "degraded" ? <Tag bordered={false}>降级手工</Tag> : <Tag color="red" bordered={false}>{s === "error" ? "出错" : "失败"}</Tag> },
            { title: "归因", dataIndex: "failure_type", width: 140, render: (v: string) => (v ? <LabelTag map={FAILURE} value={v} /> : "—") },
            { title: "说明", render: (_: unknown, r: { reason?: string; message: string }) => (
              <>
                {r.reason && <div>{r.reason}</div>}
                {r.message && (
                  <Typography.Paragraph type="secondary" className="mono" style={{ marginBottom: 0, fontSize: 12 }}
                    ellipsis={{ rows: 2, expandable: true, symbol: "展开" }}>{r.message}</Typography.Paragraph>
                )}
              </>
            ) },
          ]} />
      </CaseTitles>
    </Card>
  );
}

type Paged<T> = ReturnType<typeof usePaged<T>>;

function Proposals({ project, paged }: { project: Project; paged: Paged<Proposal> }) {
  const { items: data, loading, reload, pagination } = paged;
  const { busy, run } = useAction();
  if (!loading && !data.length) return <Empty description="没有待处理的修改建议" />;
  return (
    <CaseTitles projectId={project.id} ids={data.map((p) => p.case_id)}>
    <List
      loading={loading}
      dataSource={data}
      pagination={{ ...pagination, pageSizeOptions: [5, 10, 20], align: "end" }}
      renderItem={(p) => (
        <Card size="small" style={{ marginBottom: 12 }}
          title={<Space size={12} style={{ minWidth: 0, maxWidth: "100%" }}><CaseLink id={p.case_id} />
            <Typography.Text type="secondary" className="mono" ellipsis style={{ maxWidth: 320 }}>{p.script_path}</Typography.Text></Space>}
          extra={<Space>
            <Button size="small" icon={<CloseOutlined />} loading={busy} onClick={() => run(async () => { await api().resolveProposal(project.id, p.id, false); await reload(); }, "已拒绝")}>拒绝</Button>
            <Button size="small" type="primary" icon={<CheckOutlined />} loading={busy} onClick={() => run(async () => { await api().resolveProposal(project.id, p.id, true); await reload(); }, "已合并并提交到 workspace 的 git")}>合并</Button>
          </Space>}
        >
          {p.reason && <Typography.Paragraph type="secondary">{p.reason}</Typography.Paragraph>}
          <DiffView diff={p.diff} />
        </Card>
      )}
    />
    </CaseTitles>
  );
}

function Reviews({ project, paged }: { project: Project; paged: Paged<Review> }) {
  const { items: data, loading, reload, pagination } = paged;
  const workspace = project.workspace_path;
  // 证据路径可能是 workspace 内的相对路径
  const fileUrl = (p: string) => `file://${/^([A-Za-z]:)?[\\/]/.test(p) ? p : `${workspace}/${p}`}`;
  const { busy, run } = useAction();
  return (
    <CaseTitles projectId={project.id} ids={data.map((r) => r.case_id)}>
    <Table
      size="small"
      rowKey="id"
      loading={loading}
      dataSource={data}
      scroll={{ x: 720 }}
      locale={{ emptyText: <Empty description="没有待复核的 AI 判定" /> }}
      pagination={{ ...pagination, size: "small" }}
      columns={[
        { title: "用例", dataIndex: "case_id", width: 200, render: (id: string) => <CaseLink id={id} /> },
        { title: "判定内容", dataIndex: "description" },
        { title: "AI 结论", dataIndex: "ai_verdict", width: 100, render: (v: string) =>
          v ? <Tag color={v === "pass" ? "green" : "red"} bordered={false}>{v === "pass" ? "通过" : "不通过"}</Tag> : <Tag bordered={false}>未判定</Tag> },
        { title: "截图", dataIndex: "evidence_paths", width: 90, render: (paths: string[]) => paths[0] && (
          <Image width={64} src={fileUrl(paths[0])} fallback="data:image/gif;base64,R0lGODlhAQABAAAAACw=" />
        ) },
        { title: "", width: 170, render: (_: unknown, r: Review) => (
          <Space>
            <Button size="small" type="primary" ghost loading={busy} onClick={() => run(async () => { await api().resolveReview(r.id, true); await reload(); })}>通过</Button>
            <Button size="small" danger loading={busy} onClick={() => run(async () => { await api().resolveReview(r.id, false); await reload(); })}>不通过</Button>
          </Space>
        ) },
      ]}
    />
    </CaseTitles>
  );
}

function UiCases({ project, env }: { project: Project; env: string }) {
  // UI / 埋点抓包用例，排除已废弃
  const { items: rows, loading, reload, pagination } = usePaged<TestCase>(
    (q) => api().pageCases(project.id, { ...q, filters: { execution_mode: "ui,capture", status: "draft,reviewed" } }) as
      Promise<{ items: TestCase[]; total: number }>,
    [project.id], 15);
  const { busy, run } = useAction();
  return (
    <Table
      size="small"
      rowKey="id"
      loading={loading}
      dataSource={rows}
      scroll={{ x: 560 }}
      pagination={{ ...pagination, size: "small", pageSizeOptions: [15, 30, 50, 100] }}
      columns={[
        { title: "标题", dataIndex: "title" },
        { title: "执行方式", dataIndex: "execution_mode", width: 110, render: (v: string) => <LabelTag map={MODE} value={v} /> },
        { title: "规范检查", dataIndex: "lint_status", width: 100, render: (v: string) => <LabelTag map={LINT} value={v} /> },
        { title: "", width: 150, render: (_: unknown, c: TestCase) => (
          <Button size="small" icon={<CompassOutlined />} disabled={c.lint_status === "blocked"} loading={busy}
            onClick={() => run(async () => { await api().exploreUiCase(project.id, env, c.id); await reload(); }, "脚本已生成")}>
            探索生成脚本
          </Button>
        ) },
      ]}
    />
  );
}

/** 角色账号与登录方式。子项目显示继承自大项目的角色；登录方式保存到环境所在的项目（继承的环境保存到大项目） */
export function Roles({ project, env }: { project: Project; env: string }) {
  const roles = useLoad(() => api().listRoles(project.id), [project.id]);
  const [roleForm] = Form.useForm<{ name: string; username: string; password: string }>();
  const [loginForm] = Form.useForm();
  const { busy, run } = useAction();
  const { reload: reloadProjects, projects } = useProjects();
  const owner = env ? envOwner(project, env) : project.id;
  const ownerName = owner !== project.id ? projects.find((p) => p.id === owner)?.name : undefined;
  const parentName = project.parent_id ? projects.find((p) => p.id === project.parent_id)?.name : undefined;
  const login = (project.environments[env] as { login?: Record<string, string> })?.login ?? {
    url: "/login", username: "#username", password: "#password", submit: "button[type=submit]", success: "",
  };
  return (
    <div className="split">
      <div style={{ flex: "1 1 320px" }}>
        <Card size="small" title="角色账号" extra={<Typography.Text type="secondary">存入系统钥匙串，用例只写角色名</Typography.Text>}>
          <Space wrap style={{ marginBottom: 12 }}>
            {(roles.data ?? []).map((r) => (
              <Tooltip key={r.role_name} title={r.inherited_from ? `继承自大项目「${parentName}」；在这里保存同名角色可单独设置账号` : undefined}>
                <Tag color={r.inherited_from ? "default" : "blue"} bordered={false}>{r.role_name}{r.inherited_from ? "（继承）" : ""}</Tag>
              </Tooltip>
            ))}
            {!roles.data?.length && <Typography.Text type="secondary">还没有角色</Typography.Text>}
          </Space>
          <Form form={roleForm} layout="vertical" onFinish={(v) => run(async () => {
            await api().setRoleSecret(project.id, v.name, v.username, v.password);
            roleForm.resetFields();
            await roles.reload();
          }, "角色已保存")}>
            <Form.Item name="name" label="角色名" rules={[{ required: true }]}><Input placeholder="如：管理员、运营、访客" /></Form.Item>
            <Row gutter={8}>
              <Col span={12}><Form.Item name="username" label="账号" rules={[{ required: true }]}><Input /></Form.Item></Col>
              <Col span={12}><Form.Item name="password" label="密码" rules={[{ required: true }]}><Input.Password /></Form.Item></Col>
            </Row>
            <Button htmlType="submit" icon={<UserAddOutlined />} loading={busy}>保存角色</Button>
          </Form>
        </Card>
      </div>
      <div style={{ flex: "1.2 1 380px" }}>
        <Card size="small" title={`登录方式（${env} 环境${ownerName ? `，保存到大项目「${ownerName}」` : ""}）`} extra={<Typography.Text type="secondary">填写 CSS 选择器</Typography.Text>}>
          <Form form={loginForm} layout="vertical" initialValues={login} key={env}
            onFinish={(v) => run(async () => {
              await api().setEnvironment(owner, env, { ...project.environments[env], login: Object.fromEntries(Object.entries(v).filter(([, x]) => x)) });
              // 刷新项目数据，否则之后再保存环境配置会用旧值覆盖登录方式
              await reloadProjects();
            }, "登录方式已保存")}>
            <Form.Item name="url" label="登录页地址" rules={[{ required: true }]}><Input placeholder="/login" /></Form.Item>
            <Row gutter={8}>
              <Col span={8}><Form.Item name="username" label="账号输入框" rules={[{ required: true }]}><Input className="mono" /></Form.Item></Col>
              <Col span={8}><Form.Item name="password" label="密码输入框" rules={[{ required: true }]}><Input className="mono" /></Form.Item></Col>
              <Col span={8}><Form.Item name="submit" label="登录按钮" rules={[{ required: true }]}><Input className="mono" /></Form.Item></Col>
            </Row>
            <Form.Item name="success" label="登录成功后 URL 包含" extra="留空则等待页面网络空闲"><Input placeholder="/dashboard" /></Form.Item>
            <Button htmlType="submit" loading={busy}>保存登录方式</Button>
          </Form>
        </Card>
      </div>
    </div>
  );
}
