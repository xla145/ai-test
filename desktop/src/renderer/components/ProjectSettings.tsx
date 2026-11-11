import { DeleteOutlined, EditOutlined, PlusOutlined } from "@ant-design/icons";
import { Alert, App, Button, Card, Drawer, Form, Input, Modal, Popconfirm, Space, Switch, Table, Tag, Typography } from "antd";
import { createContext, useContext, useEffect, useState } from "react";
import { api, type Project } from "../api";
import { useAction } from "../hooks";

/** 项目数据变化（改名、改环境、保存登录方式）后刷新项目列表，避免页面拿着旧配置再保存 */
export const ProjectsContext = createContext<{ reload: () => Promise<void> }>({ reload: async () => undefined });
export const useProjects = () => useContext(ProjectsContext);

type Env = Project["environments"][string] & Record<string, unknown>;

interface EnvForm {
  name: string;
  base_url: string;
  production?: boolean;
  auth_header?: string;
}

export function ProjectSettings({ project, open, onClose, onDeleted }: {
  project: Project;
  open: boolean;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const { reload } = useProjects();
  const { busy, run } = useAction();
  const { modal } = App.useApp();
  const [nameForm] = Form.useForm<{ name: string }>();
  const [editing, setEditing] = useState<string | "new">();
  useEffect(() => {
    if (open) nameForm.setFieldsValue({ name: project.name });
  }, [open, project.name, nameForm]);

  const envs = Object.entries(project.environments as Record<string, Env>);

  const remove = () => modal.confirm({
    title: `从客户端移除「${project.name}」？`,
    content: (
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
    <Drawer open={open} onClose={onClose} width={640} title="项目设置" destroyOnHidden>
      <Card size="small" title="基本信息" style={{ marginBottom: 16 }}>
        <Form form={nameForm} layout="vertical" onFinish={(v) => run(async () => {
          await api().renameProject(project.id, v.name.trim());
          await reload();
        }, "已保存")}>
          <Form.Item name="name" label="项目名" rules={[{ required: true, whitespace: true, message: "请输入项目名" }]}>
            <Input />
          </Form.Item>
          <Form.Item label="workspace 目录" extra="用例、脚本与报告保存在这里并用 git 管理；创建后不能修改">
            <Typography.Text className="mono" copyable>{project.workspace_path}</Typography.Text>
          </Form.Item>
          <Button type="primary" htmlType="submit" loading={busy}>保存</Button>
        </Form>
      </Card>

      <Card size="small" title="执行环境" style={{ marginBottom: 16 }}
        extra={<Button size="small" icon={<PlusOutlined />} onClick={() => setEditing("new")}>添加环境</Button>}>
        <Table<Env & { name: string }> size="small" rowKey="name" pagination={false}
          dataSource={envs.map(([name, e]) => ({ name, ...e }))}
          locale={{ emptyText: "还没有执行环境，添加后才能执行回归" }}
          columns={[
            { title: "名称", dataIndex: "name", width: 140, render: (n: string, e) => (
              <Space size={4}>{n}{e.production && <Tag color="red" bordered={false}>生产</Tag>}</Space>
            ) },
            { title: "被测地址", dataIndex: "base_url", ellipsis: true, render: (u: string) => <span className="mono">{u}</span> },
            { title: "", width: 80, render: (_: unknown, e) => (
              <Space size={0}>
                <Button size="small" type="text" icon={<EditOutlined />} aria-label="编辑" onClick={() => setEditing(e.name)} />
                <Popconfirm title={`删除环境「${e.name}」？`} description="同时删除该环境保存在钥匙串中的 token"
                  okButtonProps={{ danger: true }} onConfirm={() => run(async () => {
                    await api().deleteEnvironment(project.id, e.name);
                    await reload();
                  }, "环境已删除")}>
                  <Button size="small" type="text" danger icon={<DeleteOutlined />} aria-label="删除" />
                </Popconfirm>
              </Space>
            ) },
          ]} />
        <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 8, marginBottom: 0 }}>
          标记为生产的环境：执行回归前需要二次确认；agent 访问生产地址的命令一律需要审批。鉴权 token 在「接口回归」页保存到钥匙串。
        </Typography.Paragraph>
      </Card>

      <Card size="small" title={<Typography.Text type="danger">移除项目</Typography.Text>}>
        <Space direction="vertical" style={{ width: "100%" }}>
          <Alert type="warning" showIcon message="只删除客户端中的记录与凭据，workspace 目录与其中的 git 历史保留。" />
          <Button danger loading={busy} onClick={remove}>从客户端移除</Button>
        </Space>
      </Card>

      <EnvModal
        open={!!editing}
        name={editing === "new" ? undefined : editing}
        env={editing && editing !== "new" ? (project.environments as Record<string, Env>)[editing] : undefined}
        existing={envs.map(([n]) => n)}
        busy={busy}
        onCancel={() => setEditing(undefined)}
        onSubmit={(v) => run(async () => {
          const prev = editing && editing !== "new" ? (project.environments as Record<string, Env>)[editing] : {};
          // 保留登录方式、造数接口等其它配置
          const cfg: Record<string, unknown> = { ...prev, base_url: v.base_url.trim(), production: Boolean(v.production) };
          if (v.auth_header?.trim()) cfg.auth_header = v.auth_header.trim();
          else delete cfg.auth_header;
          if (!cfg.production) delete cfg.production;
          await api().setEnvironment(project.id, v.name.trim(), cfg);
          await reload();
          setEditing(undefined);
        }, "环境已保存")}
      />
    </Drawer>
  );
}

function EnvModal({ open, name, env, existing, busy, onCancel, onSubmit }: {
  open: boolean;
  name?: string;
  env?: Env;
  existing: string[];
  busy: boolean;
  onCancel: () => void;
  onSubmit: (v: EnvForm) => void;
}) {
  const [form] = Form.useForm<EnvForm>();
  useEffect(() => {
    if (!open) return;
    form.resetFields();
    form.setFieldsValue(name && env
      ? { name, base_url: env.base_url, production: Boolean(env.production), auth_header: (env.auth_header as string) ?? "" }
      : { production: false });
  }, [open, name, env, form]);
  const submit = async () => {
    const v = await form.validateFields().catch(() => undefined);
    if (v) onSubmit(v);
  };
  return (
    <Modal open={open} title={name ? `编辑环境：${name}` : "添加环境"} onCancel={onCancel} onOk={submit} okText="保存"
      confirmLoading={busy} destroyOnHidden>
      <Form form={form} layout="vertical" preserve={false}>
        <Form.Item name="name" label="环境名" extra={name ? "环境名创建后不能修改（钥匙串中的 token 按环境名保存）" : "如 test、staging、prod"}
          rules={[
            { required: true, whitespace: true, message: "请输入环境名" },
            { pattern: /^[\w.-]+$/, message: "只能包含字母、数字、下划线、点和短横线" },
            { validator: (_, v: string) => (!name && existing.includes(v?.trim()) ? Promise.reject(new Error("环境已存在")) : Promise.resolve()) },
          ]}>
          <Input disabled={!!name} />
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
      </Form>
    </Modal>
  );
}
