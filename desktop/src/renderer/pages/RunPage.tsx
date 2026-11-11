import { ChromeOutlined } from "@ant-design/icons";
import { Alert, Button, Card, Collapse, Empty, Progress, Space, Statistic, Table, Typography } from "antd";
import { useState } from "react";
import { api, type Project } from "../api";
import { CaseLink, CaseTitles } from "../components/CaseLink";
import { ApiLoginCard } from "../components/ApiLogin";
import { EnvCredentials } from "../components/EnvCredentials";
import { RoleAccounts } from "../components/RoleAccounts";
import { EnvSelect, RunButton, useEnvChoice } from "../components/EnvPicker";
import { FAILURE, LabelTag } from "../components/labels";
import { PageHeader } from "../components/PageHeader";
import { useAction } from "../hooks";

interface RunResult {
  run: { run_id: string; total: number; passed: number; failed: number; error: number; skipped: number; pass_rate: number };
  triage?: { case_id: string; failure_type: string; reason?: string; suggestion?: string }[];
}

export function RunPage({ project }: { project: Project }) {
  const envs = Object.keys(project.environments);
  const [env, setEnv] = useEnvChoice(project);
  const [result, setResult] = useState<RunResult>();
  const { busy, run } = useAction();

  if (!envs.length) return <Empty description="项目还没有配置执行环境" />;
  const failed = result ? result.run.failed + result.run.error : 0;

  return (
    <>
      <PageHeader
        title="接口回归"
        description="直接执行已生成的脚本，不调用模型；只有原因不明的失败才交给 agent 归因。"
        extra={<>
          <EnvSelect project={project} value={env} onChange={setEnv} showUrl />
          <Button icon={<ChromeOutlined />} onClick={() => api().openTestPage(project.environments[env].base_url)}>在内嵌浏览器打开</Button>
          <RunButton project={project} env={env} loading={busy}
            onRun={(confirmProduction) => run(async () => setResult((await api().runRegression(project.id, env, { confirmProduction })) as RunResult))}>
            执行回归
          </RunButton>
        </>}
      />
      <EnvCredentials project={project} env={env} />
      <Collapse size="small" style={{ marginBottom: 16 }} items={[{
        key: "roles",
        label: <Space>多账号<Typography.Text type="secondary" style={{ fontSize: 12 }}>流程用例中每步可用不同角色（如 买家下单 → 运营审核 → 买家退款）</Typography.Text></Space>,
        children: (
          <div className="split">
            <div style={{ flex: "1 1 320px" }}><RoleAccounts project={project} purpose="api" /></div>
            <div style={{ flex: "1 1 360px" }}><ApiLoginCard project={project} env={env} /></div>
          </div>
        ),
      }]} />
      {result && (
        <>
          <div className="stat-grid">
            <Card>
              <Space align="center" size={16}>
                <Progress type="circle" size={64} percent={Math.round(result.run.pass_rate * 100)} status={failed ? "exception" : "success"} />
                <Statistic title="通过率" value={`${result.run.passed}/${result.run.total}`} />
              </Space>
            </Card>
            <Card><Statistic title="失败" value={failed} valueStyle={{ color: failed ? "#cf1322" : undefined }} /></Card>
            <Card><Statistic title="跳过" value={result.run.skipped} /></Card>
            <Card><Statistic title="执行记录" value={result.run.run_id} valueStyle={{ fontSize: 14 }} className="mono" /></Card>
          </div>
          {failed === 0 && <Alert style={{ marginTop: 16 }} type="success" showIcon message="全部通过" />}
          {result.triage && result.triage.length > 0 && (
            <Card title="失败归因" size="small" style={{ marginTop: 16 }} extra={<Typography.Text type="secondary">在「工程化」页确认归因</Typography.Text>}>
              <CaseTitles projectId={project.id} ids={result.triage.map((t) => t.case_id)}>
              <Table size="small" rowKey="case_id" dataSource={result.triage} scroll={{ x: 640 }}
                pagination={{ defaultPageSize: 10, size: "small", hideOnSinglePage: true, showSizeChanger: true, showTotal: (t) => `共 ${t} 条` }}
                columns={[
                { title: "用例", dataIndex: "case_id", width: 220, render: (id: string) => <CaseLink id={id} /> },
                { title: "归因", dataIndex: "failure_type", width: 140, render: (v: string) => <LabelTag map={FAILURE} value={v} /> },
                { title: "原因", dataIndex: "reason" },
                { title: "建议", dataIndex: "suggestion" },
              ]} />
              </CaseTitles>
            </Card>
          )}
        </>
      )}
    </>
  );
}
