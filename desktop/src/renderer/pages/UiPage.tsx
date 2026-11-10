import { CaretRightOutlined, CheckOutlined, CloseOutlined, CompassOutlined, UserAddOutlined } from "@ant-design/icons";
import {
  Alert,
  Badge,
  Button,
  Card,
  Col,
  Empty,
  Form,
  Image,
  Input,
  List,
  Row,
  Select,
  Space,
  Statistic,
  Switch,
  Table,
  Tabs,
  Tag,
  Typography,
} from "antd";
import { useState } from "react";
import { api, type Project, type TestCase } from "../api";
import { DiffView } from "../components/DiffView";
import { LabelTag, LINT, MODE } from "../components/labels";
import { PageHeader } from "../components/PageHeader";
import { useAction, useLoad, usePaged } from "../hooks";

interface Proposal { id: string; case_id: string; script_path: string; diff: string; reason: string; status: string }
interface Review { id: string; case_id: string; kind: string; description: string; ai_verdict: string; evidence_paths: string[]; status: string }
interface UiRunResult {
  run: { run_id: string; total: number; passed: number; failed: number; error: number; reviews: number };
  heal?: { case_id: string; failure_type: string; reason?: string }[];
  degraded: string[];
  missingData: string[];
  htmlReport: string;
}

export function UiPage({ project }: { project: Project }) {
  const envs = Object.keys(project.environments);
  const [env, setEnv] = useState(envs[0]);
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
          <Select value={env} onChange={setEnv} style={{ width: 160 }} options={envs.map((e) => ({ value: e, label: e }))} />
          <Space><Switch size="small" checked={headed} onChange={setHeaded} />可视化执行</Space>
          <Button type="primary" icon={<CaretRightOutlined />} loading={busy}
            onClick={() => run(async () => {
              setResult((await api().runUiRegression(project.id, env, headed)) as UiRunResult);
              await Promise.all([proposals.reload(), reviews.reload()]);
            })}>
            执行 UI 回归
          </Button>
        </>}
      />
      {result && (
        <>
          <Row gutter={16} style={{ marginBottom: 16 }}>
            <Col span={5}><Card size="small"><Statistic title="总数" value={result.run.total} /></Card></Col>
            <Col span={5}><Card size="small"><Statistic title="通过" value={result.run.passed} valueStyle={{ color: "#3f8600" }} /></Card></Col>
            <Col span={5}><Card size="small"><Statistic title="失败" value={failed} valueStyle={{ color: failed ? "#cf1322" : undefined }} /></Card></Col>
            <Col span={5}><Card size="small"><Statistic title="待人工复核" value={result.run.reviews} /></Card></Col>
            <Col span={4}><Card size="small"><Statistic title="降级手工" value={result.degraded.length} /></Card></Col>
          </Row>
          {result.missingData.length > 0 && (
            <Alert style={{ marginBottom: 16 }} type="warning" showIcon
              message={`缺少测试数据且无法造数：${result.missingData.join("、")}`} description="依赖这些数据的用例本次未执行，已降级为手工。" />
          )}
        </>
      )}
      <Tabs
        type="card"
        items={[
          { key: "proposals", label: <Badge count={proposals.total} size="small" offset={[10, 0]}>脚本修改建议</Badge>,
            children: <Proposals project={project} paged={proposals} /> },
          { key: "reviews", label: <Badge count={reviews.total} size="small" offset={[10, 0]}>人工复核</Badge>,
            children: <Reviews workspace={project.workspace_path} paged={reviews} /> },
          { key: "cases", label: "UI 用例", children: <UiCases project={project} env={env} /> },
          { key: "roles", label: "角色与登录", children: <Roles project={project} env={env} /> },
        ]}
      />
    </>
  );
}

type Paged<T> = ReturnType<typeof usePaged<T>>;

function Proposals({ project, paged }: { project: Project; paged: Paged<Proposal> }) {
  const { items: data, loading, reload, pagination } = paged;
  const { busy, run } = useAction();
  if (!loading && !data.length) return <Empty description="没有待处理的修改建议" />;
  return (
    <List
      loading={loading}
      dataSource={data}
      pagination={{ ...pagination, pageSizeOptions: [5, 10, 20], align: "end" }}
      renderItem={(p) => (
        <Card size="small" style={{ marginBottom: 12 }}
          title={<Space><span className="mono">{p.case_id}</span><Typography.Text type="secondary" className="mono">{p.script_path}</Typography.Text></Space>}
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
  );
}

function Reviews({ workspace, paged }: { workspace: string; paged: Paged<Review> }) {
  const { items: data, loading, reload, pagination } = paged;
  // 证据路径可能是 workspace 内的相对路径
  const fileUrl = (p: string) => `file://${/^([A-Za-z]:)?[\\/]/.test(p) ? p : `${workspace}/${p}`}`;
  const { busy, run } = useAction();
  return (
    <Table
      size="small"
      rowKey="id"
      loading={loading}
      dataSource={data}
      locale={{ emptyText: <Empty description="没有待复核的 AI 判定" /> }}
      pagination={{ ...pagination, size: "small" }}
      columns={[
        { title: "用例", dataIndex: "case_id", className: "mono", width: 150 },
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

function Roles({ project, env }: { project: Project; env: string }) {
  const roles = useLoad(() => api().listRoles(project.id), [project.id]);
  const [roleForm] = Form.useForm<{ name: string; username: string; password: string }>();
  const [loginForm] = Form.useForm();
  const { busy, run } = useAction();
  const login = (project.environments[env] as { login?: Record<string, string> })?.login ?? {
    url: "/login", username: "#username", password: "#password", submit: "button[type=submit]", success: "",
  };
  return (
    <Row gutter={16}>
      <Col span={11}>
        <Card size="small" title="角色账号" extra={<Typography.Text type="secondary">存入系统钥匙串，用例只写角色名</Typography.Text>}>
          <Space wrap style={{ marginBottom: 12 }}>
            {(roles.data ?? []).map((r) => <Tag key={r.role_name} color="blue" bordered={false}>{r.role_name}</Tag>)}
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
      </Col>
      <Col span={13}>
        <Card size="small" title={`登录方式（${env} 环境）`} extra={<Typography.Text type="secondary">填写 CSS 选择器</Typography.Text>}>
          <Form form={loginForm} layout="vertical" initialValues={login} key={env}
            onFinish={(v) => run(async () => {
              await api().setEnvironment(project.id, env, { ...project.environments[env], login: Object.fromEntries(Object.entries(v).filter(([, x]) => x)) });
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
      </Col>
    </Row>
  );
}
