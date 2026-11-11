import {
  ApiOutlined,
  AppstoreOutlined,
  ClusterOutlined,
  DashboardOutlined,
  BarChartOutlined,
  BugOutlined,
  ChromeOutlined,
  CloseOutlined,
  DatabaseOutlined,
  FileExcelOutlined,
  FileSearchOutlined,
  FolderOpenOutlined,
  HistoryOutlined,
  MobileOutlined,
  PlayCircleOutlined,
  PlusOutlined,
  SafetyCertificateOutlined,
  SettingOutlined,
  ToolOutlined,
} from "@ant-design/icons";
import {
  App as AntApp,
  Avatar,
  Badge,
  Button,
  Descriptions,
  Drawer,
  Empty,
  Flex,
  Form,
  Input,
  Layout,
  Menu,
  Modal,
  Radio,
  Select,
  Space,
  Tabs,
  Tag,
  Timeline,
  Tooltip,
  Typography,
  theme,
} from "antd";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ApprovalRequest } from "../shared/ipc";
import { api, isGroup, type Project } from "./api";
import { ProjectSettings, ProjectsContext } from "./components/ProjectSettings";
import { useUpdateState } from "./components/UpdateCard";
import { useAction, useLoad } from "./hooks";
import { ApiPage } from "./pages/ApiPage";
import { AppPage } from "./pages/AppPage";
import { GroupPage } from "./pages/GroupPage";
import { CasesPage } from "./pages/CasesPage";
import { DatabasePage } from "./pages/DatabasePage";
import { ImportPage } from "./pages/ImportPage";
import { OpsPage } from "./pages/OpsPage";
import { ReportsPage } from "./pages/ReportsPage";
import { RunPage } from "./pages/RunPage";
import { SettingsPage } from "./pages/SettingsPage";
import { UiPage } from "./pages/UiPage";

const { Sider, Header, Content } = Layout;

interface ActivityItem {
  time: string;
  method: string;
  detail: string;
}

/** 头像文字：中文取最后一个字（名），其他取首字母 */
function initial(name?: string): string {
  if (!name) return "?";
  const n = name.trim();
  return /[\u4e00-\u9fff]/.test(n) ? n.slice(-1) : n.charAt(0).toUpperCase();
}

/** Codex 事件 → 可读的活动记录 */
function describe(method: string, params: any): string | undefined {
  switch (method) {
    case "aitest/progress":
      return { run: "开始接口回归", "ui-run": "开始 UI 回归", case_gen: "agent：生成用例", api_script: "agent：补充接口脚本",
        triage: "agent：失败归因", explore: "agent：探索 UI 用例", heal: "agent：自愈",
        "app-run": "开始 App 回归", app_explore: "agent：探索 App 用例" }[params?.stage as string] ?? params?.stage;
    case "item/started":
      return params?.item?.type === "mcpToolCall" ? `调用工具 ${params.item.server ?? ""}.${params.item.tool ?? ""}` : undefined;
    case "turn/completed":
      return "agent 完成本轮任务";
    default:
      return undefined;
  }
}

export function App() {
  const { token } = theme.useToken();
  const { data: projects = [], reload } = useLoad(() => api().listProjects() as Promise<Project[]>, []);
  const [currentId, setCurrentId] = useState<string>();
  const [tab, setTab] = useState("import");
  const [approval, setApproval] = useState<ApprovalRequest>();
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [activityOpen, setActivityOpen] = useState(false);
  /** 打开活动面板后新到的条数，用于侧栏的提示点 */
  const [unread, setUnread] = useState(0);
  /** 新建项目弹窗：parent 为预选的大项目 */
  const [creating, setCreating] = useState<false | { parent?: string; kind?: "project" | "group" }>(false);
  const [viewVisible, setViewVisible] = useState(false);
  // 全局设置不属于任何项目，单独一个视图
  const [showSettings, setShowSettings] = useState(false);
  const [projectSettingsOpen, setProjectSettingsOpen] = useState(false);
  const { data: user } = useLoad(() => api().getUserInfo(), []);
  const update = useUpdateState();
  const { notification } = AntApp.useApp();
  // 新版本下载完成：提示一次，可直接重启更新
  useEffect(() => {
    if (update?.status !== "downloaded" || !update.version) return;
    const key = `update-${update.version}`;
    notification.info({
      key, duration: 0, placement: "bottomRight",
      message: `新版本 ${update.version} 已下载`,
      description: "重启后完成更新，正在进行的任务请先等待结束。",
      btn: <Button type="primary" size="small" onClick={() => { notification.destroy(key); void api().installUpdate(); }}>重启并更新</Button>,
    });
  }, [update?.status, update?.version, notification]);
  const current = projects.find((p) => p.id === currentId) ?? projects[0];
  // 内嵌浏览器打开时界面只有半屏：侧栏收成图标，把宽度留给内容
  const compact = viewVisible;
  const projectsCtx = useMemo(() => ({ reload, projects }), [reload, projects]);
  const groups = projects.filter(isGroup);
  const parentOf = (p?: Project) => (p?.parent_id ? projects.find((x) => x.id === p.parent_id) : undefined);
  // 侧栏树：大项目 → 概览 + 子项目 + 新建子项目；独立项目在后
  const menuItems = [
    ...groups.map((g) => ({
      key: `group:${g.id}`,
      icon: <ClusterOutlined />,
      label: g.name,
      children: [
        { key: g.id, icon: <DashboardOutlined />, label: "概览与共享配置" },
        ...projects.filter((p) => p.parent_id === g.id).map((p) => ({ key: p.id, icon: <FolderOpenOutlined />, label: p.name })),
        { key: `new:${g.id}`, icon: <PlusOutlined />, label: <Typography.Text type="secondary">新建子项目</Typography.Text> },
      ],
    })),
    ...projects.filter((p) => !isGroup(p) && !p.parent_id).map((p) => ({ key: p.id, icon: <FolderOpenOutlined />, label: p.name })),
  ];
  const [openGroups, setOpenGroups] = useState<string[]>();
  // 默认展开全部大项目；之后由用户折叠 / 展开
  const openKeys = openGroups ?? groups.map((g) => `group:${g.id}`);

  useEffect(() => {
    const offApproval = api().onApprovalRequest(setApproval);
    const offEvent = api().onEvent((e) => {
      const detail = describe(e.method, e.params);
      if (!detail) return;
      setActivity((xs) => [...xs.slice(-199), { time: new Date().toLocaleTimeString(), method: e.method, detail }]);
      setUnread((n) => n + 1);
    });
    const offView = api().onViewChange?.((v) => setViewVisible(v.visible));
    return () => {
      offApproval();
      offEvent();
      offView?.();
    };
  }, []);

  const respond = useCallback((accept: boolean) => {
    if (approval) api().respondApproval(approval.id, accept);
    setApproval(undefined);
  }, [approval]);

  const tabs = current
    ? [
        { key: "import", label: "用例导入与检查", icon: <FileExcelOutlined />, children: <ImportPage project={current} /> },
        { key: "cases", label: "用例库", icon: <AppstoreOutlined />, children: <CasesPage project={current} /> },
        { key: "api", label: "接口测试", icon: <ApiOutlined />, children: <ApiPage project={current} /> },
        { key: "run", label: "接口回归", icon: <PlayCircleOutlined />, children: <RunPage project={current} /> },
        { key: "ui", label: "UI 测试", icon: <ChromeOutlined />, children: <UiPage project={current} /> },
        { key: "db", label: "数据库", icon: <DatabaseOutlined />, children: <DatabasePage project={current} onChanged={reload} /> },
        { key: "reports", label: "测试报告", icon: <FileSearchOutlined />, children: <ReportsPage project={current} /> },
        { key: "app", label: "App 测试", icon: <MobileOutlined />, children: <AppPage project={current} /> },
        { key: "ops", label: "工程化", icon: <BarChartOutlined />, children: <OpsPage project={current} /> },
      ]
    : [];

  return (
    <ProjectsContext.Provider value={projectsCtx}>
    <Layout className={`app-shell ${viewVisible ? "with-view" : ""}`}>
      <Sider width={232} collapsedWidth={64} collapsed={compact} trigger={null} theme="light"
        style={{ borderRight: `1px solid ${token.colorBorderSecondary}` }}>
        <Flex vertical style={{ height: "100%" }}>
          <div className={`brand ${compact ? "compact" : ""}`}>
            <div className="brand-logo"><BugOutlined /></div>
            {!compact && "AI 测试客户端"}
          </div>
          <div className="sider-section">
            <Tooltip title={compact ? "新建项目" : undefined} placement="right">
              <Button block type="dashed" icon={<PlusOutlined />} aria-label="新建项目" onClick={() => setCreating({})}>
                {!compact && "新建项目"}
              </Button>
            </Tooltip>
          </div>
          <Menu
            mode="inline"
            style={{ borderInlineEnd: "none", flex: 1, overflow: "auto", marginTop: 8 }}
            selectedKeys={current && !showSettings ? [current.id] : []}
            openKeys={compact ? undefined : openKeys}
            onOpenChange={(keys) => setOpenGroups(keys as string[])}
            onClick={(e) => {
              if (e.key.startsWith("new:")) return setCreating({ parent: e.key.slice(4) });
              setCurrentId(e.key);
              setShowSettings(false);
            }}
            items={menuItems}
          />
          <div className={`sider-footer ${compact ? "compact" : ""}`} style={{ borderTop: `1px solid ${token.colorBorderSecondary}` }}>
            <Tooltip placement={compact ? "right" : "topLeft"} title={user && (
              <>
                <div>{user.name}{user.email ? ` <${user.email}>` : ""}</div>
                <div style={{ opacity: 0.75, fontSize: 12 }}>
                  {user.source === "git" ? "来自 git 全局配置（user.name / user.email）" : "系统用户名；可用 git config --global user.name 设置显示名"}
                </div>
              </>
            )}>
              <div className="sider-user">
                <Avatar size={30} style={{ background: token.colorPrimary, flexShrink: 0, fontSize: 14 }}>
                  {initial(user?.name)}
                </Avatar>
                {!compact && (
                  <span className="sider-user-text">
                    <span className="sider-user-name">{user?.name ?? "—"}</span>
                    <span className="sider-user-sub" style={{ color: token.colorTextTertiary }}>{user?.email ?? "本机用户"}</span>
                  </span>
                )}
              </div>
            </Tooltip>
            <Tooltip title={update?.status === "downloaded" ? `全局设置（新版本 ${update.version} 已下载）` : "全局设置"} placement={compact ? "right" : "top"}>
              <Button type="text" className="sider-action" aria-label="全局设置"
                icon={<Badge dot={update?.status === "downloaded"} offset={[-1, 2]}><SettingOutlined /></Badge>}
                style={showSettings ? { background: token.colorPrimaryBg, color: token.colorPrimary } : undefined}
                onClick={() => setShowSettings(true)} />
            </Tooltip>
            <Tooltip title={unread ? `agent 活动（${unread} 条新活动）` : "agent 活动"} placement={compact ? "right" : "top"}>
              <Button type="text" className="sider-action" aria-label="agent 活动"
                icon={<Badge dot={unread > 0} offset={[-1, 2]}><HistoryOutlined /></Badge>}
                onClick={() => {
                  setActivityOpen(true);
                  setUnread(0);
                }} />
            </Tooltip>
          </div>
        </Flex>
      </Sider>

      <Layout>
        {current && !showSettings && (
          <Header style={{ padding: "0 24px", height: 56, lineHeight: "normal", borderBottom: `1px solid ${token.colorBorderSecondary}` }}>
            <Flex justify="space-between" align="center" gap={16} style={{ height: "100%" }}>
              <Flex align="center" gap={8} style={{ minWidth: 0 }}>
                {parentOf(current) && (
                  <>
                    <Typography.Link type="secondary" style={{ fontSize: 16, whiteSpace: "nowrap" }}
                      onClick={() => setCurrentId(parentOf(current)!.id)}>{parentOf(current)!.name}</Typography.Link>
                    <Typography.Text type="secondary">/</Typography.Text>
                  </>
                )}
                <Typography.Text strong ellipsis style={{ fontSize: 16, minWidth: 0 }}>{current.name}</Typography.Text>
                {isGroup(current) && <Tag color="purple" bordered={false} style={{ marginInlineEnd: 0 }}>大项目</Tag>}
                <Tooltip title="项目设置：名称、执行环境">
                  <Button size="small" type="text" icon={<ToolOutlined />} aria-label="项目设置" onClick={() => setProjectSettingsOpen(true)} />
                </Tooltip>
                {!compact && current.workspace_path && (
                  <Tooltip title={current.workspace_path}>
                    <Typography.Text type="secondary" className="mono" ellipsis style={{ minWidth: 0 }}>
                      {current.workspace_path}
                    </Typography.Text>
                  </Tooltip>
                )}
              </Flex>
              <Space size={4} style={{ flexShrink: 0 }}>
                {!compact && Object.entries(current.environments).map(([name, env]) => (
                  <Tooltip key={name} title={env.base_url}>
                    <Tag color={env.production ? "red" : "blue"} bordered={false}>{env.production ? `${name}（生产）` : name}</Tag>
                  </Tooltip>
                ))}
                {viewVisible && (
                  <Button size="small" icon={<CloseOutlined />} onClick={() => api().hideTestView?.()}>收起浏览器</Button>
                )}
              </Space>
            </Flex>
          </Header>
        )}
        <Content style={{ overflow: "hidden" }}>
          {showSettings ? (
            <div className="page"><SettingsPage /></div>
          ) : current && isGroup(current) ? (
            <div className="page">
              <GroupPage group={current} onOpen={setCurrentId} onNewChild={() => setCreating({ parent: current.id })} />
            </div>
          ) : current ? (
            <Tabs
              activeKey={tab}
              onChange={setTab}
              items={tabs.map((t) => ({ key: t.key, label: <span>{t.icon} {t.label}</span>, children: <div className="page">{t.children}</div> }))}
              tabBarStyle={{ padding: "0 24px", marginBottom: 0 }}
              style={{ height: "100%" }}
              destroyOnHidden
            />
          ) : (
            <Flex align="center" justify="center" style={{ height: "100%" }}>
              <Empty description="还没有项目">
                <Space>
                  <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreating({})}>新建项目</Button>
                  <Button icon={<ClusterOutlined />} onClick={() => setCreating({ kind: "group" })}>新建大项目</Button>
                </Space>
              </Empty>
            </Flex>
          )}
        </Content>
      </Layout>

      {current && (
        <ProjectSettings project={current} open={projectSettingsOpen} onClose={() => setProjectSettingsOpen(false)}
          onDeleted={() => setCurrentId(undefined)} />
      )}

      <NewProjectModal open={!!creating} preset={creating || NO_PRESET} groups={groups} onClose={() => setCreating(false)} onCreated={async (p) => { await reload(); setCurrentId(p.id); setShowSettings(false); }} />

      <Modal
        open={!!approval}
        title={<Space><SafetyCertificateOutlined style={{ color: token.colorWarning }} />需要你的审批</Space>}
        okText="允许"
        cancelText="拒绝"
        onOk={() => respond(true)}
        onCancel={() => respond(false)}
        maskClosable={false}
        width={560}
      >
        {approval && (
          <>
            <Typography.Paragraph strong>{approval.reason}</Typography.Paragraph>
            <Descriptions size="small" column={1} bordered items={[
              { key: "kind", label: "类型", children: approval.kind === "command" ? "执行命令" : "修改文件" },
              ...Object.entries((approval.detail ?? {}) as Record<string, unknown>)
                .filter(([k]) => ["command", "cwd", "reason", "grantRoot", "changes"].includes(k))
                .map(([k, v]) => ({ key: k, label: k, children: <span className="mono">{typeof v === "string" ? v : JSON.stringify(v)}</span> })),
            ]} />
          </>
        )}
      </Modal>

      <Drawer title="agent 活动" open={activityOpen} onClose={() => setActivityOpen(false)} width={420}
        extra={<Button size="small" onClick={() => { setActivity([]); setUnread(0); }}>清空</Button>}>
        {activity.length ? (
          <Timeline items={[...activity].reverse().map((a) => ({ children: <><Typography.Text type="secondary">{a.time}</Typography.Text> {a.detail}</> }))} />
        ) : (
          <Empty description="暂无活动" />
        )}
      </Drawer>
    </Layout>
    </ProjectsContext.Provider>
  );
}

const NO_PRESET = {};

interface NewProjectForm {
  kind: "project" | "group";
  parent?: string;
  name: string;
  workspace?: string;
  env: string;
  baseUrl?: string;
}

function NewProjectModal({ open, preset, groups, onClose, onCreated }: {
  open: boolean;
  preset: { parent?: string; kind?: "project" | "group" };
  groups: Project[];
  onClose: () => void;
  onCreated: (p: Project) => void;
}) {
  const [form] = Form.useForm<NewProjectForm>();
  const kind = Form.useWatch("kind", form);
  const parent = Form.useWatch("parent", form);
  const { busy, run } = useAction();
  useEffect(() => {
    if (open) form.setFieldsValue({ kind: preset.kind ?? "project", parent: preset.parent, env: "test" });
  }, [open, preset, form]);
  const pick = async () => {
    const dir = await api().pickDirectory();
    if (dir) form.setFieldValue("workspace", dir);
  };
  const submit = async () => {
    const v = await form.validateFields().catch(() => undefined);
    if (!v) return;
    const envs = v.baseUrl ? { [v.env || "test"]: { base_url: v.baseUrl } } : {};
    const p = await run(() => api().createProject(v.name, v.workspace ?? "", envs,
      { kind: v.kind, parent: v.kind === "project" ? v.parent : undefined }) as Promise<Project>,
      v.kind === "group" ? "大项目已创建，可以在其下新建子项目" : "项目已创建");
    if (p) {
      form.resetFields();
      onClose();
      onCreated(p);
    }
  };
  const group = kind === "group";
  return (
    <Modal open={open} title={group ? "新建大项目" : parent ? "新建子项目" : "新建项目"} onCancel={onClose} onOk={submit}
      okText="创建" confirmLoading={busy} destroyOnHidden>
      <Form form={form} layout="vertical" initialValues={{ env: "test", kind: "project" }} preserve={false}>
        <Form.Item name="kind" label="类型" extra={group
          ? "大项目不含用例，只存放执行环境、凭据、角色账号与预算，其下的子项目自动继承"
          : "项目有自己的用例库与 workspace；放在大项目下时继承大项目的环境与账号"}>
          <Radio.Group optionType="button" options={[{ value: "project", label: "项目" }, { value: "group", label: "大项目" }]} />
        </Form.Item>
        {!group && groups.length > 0 && (
          <Form.Item name="parent" label="所属大项目">
            <Select allowClear placeholder="不属于任何大项目（独立项目）" options={groups.map((g) => ({ value: g.id, label: g.name }))} />
          </Form.Item>
        )}
        <Form.Item name="name" label={group ? "大项目名" : "项目名"} rules={[{ required: true, whitespace: true, message: "请输入名称" }]}>
          <Input placeholder={group ? "如：特征中心" : parent ? "如：v4.4、标签管理" : "如：订单服务"} />
        </Form.Item>
        {!group && (
          <Form.Item label="workspace 目录" required extra="用例、脚本与报告都放在这里，并用 git 管理">
            <Space.Compact style={{ width: "100%" }}>
              <Form.Item name="workspace" noStyle rules={[{ required: true, message: "请选择目录" }]}>
                <Input placeholder="选择或输入目录" />
              </Form.Item>
              <Button onClick={pick}>选择…</Button>
            </Space.Compact>
          </Form.Item>
        )}
        <Flex gap={8}>
          <Form.Item name="env" label="环境名" style={{ width: 120 }}><Input /></Form.Item>
          <Form.Item name="baseUrl" label={parent && !group ? "被测地址（留空则继承大项目的环境）" : "被测地址（可稍后配置）"} style={{ flex: 1 }}
            rules={[{ type: "url", message: "请输入完整地址，如 https://test.example.com" }]}>
            <Input placeholder="https://test.example.com" />
          </Form.Item>
        </Flex>
      </Form>
    </Modal>
  );
}
