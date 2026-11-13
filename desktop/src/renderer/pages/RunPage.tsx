import { ChromeOutlined } from "@ant-design/icons";
import { Alert, Button, Card, Collapse, Progress, Space, Statistic, Table, Typography } from "antd";
import { useState } from "react";
import { api, type Project, type TestCase } from "../api";
import { ApiCasePicker } from "../components/ApiCasePicker";
import { CaseLink, CaseTitles } from "../components/CaseLink";
import { ApiLoginCard } from "../components/ApiLogin";
import { EnvCredentials } from "../components/EnvCredentials";
import { RoleAccounts } from "../components/RoleAccounts";
import { EnvSelect, RunButton, useEnvChoice, NoEnvironment } from "../components/EnvPicker";
import { FAILURE, LabelTag } from "../components/labels";
import { PageHeader } from "../components/PageHeader";
import { useAction, notifyProjectChanged } from "../hooks";

interface RunResult {
  run: { run_id: string; total: number; passed: number; failed: number; error: number; skipped: number; pass_rate: number };
  triage?: { case_id: string; failure_type: string; reason?: string; suggestion?: string }[];
}

export function RunPage({ project }: { project: Project }) {
  return <ApiRunPage key={project.id} project={project} />;
}

function ApiRunPage({ project }: { project: Project }) {
  const envs = Object.keys(project.environments);
  const [env, setEnv] = useEnvChoice(project);
  const [result, setResult] = useState<RunResult>();
  const [selected, setSelected] = useState<string[]>([]);
  const [available, setAvailable] = useState<TestCase[]>([]);
  const [preparing, setPreparing] = useState(false);
  const { busy, run } = useAction();

  if (!envs.length) return <NoEnvironment project={project} purpose="执行接口回归" />;
  const failed = result ? result.run.failed + result.run.error : 0;

  return (
    <>
      <PageHeader
        title="接口回归"
        description="直接执行已生成的脚本，不调用模型；只有原因不明的失败才交给 agent 归因。"
        extra={<>
          <EnvSelect project={project} value={env} onChange={setEnv} showUrl />
          <Button icon={<ChromeOutlined />} onClick={() => api().openTestPage(project.environments[env].base_url)}>在内嵌浏览器打开</Button>
          <RunButton project={project} env={env} loading={busy} disabled={preparing || !available.length}
            onRun={(confirmProduction) => run(async () => {
              setResult((await api().runRegression(project.id, env, { confirmProduction, caseIds: available.map((c) => c.id) })) as RunResult);
              notifyProjectChanged(project.id);
            })}>
            全量回归（{available.length} 条已审核用例）
          </RunButton>
        </>}
      />
      <ApiCasePicker projectId={project.id} selected={selected} onSelect={setSelected} onAvailable={setAvailable}
        disabled={busy} onBusyChange={setPreparing} />
      <Space style={{ marginBottom: 16 }}>
        <RunButton project={project} env={env} loading={busy}
          disabled={preparing || !selected.length || selected.some((id) => !available.some((c) => c.id === id))}
          onRun={(confirmProduction) => run(async () => {
            setResult((await api().runRegression(project.id, env, { confirmProduction, caseIds: selected })) as RunResult);
            notifyProjectChanged(project.id);
          })}>
          执行选中项（{selected.length} 条）
        </RunButton>
        <Typography.Text type="secondary">仅向选中用例涉及的接口发送请求</Typography.Text>
      </Space>
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
            <Card><Statistic title="失败" value={failed} valueStyle={{ color: failed ? "var(--console-error)" : undefined }} /></Card>
            <Card><Statistic title="跳过" value={result.run.skipped} /></Card>
            <Card><Statistic title="执行记录" value={result.run.run_id} valueStyle={{ fontSize: 14 }} className="mono" /></Card>
          </div>
          {failed === 0 && result.run.total > 0 && <Alert style={{ marginTop: 16 }} type="success" showIcon message="全部通过" />}
          {result.run.total === 0 && <Alert style={{ marginTop: 16 }} type="warning" showIcon message="没有执行任何用例，请检查脚本与测试范围" />}
          <Space style={{ marginTop: 16 }}>
            <Button size="small" loading={busy} onClick={() => run(async () => {
              const out = await api().exportReport([result.run.run_id], "html");
              if (out) await api().showInFolder(out.path).catch(() => undefined);
            })}>导出 HTML 报告</Button>
            <Typography.Text type="secondary">完整执行记录见「测试报告」页</Typography.Text>
          </Space>
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
