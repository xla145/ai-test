import { UserAddOutlined } from "@ant-design/icons";
import { Button, Card, Col, Form, Input, Row, Space, Tag, Tooltip, Typography } from "antd";
import { api, type Project } from "../api";
import { useAction, useLoad } from "../hooks";
import { useProjects } from "./ProjectSettings";

interface RoleForm {
  name: string;
  username?: string;
  password?: string;
  token?: string;
}

/**
 * 角色账号：账号密码（页面登录、接口登录换 token）与接口 token（接口测试固定凭据），都存系统钥匙串。
 * 用例与脚本只写角色名。子项目继承大项目的角色，保存同名角色即单独设置。
 */
export function RoleAccounts({ project, purpose = "all" }: { project: Project; purpose?: "all" | "api" }) {
  const roles = useLoad(() => api().listRoles(project.id), [project.id]);
  const status = useLoad(() => api().roleSecretStatus(project.id), [project.id]);
  const [form] = Form.useForm<RoleForm>();
  const { busy, run } = useAction();
  const { projects } = useProjects();
  const parentName = project.parent_id ? projects.find((p) => p.id === project.parent_id)?.name : undefined;
  const names = [...new Set([...(roles.data ?? []).map((r) => r.role_name), ...Object.keys(status.data ?? {})])].sort();

  return (
    <Card size="small" title="角色账号" extra={<Typography.Text type="secondary">存入系统钥匙串，用例只写角色名</Typography.Text>}>
      <Space wrap style={{ marginBottom: 12 }}>
        {names.map((name) => {
          const s = status.data?.[name];
          const inherited = (roles.data ?? []).find((r) => r.role_name === name)?.inherited_from || s?.inherited;
          return (
            <Tooltip key={name} title={inherited ? `继承自大项目「${parentName}」；在这里保存同名角色可单独设置` : "点击填入表单以修改"}>
              <Tag color={inherited ? "default" : "blue"} bordered={false} style={{ cursor: "pointer" }}
                onClick={() => form.setFieldsValue({ name, username: "", password: "", token: "" })}>
                {name}{inherited ? "（继承）" : ""}
                <Typography.Text type="secondary" style={{ fontSize: 11, marginLeft: 6 }}>
                  {[s?.account && "账号", s?.token && "token"].filter(Boolean).join(" · ") || "未保存凭据"}
                </Typography.Text>
              </Tag>
            </Tooltip>
          );
        })}
        {!names.length && <Typography.Text type="secondary">还没有角色</Typography.Text>}
      </Space>
      <Form form={form} layout="vertical" onFinish={(v) => run(async () => {
        await api().setRoleSecret(project.id, v.name.trim(), v.username?.trim() ?? "", v.password ?? "", v.token?.trim() || undefined);
        form.resetFields();
        await Promise.all([roles.reload(), status.reload()]);
      }, "角色已保存")}>
        <Form.Item name="name" label="角色名" rules={[{ required: true, whitespace: true, message: "请输入角色名" }]}>
          <Input placeholder={purpose === "api" ? "如：买家、运营、财务" : "如：管理员、运营、访客"} />
        </Form.Item>
        <Row gutter={8}>
          <Col span={12}><Form.Item name="username" label="账号"><Input autoComplete="off" /></Form.Item></Col>
          <Col span={12}><Form.Item name="password" label="密码"><Input.Password autoComplete="new-password" /></Form.Item></Col>
        </Row>
        <Form.Item name="token" label="接口 token（可选）"
          extra="接口测试优先使用；不填则用账号密码调用环境的「接口登录」换取。修改已有角色时，留空的项保持不变。"
          rules={[({ getFieldValue }) => ({
            validator: (_, token: string) => (token || getFieldValue("username")
              || status.data?.[getFieldValue("name")]?.account || status.data?.[getFieldValue("name")]?.token
              ? Promise.resolve() : Promise.reject(new Error("请填写账号密码或接口 token"))),
          })]}>
          <Input.Password placeholder="如 Bearer eyJhbGci…" autoComplete="off" />
        </Form.Item>
        <Button htmlType="submit" icon={<UserAddOutlined />} loading={busy}>保存角色</Button>
      </Form>
    </Card>
  );
}
