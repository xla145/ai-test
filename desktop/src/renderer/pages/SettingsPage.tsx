import {
  ApiOutlined,
  CheckCircleFilled,
  CloseCircleFilled,
  DeleteOutlined,
  EditOutlined,
  FolderOpenOutlined,
  PlusOutlined,
  ReloadOutlined,
} from "@ant-design/icons";
import {
  Alert,
  Button,
  Card,
  Descriptions,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Radio,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import { useEffect, useMemo, useState } from "react";
import type { GlobalSettings, GlobalSettingsView, ModelCheckResult, ModelEntry, ModelPresetInfo, RuntimeCheck } from "../../shared/ipc";
import { api } from "../api";
import { PageHeader } from "../components/PageHeader";
import { useAction, useLoad } from "../hooks";

/** 全局设置保存后广播（detail 为 GlobalSettingsView）：主题、侧栏当前模型据此立即刷新 */
export const SETTINGS_EVENT = "aitest:settings";

const SOURCE: Record<string, string> = { env: "环境变量", settings: "全局设置", bundled: "内置", default: "默认" };

export function SettingsPage() {
  const view = useLoad(() => api().getGlobalSettings(), []);
  const presets = useLoad(() => api().modelPresets(), []);
  const { busy, run } = useAction();

  if (!view.data || !presets.data) return <Card loading />;
  const save = (settings: GlobalSettings, keys?: Record<string, string>, success = "已保存") =>
    run(async () => {
      const next = await api().saveGlobalSettings(settings, keys);
      view.setData(next);
      window.dispatchEvent(new CustomEvent<GlobalSettingsView>(SETTINGS_EVENT, { detail: next }));
      return next;
    }, success);

  const props = { view: view.data, presets: presets.data, save, busy };
  return (
    <>
      <PageHeader title="全局设置" description="对所有项目生效，不随项目保存。API key 存入系统钥匙串，只注入对应进程。" />
      <Tabs
        tabPosition="left"
        items={[
          { key: "models", label: "模型", children: <Models {...props} /> },
          { key: "runtime", label: "运行环境", children: <Runtime {...props} /> },
          { key: "appearance", label: "外观", children: <Appearance {...props} /> },
          { key: "about", label: "数据与关于", children: <About view={view.data} /> },
        ]}
      />
    </>
  );
}

interface SectionProps {
  view: GlobalSettingsView;
  presets: ModelPresetInfo[];
  save: (s: GlobalSettings, keys?: Record<string, string>, success?: string) => Promise<GlobalSettingsView | undefined>;
  busy: boolean;
}

// --------------------------------------------------------------------------- 模型

function Models({ view, presets, save, busy }: SectionProps) {
  const { settings, hasKey } = view;
  const [editing, setEditing] = useState<ModelEntry | "new">();
  const [checks, setChecks] = useState<Record<string, ModelCheckResult | "checking">>({});
  const presetOf = (id: string) => presets.find((p) => p.id === id);
  const visionCapable = settings.models.filter((m) => presetOf(m.preset)?.visionFamily);

  const test = async (id: string) => {
    setChecks((c) => ({ ...c, [id]: "checking" }));
    try {
      const r = await api().checkModel(id);
      setChecks((c) => ({ ...c, [id]: r }));
    } catch (e) {
      setChecks((c) => ({ ...c, [id]: { ok: false, latencyMs: 0, detail: (e as Error).message } }));
    }
  };

  const remove = (id: string) => save({ ...settings, models: settings.models.filter((m) => m.id !== id) }, undefined, "已删除");

  return (
    <>
      <Card size="small" title="使用中的模型" style={{ marginBottom: 16 }}>
        <Form layout="vertical">
          <Space size={24} wrap align="start">
            <Form.Item label="agent 模型" extra="用例设计、脚本补充、失败归因、自愈，建议强模型" style={{ marginBottom: 0, width: 320 }}>
              <Select value={settings.agentModelId} disabled={busy}
                onChange={(v) => save({ ...settings, agentModelId: v }, undefined, "已切换 agent 模型")}
                options={settings.models.map((m) => ({ value: m.id, label: m.name }))} />
            </Form.Item>
            <Form.Item label="视觉模型" extra="UI 探索与自愈时的元素定位（Midscene），可不启用" style={{ marginBottom: 0, width: 320 }}>
              <Select value={settings.visionModelId ?? ""} disabled={busy}
                onChange={(v) => save({ ...settings, visionModelId: v || undefined }, undefined, v ? "已切换视觉模型" : "已关闭视觉定位")}
                options={[{ value: "", label: "不启用" }, ...visionCapable.map((m) => ({ value: m.id, label: m.name }))]} />
            </Form.Item>
          </Space>
        </Form>
      </Card>

      <Card size="small" title="模型列表" extra={<Button type="primary" icon={<PlusOutlined />} onClick={() => setEditing("new")}>添加模型</Button>}>
        <Table
          size="small"
          rowKey="id"
          pagination={false}
          dataSource={settings.models}
          columns={[
            { title: "名称", dataIndex: "name", render: (n: string, m: ModelEntry) => (
              <Space size={4} wrap>
                {n}
                {m.id === settings.agentModelId && <Tag color="blue" bordered={false}>agent</Tag>}
                {m.id === settings.visionModelId && <Tag color="purple" bordered={false}>视觉</Tag>}
              </Space>
            ) },
            { title: "服务", dataIndex: "preset", width: 170, render: (p: string) => presetOf(p)?.name ?? p },
            { title: "模型", dataIndex: "model", render: (v: string, m: ModelEntry) => (
              <Typography.Text className="mono">{v || presetOf(m.preset)?.model || "（服务默认）"}</Typography.Text>
            ) },
            { title: "服务地址", dataIndex: "baseUrl", ellipsis: true, render: (v: string, m: ModelEntry) => (
              <Typography.Text type={v ? undefined : "secondary"} className="mono">{v || presetOf(m.preset)?.baseUrl}</Typography.Text>
            ) },
            { title: "API key", width: 90, render: (_: unknown, m: ModelEntry) =>
              hasKey[m.id] ? <Tag color="green" bordered={false}>已保存</Tag> : <Tag bordered={false}>未设置</Tag> },
            { title: "连通性", width: 200, render: (_: unknown, m: ModelEntry) => {
              const c = checks[m.id];
              if (!c) return <Button size="small" icon={<ApiOutlined />} onClick={() => test(m.id)}>测试</Button>;
              if (c === "checking") return <Button size="small" loading>测试中</Button>;
              return (
                <Tooltip title={c.detail}>
                  <Space size={4} style={{ cursor: "pointer" }} onClick={() => test(m.id)}>
                    {c.ok ? <CheckCircleFilled style={{ color: "#52c41a" }} /> : <CloseCircleFilled style={{ color: "#ff4d4f" }} />}
                    <Typography.Text ellipsis style={{ maxWidth: 150 }}>{c.ok ? `可用 · ${c.latencyMs} ms` : c.detail}</Typography.Text>
                  </Space>
                </Tooltip>
              );
            } },
            { title: "", width: 90, render: (_: unknown, m: ModelEntry) => {
              const inUse = m.id === settings.agentModelId || m.id === settings.visionModelId;
              return (
                <Space size={0}>
                  <Button size="small" type="text" icon={<EditOutlined />} onClick={() => setEditing(m)} />
                  <Popconfirm title={`删除「${m.name}」？`} description="同时删除钥匙串中的 API key" onConfirm={() => remove(m.id)} disabled={inUse}>
                    <Tooltip title={inUse ? "使用中的模型不能删除，请先切换" : undefined}>
                      <Button size="small" type="text" danger icon={<DeleteOutlined />} disabled={inUse || busy} />
                    </Tooltip>
                  </Popconfirm>
                </Space>
              );
            } },
          ]}
        />
        <Typography.Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0, fontSize: 12 }}>
          都通过 OpenAI 兼容接口接入。非 GPT 模型效果需要实测：先测试连通、确认合规，再在小范围用例上验证。修改后下一个 agent 任务按新配置启动。
        </Typography.Paragraph>
      </Card>

      <ModelModal
        open={!!editing}
        entry={editing === "new" ? undefined : editing}
        hasKey={editing && editing !== "new" ? hasKey[editing.id] : false}
        presets={presets}
        names={settings.models.filter((m) => editing === "new" || m.id !== editing?.id).map((m) => m.name)}
        busy={busy}
        onCancel={() => setEditing(undefined)}
        onSubmit={async (entry, key) => {
          const exists = settings.models.some((m) => m.id === entry.id);
          const models = exists ? settings.models.map((m) => (m.id === entry.id ? entry : m)) : [...settings.models, entry];
          const saved = await save({ ...settings, models }, key ? { [entry.id]: key } : undefined, exists ? "已保存" : "模型已添加");
          if (saved) {
            setEditing(undefined);
            setChecks(({ [entry.id]: _, ...rest }) => rest);
          }
        }}
      />
    </>
  );
}

interface ModelForm {
  name: string;
  preset: string;
  baseUrl?: string;
  model?: string;
  key?: string;
}

function ModelModal({ open, entry, hasKey, presets, names, busy, onCancel, onSubmit }: {
  open: boolean;
  entry?: ModelEntry;
  hasKey: boolean;
  presets: ModelPresetInfo[];
  names: string[];
  busy: boolean;
  onCancel: () => void;
  onSubmit: (entry: ModelEntry, key?: string) => Promise<void>;
}) {
  const [form] = Form.useForm<ModelForm>();
  const presetId = Form.useWatch("preset", form);
  const preset = useMemo(() => presets.find((p) => p.id === presetId), [presets, presetId]);

  useEffect(() => {
    if (!open) return;
    form.resetFields();
    form.setFieldsValue(entry ? { name: entry.name, preset: entry.preset, baseUrl: entry.baseUrl, model: entry.model }
      : { preset: presets[1]?.id ?? presets[0]?.id });
  }, [open, entry, form, presets]);

  const submit = async () => {
    // 校验不通过时表单已标出错误，不再向上抛
    const v = await form.validateFields().catch(() => undefined);
    if (!v) return;
    await onSubmit({
      id: entry?.id ?? `m_${Math.random().toString(36).slice(2, 10)}`,
      name: v.name.trim(),
      preset: v.preset,
      ...(v.baseUrl?.trim() ? { baseUrl: v.baseUrl.trim() } : {}),
      ...(v.model?.trim() ? { model: v.model.trim() } : {}),
    }, v.key || undefined);
  };

  const needsUrl = preset && !preset.baseUrl;
  const needsModel = preset && !preset.model && preset.id !== "openai";
  return (
    <Modal open={open} title={entry ? `编辑模型：${entry.name}` : "添加模型"} onCancel={onCancel} onOk={submit} okText="保存"
      confirmLoading={busy} destroyOnHidden width={560}>
      <Form form={form} layout="vertical" preserve={false}>
        <Form.Item name="preset" label="服务" rules={[{ required: true }]} extra={preset?.note}>
          <Select options={presets.map((p) => ({ value: p.id, label: p.name }))}
            onChange={(id) => {
              const p = presets.find((x) => x.id === id);
              if (!form.getFieldValue("name") && p) form.setFieldValue("name", p.model ? `${p.name.replace(/（.*）$/, "")} ${p.model}` : p.name.replace(/（.*）$/, ""));
            }} />
        </Form.Item>
        <Form.Item name="name" label="名称" rules={[
          { required: true, whitespace: true, message: "请输入名称" },
          { validator: (_, v: string) => (names.includes(v?.trim()) ? Promise.reject(new Error("名称已存在")) : Promise.resolve()) },
        ]}>
          <Input placeholder="如：百炼 qwen-max" />
        </Form.Item>
        <Form.Item name="baseUrl" label="服务地址" extra={needsUrl ? undefined : "留空使用服务默认地址"}
          rules={[
            { required: !!needsUrl, message: "请填写服务地址" },
            { pattern: /^https?:\/\//, message: "以 http:// 或 https:// 开头" },
          ]}>
          <Input className="mono" placeholder={preset?.baseUrl || "http://10.0.0.8:8000/v1"} />
        </Form.Item>
        <Form.Item name="model" label="模型名" extra={needsModel ? undefined : "留空使用服务默认模型"}
          rules={[{ required: !!needsModel, message: "请填写模型名" }]}>
          <Input className="mono" placeholder={preset?.model || (preset?.id === "ark" ? "推理接入点 ID" : "模型名")} />
        </Form.Item>
        <Form.Item name="key" label="API key" extra={hasKey ? "已保存在钥匙串，留空则不修改" : "存入系统钥匙串，不写入配置文件"}>
          <Input.Password placeholder={hasKey ? "••••••••" : "API key"} autoComplete="off" />
        </Form.Item>
      </Form>
    </Modal>
  );
}

// --------------------------------------------------------------------------- 运行环境

function Runtime({ view, save, busy }: SectionProps) {
  const { settings, runtime } = view;
  const [form] = Form.useForm<{ pythonPath?: string; codexPath?: string; taskTokenLimit?: number | null }>();
  const [check, setCheck] = useState<{ python: RuntimeCheck; codex: RuntimeCheck }>();
  const [checking, setChecking] = useState(false);
  useEffect(() => form.setFieldsValue({ ...settings.general }), [settings.general, form]);

  const runCheck = async () => {
    setChecking(true);
    try {
      setCheck(await api().checkRuntime());
    } finally {
      setChecking(false);
    }
  };
  useEffect(() => void runCheck(), [runtime.python.path, runtime.codex.path]);

  const pythonVersion = check?.python.ok ? /(\d+)\.(\d+)/.exec(check.python.detail) : null;
  const pythonTooOld = pythonVersion && (Number(pythonVersion[1]) < 3 || (Number(pythonVersion[1]) === 3 && Number(pythonVersion[2]) < 10));
  const status = (c?: RuntimeCheck, warn?: string) => !c ? null : (
    <Typography.Text type={c.ok && !warn ? "success" : "danger"} style={{ fontSize: 12 }}>
      {c.ok ? <CheckCircleFilled /> : <CloseCircleFilled />} {warn ?? c.detail}
    </Typography.Text>
  );
  const envNote = (key: string) => runtime.envOverrides.includes(key) &&
    <Tag color="orange" bordered={false}>已被环境变量 {key} 覆盖</Tag>;

  return (
    <Card size="small" extra={<Button size="small" icon={<ReloadOutlined />} loading={checking} onClick={runCheck}>重新检测</Button>}
      title="运行环境">
      <Form form={form} layout="vertical" style={{ maxWidth: 640 }} onFinish={(v) => save({
        ...settings,
        general: {
          ...settings.general,
          pythonPath: v.pythonPath?.trim() || undefined,
          codexPath: v.codexPath?.trim() || undefined,
          taskTokenLimit: v.taskTokenLimit || undefined,
        },
      })}>
        <Form.Item label={<Space>Python{envNote("AITEST_PYTHON")}</Space>} name="pythonPath"
          extra={<Space direction="vertical" size={0}>
            <span>执行引擎需要 Python 3.10+，依赖已随安装包附带。留空使用 python3。</span>
            <span>当前：<span className="mono">{runtime.python.path}</span>（{SOURCE[runtime.python.source]}） {status(check?.python, pythonTooOld ? `${check?.python.detail}，需要 3.10 及以上` : undefined)}</span>
          </Space>}>
          <Input className="mono" placeholder="python3" allowClear />
        </Form.Item>
        <Form.Item label={<Space>Codex{envNote("AITEST_CODEX_BIN")}</Space>} name="codexPath"
          extra={<Space direction="vertical" size={0}>
            <span>agent 引擎。留空使用安装包内置的版本，只在需要其他版本时填写。</span>
            <span>当前：<span className="mono">{runtime.codex.path}</span>（{SOURCE[runtime.codex.source]}） {status(check?.codex)}</span>
          </Space>}>
          <Input className="mono" placeholder="使用内置 Codex" allowClear />
        </Form.Item>
        <Form.Item label={<Space>agent 单次任务 token 上限{envNote("AITEST_TOKEN_LIMIT")}</Space>} name="taskTokenLimit"
          extra={`超过后中止该任务。项目可在「工程化 → 用量与预算」中设置更低的值。当前生效：${runtime.taskTokenLimit.value.toLocaleString()}（${SOURCE[runtime.taskTokenLimit.source]}）`}>
          <InputNumber min={1000} step={10000} style={{ width: 220 }} placeholder="200000" />
        </Form.Item>
        <Button type="primary" htmlType="submit" loading={busy}>保存</Button>
      </Form>
    </Card>
  );
}

// --------------------------------------------------------------------------- 外观

function Appearance({ view, save, busy }: SectionProps) {
  const { settings } = view;
  return (
    <Card size="small" title="外观">
      <Form layout="vertical">
        <Form.Item label="主题">
          <Radio.Group optionType="button" buttonStyle="solid" disabled={busy} value={settings.general.theme}
            onChange={(e) => save({ ...settings, general: { ...settings.general, theme: e.target.value } }, undefined, "主题已切换")}
            options={[{ value: "system", label: "跟随系统" }, { value: "light", label: "浅色" }, { value: "dark", label: "深色" }]} />
        </Form.Item>
      </Form>
    </Card>
  );
}

// --------------------------------------------------------------------------- 数据与关于

function About({ view }: { view: GlobalSettingsView }) {
  const { runtime } = view;
  const { run } = useAction();
  return (
    <Card size="small" title="数据与关于">
      <Descriptions size="small" column={1} bordered items={[
        { key: "v", label: "客户端版本", children: runtime.appVersion },
        { key: "d", label: "数据目录", children: (
          <Space wrap>
            <Typography.Text className="mono" copyable>{runtime.dataDir}</Typography.Text>
            <Button size="small" icon={<FolderOpenOutlined />} onClick={() => run(() => api().openDataDir())}>打开</Button>
          </Space>
        ) },
        { key: "db", label: "数据库", children: <Typography.Text className="mono" copyable>{runtime.dbPath}</Typography.Text> },
      ]} />
      <Alert style={{ marginTop: 16 }} type="info" showIcon
        message="数据目录中保存全局设置、本地数据库与加密后的凭据。用例、脚本与报告保存在各项目的 workspace 目录中，随 git 管理。" />
      {runtime.envOverrides.length > 0 && (
        <Alert style={{ marginTop: 12 }} type="warning" showIcon
          message={<>以下环境变量优先于全局设置：{runtime.envOverrides.map((k) => <Tag key={k} className="mono">{k}</Tag>)}</>} />
      )}
    </Card>
  );
}
