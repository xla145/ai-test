import { AndroidOutlined, AppleOutlined, CompassOutlined } from "@ant-design/icons";
import { Alert, App, Button, Card, Empty, Input, Segmented, Space, Statistic, Table, Tag, Tooltip, Typography } from "antd";
import { useState } from "react";
import { api, type Project, type TestCase } from "../api";
import { CaseLink, CaseTitles } from "../components/CaseLink";
import { EnvSelect, RunButton, useEnvChoice } from "../components/EnvPicker";
import { FAILURE, LabelTag, LINT } from "../components/labels";
import { PageHeader } from "../components/PageHeader";
import { useAction, useLoad, usePaged } from "../hooks";

type Platform = "android" | "ios";

interface AppRunResult {
  platform: Platform;
  report: string;
  run: { run_id: string; total: number; passed: number; failed: number; error: number; skipped: number; pass_rate: number };
  failures: { case_id: string; status: string; failure_type: string; message: string }[];
}

const PLATFORM_LABEL: Record<Platform, string> = { android: "Android", ios: "iOS" };

/** App 测试：Pinky 探索生成 Maestro 脚本，Maestro 回归（Android / iOS 共用一份脚本） */
export function AppPage({ project }: { project: Project }) {
  const [env, setEnv] = useEnvChoice(project);
  const [platform, setPlatform] = useState<Platform>("android");
  const [device, setDevice] = useState("");
  const [result, setResult] = useState<AppRunResult>();
  const { busy, run } = useAction();
  const view = useLoad(() => api().getGlobalSettings(), []);
  const tools = useLoad(() => api().checkRuntime(), []);
  const appId = project.environments[env]?.app?.[platform];
  const pinkyOn = view.data?.runtime.pinky.enabled ?? false;
  const failed = result ? result.run.failed + result.run.error : 0;

  if (!Object.keys(project.environments).length) return <Empty description="项目还没有配置执行环境" />;

  return (
    <>
      <PageHeader
        title="App 测试"
        description="agent 通过 Pinky 在手机上走通用例，生成 Maestro 脚本；回归直接执行脚本，不调用模型。同一份脚本在 Android 与 iOS 上运行。"
        extra={<>
          <Segmented<Platform> value={platform} onChange={setPlatform} options={[
            { value: "android", label: <Space size={4}><AndroidOutlined />Android</Space> },
            { value: "ios", label: <Space size={4}><AppleOutlined />iOS</Space> },
          ]} />
          <EnvSelect project={project} value={env} onChange={setEnv} width={160} />
          <Tooltip title="adb devices / xcrun simctl list 中的设备 ID；只连接一台设备时可不填">
            <Input value={device} onChange={(e) => setDevice(e.target.value)} placeholder="设备 ID（可选）" style={{ width: 170 }} allowClear />
          </Tooltip>
          <RunButton project={project} env={env} loading={busy}
            onRun={(confirmProduction) => run(async () => {
              setResult((await api().runAppRegression(project.id, env, platform, { device: device.trim() || undefined, confirmProduction })) as AppRunResult);
            })}>
            执行 App 回归
          </RunButton>
        </>}
      />

      {!appId && (
        <Alert type="warning" showIcon style={{ marginBottom: 16 }}
          message={`环境「${env}」没有配置 ${PLATFORM_LABEL[platform]} App`}
          description={`点击顶部项目名旁的设置按钮，在执行环境中填写${platform === "ios" ? " iOS Bundle ID" : " Android 包名"}。`} />
      )}
      {platform === "ios" && (
        <Alert type="info" showIcon style={{ marginBottom: 16 }}
          message="iOS 回归目前只能在模拟器上执行"
          description="Maestro 暂不支持 iOS 真机（Android 真机可以）。探索可以用 Pinky 在 iPhone 真机上进行，生成的脚本在 iOS 模拟器上回归。" />
      )}
      {tools.data && !tools.data.maestro.ok && (
        <Alert type="warning" showIcon style={{ marginBottom: 16 }} message="未检测到 Maestro，无法执行 App 回归"
          description="安装 Maestro（maestro.dev，依赖 Java 17+）后，在「全局设置 → 运行环境」中确认路径。测 iOS 需要 Mac 与 Xcode 模拟器。" />
      )}

      {result && (
        <>
          <div className="stat-grid" style={{ marginBottom: 16 }}>
            <Card size="small"><Statistic title={`${PLATFORM_LABEL[result.platform]} 用例`} value={result.run.total} /></Card>
            <Card size="small"><Statistic title="通过" value={result.run.passed} valueStyle={{ color: "#3f8600" }} /></Card>
            <Card size="small"><Statistic title="失败" value={failed} valueStyle={{ color: failed ? "#cf1322" : undefined }} /></Card>
            <Card size="small"><Statistic title="执行记录" value={result.run.run_id} valueStyle={{ fontSize: 14 }} className="mono" /></Card>
          </div>
          {failed === 0 && <Alert style={{ marginBottom: 16 }} type="success" showIcon message="全部通过" />}
          {result.failures.length > 0 && (
            <Card size="small" title="失败明细" style={{ marginBottom: 16 }}
              extra={<Typography.Text type="secondary">截图在 <span className="mono">{result.report}</span>；归因在「工程化 → 失败归因」确认</Typography.Text>}>
              <CaseTitles projectId={project.id} ids={result.failures.map((f) => f.case_id)}>
                <Table size="small" rowKey="case_id" dataSource={result.failures} scroll={{ x: 640 }}
                  pagination={{ defaultPageSize: 10, size: "small", hideOnSinglePage: true }}
                  columns={[
                    { title: "用例", dataIndex: "case_id", width: 220, render: (id: string) => <CaseLink id={id} /> },
                    { title: "结果", dataIndex: "status", width: 80, render: (s: string) => <Tag color="red" bordered={false}>{s === "error" ? "出错" : "失败"}</Tag> },
                    { title: "归因", dataIndex: "failure_type", width: 140, render: (v: string) => <LabelTag map={FAILURE} value={v} /> },
                    { title: "信息", dataIndex: "message", render: (m: string) => (
                      <Typography.Paragraph type="secondary" className="mono" style={{ marginBottom: 0, fontSize: 12 }}
                        ellipsis={{ rows: 2, expandable: true, symbol: "展开" }}>{m}</Typography.Paragraph>
                    ) },
                  ]} />
              </CaseTitles>
            </Card>
          )}
        </>
      )}

      <AppCases project={project} env={env} platform={platform} canExplore={Boolean(appId) && pinkyOn} pinkyOn={pinkyOn} />
    </>
  );
}

function AppCases({ project, env, platform, canExplore, pinkyOn }: {
  project: Project; env: string; platform: Platform; canExplore: boolean; pinkyOn: boolean;
}) {
  const { items, loading, reload, pagination } = usePaged<TestCase>(
    (q) => api().pageCases(project.id, { ...q, filters: { execution_mode: "app", status: "draft,reviewed" } }) as
      Promise<{ items: TestCase[]; total: number }>,
    [project.id], 15);
  const scripts = useLoad(() => api().scriptMap("maestro"), [project.id]);
  const { busy, run } = useAction();
  const { modal } = App.useApp();
  const production = Boolean(project.environments[env]?.production);

  const explore = (c: TestCase) => {
    const go = (confirmProduction: boolean) => run(async () => {
      await api().exploreAppCase(project.id, env, platform, c.id, { confirmProduction });
      await Promise.all([reload(), scripts.reload()]);
    }, "脚本已生成，请查看 agent 的结论与试跑结果");
    if (!production) return go(false);
    modal.confirm({
      title: `在生产环境「${env}」上探索？`,
      content: "agent 会在手机上操作该环境的 App，可能产生真实数据；关键步骤仍需你在 Pinky 中确认。",
      okText: "确认探索", okButtonProps: { danger: true }, cancelText: "取消",
      onOk: () => go(true),
    });
  };

  return (
    <Card size="small" title="App 用例" extra={!pinkyOn && <Typography.Text type="secondary">探索需要先在「全局设置 → 运行环境」中启用 Pinky</Typography.Text>}>
      <Table size="small" rowKey="id" loading={loading} dataSource={items} scroll={{ x: 640 }}
        pagination={{ ...pagination, size: "small", pageSizeOptions: [15, 30, 50] }}
        locale={{ emptyText: <Empty description="还没有 App 用例：执行方式为「App」的用例会出现在这里（标题或步骤含 App端、Android、iOS 等会自动归入）" /> }}
        columns={[
          { title: "用例", dataIndex: "title", render: (t: string, c: TestCase) => <CaseLink id={c.id} title={t} /> },
          { title: "脚本", width: 120, render: (_: unknown, c: TestCase) => scripts.data?.[c.id]
            ? <Tooltip title={scripts.data[c.id]}><Tag color="green" bordered={false}>已生成</Tag></Tooltip>
            : <Tag bordered={false}>未生成</Tag> },
          { title: "规范检查", dataIndex: "lint_status", width: 100, render: (v: string) => <LabelTag map={LINT} value={v} /> },
          { title: "", width: 160, render: (_: unknown, c: TestCase) => (
            <Tooltip title={!pinkyOn ? "未启用 Pinky" : !canExplore ? `环境没有配置 ${PLATFORM_LABEL[platform]} App` : c.lint_status === "blocked" ? "用例有阻断问题" : undefined}>
              <Button size="small" icon={<CompassOutlined />} loading={busy}
                disabled={!canExplore || c.lint_status === "blocked"} onClick={() => explore(c)}>
                {scripts.data?.[c.id] ? "重新探索" : "探索生成脚本"}
              </Button>
            </Tooltip>
          ) },
        ]} />
    </Card>
  );
}
