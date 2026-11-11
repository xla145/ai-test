import {
  CheckCircleFilled,
  CloseCircleFilled,
  CloudDownloadOutlined,
  CloudUploadOutlined,
  GithubOutlined,
} from "@ant-design/icons";
import {
  Alert,
  Button,
  Card,
  Col,
  Descriptions,
  Empty,
  Form,
  Input,
  InputNumber,
  Progress,
  Radio,
  Row,
  Select,
  Space,
  Statistic,
  Table,
  Tabs,
  Tag,
  Typography,
} from "antd";
import { useEffect, useState } from "react";
import { api, type Project } from "../api";
import { FAILURE, LabelTag, PURPOSE } from "../components/labels";
import { PageHeader } from "../components/PageHeader";
import { CaseLink, CaseTitles } from "../components/CaseLink";
import { useProjects } from "../components/ProjectSettings";
import { useAction, useLoad, useNarrow, usePaged } from "../hooks";

const pct = (v?: number | null) => (v == null ? "—" : `${(v * 100).toFixed(1)}%`);

export function OpsPage({ project }: { project: Project }) {
  const [ref, narrow] = useNarrow<HTMLDivElement>();
  return (
    <div ref={ref}>
      <PageHeader title="工程化" description="验证指标与门禁、失败归因确认、模型用量与预算、团队共享与 CI。模型服务在「全局设置」中配置。" />
      <Tabs
        tabPosition={narrow ? "top" : "left"}
        items={[
          { key: "metrics", label: "验证指标", children: <Metrics project={project} /> },
          { key: "attribution", label: "失败归因", children: <Attributions project={project} /> },
          { key: "usage", label: "用量与预算", children: <Usage project={project} /> },
          { key: "share", label: "团队共享与 CI", children: <Share project={project} /> },
        ]}
      />
    </div>
  );
}

function Metrics({ project }: { project: Project }) {
  const { data: m, loading } = useLoad(() => api().metrics(project.id), [project.id]);
  if (!m) return <Card loading={loading} />;
  const gate = m.ui_gate;
  return (
    <>
      <div className="stat-grid">
          <Card>
            <Statistic title="一次生成通过率" value={pct(m.first_pass_rate)} />
            <Typography.Text type="secondary">脚本生成后不经修改即跑通：{m.first_pass.passed}/{m.first_pass.measured}</Typography.Text>
          </Card>
          <Card>
            <Statistic title="失败归因准确率" value={pct(m.attribution_accuracy)} />
            <Typography.Text type="secondary">已人工确认 {m.attribution.confirmed} 条，其中一致 {m.attribution.correct} 条</Typography.Text>
          </Card>
          <Card>
            <Statistic title="每条用例人工介入次数" value={m.interventions_per_case ?? "—"} />
            <Typography.Text type="secondary">共 {m.interventions.total} 次，涉及 {m.interventions.cases} 条用例</Typography.Text>
          </Card>
      </div>
      <Card style={{ marginTop: 16 }} title="门禁：UI 回归稳定"
        extra={gate.passed ? <Tag icon={<CheckCircleFilled />} color="success">已达标</Tag> : <Tag icon={<CloseCircleFilled />} color="error">未达标</Tag>}>
        <div className="split" style={{ alignItems: "center", gap: 24 }}>
          <div style={{ flex: "0 0 auto" }}>
            <Progress type="dashboard" percent={Math.round((gate.avg_pass_rate ?? 0) * 100)}
              status={gate.avg_pass_rate == null ? "normal" : gate.avg_pass_rate >= gate.threshold ? "success" : "exception"} format={(p) => (gate.avg_pass_rate == null ? "—" : `${p}%`)} />
          </div>
          <div style={{ flex: "1 1 320px" }}>
            <Descriptions size="small" column={1} items={[
              { key: "r", label: "统计范围", children: `最近 ${gate.runs} 次 UI 回归（至少 3 次）` },
              { key: "t", label: "达标线", children: `平均通过率 ≥ ${pct(gate.threshold)}，且没有不稳定用例；产品缺陷导致的失败不计入` },
              { key: "f", label: "不稳定用例", children: gate.flaky_cases.length ? gate.flaky_cases.map((c: string) => <Tag key={c} className="mono">{c}</Tag>) : "无" },
            ]} />
            {gate.reasons.length > 0 && <Alert type="warning" showIcon message={gate.reasons.join("；")} style={{ marginTop: 8 }} />}
          </div>
        </div>
      </Card>
    </>
  );
}

function Attributions({ project }: { project: Project }) {
  const { items: data, loading, reload, pagination } = usePaged<any>(
    (q) => api().pageAttributions(project.id, { ...q, pending: true }), [project.id], 10);
  const { busy, run } = useAction();
  return (
    <Card title="待确认的失败归因" extra={<Typography.Text type="secondary">确认后以人工结论为准，并计入归因准确率</Typography.Text>}>
      <CaseTitles projectId={project.id} ids={data.map((r: any) => r.case_id)}>
      <Table
        size="small"
        scroll={{ x: 820 }}
        rowKey={(r) => `${r.run_id}/${r.case_id}`}
        loading={loading}
        dataSource={data}
        locale={{ emptyText: <Empty description="没有待确认的归因" /> }}
        pagination={{ ...pagination, size: "small" }}
        columns={[
          { title: "用例", dataIndex: "case_id", width: 220, render: (c: string, r: any) => (
            <><CaseLink id={c} /><Typography.Text type="secondary" style={{ fontSize: 12 }}>执行记录 {r.run_id}</Typography.Text></>
          ) },
          { title: "自动归因", dataIndex: "auto_type", width: 160, render: (v: string, r: any) => <Space size={4}><LabelTag map={FAILURE} value={v} /><Typography.Text type="secondary" style={{ fontSize: 12 }}>{r.source === "rule" ? "规则" : "agent"}</Typography.Text></Space> },
          { title: "依据", dataIndex: "reason", ellipsis: true },
          { title: "人工确认", width: 280, render: (_: unknown, r: any) => (
            <Radio.Group size="small" optionType="button" disabled={busy}
              onChange={(e) => run(async () => { await api().confirmAttribution(r.run_id, r.case_id, e.target.value); await reload(); }, "已确认")}
              options={["product_bug", "script_error", "environment"].map((k) => ({ value: k, label: FAILURE[k].text }))} />
          ) },
        ]}
      />
      </CaseTitles>
    </Card>
  );
}

/** 用量与预算。子项目逐项继承大项目的设置：表单只填本项目自己的值，留空即继承（占位显示继承的值） */
export function Usage({ project }: { project: Project }) {
  const usage = useLoad(() => api().usageReport(project.id, 30), [project.id]);
  const budget = useLoad(() => api().checkBudget(project.id), [project.id]);
  const settings = useLoad(() => api().getSettingsDetail(project.id), [project.id]);
  const [form] = Form.useForm();
  const { busy, run } = useAction();
  const { projects } = useProjects();
  useEffect(() => {
    form.resetFields();
    form.setFieldsValue(settings.data?.own ?? {});
  }, [settings.data, form]);
  const inherited = (settings.data?.inherited ?? {}) as Record<string, number | string>;
  const hint = (key: string, fallback: string) => (inherited[key] != null ? `继承：${inherited[key]}` : fallback);
  const nameOf = (id: string) => projects.find((p) => p.id === id)?.name ?? id;
  const u = usage.data;
  const b = budget.data;
  const ratio = b?.monthly_budget ? Math.min(100, Math.round((b.month_used / b.monthly_budget) * 100)) : 0;
  return (
    <>
      <div className="stat-grid">
        <Card loading={usage.loading}><Statistic title="近 30 天 token" value={u?.total_tokens ?? 0} /><Typography.Text type="secondary">{u?.agent_tasks ?? 0} 个 agent 任务</Typography.Text></Card>
        <Card loading={usage.loading}><Statistic title="估算成本" value={u?.estimated_cost ?? "—"} suffix={u?.currency} /><Typography.Text type="secondary">按设置中的单价估算</Typography.Text></Card>
        <div style={{ display: "grid" }}>
          <Card loading={budget.loading}>
            <Typography.Text type="secondary">本月预算</Typography.Text>
            {b?.monthly_budget ? (
              <>
                <Progress percent={ratio} status={b.allowed ? (ratio > 80 ? "active" : "normal") : "exception"} />
                <Typography.Text type="secondary">{b.month_used.toLocaleString()} / {b.monthly_budget.toLocaleString()} tokens{b.allowed ? "" : "（已用完，agent 任务将被拒绝）"}</Typography.Text>
                {b.shared && <div><Typography.Text type="secondary" style={{ fontSize: 12 }}>与大项目的全部子项目共用</Typography.Text></div>}
              </>
            ) : <div style={{ fontSize: 24, marginTop: 4 }}>不限</div>}
          </Card>
        </div>
      </div>
      <div className="split" style={{ marginTop: 16 }}>
        <div style={{ flex: "1 1 320px" }}>
          <Card size="small" title="按用途">
            <Table size="small" pagination={false} rowKey="k"
              dataSource={Object.entries((u?.by_purpose ?? {}) as Record<string, number>).map(([k, v]) => ({ k, v }))}
              locale={{ emptyText: "暂无用量" }}
              columns={[
                { title: "用途", dataIndex: "k", render: (k: string) => PURPOSE[k] ?? k },
                { title: "tokens", dataIndex: "v", align: "right", render: (v: number) => v.toLocaleString() },
                { title: "", dataIndex: "v", width: 120, render: (v: number) => <Progress size="small" showInfo={false} percent={u?.total_tokens ? (v / u.total_tokens) * 100 : 0} /> },
              ]} />
          </Card>
          {u?.by_project && (
            <Card size="small" title="按子项目" style={{ marginTop: 16 }}>
              <Table size="small" pagination={false} rowKey="k"
                dataSource={Object.entries(u.by_project as Record<string, number>).sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ k, v }))}
                locale={{ emptyText: "暂无用量" }}
                columns={[
                  { title: "子项目", dataIndex: "k", render: (k: string) => (k === project.id ? "大项目本身" : nameOf(k)) },
                  { title: "tokens", dataIndex: "v", align: "right", render: (v: number) => v.toLocaleString() },
                  { title: "", dataIndex: "v", width: 120, render: (v: number) => <Progress size="small" showInfo={false} percent={u?.total_tokens ? (v / u.total_tokens) * 100 : 0} /> },
                ]} />
            </Card>
          )}
        </div>
        <div style={{ flex: "1 1 320px" }}>
          <Card size="small" title="预算与价格">
            {settings.data?.parent_name && (
              <Alert type="info" showIcon style={{ marginBottom: 12 }}
                message={`留空的项继承大项目「${settings.data.parent_name}」；月度上限继承时按整个大项目累计用量`} />
            )}
            <Form form={form} layout="vertical" onFinish={(v) => run(async () => {
              // 留空 = 清除本项目的值（子项目恢复继承）
              await api().setSettings(project.id, Object.fromEntries(Object.entries(v).map(([k, x]) => [k, x === undefined || x === "" ? null : x])) as Record<string, string | number | null>);
              await Promise.all([settings.reload(), budget.reload(), usage.reload()]);
            }, "已保存")}>
              <Row gutter={8}>
                <Col span={12}><Form.Item name="monthly_token_budget" label="月度 token 上限"><InputNumber min={0} style={{ width: "100%" }} placeholder={hint("monthly_token_budget", "不限")} /></Form.Item></Col>
                <Col span={12}><Form.Item name="per_task_token_limit" label="单次任务上限"><InputNumber min={0} style={{ width: "100%" }} placeholder={hint("per_task_token_limit", "不限")} /></Form.Item></Col>
                <Col span={12}><Form.Item name="price_per_mtok" label="每百万 token 价格"><InputNumber min={0} style={{ width: "100%" }} placeholder={hint("price_per_mtok", "")} /></Form.Item></Col>
                <Col span={6}><Form.Item name="currency" label="币种"><Input placeholder={hint("currency", "CNY")} /></Form.Item></Col>
                <Col span={6}><Form.Item name="stability_threshold" label="门禁通过率"><InputNumber min={0} max={1} step={0.01} style={{ width: "100%" }} placeholder={hint("stability_threshold", "0.95")} /></Form.Item></Col>
              </Row>
              <Button htmlType="submit" type="primary" loading={busy}>保存</Button>
            </Form>
          </Card>
        </div>
      </div>
      <Alert style={{ marginTop: 16 }} type="info" showIcon message="日常回归直接执行脚本，不消耗模型；只有新增用例、页面变动和原因不明的失败才调用 agent。" />
    </>
  );
}

function Share({ project }: { project: Project }) {
  const envs = Object.keys(project.environments);
  const [form] = Form.useForm<{ provider: "github" | "gitlab"; env: string; toolRepo: string }>();
  const [generated, setGenerated] = useState<string>();
  const { busy, run } = useAction();
  return (
    <div className="split">
      <div style={{ flex: "1 1 300px" }}>
        <Card title="团队共享" size="small">
          <Typography.Paragraph type="secondary">
            workspace 是一个 git 仓库。导出后用例、脚本与项目配置（不含任何凭据）随 git 共享，成员 clone 后导入即可得到相同的用例库。
          </Typography.Paragraph>
          <Space>
            <Button type="primary" icon={<CloudUploadOutlined />} loading={busy}
              onClick={() => run(() => api().exportWorkspace(project.id), "已导出并提交到 workspace 的 git")}>导出到 workspace</Button>
            <Button icon={<CloudDownloadOutlined />} loading={busy}
              onClick={() => run(async () => { const dir = await api().pickDirectory(); if (dir) await api().importWorkspace(dir); }, "已导入")}>导入 workspace</Button>
          </Space>
        </Card>
      </div>
      <div style={{ flex: "1.4 1 360px" }}>
        <Card title="CI 集成" size="small">
          <Form form={form} layout="vertical" initialValues={{ provider: "github", env: envs[0] }}
            onFinish={(v) => run(async () => setGenerated(await api().initCi(project.id, v.provider, v.toolRepo, v.env)), "CI 配置已生成")}>
            <Row gutter={8}>
              <Col span={12}>
                <Form.Item name="provider" label="CI 平台">
                  <Radio.Group optionType="button" options={[{ value: "github", label: <><GithubOutlined /> GitHub Actions</> }, { value: "gitlab", label: "GitLab CI" }]} />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item name="env" label="执行环境"><Select options={envs.map((e) => ({ value: e, label: e }))} /></Form.Item>
              </Col>
            </Row>
            <Form.Item name="toolRepo" label="客户端仓库地址" rules={[{ required: true, message: "CI 从这里安装执行器" }]}>
              <Input placeholder="https://github.com/<组织>/ai-test.git" />
            </Form.Item>
            <Button htmlType="submit" loading={busy}>生成 CI 配置</Button>
          </Form>
          {generated && (
            <Alert style={{ marginTop: 12 }} type="success" showIcon message={<>已生成 <span className="mono">{generated}</span></>}
              description="在 CI 的密钥中配置 AITEST_AUTH_TOKEN 与 AITEST_ROLES（JSON），提交后每次推送都会执行回归，不调用模型。" />
          )}
        </Card>
      </div>
    </div>
  );
}
