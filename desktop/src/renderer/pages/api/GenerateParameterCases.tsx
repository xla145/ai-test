import { Alert, App, Button, Checkbox, Col, Form, Input, InputNumber, Modal, Row, Select, Space, Table, Tag, Typography } from "antd";
import { useState } from "react";
import type { ApiCaseDraft, ApiCaseGenerationOptions, ApiCaseGenerationPreview, ApiDebugResult } from "../../../shared/apiWorkspace";
import { api } from "../../api";
import { useKeyedAction } from "../../hooks";

type Fields = Omit<ApiCaseGenerationOptions, "success_code" | "error_code"> & { success_code: string; error_code: string };
const scalar = (value: string) => {
  const parsed: unknown = JSON.parse(value);
  if (parsed !== null && !["string", "number", "boolean"].includes(typeof parsed)) throw new Error("请填写 JSON 标量，例如 200 或 \"OK\"");
  return parsed;
};
const scalarRule = { validator: (_: unknown, value: string) => {
  try { scalar(value); return Promise.resolve(); } catch { return Promise.reject(new Error("请填写 JSON 值，例如 200 或 \"OK\"")); }
} };

export function GenerateParameterCases({ projectId, draft, result, onClose, onSaved }: {
  projectId: string; draft: ApiCaseDraft; result?: ApiDebugResult; onClose: () => void; onSaved: () => Promise<void>;
}) {
  const { message } = App.useApp();
  const [form] = Form.useForm<Fields>();
  const { busy, activeKey, run } = useKeyedAction();
  const [preview, setPreview] = useState<{ data: ApiCaseGenerationPreview; options: ApiCaseGenerationOptions }>();
  const [selected, setSelected] = useState<string[]>([]);
  const mode = Form.useWatch("response_mode", form);
  const negative = Form.useWatch("include_negative", form);
  const body = result?.steps[0]?.response?.body;
  const observed = body && typeof body === "object" && "code" in body ? body.code : draft.steps[0]?.expected_fields?.code;
  const hasBusinessCode = observed !== undefined && (observed === null || ["string", "number", "boolean"].includes(typeof observed));
  const configuredSuccess = draft.steps[0]?.expected_fields?.code;
  const successCode = configuredSuccess !== undefined ? JSON.stringify(configuredSuccess) : observed === 0 || observed === 200 ? JSON.stringify(observed) : "";
  const generate = () => run("preview", async () => {
    const values = await form.validateFields();
    const options: ApiCaseGenerationOptions = { max_cases: values.max_cases, seed: values.seed, include_negative: values.include_negative, response_mode: values.response_mode,
      ...(values.response_mode === "business" ? { code_path: values.code_path, success_code: scalar(values.success_code), ...(values.include_negative ? { error_code: scalar(values.error_code) } : {}) } : {}) };
    const data = await api().previewApiParameterCases(projectId, draft, options);
    setPreview({ data, options });
    setSelected(data.candidates.filter((c) => !c.existing).map((c) => c.key));
  });
  return <Modal title="根据参数生成测试用例" open width={980} onCancel={() => { if (!busy) onClose(); }} maskClosable={!busy} keyboard={!busy}
    footer={<Space><Button disabled={busy} onClick={onClose}>取消</Button><Button type="primary" disabled={busy || !preview || !selected.length} loading={activeKey === "save"} onClick={() => run("save", async () => {
      const out = await api().saveApiParameterCases(projectId, draft, preview!.options, selected);
      await onSaved();
      message.success(`新增 ${out.generated} 条草稿，跳过 ${out.skipped} 条已有用例`);
      onClose();
    })}>保存选中的 {selected.length} 条草稿</Button></Space>}>
    <Typography.Paragraph type="secondary">以当前请求参数为基础，覆盖必填缺失、空值、类型、枚举、边界和 Schema 样本。保留真实 ID、环境鉴权及角色选择；生成不发送请求、不调用模型。</Typography.Paragraph>
    <Form form={form} layout="vertical" disabled={busy} initialValues={{ max_cases: 30, seed: 20261113, include_negative: true, response_mode: hasBusinessCode ? "business" : "http", code_path: "code", success_code: successCode, error_code: "" }}
      onValuesChange={() => { setPreview(undefined); setSelected([]); }}>
      <Row gutter={16}>
        <Col span={8}><Form.Item name="max_cases" label="最多生成" rules={[{ required: true }]}><InputNumber min={1} max={100} precision={0} addonAfter="条" style={{ width: "100%" }} /></Form.Item></Col>
        <Col span={8}><Form.Item name="seed" label="随机种子" rules={[{ required: true }]}><InputNumber min={0} max={4294967295} precision={0} style={{ width: "100%" }} /></Form.Item></Col>
        <Col span={8}><Form.Item name="response_mode" label="响应断言方式"><Select options={[{ value: "http", label: "HTTP 状态码" }, { value: "business", label: "HTTP 状态码 + 业务码" }]} /></Form.Item></Col>
      </Row>
      <Form.Item name="include_negative" valuePropName="checked"><Checkbox>同时生成非法参数用例</Checkbox></Form.Item>
      {mode === "business" ? <Row gutter={16}>
        <Col span={8}><Form.Item name="code_path" label="业务码字段路径" rules={[{ required: true }, { pattern: /^[\w-]+(?:\.[\w-]+)*$/, message: "例如 code 或 data.code" }]}><Input placeholder="code" /></Form.Item></Col>
        <Col span={8}><Form.Item name="success_code" label="成功业务码（JSON 值）" rules={[{ required: true }, scalarRule]}><Input placeholder="例如 200" /></Form.Item></Col>
        {negative && <Col span={8}><Form.Item name="error_code" label="参数错误业务码（JSON 值）" rules={[{ required: true, message: "请按系统定义填写，不会自动猜测" }, scalarRule]}><Input placeholder="按系统定义填写" /></Form.Item></Col>}
      </Row> : <Alert style={{ marginBottom: 16 }} type="warning" showIcon message="如果系统用 HTTP 200 包装业务错误，请选择业务码模式，避免误判" />}
      <Button loading={activeKey === "preview"} disabled={busy} onClick={generate}>生成预览</Button>
    </Form>
    {preview && <div style={{ marginTop: 20 }}>
      <Space wrap style={{ marginBottom: 12 }}><Tag>{preview.data.engine}</Tag><Typography.Text type="secondary">共 {preview.data.candidates.length} 条 · 已有 {preview.data.candidates.filter((c) => c.existing).length} 条 · 种子 {preview.data.seed}</Typography.Text></Space>
      <Table size="small" rowKey="key" dataSource={preview.data.candidates} pagination={{ pageSize: 8, hideOnSinglePage: true }}
        rowSelection={{ selectedRowKeys: selected, onChange: (keys) => setSelected(keys as string[]), getCheckboxProps: (c) => ({ disabled: c.existing || busy }) }}
        columns={[{ title: "场景", dataIndex: "scenario" }, { title: "类型", dataIndex: "polarity", width: 80, render: (value) => <Tag color={value === "positive" ? "green" : "orange"}>{value === "positive" ? "正向" : "反向"}</Tag> },
          { title: "状态", dataIndex: "existing", width: 80, render: (exists) => exists ? "已存在" : "待保存" }]}
        expandable={{ expandedRowRender: (candidate) => <><Typography.Text strong>{candidate.title}</Typography.Text><pre className="api-response-code">{JSON.stringify(candidate.request, null, 2)}</pre></> }} />
      {preview.data.notices.map((notice) => <Typography.Paragraph key={notice} type="secondary" style={{ marginBottom: 4 }}>{notice}</Typography.Paragraph>)}
    </div>}
  </Modal>;
}
