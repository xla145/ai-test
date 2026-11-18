import { DeleteOutlined, PlusOutlined } from "@ant-design/icons";
import { Alert, App, Button, Form, Input, Modal, Space, Timeline, Typography } from "antd";
import { useRef, useState } from "react";
import { api, type TestCase } from "../api";
import { useLoad } from "../hooks";

type CaseContent = Pick<TestCase, "title" | "owner" | "preconditions" | "steps" | "expected" | "data_refs">;

/** Each textarea is one original item; embedded newlines do not change its identity. */
export function CaseEditor({ value, onClose, onSaved }: {
  value: TestCase; onClose: () => void; onSaved: (value: TestCase) => void;
}) {
  const [form] = Form.useForm<CaseContent>();
  const { modal } = App.useApp();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const pending = useRef(false);
  const history = useLoad(() => api().caseHistory(value.id), [value.id]);
  const close = () => {
    if (pending.current) return;
    if (!form.isFieldsTouched()) { onClose(); return; }
    modal.confirm({ title: "放弃未保存的修改？", okText: "放弃修改", cancelText: "继续编辑", onOk: onClose });
  };
  const save = async () => {
    if (pending.current) return;
    let fields: CaseContent;
    try { fields = await form.validateFields(); } catch { return; }
    pending.current = true; setSaving(true); setError(undefined);
    try {
      const patch = Object.fromEntries(Object.entries(fields).filter(([key, val]) => JSON.stringify(val) !== JSON.stringify(value[key as keyof CaseContent] ?? [])));
      const updated = Object.keys(patch).length ? await api().updateCase(value.id, patch, "human") as TestCase : value;
      onSaved(updated);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { pending.current = false; setSaving(false); }
  };
  return <Modal open title="编辑测试用例" width={720} onCancel={close} onOk={save} okText="保存用例" cancelText="取消"
    confirmLoading={saving} cancelButtonProps={{ disabled: saving }} closable={!saving} maskClosable={false}>
    <Alert type="info" showIcon message="修改原始用例，不调用 AI。保存后重新检查规范；执行内容变化后，原脚本需重新校验。" style={{ marginBottom: 16 }} />
    {history.data?.length ? <details style={{ marginBottom: 16 }}><summary>变更审计（最近 {history.data.length} 条）</summary><Timeline items={history.data.slice(0, 10).map((event: any, i: number) => ({ key: i, children: <Typography.Text type="secondary">{event.ts} · {event.actor} · {event.data?.comment || event.kind} · {(event.data?.fields || []).join("、")}</Typography.Text> }))} /></details> : null}
    {error && <Alert type="error" showIcon message="保存失败，修改内容已保留" description={error} style={{ marginBottom: 16 }} />}
    <Form form={form} layout="vertical" disabled={saving} initialValues={{ title: value.title, owner: value.owner ?? "", preconditions: value.preconditions, steps: value.steps, expected: value.expected, data_refs: value.data_refs ?? [] }}>
      <Form.Item name="title" label="用例标题" rules={[{ required: true, whitespace: true, message: "请输入用例标题" }]}><Input /></Form.Item>
      <Form.Item name="owner" label="责任人"><Input placeholder="填写责任人或团队" /></Form.Item>
      {([
        ["preconditions", "前置条件", false], ["steps", "操作步骤", true], ["expected", "预期结果", true], ["data_refs", "数据引用", false],
      ] as const).map(([name, label, required]) => <Form.List key={name} name={name} rules={required ? [{ validator: async (_, items) => { if (!items?.length) throw new Error(`请至少填写一条${label}`); } }] : []}>
        {(fields, { add, remove }, { errors }) => <div className="case-editor-section">
          <div className="case-editor-label">{label}</div>
          {fields.map(field => <div key={field.key} className="case-editor-row">
            <Form.Item {...field} rules={[{ required: true, whitespace: true, message: `请填写${label}或删除空项` }]}>
              <Input.TextArea aria-label={`${label} ${field.name + 1}`} autoSize={{ minRows: 2, maxRows: 8 }} />
            </Form.Item>
            <Button type="text" icon={<DeleteOutlined />} aria-label={`删除${label} ${field.name + 1}`} onClick={() => remove(field.name)} />
          </div>)}
          <Space><Button size="small" type="dashed" icon={<PlusOutlined />} onClick={() => add("")}>添加{label}</Button></Space>
          <Form.ErrorList errors={errors} />
        </div>}
      </Form.List>)}
    </Form>
  </Modal>;
}
