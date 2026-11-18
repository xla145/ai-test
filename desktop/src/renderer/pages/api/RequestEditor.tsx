import { BulbOutlined, ClearOutlined, CopyOutlined, DeleteOutlined, PlusOutlined, ThunderboltOutlined } from "@ant-design/icons";
import { App, Button, Checkbox, Input, InputNumber, Select, Space, Tabs, Tag, Tooltip, Typography } from "antd";
import { useEffect, useMemo, useState } from "react";
import type { ApiAssertion, ApiRequest } from "../../../shared/apiWorkspace";

const pretty = (v: unknown) => JSON.stringify(v, null, 2);
const valueText = (v: unknown) => typeof v === "string" ? v : JSON.stringify(v);
const parseValue = (v: string): unknown => { try { return JSON.parse(v); } catch { return v; } };

/* ── Schema → 示例数据生成 ─────────────────────────────── */
function sampleFromSchema(schema: Record<string, unknown> | null | undefined, depth = 0): unknown {
  if (!schema || depth > 6) return null;
  const type = schema.type as string | undefined;
  if (schema.example !== undefined) return schema.example;
  if (schema.default !== undefined) return schema.default;
  if (schema.enum && Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
  if (type === "object" || schema.properties) {
    const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
    const result: Record<string, unknown> = {};
    for (const [key, prop] of Object.entries(props)) result[key] = sampleFromSchema(prop, depth + 1);
    return result;
  }
  if (type === "array") {
    const items = schema.items as Record<string, unknown> | undefined;
    return items ? [sampleFromSchema(items, depth + 1)] : [];
  }
  if (type === "string") {
    if (schema.format === "date-time") return new Date().toISOString();
    if (schema.format === "date") return new Date().toISOString().slice(0, 10);
    if (schema.format === "email") return "user@example.com";
    if (schema.format === "uri" || schema.format === "url") return "https://example.com";
    if (schema.minLength && typeof schema.minLength === "number") return "a".repeat(schema.minLength as number);
    return "";
  }
  if (type === "integer" || type === "number") {
    if (typeof schema.minimum === "number") return schema.minimum;
    return type === "integer" ? 0 : 0.0;
  }
  if (type === "boolean") return false;
  return null;
}

/** 从 Schema 中提取字段类型提示 */
function schemaHints(schema?: Record<string, unknown> | null): Map<string, { type: string; required: boolean; desc?: string }> {
  const hints = new Map<string, { type: string; required: boolean; desc?: string }>();
  if (!schema) return hints;
  const required = new Set(Array.isArray(schema.required) ? schema.required as string[] : []);
  const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  for (const [key, prop] of Object.entries(props)) {
    const type = (prop.type as string) ?? (prop.enum ? "enum" : "any");
    hints.set(key, { type, required: required.has(key), desc: prop.description as string | undefined });
  }
  return hints;
}

export function JsonField({ value, onChange, label, object = false, onValidity, rows = 8, placeholder, extra }: {
  value: unknown; onChange: (value: any) => void; label: string; object?: boolean;
  onValidity?: (valid: boolean) => void; rows?: number; placeholder?: string;
  extra?: React.ReactNode;
}) {
  const [text, setText] = useState(pretty(value ?? (object ? {} : null)));
  const [error, setError] = useState("");
  const lineCount = useMemo(() => text.split("\n").length, [text]);
  return <div className="api-json-field">
    {extra && <div className="api-json-field-extra">{extra}</div>}
    <div className="api-json-field-wrap">
      <div className="api-json-line-numbers" aria-hidden>{Array.from({ length: lineCount }, (_, i) => <span key={i}>{i + 1}</span>)}</div>
      <Input.TextArea aria-label={label} value={text} rows={rows} spellCheck={false}
        placeholder={placeholder} className="api-code-input api-code-with-lines" status={error ? "error" : undefined} onChange={(e) => {
          setText(e.target.value);
          try {
            const next = JSON.parse(e.target.value);
            if (object && (!next || Array.isArray(next) || typeof next !== "object")) throw new Error("请填写 JSON 对象");
            onChange(next); setError(""); onValidity?.(true);
          } catch { setError(object ? "请输入有效的 JSON 对象" : "请输入有效的 JSON"); onValidity?.(false); }
        }} />
    </div>
    {error && <span className="api-field-error" role="alert">{error}</span>}
  </div>;
}

/** 从 JSON 响应中递归提取所有字段路径及其值，用于快速创建断言 */
export function flattenPaths(obj: unknown, prefix = ""): { path: string; value: unknown }[] {
  const result: { path: string; value: unknown }[] = [];
  if (obj && typeof obj === "object" && !Array.isArray(obj)) {
    for (const [key, val] of Object.entries(obj as Record<string, unknown>)) {
      const path = prefix ? `${prefix}.${key}` : key;
      result.push({ path, value: val });
      if (val && typeof val === "object") result.push(...flattenPaths(val, path));
    }
  } else if (Array.isArray(obj)) {
    obj.forEach((item, i) => {
      const path = `${prefix}.${i}`;
      result.push({ path, value: item });
      if (item && typeof item === "object") result.push(...flattenPaths(item, path));
    });
  }
  return result;
}

export function PairEditor({ value, onChange, name, path = false, onValidity, hints }: {
  value: Record<string, unknown>; onChange: (value: Record<string, any>) => void; name: string; path?: boolean;
  onValidity?: (valid: boolean) => void;
  hints?: Map<string, { type: string; required: boolean; desc?: string }>;
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
    {entries.map(([key, v], i) => {
      const hint = hints?.get(key);
      return <div className="api-pair-row" key={i}>
        <div className="api-pair-key">
          <Input aria-label={`${name}名称 ${i + 1}`} value={key} onChange={(e) => change(i, e.target.value, v)} />
          {hint && <span className="api-pair-hint">
            <Tag bordered={false} className="api-type-tag">{hint.type}</Tag>
            {hint.required && <Tag bordered={false} color="red" className="api-type-tag">必填</Tag>}
          </span>}
        </div>
        <Tooltip title={hint?.desc} open={hint?.desc ? undefined : false}>
          <Input aria-label={`${name}值 ${i + 1}`} value={valueText(v)} placeholder={hint?.desc}
            onChange={(e) => change(i, key, path ? e.target.value : parseValue(e.target.value))} />
        </Tooltip>
        <Button type="text" aria-label={`删除${name} ${i + 1}`} icon={<DeleteOutlined />} onClick={() => publish(entries.filter((_, n) => n !== i))} />
      </div>;
    })}
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

export function RequestEditor({ request, onChange, roles, onValidity, initialTab = "params", sourceSchema, bodySchema, paramSchema, lastResponse }: {
  request: ApiRequest; onChange: (value: ApiRequest) => void; roles: string[];
  onValidity: (key: string, valid: boolean) => void; initialTab?: string;
  sourceSchema?: Record<string, unknown> | null;
  /** OpenAPI body schema for sample fill */
  bodySchema?: Record<string, unknown> | null;
  /** OpenAPI params for type hints */
  paramSchema?: { name: string; location: string; required: boolean; schema: Record<string, unknown> }[];
  /** Last response body for quick assertion creation */
  lastResponse?: unknown;
}) {
  const { message } = App.useApp();
  const [statusText, setStatusText] = useState(request.expected_status.join(","));
  const set = <K extends keyof ApiRequest>(key: K, value: ApiRequest[K]) => onChange({ ...request, [key]: value });
  const updateAssertion = (index: number, patch: Partial<ApiAssertion>) => set("assertions", (request.assertions ?? []).map((a, i) => i === index ? { ...a, ...patch } : a));

  const bodyHints = useMemo(() => schemaHints(bodySchema), [bodySchema]);
  const pathHints = useMemo(() => {
    if (!paramSchema) return undefined;
    const map = new Map<string, { type: string; required: boolean; desc?: string }>();
    for (const p of paramSchema.filter((p) => p.location === "path"))
      map.set(p.name, { type: (p.schema.type as string) ?? "any", required: p.required, desc: p.schema.description as string });
    return map;
  }, [paramSchema]);
  const queryHints = useMemo(() => {
    if (!paramSchema) return undefined;
    const map = new Map<string, { type: string; required: boolean; desc?: string }>();
    for (const p of paramSchema.filter((p) => p.location === "query"))
      map.set(p.name, { type: (p.schema.type as string) ?? "any", required: p.required, desc: p.schema.description as string });
    return map;
  }, [paramSchema]);

  const fillBody = () => {
    const sample = sampleFromSchema(bodySchema);
    if (sample !== null) {
      set("body", sample);
      void message.success("已从 Schema 填充示例数据");
    } else {
      void message.warning("无法从当前 Schema 生成示例");
    }
  };

  const addAssertionFromResponse = (path: string, value: unknown) => {
    const operator: ApiAssertion["operator"] = value === null || value === undefined ? "exists"
      : typeof value === "string" && value.length > 50 ? "not_empty"
      : "eq";
    const assertion: ApiAssertion = { path, operator, ...(operator === "eq" ? { value } : {}) };
    set("assertions", [...(request.assertions ?? []), assertion]);
    void message.success(`已添加断言: ${path}`);
  };

  const responsePaths = useMemo(() => lastResponse ? flattenPaths(lastResponse).filter(({ value }) =>
    value === null || typeof value !== "object") : [], [lastResponse]);

  return <div className="api-request-editor">
    <div className="api-auth-line">
      <label>调用身份</label><Select aria-label="调用身份" value={request.auth === false ? "__none" : request.role || ""} style={{ minWidth: 160 }}
        options={[{ value: "", label: "环境默认鉴权" }, { value: "__none", label: "不携带鉴权" }, ...roles.map((r) => ({ value: r, label: r }))]}
        onChange={(value) => onChange({ ...request, auth: value !== "__none", role: value === "__none" ? "" : value })} />
      <span className="api-muted">超时</span>
      <Select aria-label="请求超时" value={request.timeout ?? 30} style={{ width: 132 }}
        options={[{ value: 5, label: "5 秒（快速）" }, { value: 15, label: "15 秒" }, { value: 30, label: "30 秒（默认）" }, { value: 60, label: "60 秒" }, { value: 120, label: "120 秒" }, { value: 300, label: "300 秒" }]}
        onChange={(v) => set("timeout", v)} />
    </div>
    <Tabs defaultActiveKey={initialTab} items={[
      { key: "params", label: <span>参数{Object.keys(request.path_params ?? {}).length + Object.keys(request.query ?? {}).length ? <span className="api-tab-badge">{Object.keys(request.path_params ?? {}).length + Object.keys(request.query ?? {}).length}</span> : null}</span>, children: <>
        <div className="api-editor-section"><h4>路径参数</h4><PairEditor name="路径参数" value={request.path_params ?? {}} onChange={(v) => set("path_params", v)} onValidity={(v) => onValidity("path_params", v)} hints={pathHints} /></div>
        <div className="api-editor-section"><h4>Query 参数</h4><PairEditor name="Query 参数" value={request.query ?? {}} onChange={(v) => set("query", v)} onValidity={(v) => onValidity("query", v)} hints={queryHints} /></div>
      </> },
      { key: "headers", label: <span>Headers{Object.keys(request.headers ?? {}).length ? <span className="api-tab-badge">{Object.keys(request.headers ?? {}).length}</span> : null}</span>, children: <><p className="api-muted">鉴权由所选身份注入；同名鉴权头以身份配置为准</p><PairEditor name="Header" value={request.headers ?? {}} onChange={(v) => set("headers", v)} onValidity={(v) => onValidity("headers", v)} /></> },
      { key: "body", label: <span>Body{request.body != null ? <span className="api-tab-badge">·</span> : null}</span>, children: <>
        <div className="api-body-toolbar">
          <Checkbox checked={Boolean(request.encrypt)} onChange={(e) => set("encrypt", e.target.checked)}>加密正文</Checkbox>
          <Space size={4}>
            {bodySchema && <Button size="small" type="text" icon={<BulbOutlined />} onClick={fillBody}>从 Schema 填充示例</Button>}
            {request.body != null && <Button size="small" type="text" icon={<ClearOutlined />} onClick={() => set("body", null)}>清空</Button>}
          </Space>
        </div>
        <JsonField label="JSON 请求体" value={request.body} onChange={(v) => set("body", v)} onValidity={(v) => onValidity("body", v)}
          placeholder={bodySchema ? "点击「从 Schema 填充示例」快速生成，或手动输入 JSON" : "输入 JSON 请求体；无需请求体时填写 null"}
          extra={bodyHints.size > 0 && <div className="api-body-hints">
            {[...bodyHints.entries()].slice(0, 8).map(([key, hint]) => <Tag key={key} bordered={false} className="api-body-hint-tag">
              <span>{key}</span><span className="api-muted">{hint.type}</span>{hint.required && <span className="api-required-dot" />}
            </Tag>)}
            {bodyHints.size > 8 && <span className="api-muted">+{bodyHints.size - 8} 个字段</span>}
          </div>}
        />
      </> },
      { key: "assertions", label: <span>断言{(request.assertions?.length ?? 0) + Object.keys(request.expected_fields ?? {}).length > 0 ? <span className="api-tab-badge">{(request.assertions?.length ?? 0) + Object.keys(request.expected_fields ?? {}).length}</span> : null}</span>, children: <>
        <div className="api-status-assert"><label>HTTP 状态码</label><Input aria-label="预期 HTTP 状态码" placeholder="200,201；留空不检查状态码" value={statusText} onChange={(e) => {
          setStatusText(e.target.value);
          const codes = e.target.value ? e.target.value.split(",").map(Number) : [];
          set("expected_status", codes); onValidity("status", codes.every((c) => Number.isInteger(c) && c >= 100 && c <= 599));
        }} /></div>
        <div className="api-assert-section-header"><h4>业务字段</h4><span className="api-muted">key=value 相等断言</span></div>
        <PairEditor name="相等断言" value={request.expected_fields ?? {}} onChange={(v) => set("expected_fields", v)} onValidity={(v) => onValidity("expected_fields", v)} />
        <div className="api-assert-section-header"><h4>字段断言</h4><span className="api-muted">支持多种运算符</span></div>
        {(request.assertions ?? []).map((a, i) => <div className="api-assert-row" key={i}>
          <Input aria-label={`断言字段 ${i + 1}`} placeholder="data.orderId" value={a.path} onChange={(e) => updateAssertion(i, { path: e.target.value })} />
          <Select aria-label={`断言运算符 ${i + 1}`} value={a.operator} options={operators} onChange={(operator) => updateAssertion(i, { operator })} />
          <Input aria-label={`断言预期 ${i + 1}`} placeholder="JSON 值或文本" disabled={["exists", "not_empty"].includes(a.operator)} value={valueText(a.value ?? "")} onChange={(e) => updateAssertion(i, { value: parseValue(e.target.value) })} />
          <Button type="text" aria-label={`删除字段断言 ${i + 1}`} icon={<DeleteOutlined />} onClick={() => set("assertions", request.assertions!.filter((_, n) => n !== i))} />
        </div>)}
        <Space size={8} wrap>
          <Button size="small" type="text" icon={<PlusOutlined />} onClick={() => set("assertions", [...(request.assertions ?? []), { path: "", operator: "not_empty" }])}>添加字段断言</Button>
          {responsePaths.length > 0 && <Tooltip title="从最近响应中选择字段添加断言">
            <Button size="small" type="text" icon={<ThunderboltOutlined />} onClick={() => {
              /* 取前 5 个非空叶子字段添加 not_empty 断言 */
              const newAssertions = responsePaths.filter(({ value }) => value != null && value !== "")
                .slice(0, 5).filter(({ path }) => !(request.assertions ?? []).some((a) => a.path === path))
                .map(({ path }) => ({ path, operator: "not_empty" as const }));
              if (newAssertions.length) { set("assertions", [...(request.assertions ?? []), ...newAssertions]); void message.success(`已从响应添加 ${newAssertions.length} 条断言`); }
              else void message.info("响应中没有更多可添加的字段");
            }}>从响应快速添加</Button>
          </Tooltip>}
        </Space>
        <div className="api-schema-check"><Checkbox checked={Boolean(request.response_schema)} disabled={!request.response_schema} onChange={(e) => { if (!e.target.checked) set("response_schema", null); }}>校验导入的响应结构</Checkbox>
          {!request.response_schema && sourceSchema && <Button size="small" type="link" onClick={() => set("response_schema", sourceSchema)}>恢复来源响应结构</Button>}</div>
        {!request.expected_status.length && !request.assertions?.length && !Object.keys(request.expected_fields ?? {}).length && !request.response_schema && <div className="api-assert-empty"><Typography.Text type="warning">⚠ 尚未配置断言，可调试但不能审核为回归用例</Typography.Text><Typography.Text type="secondary" className="api-muted">发送请求后，可在响应区域点击字段快速添加断言</Typography.Text></div>}
      </> },
      { key: "extract", label: <span>提取变量{Object.keys(request.extract ?? {}).length ? <span className="api-tab-badge">{Object.keys(request.extract ?? {}).length}</span> : null}</span>, children: <><p className="api-muted">使用点号路径，如 data.orderId、data.items.0.id；后续步骤以 ${"{orderId}"} 引用</p><PairEditor name="提取变量" path value={request.extract ?? {}} onChange={(v) => set("extract", v)} onValidity={(v) => onValidity("extract", v)} /></> },
      { key: "database", label: "数据库", children: <><p className="api-muted">使用项目已有的数据库连接，连接凭据从受控配置读取</p><h4>请求前准备</h4><JsonField label="数据库准备配置" value={request.db_setup ?? []} onChange={(v) => set("db_setup", v)} onValidity={(v) => onValidity("dbSetup", v)} rows={4} /><h4>请求后校验</h4><JsonField label="数据库校验配置" value={request.db_checks ?? []} onChange={(v) => set("db_checks", v)} onValidity={(v) => onValidity("dbChecks", v)} rows={4} /></> },
    ]} />
  </div>;
}
