import { CheckOutlined, EyeOutlined, LoginOutlined } from "@ant-design/icons";
import { Alert, Badge, Button, Card, Col, Form, Input, Row, Segmented, Select, Space, Tag, Tooltip, Typography, theme } from "antd";
import { useEffect, useState, type CSSProperties } from "react";
import type { GlobalSettingsView } from "../../shared/ipc";
import { api, envOwner, type Project } from "../api";
import { EnvSelect, NoEnvironment, useEnvChoice } from "../components/EnvPicker";
import { PageHeader } from "../components/PageHeader";
import { useProjects } from "../components/ProjectSettings";
import { RoleAccounts } from "../components/RoleAccounts";
import { useAction, useKeyedAction, useLoad, usePaged, useProjectChanged } from "../hooks";
import { UiInbox, type Proposal, type Review } from "./ui/UiInbox";
import { UiWorkbench } from "./ui/UiWorkbench";

type View = "workspace" | "inbox" | "roles";

/**
 * UI 测试：工作台（AI 生成 → 试跑 → 确认 → 回归）、待处理（修正建议与人工复核）、角色与登录。
 * 页面内的配色取自 antd 主题 token，亮色 / 暗色下保持一致。
 */
export function UiPage({ project }: { project: Project }) {
  const [env, setEnv] = useEnvChoice(project);
  const [working, setWorking] = useState(false);
  const { token } = theme.useToken();
  const proposals = usePaged<Proposal>(
    (q) => api().pageProposals(project.id, { ...q, status: "pending" }) as Promise<{ items: Proposal[]; total: number }>,
    [project.id], 5);
  const reviews = usePaged<Review>(
    (q) => api().pageReviews(project.id, { ...q, status: "pending" }) as Promise<{ items: Review[]; total: number }>,
    [project.id], 10);
  const [view, setView] = useState<View>("workspace");
  const [modelView, setModelView] = useState<GlobalSettingsView>();
  useEffect(() => {
    let disposed = false;
    const update = () => { void api().getGlobalSettings().then((v) => { if (!disposed) setModelView(v); }).catch(() => undefined); };
    update();
    window.addEventListener("aitest:settings", update);
    return () => { disposed = true; window.removeEventListener("aitest:settings", update); };
  }, []);
  const visionModel = modelView?.settings.models.find((m) => m.id === modelView.settings.visionModelId);
  if (!Object.keys(project.environments).length) return <NoEnvironment project={project} purpose="执行 UI 测试" />;
  const todo = proposals.total + reviews.total;
  const vars = {
    "--uix-bg": token.colorBgContainer, "--uix-border": token.colorBorderSecondary, "--uix-text": token.colorText,
    "--uix-text2": token.colorTextSecondary, "--uix-text3": token.colorTextTertiary, "--uix-fill": token.colorFillQuaternary,
    "--uix-fill2": token.colorFillTertiary, "--uix-primary": token.colorPrimary, "--uix-primary-bg": token.colorPrimaryBg,
    "--uix-success": token.colorSuccess, "--uix-warning": token.colorWarning, "--uix-error": token.colorError,
  } as CSSProperties;
  return (
    <div className="uix" style={vars}>
      <PageHeader title="UI 测试" description="AI 生成脚本并在内嵌浏览器中试跑，确认后加入回归；日常回归直接执行脚本，不调用模型。"
        extra={<>
          {modelView && (
            <Tooltip title={visionModel
              ? "探索时可用视觉定位辅助生成脚本，视觉判定进入人工复核。实际可用性取决于模型服务；普通回归直接执行脚本。"
              : "在全局设置 → 模型中添加视觉模型并指定用途；启用后可在内嵌浏览器中辅助定位和校验。"}>
              <span className={`uix-pill ${visionModel ? "on" : ""}`}><EyeOutlined />{visionModel ? `视觉模型 · ${visionModel.name}` : "未配置视觉模型"}</span>
            </Tooltip>
          )}
          <EnvSelect project={project} value={env} onChange={setEnv} disabled={working} showUrl width={260} />
        </>} />
      <Segmented<View> className="uix-nav" value={view} disabled={working} onChange={setView} options={[
        { value: "workspace", label: "工作台" },
        { value: "inbox", label: <span className="uix-nav-item">待处理<Badge count={todo} size="small" /></span> },
        { value: "roles", label: "角色与登录" },
      ]} />
      {/* 工作台常驻挂载：切到其它页签时保留当前用例、执行进度与调试会话 */}
      <div className="uix-view" style={{ display: view === "workspace" ? undefined : "none" }}>
        <UiWorkbench key={`${project.id}:${env}`} project={project} env={env} pendingProposals={proposals.total}
          onWorking={setWorking} onUpdated={async () => { await Promise.all([proposals.reload(), reviews.reload()]); }}
          onInbox={() => setView("inbox")} />
      </div>
      {view === "inbox" && <UiInbox project={project} proposals={proposals} reviews={reviews} />}
      {view === "roles" && <Roles project={project} env={env} />}
    </div>
  );
}

/** 角色账号与登录方式。子项目显示继承自大项目的角色；登录方式保存到环境所在的项目（继承的环境保存到大项目） */
export function Roles({ project, env }: { project: Project; env: string }) {
  const [loginForm] = Form.useForm();
  const { busy, run } = useAction();
  const { reload: reloadProjects, projects } = useProjects();
  const owner = env ? envOwner(project, env) : project.id;
  const ownerName = owner !== project.id ? projects.find((p) => p.id === owner)?.name : undefined;
  const login = (project.environments[env] as { login?: Record<string, string> })?.login ?? {
    url: "/login", username: "#username", password: "#password", submit: "button[type=submit]", success: "",
  };
  // 表单实例跨环境复用，切换环境（或保存后配置刷新）时必须换成该环境的值，否则会把上一个环境的登录方式存到当前环境
  const loginKey = JSON.stringify(login);
  useEffect(() => {
    loginForm.resetFields();
    loginForm.setFieldsValue(login);
  }, [env, loginKey]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="split">
      <div style={{ flex: "1 1 320px" }}>
        <RoleAccounts project={project} />
      </div>
      <div style={{ flex: "1.2 1 380px" }}>
        <Card size="small" title={`登录方式（${env} 环境${ownerName ? `，保存到大项目「${ownerName}」` : ""}）`} extra={<Typography.Text type="secondary">填写 CSS 选择器</Typography.Text>}>
          <Form form={loginForm} name="login-recipe" layout="vertical" initialValues={login} key={env}
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
        <ManualLogin project={project} env={env} />
      </div>
    </div>
  );
}

/** 手动登录：验证码、扫码等无法自动登录时，用户在角色的内嵌浏览器里亲自登录一次 */
function ManualLogin({ project, env }: { project: Project; env: string }) {
  const roles = useLoad(() => api().listRoles(project.id), [project.id]);
  const sessions = useLoad(() => api().roleSessions(project.id), [project.id]);
  // 左侧新增角色后刷新可选角色
  useProjectChanged(project.id, () => { void roles.reload(); void sessions.reload(); });
  const [role, setRole] = useState<string>();
  const [opened, setOpened] = useState(false);
  const { busy, activeKey, run } = useKeyedAction();
  useEffect(() => { setOpened(false); }, [env, role]);
  const names = (roles.data ?? []).map((r) => r.role_name);
  const saved = sessions.data ?? {};
  return (
    <Card size="small" title="手动登录" style={{ marginTop: 16 }} extra={<Typography.Text type="secondary">适合验证码、扫码等无法自动登录的系统</Typography.Text>}>
      <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
        在内嵌浏览器中以某个角色亲自登录一次（{env} 环境）：AI 探索、单步调试、内嵌试跑直接沿用这份登录态；保存后无头回归也会使用。登录过期后重新登录即可。
      </Typography.Paragraph>
      {!names.length && !roles.loading ? <Alert type="info" showIcon message="先在左侧添加角色（只填角色名即可，不需要账号密码）" /> : <>
        <Space wrap>
          <Select placeholder="选择角色" style={{ width: 200 }} value={role} onChange={setRole} loading={roles.loading}
            options={names.map((n) => ({ value: n, label: saved[n] ? `${n}（已保存登录态）` : n }))} />
          <Button icon={<LoginOutlined />} disabled={!role || busy} loading={activeKey === "open"}
            onClick={() => run("open", async () => { await api().openRoleLogin(project.id, env, role!); setOpened(true); })}>打开登录页</Button>
          <Button type="primary" icon={<CheckOutlined />} disabled={!role || !opened || busy} loading={activeKey === "save"}
            onClick={() => run("save", async () => {
              const out = await api().saveRoleLogin(project.id, env, role!);
              await sessions.reload();
              return out;
            }, "登录态已保存")}>已完成登录，保存登录态</Button>
        </Space>
        {opened && <Alert type="warning" showIcon style={{ marginTop: 12 }}
          message="在右侧内嵌浏览器中完成登录（含验证码），看到登录后的页面再点「已完成登录，保存登录态」"
          description="AI 探索、单步调试和内嵌试跑共用这个角色的浏览器，不保存也会沿用；保存是为了让无头回归也能使用。" />}
        {Object.keys(saved).length > 0 && (
          <div style={{ marginTop: 12 }}>
            {Object.entries(saved).map(([n, at]) => (
              <div key={n}><Tag bordered={false} color="green">{n}</Tag><Typography.Text type="secondary">登录态保存于 {new Date(at).toLocaleString()}</Typography.Text></div>
            ))}
          </div>
        )}
      </>}
    </Card>
  );
}
