import { CheckOutlined, LoginOutlined } from "@ant-design/icons";
import { Alert, Button, Card, Form, Input, Space, Typography } from "antd";
import { useState } from "react";
import { api, envOwner, type Project } from "../api";
import { useKeyedAction } from "../hooks";
import { useProjects } from "./ProjectSettings";

export function ApiBrowserLogin({ project, env }: { project: Project; env: string }) {
  const [form] = Form.useForm<{ url: string; key?: string; header: string; prefix: string }>();
  const [opened, setOpened] = useState(false);
  const [savedAt, setSavedAt] = useState("");
  const { busy, activeKey, run } = useKeyedAction();
  const { reload } = useProjects();
  const cfg = project.environments[env] as { login?: { url?: string } } | undefined;
  return <Card size="small" title="网页登录，保存 token" style={{ marginBottom: 16 }}>
    <Typography.Paragraph type="secondary">在右侧浏览器完成登录后保存 token，接口调试和回归会直接使用它作为当前环境的默认鉴权。过期后重新登录并保存即可。</Typography.Paragraph>
    {envOwner(project, env) !== project.id && <Alert type="info" showIcon message="当前环境继承自大项目，保存的 token 将与该环境的其他子项目共用" style={{ marginBottom: 12 }} />}
    <Form form={form} layout="vertical" initialValues={{ url: cfg?.login?.url ?? "/login", header: "Authorization", prefix: "Bearer " }}>
      <Form.Item name="url" label="登录页地址" rules={[{ required: true, message: "请填写登录页地址" }]} extra="支持完整网址；相对路径基于当前环境地址"><Input placeholder="https://example.com/login" disabled={busy} onChange={() => setOpened(false)} /></Form.Item>
      <Form.Item name="key" label="token 存储键名或路径（可选）" extra="留空时优先读取业务请求的鉴权头，再识别浏览器存储；支持嵌套路径，如 store.auth.accessToken"><Input placeholder="自动识别" disabled={busy} /></Form.Item>
      <Space align="start">
        <Form.Item name="header" label="鉴权请求头" rules={[{ required: true }]}><Input disabled={busy} /></Form.Item>
        <Form.Item name="prefix" label="token 前缀" extra="可留空；Bearer 后保留空格"><Input disabled={busy} /></Form.Item>
      </Space>
      <Space wrap>
        <Button icon={<LoginOutlined />} disabled={!env || busy} loading={activeKey === "open"} onClick={() => run("open", async () => {
          const values = await form.validateFields(["url", "header"]);
          setOpened(false);
          await api().openApiLogin(project.id, env, values.url, values.header);
          setOpened(true);
        })}>打开登录页</Button>
        <Button type="primary" icon={<CheckOutlined />} disabled={!opened || busy} loading={activeKey === "save"} onClick={() => run("save", async () => {
          const values = await form.validateFields();
          const out = await api().saveApiLogin(project.id, env, values);
          await reload();
          setSavedAt(out.savedAt);
        }, "token 已保存，接口测试将直接使用")}>已完成登录，保存 token</Button>
      </Space>
    </Form>
    {opened && <Alert style={{ marginTop: 12 }} type="info" showIcon message="在右侧浏览器完成登录，打开一个业务页面后保存 token" description="自动保存 token 及系统需要的 clientid 请求头。选择角色的请求仍使用该角色凭据。修改鉴权头名称后需重新打开登录页。" />}
    {savedAt && <Typography.Paragraph type="success" style={{ marginTop: 12, marginBottom: 0 }}>token 已保存于 {new Date(savedAt).toLocaleString()}</Typography.Paragraph>}
  </Card>;
}
