import type { ApiDefinition } from "../../shared/apiWorkspace";
import { ChromeOutlined } from "@ant-design/icons";
import { Alert, Button, Card, Collapse, Progress, Select, Space, Statistic, Switch, Table, Typography } from "antd";
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
import { useAction, useLoad, useProjectChanged, notifyProjectChanged } from "../hooks";

interface RunResult {
  run: { run_id: string; total: number; passed: number; failed: number; error: number; skipped: number; pass_rate: number };
  triage?: { case_id: string; failure_type: string; reason?: string; suggestion?: string }[];
  analysis?: { status: "completed" | "failed"; error?: string };
}

type RunPageProps = { project: Project; definitions?: ApiDefinition[]; onClearScope?: () => void };
export function RunPage(props: RunPageProps) {
  return <ApiRunPage key={`${props.project.id}:${props.definitions?.map((d) => d.id).join(",") ?? "all"}`} {...props} />;
}

function ApiRunPage({ project, definitions, onClearScope }: RunPageProps) {
  const envs = Object.keys(project.environments);
  const [env, setEnv] = useEnvChoice(project);
  const [result, setResult] = useState<RunResult>();
  const [selected, setSelected] = useState<string[]>([]);
  const [available, setAvailable] = useState<TestCase[]>([]);
  const [preparing, setPreparing] = useState(false);
  const [autoTriage, setAutoTriage] = useState(true);
  const [selectedRole, setSelectedRole] = useState<string>();
  const roles = useLoad(async () => {
    const [names, status] = await Promise.all([api().listRoles(project.id), api().roleSecretStatus(project.id)]);
    return [...new Set([...names.map((r) => r.role_name), ...Object.keys(status)])].sort().map((name) => ({
      value: name, label: `${name}${!status[name]?.account && !status[name]?.token ? "（未配置接口凭据）" : ""}`,
      disabled: !status[name]?.account && !status[name]?.token,
    }));
  }, [project.id]);
  useProjectChanged(project.id, () => { void roles.reload(); });
  const identityReady = selectedRole !== undefined && (selectedRole === "" || !!roles.data?.some((r) => r.value === selectedRole && !r.disabled));
  const { busy, run } = useAction();

  if (!envs.length) return <NoEnvironment project={project} purpose="执行接口回归" />;
  const failed = result ? result.run.failed + result.run.error : 0;

  return (
    <>
      <PageHeader
        title="接口回归"
        workflow={[
          { title: "选择环境", description: "确认被测地址；生产环境执行前需要确认" },
          { title: "选择范围", description: "选择已审核、无阻断问题的接口用例" },
          { title: "执行脚本", description: "全量或仅执行选中项，不调用模型" },
          { title: "分析结果", description: "查看失败归因并在工程化页面确认" },
        ]}
        description="直接执行已生成的脚本，不调用模型；只有原因不明的失败才交给 agent 归因。"
        extra={<>
          <Space><Typography.Text type="secondary">环境</Typography.Text><EnvSelect project={project} value={env} onChange={setEnv} showUrl disabled={busy} /></Space>
          <Space><Typography.Text type="secondary">调用身份</Typography.Text><Select aria-label="批量执行调用身份" placeholder="请选择调用身份"
            style={{ minWidth: 200 }} value={selectedRole} onChange={setSelectedRole} loading={roles.loading} disabled={busy}
            options={[{ value: "", label: "按用例 / 环境默认" }, ...(roles.data ?? [])]} /></Space>
          <Button icon={<ChromeOutlined />} onClick={() => api().openTestPage(project.environments[env].base_url)}>打开测试页面</Button>
          <RunButton project={project} env={env} loading={busy} disabled={preparing || !env || !identityReady || !available.length}
            onRun={(confirmProduction) => run(async () => {
              await api().writeReviewedApiSuite(project.id);
              setResult((await api().runRegression(project.id, env, { confirmProduction, autoTriage, selectedRole: selectedRole || undefined, caseIds: available.map((c) => c.id) })) as RunResult);
              notifyProjectChanged(project.id);
            })}>
            {definitions ? "接口范围回归" : "全量回归"}（{available.length}）
          </RunButton>
        </>}
      />
      <Typography.Paragraph type="secondary">
        {selectedRole ? `本次调用身份：${selectedRole}。未指定角色的请求统一携带该身份的鉴权；流程中已指定的角色保留。需要验证不携带鉴权的请求时，请选择“按用例 / 环境默认”。`
          : "执行前请选择调用身份；选择“按用例 / 环境默认”时保留各请求原有的鉴权设置。角色凭据可在下方“多账号”中配置。"}
      </Typography.Paragraph>
      {definitions && <Alert type="info" showIcon style={{ marginBottom: 16 }} message={`当前范围：${definitions.length} 个接口`} description={<>{definitions.map((d) => `${d.method} ${d.path}`).join("、")}。仅执行这些接口的已审核单接口用例；业务场景请在全量范围中单独选择。</>} action={<Button disabled={busy} onClick={onClearScope}>清除接口范围</Button>} />}
      <ApiCasePicker definitions={definitions} projectId={project.id} selected={selected} onSelect={setSelected} onAvailable={setAvailable}
        disabled={busy} onBusyChange={setPreparing} />
      <Space wrap style={{ marginBottom: 16 }}>
        <RunButton project={project} env={env} loading={busy}
          disabled={preparing || !env || !identityReady || !selected.length || selected.some((id) => !available.some((c) => c.id === id))}
          onRun={(confirmProduction) => run(async () => {
            await api().writeReviewedApiSuite(project.id);
            setResult((await api().runRegression(project.id, env, { confirmProduction, autoTriage, selectedRole: selectedRole || undefined, caseIds: selected })) as RunResult);
            notifyProjectChanged(project.id);
          })}>
          执行选中项（{selected.length} 条）
        </RunButton>
        <Typography.Text type="secondary">仅向选中用例涉及的接口发送请求</Typography.Text>
        <Switch checked={autoTriage} disabled={busy} onChange={setAutoTriage} aria-label="未知失败使用 AI 分析" />
        <Typography.Text type="secondary">未知失败使用 AI 分析（消耗模型用量）</Typography.Text>
      </Space>
      <EnvCredentials project={project} env={env} />
      {result?.analysis?.status === "failed" && <Alert type="warning" showIcon style={{ marginBottom: 16 }}
        message="接口报告已生成，AI 失败分析未完成"
        description={result.analysis.error ? `原始测试结果不受影响。原因：${result.analysis.error}` : "原始测试结果不受影响，请稍后重试分析。"} />}
      <Collapse size="small" style={{ marginBottom: 16 }} items={[{
        key: "roles",
        label: <Space wrap>多账号<Typography.Text type="secondary" style={{ fontSize: 12 }}>流程用例中每步可用不同角色（如 买家下单 → 运营审核 → 买家退款）</Typography.Text></Space>,
        children: (
          <div className="split">
            <div style={{ flex: "1 1 320px" }}><RoleAccounts project={project} purpose="api" /></div>
            <div style={{ flex: "1 1 360px" }}><ApiLoginCard project={project} env={env} /></div>
          </div>
        ),
      }]} />
      {result && (
        <>
          <div className="stat-grid result-summary">
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
          <Space wrap style={{ marginTop: 16 }}>
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
