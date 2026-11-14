import { Button, Card, Checkbox, Col, Form, Input, Row, Select, Typography } from "antd";
import { useEffect } from "react";
import { api, envOwner, type Project } from "../api";
import { useAction } from "../hooks";
import { useProjects } from "./ProjectSettings";

interface ApiLoginConfig {
  method?: string;
  path: string;
  body?: Record<string, unknown>;
  token_path?: string;
  prefix?: string;
  encrypt?: boolean;
  headers?: Record<string, unknown>;
}

interface ApiLoginForm {
  method: string;
  path?: string;
  body: string;
  token_path: string;
  prefix: string;
  encrypt: boolean;
  headers: string;
  protocol: string;
  public_key_file: string;
  private_key_file: string;
  common_headers: string;
}

const jsonObjectRule = { validator: (_: unknown, value: string) => {
  try { const v = JSON.parse(value); if (v && typeof v === "object" && !Array.isArray(v)) return Promise.resolve(); } catch { /* validation below */ }
  return Promise.reject(new Error("请输入 JSON 对象"));
} };

const DEFAULT_BODY = '{"username": "${username}", "password": "${password}"}';

/**
 * 环境的「接口登录」：执行接口测试时用各角色的账号密码调用它换取 token（每个角色只登录一次）。
 * 保存在环境配置中（不含任何凭据）；继承来的环境保存到大项目。
 */
export function ApiLoginCard({ project, env }: { project: Project; env: string }) {
  const [form] = Form.useForm<ApiLoginForm>();
  const { busy, run } = useAction();
  const { reload, projects } = useProjects();
  const cfg = project.environments[env] as (Project["environments"][string] & { api_login?: ApiLoginConfig; api_crypto?: { protocol?: string; public_key_file?: string; private_key_file?: string; headers?: Record<string, unknown> } }) | undefined;
  const owner = env ? envOwner(project, env) : project.id;
  const ownerName = owner !== project.id ? projects.find((p) => p.id === owner)?.name : undefined;

  useEffect(() => {
    const l = cfg?.api_login;
    form.setFieldsValue({
      encrypt: l?.encrypt ?? false, headers: JSON.stringify(l?.headers ?? {}),
      protocol: cfg?.api_crypto?.protocol ?? "none", public_key_file: cfg?.api_crypto?.public_key_file ?? "", private_key_file: cfg?.api_crypto?.private_key_file ?? "",
      common_headers: JSON.stringify(cfg?.api_crypto?.headers ?? {}),
      method: l?.method ?? "POST", path: l?.path ?? "", token_path: l?.token_path ?? "data.token",
      prefix: l?.prefix ?? "Bearer ", body: l?.body ? JSON.stringify(l.body) : DEFAULT_BODY,
    });
  }, [cfg?.api_login, cfg?.api_crypto, env, form]);

  const save = (v: ApiLoginForm) => run(async () => {
    const next: Record<string, unknown> = { ...cfg, api_crypto: { protocol: v.protocol, public_key_file: v.public_key_file.trim(), private_key_file: v.private_key_file.trim(), headers: JSON.parse(v.common_headers) } };
    if (v.path?.trim()) {
      next.api_login = {
        ...cfg?.api_login, method: v.method, path: v.path.trim(), body: JSON.parse(v.body), encrypt: v.encrypt, headers: JSON.parse(v.headers),
        token_path: v.token_path.trim() || "data.token", prefix: v.prefix,
      };
    } else {
      delete next.api_login;
    }
    await api().setEnvironment(owner, env, next);
    await reload();
  }, v.path?.trim() ? (ownerName ? `已保存到大项目「${ownerName}」` : "接口登录已保存") : "已清除接口登录");

  return (
    <Card size="small" title={`接口登录（${env} 环境${ownerName ? `，保存到大项目「${ownerName}」` : ""}）`}
      extra={<Typography.Text type="secondary">用角色账号密码换取 token</Typography.Text>}>
      <Form form={form} layout="vertical" onFinish={save}>
        <Form.Item name="protocol" label="接口传输协议"><Select options={[{ value: "none", label: "普通 JSON" }, { value: "ruoyi", label: "RuoYi · AES-256-ECB + RSA" }]} /></Form.Item>
        <Form.Item name="public_key_file" label="请求加密公钥文件" extra="填写引擎所在机器的 PEM 文件绝对路径"><Input placeholder="/path/to/request-public.pem" /></Form.Item>
        <Form.Item name="private_key_file" label="响应解密私钥文件" extra="密钥不写入用例；服务端响应带 encrypt-key 时自动解密"><Input placeholder="/path/to/response-private.pem" /></Form.Item>
        <Form.Item name="common_headers" label="公共请求头（JSON）" rules={[jsonObjectRule]} extra='例如 {"clientid":"你的客户端 ID"}，应用于登录及业务接口'><Input.TextArea rows={2} /></Form.Item>
        <Button type="link" onClick={() => form.setFieldsValue({ protocol: "ruoyi", method: "POST", path: "/auth/login", encrypt: true, token_path: "data.access_token", body: JSON.stringify({ username: "${username}", password: "${password}", clientId: "请填写客户端 ID", grantType: "password", tenantId: "000000" }) })}>填入 RuoYi 登录模板</Button>
        <Row gutter={8}>
          <Col flex="110px">
            <Form.Item name="method" label="方法">
              <Select options={["POST", "PUT", "GET"].map((m) => ({ value: m, label: m }))} />
            </Form.Item>
          </Col>
          <Col flex="auto">
            <Form.Item name="path" label="登录接口路径" extra="留空表示不使用接口登录（角色需保存固定 token）"
              rules={[{ pattern: /^\//, message: "以 / 开头，如 /api/login" }]}>
              <Input className="mono" placeholder="/api/login" />
            </Form.Item>
          </Col>
        </Row>
        <Form.Item name="body" label="请求体（JSON）" extra="${username} / ${password} 在执行时替换为角色的账号密码"
          rules={[{ validator: (_, v: string) => {
            try {
              const parsed = JSON.parse(v);
              return parsed && typeof parsed === "object" ? Promise.resolve() : Promise.reject(new Error("需要 JSON 对象"));
            } catch {
              return Promise.reject(new Error("不是合法的 JSON"));
            }
          } }]}>
          <Input.TextArea className="mono" autoSize={{ minRows: 2, maxRows: 6 }} />
        </Form.Item>
        <Form.Item name="encrypt" valuePropName="checked"><Checkbox>加密登录请求正文</Checkbox></Form.Item>
        <Form.Item name="headers" label="登录请求头（JSON）" rules={[jsonObjectRule]} extra="可填写 X-Mfa-Code 等登录专用请求头"><Input.TextArea rows={2} /></Form.Item>
        <Row gutter={8}>
          <Col span={14}>
            <Form.Item name="token_path" label="响应中 token 的路径" extra="点号路径，如 data.token、data.access_token">
              <Input className="mono" placeholder="data.token" />
            </Form.Item>
          </Col>
          <Col span={10}>
            <Form.Item name="prefix" label="鉴权头前缀" extra="拼在 token 前，可为空">
              <Input className="mono" placeholder="Bearer " />
            </Form.Item>
          </Col>
        </Row>
        <Button htmlType="submit" loading={busy}>保存接口登录</Button>
      </Form>
    </Card>
  );
}
