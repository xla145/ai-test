import { DeleteOutlined, EditOutlined, PlusOutlined, RollbackOutlined } from "@ant-design/icons";
import { Alert, App, Button, Card, Drawer, Form, Input, Modal, Popconfirm, Select, Space, Switch, Table, Tag, Tooltip, Typography } from "antd";
import { createContext, useContext, useEffect, useState } from "react";
import { api, isGroup, type Project } from "../api";
import { useAction } from "../hooks";

/** 项目数据变化（改名、改环境、保存登录方式）后刷新项目列表，避免页面拿着旧配置再保存 */
export const ProjectsContext = createContext<{
  reload: () => Promise<void>;
  projects: Project[];
  /** 切换到当前项目的某个标签页（如 "import"、"api"） */
  goTab?: (key: string) => void;
  /** 打开当前项目的设置抽屉（名称、执行环境）；addEnv 直接弹出「添加环境」 */
  openSettings?: (opts?: { addEnv?: boolean }) => void;
}>({
  reload: async () => undefined,
  projects: [],
});
export const useProjects = () => useContext(ProjectsContext);

type Env = Project["environments"][string] & Record<string, unknown>;
interface EnvRow extends Env {
  name: string;
  /** 继承自大项目（未覆盖） */
  inherited: boolean;
  /** 子项目自己的配置覆盖了大项目的同名环境 */
  overrides: boolean;
}

interface EnvForm {
  name: string;
  base_url: string;
  production?: boolean;
  auth_header?: string;
  /** App 测试：Android 包名 / iOS Bundle ID（该环境安装的那个包，如测试包） */
  app_android?: string;
  app_ios?: string;
}

/**
 * 执行环境表：大项目 / 独立项目直接管理；子项目显示继承来的环境，可「覆盖」为自己的配置，
 * 删除覆盖即「恢复继承」。
 */
export function EnvTable({ project, autoAdd, onAutoAddDone }: {
  project: Project;
  /** 挂载时直接弹出「添加环境」 */
  autoAdd?: boolean;
  /** 直接弹出的「添加环境」保存或取消后调用（如关闭所在的抽屉，回到原来的页面） */
  onAutoAddDone?: () => void;
}) {
  const { reload, projects } = useProjects();
  const { busy, run } = useAction();
  const [editing, setEditing] = useState<{ name?: string; base?: Env & { name?: string } } | undefined>(autoAdd ? {} : undefined);
  const [pendingAuto, setPendingAuto] = useState(Boolean(autoAdd));
  const closeEditor = () => {
    setEditing(undefined);
    if (pendingAuto) {
      setPendingAuto(false);
      onAutoAddDone?.();
    }
  };
  const parent = project.parent_id ? projects.find((p) => p.id === project.parent_id) : undefined;
  const own = (project.own_environments ?? project.environments) as Record<string, Env>;
  const rows: EnvRow[] = Object.entries(project.environments as Record<string, Env>).map(([name, e]) => ({
    ...e, name,
    inherited: Boolean(project.inherited_environments?.[name]),
    overrides: Boolean(parent && name in own && name in parent.environments),
  }));

  const save = (v: EnvForm) => run(async () => {
    const { name: _n, ...prev } = editing?.base ?? {};
    // 保留登录方式、造数接口等其它配置
    const cfg: Record<string, unknown> = { ...prev, base_url: v.base_url.trim(), production: Boolean(v.production) };
    for (const k of ["inherited", "overrides"]) delete cfg[k];
    if (v.auth_header?.trim()) cfg.auth_header = v.auth_header.trim();
    else delete cfg.auth_header;
    const app = { android: v.app_android?.trim() || undefined, ios: v.app_ios?.trim() || undefined };
    if (app.android || app.ios) cfg.app = Object.fromEntries(Object.entries(app).filter(([, x]) => x));
    else delete cfg.app;
    if (!cfg.production) delete cfg.production;
    await api().setEnvironment(project.id, v.name.trim(), cfg);
    await reload();
    closeEditor();
  }, "环境已保存");

  return (
    <>
      <Table<EnvRow> size="small" rowKey="name" pagination={false} dataSource={rows}
        locale={{ emptyText: parent ? "大项目还没有执行环境" : "还没有执行环境，添加后才能执行回归" }}
        columns={[
          { title: "名称", dataIndex: "name", width: 170, render: (n: string, e) => (
            <Space size={4} wrap>
              {n}
              {e.production && <Tag color="red" bordered={false}>生产</Tag>}
              {e.inherited && <Tag bordered={false}>继承</Tag>}
              {e.overrides && <Tag color="blue" bordered={false}>已覆盖</Tag>}
            </Space>
          ) },
          { title: "被测地址", dataIndex: "base_url", ellipsis: true, render: (u: string, e) => (
            <>
              <Typography.Text className="mono" type={e.inherited ? "secondary" : undefined}>{u}</Typography.Text>
              {e.app && (
                <div>
                  {Object.entries(e.app as Record<string, string>).map(([p, id]) => (
                    <Tag key={p} bordered={false} style={{ fontSize: 11 }}>{p === "ios" ? "iOS" : "Android"} {id}</Tag>
                  ))}
                </div>
              )}
            </>
          ) },
          { title: "", width: 96, render: (_: unknown, e) => e.inherited ? (
            <Tooltip title="在本项目中使用不同的配置（如另一个测试地址）">
              <Button size="small" type="link" onClick={() => setEditing({ base: e })}>覆盖</Button>
            </Tooltip>
          ) : (
            <Space size={0}>
              <Button size="small" type="text" icon={<EditOutlined />} aria-label="编辑"
                onClick={() => setEditing({ name: e.name, base: { ...own[e.name], name: e.name } })} />
              <Popconfirm
                title={e.overrides ? `恢复继承「${e.name}」？` : `删除环境「${e.name}」？`}
                description={e.overrides ? `删除本项目的配置，改用大项目「${parent?.name}」的` : "同时删除该环境保存在钥匙串中的 token"}
                okButtonProps={{ danger: !e.overrides }}
                onConfirm={() => run(async () => {
                  await api().deleteEnvironment(project.id, e.name);
                  await reload();
                }, e.overrides ? "已恢复继承" : "环境已删除")}>
                <Button size="small" type="text" danger={!e.overrides} aria-label={e.overrides ? "恢复继承" : "删除"}
                  icon={e.overrides ? <RollbackOutlined /> : <DeleteOutlined />} />
              </Popconfirm>
            </Space>
          ) },
        ]} />
      <Space style={{ marginTop: 8, width: "100%", justifyContent: "space-between" }} wrap>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {isGroup(project)
            ? "子项目自动继承这里的环境；生产环境执行前需要二次确认，agent 访问生产地址的命令一律需要审批。"
            : parent
              ? `继承自大项目「${parent.name}」的环境在大项目中修改；也可以在本项目中覆盖。`
              : "标记为生产的环境：执行回归前需要二次确认；agent 访问生产地址的命令一律需要审批。"}
        </Typography.Text>
        <Button size="small" icon={<PlusOutlined />} onClick={() => setEditing({})}>添加环境</Button>
      </Space>
      <EnvModal
        open={!!editing}
        name={editing?.name}
        base={editing?.base}
        overriding={Boolean(editing && !editing.name && editing.base)}
        existing={rows.filter((r) => !r.inherited).map((r) => r.name)}
        suggestName={rows.length ? undefined : "test"}
        busy={busy}
        onCancel={closeEditor}
        onSubmit={save}
      />
    </>
  );
}

export function ProjectSettings({ project, open, addEnv, onClose, onDeleted }: {
  project: Project;
  open: boolean;
  /** 打开时直接弹出「添加环境」（从空状态、快速开始进入） */
  addEnv?: boolean;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const { reload, projects } = useProjects();
  const { busy, run } = useAction();
  const { modal } = App.useApp();
  const [nameForm] = Form.useForm<{ name: string }>();
  useEffect(() => {
    if (open) nameForm.setFieldsValue({ name: project.name });
  }, [open, project.name, nameForm]);
  const group = isGroup(project);
  const groups = projects.filter(isGroup);
  const childCount = project.children?.length ?? 0;

  const remove = () => modal.confirm({
    title: `从客户端移除「${project.name}」？`,
    content: group ? (
      <Typography.Paragraph style={{ marginBottom: 0 }}>将删除大项目的共享环境、角色账号、设置，以及钥匙串中的 token 与账号密码。</Typography.Paragraph>
    ) : (
      <>
        <Typography.Paragraph>将删除该项目在客户端中的记录：用例库、执行记录、归因、修改建议与复核，以及钥匙串中的环境 token 和角色账号。</Typography.Paragraph>
        <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
          workspace 目录 <Typography.Text code>{project.workspace_path}</Typography.Text> 不会删除。先在「工程化 → 团队共享」导出，之后可以重新导入。
        </Typography.Paragraph>
      </>
    ),
    okText: "移除",
    okButtonProps: { danger: true },
    cancelText: "取消",
    onOk: () => run(async () => {
      await api().deleteProject(project.id);
      await reload();
      onClose();
      onDeleted();
    }, "项目已移除"),
  });

  return (
    <Drawer open={open} onClose={onClose} width={640} title={group ? "大项目设置" : "项目设置"} destroyOnHidden>
      <Card size="small" title="基本信息" style={{ marginBottom: 16 }}>
        <Form form={nameForm} layout="vertical" onFinish={(v) => run(async () => {
          await api().renameProject(project.id, v.name.trim());
          await reload();
        }, "已保存")}>
          <Form.Item name="name" label={group ? "大项目名" : "项目名"} rules={[{ required: true, whitespace: true, message: "请输入名称" }]}>
            <Input />
          </Form.Item>
          {!group && (
            <Form.Item label="workspace 目录" extra="用例、脚本与报告保存在这里并用 git 管理；创建后不能修改">
              <Typography.Text className="mono" copyable>{project.workspace_path}</Typography.Text>
            </Form.Item>
          )}
          <Button type="primary" htmlType="submit" loading={busy}>保存</Button>
        </Form>
      </Card>

      {!group && groups.length > 0 && (
        <Card size="small" title="所属大项目" style={{ marginBottom: 16 }}>
          <Select style={{ width: 260 }} value={project.parent_id || ""} disabled={busy}
            options={[{ value: "", label: "无（独立项目）" }, ...groups.map((g) => ({ value: g.id, label: g.name }))]}
            onChange={(parent) => run(async () => {
              await api().moveProject(project.id, parent);
              await reload();
            }, parent ? "已移入大项目，环境与账号改为继承" : "已移出，成为独立项目")} />
          <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 8, marginBottom: 0 }}>
            放入大项目后继承其执行环境、凭据、角色账号与设置；本项目已有的同名配置会保留并覆盖继承的值。
          </Typography.Paragraph>
        </Card>
      )}

      <Card size="small" title={group ? "共享执行环境" : "执行环境"} style={{ marginBottom: 16 }}>
        <EnvTable project={project} autoAdd={addEnv} onAutoAddDone={onClose} />
      </Card>

      <Card size="small" title={<Typography.Text type="danger">移除{group ? "大项目" : "项目"}</Typography.Text>}>
        <Space direction="vertical" style={{ width: "100%" }}>
          {group && childCount > 0 ? (
            <Alert type="info" showIcon message={`其下还有 ${childCount} 个子项目，需先移除或移出子项目`} />
          ) : (
            <Alert type="warning" showIcon message={group
              ? "只删除大项目的共享配置与凭据。"
              : "只删除客户端中的记录与凭据，workspace 目录与其中的 git 历史保留。"} />
          )}
          <Button danger loading={busy} disabled={group && childCount > 0} onClick={remove}>从客户端移除</Button>
        </Space>
      </Card>
    </Drawer>
  );
}

function EnvModal({ open, name, base, overriding, existing, suggestName, busy, onCancel, onSubmit }: {
  open: boolean;
  /** 编辑已有环境时的环境名（不可改） */
  name?: string;
  /** 预填的配置（编辑或覆盖继承的环境） */
  base?: Env & { name?: string };
  /** 覆盖继承来的环境：环境名固定为继承的名字 */
  overriding: boolean;
  existing: string[];
  /** 新增时预填的环境名（第一个环境默认 test） */
  suggestName?: string;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (v: EnvForm) => void;
}) {
  const [form] = Form.useForm<EnvForm>();
  useEffect(() => {
    if (!open) return;
    form.resetFields();
    form.setFieldsValue(base
      ? {
          name: name ?? base.name, base_url: base.base_url, production: Boolean(base.production), auth_header: (base.auth_header as string) ?? "",
          app_android: (base.app as { android?: string } | undefined)?.android ?? "", app_ios: (base.app as { ios?: string } | undefined)?.ios ?? "",
        }
      : { production: false, name: suggestName });
  }, [open, name, base, suggestName, form]);
  const submit = async () => {
    const v = await form.validateFields().catch(() => undefined);
    if (v) onSubmit(v);
  };
  const fixedName = Boolean(name) || overriding;
  return (
    <Modal open={open} title={name ? `编辑环境：${name}` : overriding ? `在本项目中覆盖：${base?.name}` : "添加环境"}
      onCancel={onCancel} onOk={submit} okText="保存" confirmLoading={busy} destroyOnHidden>
      {overriding && <Alert type="info" showIcon style={{ marginBottom: 12 }} message="覆盖后本项目使用这里的配置，大项目及其它子项目不受影响；之后可以「恢复继承」。" />}
      <Form form={form} layout="vertical" preserve={false}>
        <Form.Item name="name" label="环境名" extra={fixedName ? "环境名不能修改（钥匙串中的 token 按环境名保存）" : "如 test、staging、prod"}
          rules={[
            { required: true, whitespace: true, message: "请输入环境名" },
            { pattern: /^[\w.-]+$/, message: "只能包含字母、数字、下划线、点和短横线" },
            { validator: (_, v: string) => (!fixedName && existing.includes(v?.trim()) ? Promise.reject(new Error("环境已存在")) : Promise.resolve()) },
          ]}>
          <Input disabled={fixedName} />
        </Form.Item>
        <Form.Item name="base_url" label="被测地址" rules={[
          { required: true, message: "请输入被测地址" },
          { pattern: /^https?:\/\/\S+$/, message: "请输入完整地址，如 https://test.example.com" },
        ]}>
          <Input className="mono" placeholder="https://test.example.com" />
        </Form.Item>
        <Form.Item name="auth_header" label="鉴权头" extra="留空使用 Authorization">
          <Input placeholder="Authorization" />
        </Form.Item>
        <Form.Item name="production" label="生产环境" valuePropName="checked" extra="执行回归前需要二次确认">
          <Switch />
        </Form.Item>
        <Form.Item label="App（可选）" extra="测 App 时填写该环境安装的包，如测试包；脚本中以 ${APP_ID} 引用，Android 与 iOS 共用一份脚本" style={{ marginBottom: 0 }}>
          <Space.Compact block>
            <Form.Item name="app_android" noStyle rules={[{ pattern: /^[\w.]+$/, message: "包名格式不正确" }]}>
              <Input className="mono" addonBefore="Android" placeholder="com.example.app" />
            </Form.Item>
          </Space.Compact>
          <Space.Compact block style={{ marginTop: 8 }}>
            <Form.Item name="app_ios" noStyle rules={[{ pattern: /^[\w.-]+$/, message: "Bundle ID 格式不正确" }]}>
              <Input className="mono" addonBefore="iOS" placeholder="com.example.app" />
            </Form.Item>
          </Space.Compact>
        </Form.Item>
      </Form>
    </Modal>
  );
}
