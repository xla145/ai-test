import {
  ApiOutlined,
  CaretRightOutlined,
  CopyOutlined,
  DatabaseOutlined,
  DeleteOutlined,
  EditOutlined,
  LockOutlined,
  PlusOutlined,
  SafetyCertificateOutlined,
} from "@ant-design/icons";
import {
  Alert,
  App,
  Button,
  Card,
  Col,
  Empty,
  Flex,
  Form,
  Input,
  InputNumber,
  List,
  Modal,
  Popconfirm,
  Row,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import { useEffect, useMemo, useState } from "react";
import { api, type Project } from "../api";
import { PageHeader } from "../components/PageHeader";
import { useAction } from "../hooks";

type DbType = "mysql" | "postgresql" | "sqlite";
interface DbConn { type: DbType; host?: string; port?: number; database?: string; user?: string; path?: string; readonly?: boolean }
interface QueryResult { columns: string[]; rows: Record<string, unknown>[]; row_count: number; truncated: boolean; elapsed_ms: number }

const TYPE_LABEL: Record<DbType, string> = { mysql: "MySQL", postgresql: "PostgreSQL", sqlite: "SQLite" };
const DEFAULT_PORT: Record<string, number> = { mysql: 3306, postgresql: 5432 };

export function DatabasePage({ project, onChanged }: { project: Project; onChanged: () => Promise<void> }) {
  const envs = Object.keys(project.environments);
  const [env, setEnv] = useState(envs[0]);
  const envCfg = project.environments[env] as { databases?: Record<string, DbConn>; production?: boolean } | undefined;
  const conns = useMemo(() => Object.entries(envCfg?.databases ?? {}), [envCfg]);
  const [editing, setEditing] = useState<{ name?: string; cfg?: DbConn } | null>(null);
  const [status, setStatus] = useState<Record<string, { ok: boolean; text: string }>>({});
  const { busy, run } = useAction();

  if (!envs.length) return <Empty description="项目还没有配置执行环境" />;

  const test = (name: string) => run(async () => {
    try {
      const r = await api().testDatabase(project.id, env, name);
      setStatus((s) => ({ ...s, [name]: { ok: true, text: `连接正常（${r.elapsed_ms} ms）` } }));
    } catch (e) {
      setStatus((s) => ({ ...s, [name]: { ok: false, text: (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") } }));
    }
  });

  return (
    <>
      <PageHeader
        title="数据库"
        description="配置被测系统的数据库连接，用于入库校验：接口与 UI 用例执行后直接查询数据库确认结果。查询与断言均为只读。"
        extra={<>
          <Select value={env} onChange={setEnv} style={{ width: 160 }}
            options={envs.map((e) => ({ value: e, label: project.environments[e].production ? `${e}（生产）` : e }))} />
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setEditing({})}>添加连接</Button>
        </>}
      />
      {envCfg?.production && (
        <Alert style={{ marginBottom: 16 }} type="warning" showIcon icon={<LockOutlined />}
          message="生产环境：只能执行只读查询，数据准备与清理被禁止。" />
      )}
      <Row gutter={16}>
        <Col span={8}>
          <Card size="small" title={`连接（${env}）`}>
            {conns.length ? (
              <List
                dataSource={conns}
                renderItem={([name, c]) => (
                  <List.Item
                    actions={[
                      <Tooltip key="t" title="测试连接"><Button size="small" type="text" icon={<ApiOutlined />} loading={busy} onClick={() => test(name)} /></Tooltip>,
                      <Tooltip key="e" title="编辑"><Button size="small" type="text" icon={<EditOutlined />} onClick={() => setEditing({ name, cfg: c })} /></Tooltip>,
                      <Popconfirm key="d" title={`删除连接 ${name}？`} onConfirm={() => run(async () => { await api().removeDatabase(project.id, env, name); await onChanged(); }, "已删除")}>
                        <Button size="small" type="text" danger icon={<DeleteOutlined />} />
                      </Popconfirm>,
                    ]}
                  >
                    <List.Item.Meta
                      avatar={<DatabaseOutlined style={{ fontSize: 20, marginTop: 4 }} />}
                      title={<Space size={4}>{name}<Tag bordered={false}>{TYPE_LABEL[c.type]}</Tag>{c.readonly !== false && <Tag bordered={false} color="green">只读</Tag>}</Space>}
                      description={<>
                        <Typography.Text type="secondary" className="mono" ellipsis style={{ maxWidth: 170, display: "inline-block" }}>
                          {c.type === "sqlite" ? c.path : `${c.user ? `${c.user}@` : ""}${c.host}:${c.port ?? DEFAULT_PORT[c.type]}/${c.database ?? ""}`}
                        </Typography.Text>
                        {status[name] && <div><Typography.Text type={status[name].ok ? "success" : "danger"} style={{ fontSize: 12 }}>{status[name].text}</Typography.Text></div>}
                      </>}
                    />
                  </List.Item>
                )}
              />
            ) : (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有数据库连接">
                <Button icon={<PlusOutlined />} onClick={() => setEditing({})}>添加连接</Button>
              </Empty>
            )}
          </Card>
        </Col>
        <Col span={16}>
          <Console project={project} env={env} names={conns.map(([n]) => n)} />
        </Col>
      </Row>
      {editing && (
        <ConnectionModal project={project} env={env} production={!!envCfg?.production} initial={editing}
          onClose={() => setEditing(null)} onSaved={async () => { setEditing(null); await onChanged(); }} />
      )}
    </>
  );
}

function ConnectionModal({ project, env, production, initial, onClose, onSaved }: {
  project: Project; env: string; production: boolean; initial: { name?: string; cfg?: DbConn }; onClose: () => void; onSaved: () => Promise<void>;
}) {
  const [form] = Form.useForm();
  const type: DbType = Form.useWatch("type", form) ?? initial.cfg?.type ?? "mysql";
  const [hasPassword, setHasPassword] = useState(false);
  const { busy, run } = useAction();
  useEffect(() => {
    if (initial.name) void api().hasDbPassword(project.id, env, initial.name).then(setHasPassword);
  }, [initial.name, project.id, env]);

  const submit = async () => {
    const { name, password, ...cfg } = await form.validateFields();
    await run(async () => {
      await api().saveDatabase(project.id, env, name, { ...cfg, readonly: production ? true : cfg.readonly }, password || undefined);
      await onSaved();
    }, "连接已保存，密码存入系统钥匙串");
  };

  return (
    <Modal open title={initial.name ? `编辑连接 ${initial.name}` : "添加数据库连接"} onCancel={onClose} onOk={submit} confirmLoading={busy} okText="保存" width={560}>
      <Form form={form} layout="vertical" initialValues={{ type: "mysql", readonly: true, host: "127.0.0.1", ...initial.cfg, name: initial.name }}>
        <Row gutter={8}>
          <Col span={12}>
            <Form.Item name="name" label="连接名" extra="用例中用它引用，如 main、order_db"
              rules={[{ required: true }, { pattern: /^[A-Za-z_][\w-]*$/, message: "字母开头，只含字母、数字、下划线、连字符" }]}>
              <Input disabled={!!initial.name} placeholder="main" />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item name="type" label="类型">
              <Select options={(Object.keys(TYPE_LABEL) as DbType[]).map((t) => ({ value: t, label: TYPE_LABEL[t] }))} />
            </Form.Item>
          </Col>
        </Row>
        {type === "sqlite" ? (
          <Form.Item name="path" label="数据库文件路径" rules={[{ required: true }]}><Input className="mono" placeholder="/path/to/app.db" /></Form.Item>
        ) : (
          <>
            <Row gutter={8}>
              <Col span={16}><Form.Item name="host" label="主机" rules={[{ required: true }]}><Input /></Form.Item></Col>
              <Col span={8}><Form.Item name="port" label="端口"><InputNumber style={{ width: "100%" }} placeholder={String(DEFAULT_PORT[type])} min={1} max={65535} /></Form.Item></Col>
            </Row>
            <Row gutter={8}>
              <Col span={8}><Form.Item name="database" label="数据库" rules={[{ required: true }]}><Input /></Form.Item></Col>
              <Col span={8}><Form.Item name="user" label="用户名" rules={[{ required: true }]}><Input /></Form.Item></Col>
              <Col span={8}>
                <Form.Item name="password" label="密码" extra={hasPassword ? "已保存，留空不修改" : "存入系统钥匙串"}>
                  <Input.Password placeholder={hasPassword ? "••••••••" : ""} />
                </Form.Item>
              </Col>
            </Row>
          </>
        )}
        <Form.Item name="readonly" label="只读连接" valuePropName="checked"
          extra={production ? "生产环境始终只读" : "关闭后，用例中的数据准备与清理（db_setup）才能写入；查询与断言始终只读。建议使用只读账号。"}>
          <Switch disabled={production} />
        </Form.Item>
      </Form>
    </Modal>
  );
}

function Console({ project, env, names }: { project: Project; env: string; names: string[] }) {
  const { message } = App.useApp();
  const [conn, setConn] = useState<string>();
  const [sql, setSql] = useState("SELECT * FROM ");
  const [params, setParams] = useState("");
  const [result, setResult] = useState<QueryResult>();
  const [snippet, setSnippet] = useState<string>();
  const { busy, run } = useAction();
  const current = conn && names.includes(conn) ? conn : names[0];

  const exec = () => run(async () => {
    let p: Record<string, unknown> = {};
    if (params.trim()) {
      try {
        p = JSON.parse(params);
      } catch {
        throw new Error("参数需为 JSON，如 {\"id\": 1}");
      }
    }
    setResult(await api().queryDatabase(project.id, env, current!, sql, p));
  });

  /** 把这次查询转成用例里可直接用的入库校验（时间类字段每次执行都不同，不放进断言） */
  const toCheck = () => {
    const volatile = /(_at|_time|time|date|timestamp)$/i;
    const first = result?.rows[0] && Object.fromEntries(Object.entries(result.rows[0]).filter(([k]) => !volatile.test(k)));
    const check = {
      db: current,
      description: "入库校验",
      sql: sql.trim().replace(/;$/, ""),
      ...(params.trim() ? { params: JSON.parse(params) } : {}),
      expect: first ? { row: first } : { empty: true },
    };
    setSnippet(JSON.stringify({ db_checks: [check] }, null, 2));
  };

  return (
    <Card size="small" title={<Space><SafetyCertificateOutlined />查询（只读）</Space>}
      extra={<Typography.Text type="secondary">Ctrl / ⌘ + Enter 执行；参数写 :name</Typography.Text>}>
      {!names.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="先添加数据库连接" /> : (
        <>
          <Flex gap={8} style={{ marginBottom: 8 }}>
            <Select value={current} onChange={setConn} style={{ width: 160 }} options={names.map((n) => ({ value: n, label: n }))} />
            <Input placeholder='参数（JSON，可选），如 {"id": 1}' className="mono" value={params} onChange={(e) => setParams(e.target.value)} />
            <Button type="primary" icon={<CaretRightOutlined />} loading={busy} onClick={exec}>执行</Button>
          </Flex>
          <Input.TextArea className="mono" rows={5} value={sql} onChange={(e) => setSql(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void exec(); } }} />
          {result && (
            <>
              <Flex justify="space-between" align="center" style={{ margin: "12px 0 8px" }}>
                <Typography.Text type="secondary">
                  {result.row_count} 行{result.truncated ? `（只显示前 ${result.rows.length} 行）` : ""}，{result.elapsed_ms} ms
                </Typography.Text>
                <Button size="small" icon={<CopyOutlined />} onClick={toCheck}>生成入库校验</Button>
              </Flex>
              <Table size="small" rowKey={(_, i) => String(i)} dataSource={result.rows} scroll={{ x: "max-content" }}
                pagination={{ pageSize: 10, size: "small", hideOnSinglePage: true }}
                columns={result.columns.map((c) => ({
                  title: c, dataIndex: c, ellipsis: true,
                  render: (v: unknown) => v === null || v === undefined ? <Typography.Text type="secondary">NULL</Typography.Text> : String(v),
                }))} />
            </>
          )}
        </>
      )}
      <Modal open={!!snippet} title="入库校验（粘贴到接口用例的 api 字段中）" onCancel={() => setSnippet(undefined)}
        okText="复制" onOk={() => { void navigator.clipboard.writeText(snippet!); message.success("已复制"); setSnippet(undefined); }}>
        <Typography.Paragraph type="secondary">
          也可让 agent 在 UI 探索时用 <Typography.Text code>browser.expect_db</Typography.Text> 录入同样的断言。expect 支持
          rows、min_rows、empty、value、row、contains；入库有延迟时可加 timeout_ms。时间类字段（*_at、*_time 等）每次执行都不同，已从断言中去掉。
        </Typography.Paragraph>
        <pre className="mono" style={{ whiteSpace: "pre-wrap", maxHeight: 360, overflow: "auto" }}>{snippet}</pre>
      </Modal>
    </Card>
  );
}
