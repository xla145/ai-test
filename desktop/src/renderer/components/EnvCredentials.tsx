import { KeyOutlined } from "@ant-design/icons";
import { Button, Card, Form, Input, Space, Typography } from "antd";
import { api, envOwner, isGroup, type Project } from "../api";
import { useAction } from "../hooks";
import { EnvSelect } from "./EnvPicker";
import { useProjects } from "./ProjectSettings";

/**
 * 环境鉴权 token：存入系统钥匙串。
 * 子项目继承来的环境，token 保存到大项目（所有子项目共用）；覆盖了的环境保存到本项目。
 */
export function EnvCredentials({ project, env, onEnvChange }: { project: Project; env: string; onEnvChange?: (env: string) => void }) {
  const [form] = Form.useForm<{ token: string; header?: string }>();
  const { busy, run } = useAction();
  const { projects } = useProjects();
  const owner = env ? envOwner(project, env) : project.id;
  const ownerName = owner !== project.id ? projects.find((p) => p.id === owner)?.name : undefined;
  return (
    <Card size="small" title={<Space><KeyOutlined />环境凭据</Space>} style={{ marginBottom: 16 }}
      extra={onEnvChange && <EnvSelect project={project} value={env} onChange={onEnvChange} width={180} />}>
      <Form form={form} layout="inline" style={{ rowGap: 8 }} onFinish={(v) => run(async () => {
        await api().setEnvSecret(owner, env, v.token, v.header || undefined);
        form.resetFields();
      }, ownerName ? `已保存到大项目「${ownerName}」，子项目共用` : "凭据已存入系统钥匙串")}>
        <Form.Item name="token" rules={[{ required: true, message: "请输入 token" }]}>
          <Input.Password placeholder={`「${env}」的鉴权 token，如 Bearer xxx`} style={{ width: 320, maxWidth: "100%" }} />
        </Form.Item>
        <Form.Item name="header"><Input placeholder="鉴权头（默认 Authorization）" style={{ width: 220 }} /></Form.Item>
        <Form.Item><Button htmlType="submit" loading={busy} disabled={!env}>保存到钥匙串</Button></Form.Item>
      </Form>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {ownerName
          ? `「${env}」继承自大项目「${ownerName}」，token 保存在大项目，所有子项目共用；在项目设置中覆盖该环境后可单独设置。`
          : isGroup(project)
            ? "子项目继承这里的 token；子项目覆盖了环境时使用自己的 token。"
            : "凭据只在执行时注入脚本进程，不会进入模型上下文或写入数据库。"}
      </Typography.Text>
    </Card>
  );
}
