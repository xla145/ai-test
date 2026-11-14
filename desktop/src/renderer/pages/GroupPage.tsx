import { FolderOpenOutlined, PlusOutlined } from "@ant-design/icons";
import { Button, Card, Empty, Progress, Space, Statistic, Table, Tabs, Tag, Typography } from "antd";
import type { GroupOverview } from "../../shared/ipc";
import { api, type Project } from "../api";
import { EnvCredentials } from "../components/EnvCredentials";
import { EnvSelect, useEnvChoice } from "../components/EnvPicker";
import { PageHeader } from "../components/PageHeader";
import { EnvTable, useProjects } from "../components/ProjectSettings";
import { useLoad, useNarrow } from "../hooks";
import { Usage } from "./OpsPage";
import { Roles } from "./UiPage";

type Child = GroupOverview["children"][number];

/** 大项目：子项目概览 + 共享配置（环境、凭据、角色与登录、用量与预算），子项目自动继承 */
export function GroupPage({ group, onOpen, onNewChild }: { group: Project; onOpen: (id: string) => void; onNewChild: () => void }) {
  const { projects } = useProjects();
  // 子项目增删、改名后重新读取
  const childKey = projects.filter((p) => p.parent_id === group.id).map((p) => `${p.id}:${p.name}`).join(",");
  const overview = useLoad(() => api().projectOverview(group.id), [group.id, childKey]);
  const [env, setEnv] = useEnvChoice(group);
  const [ref, narrow] = useNarrow<HTMLDivElement>();
  const children = overview.data?.children ?? [];
  const totalCases = children.reduce((n, c) => n + c.cases, 0);
  const monthTokens = children.reduce((n, c) => n + c.month_tokens, 0);
  const budget = overview.data?.budget;

  return (
    <div ref={ref}>
      <PageHeader
        title={group.name}
        description="大项目存放共享的执行环境、凭据、角色账号与预算，子项目自动继承；用例、脚本与执行记录在各子项目中。"
        extra={<Button type="primary" icon={<PlusOutlined />} onClick={onNewChild}>新建子项目</Button>}
      />
      <div className="stat-grid metric-strip" style={{ marginBottom: 16 }}>
        <Card size="small"><Statistic title="子项目" value={children.length} /></Card>
        <Card size="small"><Statistic title="用例总数" value={totalCases} /></Card>
        <Card size="small"><Statistic title="本月 token" value={monthTokens} /></Card>
        <Card size="small">
          <Typography.Text type="secondary">本月预算（全部子项目共用）</Typography.Text>
          {budget?.monthly_budget ? (
            <>
              <Progress percent={Math.min(100, Math.round((budget.month_used / budget.monthly_budget) * 100))}
                status={budget.allowed ? "normal" : "exception"} />
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {budget.month_used.toLocaleString()} / {budget.monthly_budget.toLocaleString()}
              </Typography.Text>
            </>
          ) : <div style={{ fontSize: 20, marginTop: 4 }}>不限</div>}
        </Card>
      </div>
      <Tabs
        tabPosition={narrow ? "top" : "left"}
        items={[
          { key: "children", label: "子项目", children: (
            <Card size="small">
              <Table<Child> size="small" rowKey="id" loading={overview.loading} dataSource={children} pagination={false}
                scroll={{ x: 640 }}
                locale={{ emptyText: <Empty description="还没有子项目"><Button icon={<PlusOutlined />} onClick={onNewChild}>新建子项目</Button></Empty> }}
                columns={[
                  { title: "子项目", dataIndex: "name", render: (n: string, c) => (
                    <>
                      <Typography.Link onClick={() => onOpen(c.id)}><FolderOpenOutlined /> {n}</Typography.Link>
                      <div><Typography.Text type="secondary" className="mono" style={{ fontSize: 12 }} ellipsis>{c.workspace_path}</Typography.Text></div>
                    </>
                  ) },
                  { title: "用例", width: 150, render: (_: unknown, c) => (
                    <Space size={4} wrap>
                      <span>{c.cases}</span>
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>已审 {c.reviewed}</Typography.Text>
                      {c.blocked > 0 && <Tag color="red" bordered={false}>阻断 {c.blocked}</Tag>}
                    </Space>
                  ) },
                  { title: "最近执行", width: 190, render: (_: unknown, c) => c.last_run ? (
                    <>
                      <Space size={6}>
                        <Progress type="circle" size={22} percent={Math.round((c.last_run.pass_rate ?? 0) * 100)} showInfo={false}
                          status={c.last_run.passed === c.last_run.total ? "success" : "exception"} />
                        <span>{c.last_run.passed}/{c.last_run.total}</span>
                        <Tag bordered={false}>{c.last_run.framework === "playwright" ? "UI" : "接口"}</Tag>
                      </Space>
                      <div><Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        {c.last_run.env} · {new Date(c.last_run.started_at).toLocaleString()}
                      </Typography.Text></div>
                    </>
                  ) : <Typography.Text type="secondary">未执行</Typography.Text> },
                  { title: "本月 token", dataIndex: "month_tokens", width: 110, align: "right", render: (v: number) => v.toLocaleString() },
                  { title: "", width: 70, render: (_: unknown, c) => <Button size="small" onClick={() => onOpen(c.id)}>打开</Button> },
                ]} />
            </Card>
          ) },
          { key: "envs", label: "执行环境", children: <Card size="small"><EnvTable project={group} /></Card> },
          { key: "secrets", label: "环境凭据", children: <EnvCredentials project={group} env={env} onEnvChange={setEnv} /> },
          { key: "roles", label: "角色与登录", children: (
            <>
              <Space style={{ marginBottom: 12 }}>
                <Typography.Text type="secondary">登录方式按环境配置：</Typography.Text>
                <EnvSelect project={group} value={env} onChange={setEnv} width={180} />
              </Space>
              <Roles project={group} env={env} />
            </>
          ) },
          { key: "usage", label: "用量与预算", children: <Usage project={group} /> },
        ]}
      />
    </div>
  );
}
