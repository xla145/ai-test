import {
  ApiOutlined,
  AppstoreOutlined,
  BarChartOutlined,
  BugOutlined,
  ChromeOutlined,
  CloseOutlined,
  FileExcelOutlined,
  FolderOpenOutlined,
  HistoryOutlined,
  PlayCircleOutlined,
  PlusOutlined,
  SafetyCertificateOutlined,
  SettingOutlined,
} from "@ant-design/icons";
import {
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
  Space,
  Tabs,
  Tag,
  Timeline,
  Tooltip,
  Typography,
  theme,
} from "antd";
import { useCallback, useEffect, useState } from "react";
import type { ApprovalRequest } from "../shared/ipc";
import { api, type Project } from "./api";
import { useAction, useLoad } from "./hooks";
import { ApiPage } from "./pages/ApiPage";
import { CasesPage } from "./pages/CasesPage";
import { ImportPage } from "./pages/ImportPage";
import { OpsPage } from "./pages/OpsPage";
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
        triage: "agent：失败归因", explore: "agent：探索 UI 用例", heal: "agent：自愈" }[params?.stage as string] ?? params?.stage;
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
  const [creating, setCreating] = useState(false);
  const [viewVisible, setViewVisible] = useState(false);
  // 全局设置不属于任何项目，单独一个视图
  const [showSettings, setShowSettings] = useState(false);
  const { data: user } = useLoad(() => api().getUserInfo(), []);
  const current = projects.find((p) => p.id === currentId) ?? projects[0];

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
        { key: "ops", label: "工程化", icon: <BarChartOutlined />, children: <OpsPage project={current} /> },
      ]
    : [];

  return (
    <Layout className={`app-shell ${viewVisible ? "with-view" : ""}`}>
      <Sider width={232} theme="light" style={{ borderRight: `1px solid ${token.colorBorderSecondary}` }}>
        <Flex vertical style={{ height: "100%" }}>
          <div className="brand">
            <div className="brand-logo"><BugOutlined /></div>
            AI 测试客户端
          </div>
          <div className="sider-section">
            <Button block type="dashed" icon={<PlusOutlined />} onClick={() => setCreating(true)}>新建项目</Button>
          </div>
          <Menu
            mode="inline"
            style={{ borderInlineEnd: "none", flex: 1, overflow: "auto", marginTop: 8 }}
            selectedKeys={current && !showSettings ? [current.id] : []}
            onClick={(e) => {
              setCurrentId(e.key);
              setShowSettings(false);
            }}
            items={projects.map((p) => ({ key: p.id, icon: <FolderOpenOutlined />, label: p.name }))}
          />
          <div className="sider-footer" style={{ borderTop: `1px solid ${token.colorBorderSecondary}` }}>
            <Tooltip placement="topLeft" title={user && (
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
                <span className="sider-user-text">
                  <span className="sider-user-name">{user?.name ?? "—"}</span>
                  <span className="sider-user-sub" style={{ color: token.colorTextTertiary }}>{user?.email ?? "本机用户"}</span>
                </span>
              </div>
            </Tooltip>
            <Tooltip title="全局设置" placement="top">
              <Button type="text" className="sider-action" aria-label="全局设置" icon={<SettingOutlined />}
                style={showSettings ? { background: token.colorPrimaryBg, color: token.colorPrimary } : undefined}
                onClick={() => setShowSettings(true)} />
            </Tooltip>
            <Tooltip title={unread ? `agent 活动（${unread} 条新活动）` : "agent 活动"} placement="top">
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
              <Flex align="baseline" gap={12} style={{ minWidth: 0 }}>
                <Typography.Text strong style={{ fontSize: 16, whiteSpace: "nowrap" }}>{current.name}</Typography.Text>
                <Tooltip title={current.workspace_path}>
                  <Typography.Text type="secondary" className="mono" ellipsis style={{ minWidth: 0 }}>
                    {current.workspace_path}
                  </Typography.Text>
                </Tooltip>
              </Flex>
              <Space size={4} style={{ flexShrink: 0 }}>
                {Object.entries(current.environments).map(([name, env]) => (
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
          ) : current ? (
            <Tabs
              activeKey={tab}
              onChange={setTab}
              items={tabs.map((t) => ({ key: t.key, label: <span>{t.icon} {t.label}</span>, children: <div className="page">{t.children}</div> }))}
              tabBarStyle={{ padding: "0 24px", marginBottom: 0 }}
              style={{ height: "100%" }}
              destroyInactiveTabPane
            />
          ) : (
            <Flex align="center" justify="center" style={{ height: "100%" }}>
              <Empty description="还没有项目">
                <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreating(true)}>新建项目</Button>
              </Empty>
            </Flex>
          )}
        </Content>
      </Layout>

      <NewProjectModal open={creating} onClose={() => setCreating(false)} onCreated={async (p) => { await reload(); setCurrentId(p.id); setShowSettings(false); }} />

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
  );
}

function NewProjectModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (p: Project) => void }) {
  const [form] = Form.useForm<{ name: string; workspace: string; env: string; baseUrl?: string }>();
  const { busy, run } = useAction();
  const pick = async () => {
    const dir = await api().pickDirectory();
    if (dir) form.setFieldValue("workspace", dir);
  };
  const submit = async () => {
    const v = await form.validateFields().catch(() => undefined);
    if (!v) return;
    const p = await run(() => api().createProject(v.name, v.workspace, v.baseUrl ? { [v.env || "test"]: { base_url: v.baseUrl } } : {}) as Promise<Project>, "项目已创建");
    if (p) {
      form.resetFields();
      onClose();
      onCreated(p);
    }
  };
  return (
    <Modal open={open} title="新建项目" onCancel={onClose} onOk={submit} okText="创建" confirmLoading={busy} destroyOnClose>
      <Form form={form} layout="vertical" initialValues={{ env: "test" }} preserve={false}>
        <Form.Item name="name" label="项目名" rules={[{ required: true, message: "请输入项目名" }]}>
          <Input placeholder="如：特征中心 v4.4" />
        </Form.Item>
        <Form.Item label="workspace 目录" required extra="用例、脚本与报告都放在这里，并用 git 管理">
          <Space.Compact style={{ width: "100%" }}>
            <Form.Item name="workspace" noStyle rules={[{ required: true, message: "请选择目录" }]}>
              <Input placeholder="选择或输入目录" />
            </Form.Item>
            <Button onClick={pick}>选择…</Button>
          </Space.Compact>
        </Form.Item>
        <Flex gap={8}>
          <Form.Item name="env" label="环境名" style={{ width: 120 }}><Input /></Form.Item>
          <Form.Item name="baseUrl" label="被测地址（可稍后配置）" style={{ flex: 1 }}
            rules={[{ type: "url", message: "请输入完整地址，如 https://test.example.com" }]}>
            <Input placeholder="https://test.example.com" />
          </Form.Item>
        </Flex>
      </Form>
    </Modal>
  );
}
