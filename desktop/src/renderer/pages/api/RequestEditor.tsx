import { DeleteOutlined, PlusOutlined } from "@ant-design/icons";
import { Button, Checkbox, Input, InputNumber, Select, Tabs, Typography } from "antd";
import { useEffect, useState } from "react";
import type { ApiAssertion, ApiRequest } from "../../../shared/apiWorkspace";

const pretty = (v: unknown) => JSON.stringify(v, null, 2);
const valueText = (v: unknown) => typeof v === "string" ? v : JSON.stringify(v);
const parseValue = (v: string): unknown => { try { return JSON.parse(v); } catch { return v; } };

export function JsonField({ value, onChange, label, object = false, onValidity, rows = 8 }: {
  value: unknown; onChange: (value: any) => void; label: string; object?: boolean;
  onValidity?: (valid: boolean) => void; rows?: number;
}) {
  const [text, setText] = useState(pretty(value ?? (object ? {} : null)));
  const [error, setError] = useState("");
  return <div className="api-json-field"><Input.TextArea aria-label={label} value={text} rows={rows} spellCheck={false}
    className="api-code-input" status={error ? "error" : undefined} onChange={(e) => {
      setText(e.target.value);
      try {
        const next = JSON.parse(e.target.value);
        if (object && (!next || Array.isArray(next) || typeof next !== "object")) throw new Error("请填写 JSON 对象");
        onChange(next); setError(""); onValidity?.(true);
      } catch { setError(object ? "请输入有效的 JSON 对象" : "请输入有效的 JSON"); onValidity?.(false); }
    }} />{error && <span className="api-field-error" role="alert">{error}</span>}</div>;
}

export function PairEditor({ value, onChange, name, path = false, onValidity }: {
  value: Record<string, unknown>; onChange: (value: Record<string, any>) => void; name: string; path?: boolean;
  onValidity?: (valid: boolean) => void;
}) {
  const [entries, setEntries] = useState(Object.entries(value));
  const [error, setError] = useState("");
  useEffect(() => { setEntries(Object.entries(value)); }, [value]);
  const publish = (next: [string, unknown][]) => {
    setEntries(next);
    const keys = next.map(([key]) => key);
    const valid = keys.every((key) => key.trim().length > 0) && new Set(keys).size === keys.length;
    setError(valid ? "" : "参数名不能为空或重复"); onValidity?.(valid);
    if (valid) onChange(Object.fromEntries(next));
  };
  const change = (index: number, key: string, v: unknown) => {
    publish(entries.map((entry, i) => i === index ? [key, v] : entry));
  };
  return <div className="api-pairs">
    <div className="api-pairs-head"><span>{path ? "变量名" : "参数名"}</span><span>{path ? "响应字段路径" : "值 · 支持 ${变量}"}</span><span /></div>
    {entries.map(([key, v], i) => <div className="api-pair-row" key={i}>
      <Input aria-label={`${name}名称 ${i + 1}`} value={key} onChange={(e) => change(i, e.target.value, v)} />
      <Input aria-label={`${name}值 ${i + 1}`} value={valueText(v)} onChange={(e) => change(i, key, path ? e.target.value : parseValue(e.target.value))} />
      <Button type="text" aria-label={`删除${name} ${i + 1}`} icon={<DeleteOutlined />} onClick={() => publish(entries.filter((_, n) => n !== i))} />
    </div>)}
    {error && <span className="api-field-error" role="alert">{error}</span>}
    {!entries.length && <p className="api-muted api-empty-row">暂无{name}</p>}
    <Button type="text" size="small" icon={<PlusOutlined />} onClick={() => {
      let key = path ? "variable" : "param"; let i = 1;
      while (entries.some(([name]) => name === key)) key = `${path ? "variable" : "param"}${i++}`;
      publish([...entries, [key, ""]]);
    }}>添加{name}</Button>
  </div>;
}

const operators: { value: ApiAssertion["operator"]; label: string }[] = [
  { value: "eq", label: "等于" }, { value: "ne", label: "不等于" }, { value: "exists", label: "存在" },
  { value: "not_empty", label: "非空" }, { value: "contains", label: "包含" }, { value: "gt", label: "大于" },
  { value: "gte", label: "大于等于" }, { value: "lt", label: "小于" }, { value: "lte", label: "小于等于" },
];

export function RequestEditor({ request, onChange, roles, onValidity, initialTab = "params", sourceSchema }: {
  request: ApiRequest; onChange: (value: ApiRequest) => void; roles: string[];
  onValidity: (key: string, valid: boolean) => void; initialTab?: string;
  sourceSchema?: Record<string, unknown> | null;
}) {
  const [statusText, setStatusText] = useState(request.expected_status.join(","));
  const set = <K extends keyof ApiRequest>(key: K, value: ApiRequest[K]) => onChange({ ...request, [key]: value });
  const updateAssertion = (index: number, patch: Partial<ApiAssertion>) => set("assertions", (request.assertions ?? []).map((a, i) => i === index ? { ...a, ...patch } : a));
  return <div className="api-request-editor">
    <div className="api-auth-line">
      <label>调用身份</label><Select aria-label="调用身份" value={request.auth === false ? "__none" : request.role || ""} style={{ minWidth: 160 }}
        options={[{ value: "", label: "环境默认鉴权" }, { value: "__none", label: "不携带鉴权" }, ...roles.map((r) => ({ value: r, label: r }))]}
        onChange={(value) => onChange({ ...request, auth: value !== "__none", role: value === "__none" ? "" : value })} />
      <span className="api-muted">超时</span><InputNumber aria-label="请求超时秒数" min={1} max={300} value={request.timeout ?? 30} onChange={(v) => set("timeout", v ?? 30)} addonAfter="秒" style={{ width: 124 }} />
    </div>
    <Tabs defaultActiveKey={initialTab} items={[
      { key: "params", label: "参数", children: <>
        <div className="api-editor-section"><h4>路径参数</h4><PairEditor name="路径参数" value={request.path_params ?? {}} onChange={(v) => set("path_params", v)} onValidity={(v) => onValidity("path_params", v)} /></div>
        <div className="api-editor-section"><h4>Query 参数</h4><PairEditor name="Query 参数" value={request.query ?? {}} onChange={(v) => set("query", v)} onValidity={(v) => onValidity("query", v)} /></div>
      </> },
      { key: "headers", label: "Headers", children: <><p className="api-muted">鉴权由所选身份注入；同名鉴权头以身份配置为准</p><PairEditor name="Header" value={request.headers ?? {}} onChange={(v) => set("headers", v)} onValidity={(v) => onValidity("headers", v)} /></> },
      { key: "body", label: "Body", children: <><Checkbox checked={Boolean(request.encrypt)} onChange={(e) => set("encrypt", e.target.checked)}>加密正文（需配置环境的 RuoYi AES/RSA 协议）</Checkbox><div className="api-editor-caption">JSON 请求体 <span className="api-muted">无需请求体时填写 null</span></div><JsonField label="JSON 请求体" value={request.body} onChange={(v) => set("body", v)} onValidity={(v) => onValidity("body", v)} /></> },
      { key: "assertions", label: `断言${(request.assertions?.length ?? 0) ? ` · ${request.assertions!.length}` : ""}`, children: <>
        <div className="api-status-assert"><label>HTTP 状态码</label><Input aria-label="预期 HTTP 状态码" placeholder="200,201；留空不检查状态码" value={statusText} onChange={(e) => {
          setStatusText(e.target.value);
          const codes = e.target.value ? e.target.value.split(",").map(Number) : [];
          set("expected_status", codes); onValidity("status", codes.every((c) => Number.isInteger(c) && c >= 100 && c <= 599));
        }} /></div>
        <h4>业务字段</h4><PairEditor name="相等断言" value={request.expected_fields ?? {}} onChange={(v) => set("expected_fields", v)} onValidity={(v) => onValidity("expected_fields", v)} />
        {(request.assertions ?? []).map((a, i) => <div className="api-assert-row" key={i}>
          <Input aria-label={`断言字段 ${i + 1}`} placeholder="data.orderId" value={a.path} onChange={(e) => updateAssertion(i, { path: e.target.value })} />
          <Select aria-label={`断言运算符 ${i + 1}`} value={a.operator} options={operators} onChange={(operator) => updateAssertion(i, { operator })} />
          <Input aria-label={`断言预期 ${i + 1}`} placeholder="JSON 值或文本" disabled={["exists", "not_empty"].includes(a.operator)} value={valueText(a.value ?? "")} onChange={(e) => updateAssertion(i, { value: parseValue(e.target.value) })} />
          <Button type="text" aria-label={`删除字段断言 ${i + 1}`} icon={<DeleteOutlined />} onClick={() => set("assertions", request.assertions!.filter((_, n) => n !== i))} />
        </div>)}
        <Button size="small" type="text" icon={<PlusOutlined />} onClick={() => set("assertions", [...(request.assertions ?? []), { path: "", operator: "not_empty" }])}>添加字段断言</Button>
        <div className="api-schema-check"><Checkbox checked={Boolean(request.response_schema)} disabled={!request.response_schema} onChange={(e) => { if (!e.target.checked) set("response_schema", null); }}>校验导入的响应结构</Checkbox>
          {!request.response_schema && sourceSchema && <Button size="small" type="link" onClick={() => set("response_schema", sourceSchema)}>恢复来源响应结构</Button>}</div>
        {!request.expected_status.length && !request.assertions?.length && !Object.keys(request.expected_fields ?? {}).length && !request.response_schema && <Typography.Text type="warning">尚未配置断言，可调试但不能审核为回归用例</Typography.Text>}
      </> },
      { key: "extract", label: "提取变量", children: <><p className="api-muted">使用点号路径，如 data.orderId、data.items.0.id；后续步骤以 ${"{orderId}"} 引用</p><PairEditor name="提取变量" path value={request.extract ?? {}} onChange={(v) => set("extract", v)} onValidity={(v) => onValidity("extract", v)} /></> },
      { key: "database", label: "数据库", children: <><p className="api-muted">使用项目已有的数据库连接，连接凭据从受控配置读取</p><h4>请求前准备</h4><JsonField label="数据库准备配置" value={request.db_setup ?? []} onChange={(v) => set("db_setup", v)} onValidity={(v) => onValidity("dbSetup", v)} rows={4} /><h4>请求后校验</h4><JsonField label="数据库校验配置" value={request.db_checks ?? []} onChange={(v) => set("db_checks", v)} onValidity={(v) => onValidity("dbChecks", v)} rows={4} /></> },
    ]} />
  </div>;
}
