import { Collapse, Empty, Table, Tabs, Tag } from "antd";
import type { ApiDebugResult, ApiStepTrace } from "../../../shared/apiWorkspace";
import { ResponseBody } from "./ResponseBody";

const statusText: Record<string, string> = { passed: "通过", failed: "失败", error: "执行错误", blocked: "阻塞", running: "执行中" };
const json = (value: unknown) => JSON.stringify(value, null, 2);
const code = (value: unknown) => <pre className="api-response-code">{json(value)}</pre>;

export function StepResult({ step }: { step: ApiStepTrace }) {
  return <div className="api-step-result">
    {step.error && <div className="api-result-error" role="alert">{step.error}</div>}
    <Tabs size="small" items={[
      { key: "response", label: "响应", children: step.response ? <ResponseBody response={step.response} /> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={step.status === "blocked" ? "前置步骤失败，未发送请求" : "没有收到响应"} /> },
      { key: "assertions", label: `断言 · ${step.assertions?.length ?? 0}`, children: <Table size="small" pagination={false} rowKey={(_, i) => String(i)} dataSource={step.assertions ?? []} columns={[
        { title: "检查项", dataIndex: "name" }, { title: "预期", dataIndex: "expected", render: json },
        { title: "实际", dataIndex: "actual", render: json }, { title: "结果", dataIndex: "passed", render: (v) => <span className={v ? "api-pass" : "api-fail"}>{v ? "通过" : "失败"}</span> },
      ]} /> },
      { key: "request", label: "实际请求", children: code(step.request ?? {}) },
      { key: "headers", label: "响应头", children: code(step.response?.headers ?? {}) },
      { key: "variables", label: "提取变量", children: code(step.variables ?? {}) },
    ]} />
  </div>;
}

export function ExecutionResult({ result }: { result?: ApiDebugResult }) {
  if (!result) return <div className="api-response-empty"><span className="api-response-bracket">{`{ }`}</span><h4>等待响应</h4><p>发送请求后，查看响应内容、断言和提取变量</p></div>;
  const all = [...result.steps, ...result.cleanup.map((s) => ({ ...s, name: `清理 · ${s.name}` }))];
  return <section className="api-execution-result" aria-label="执行结果">
    <div className="api-result-bar"><span className={result.status === "passed" ? "api-pass" : "api-fail"}>{statusText[result.status]}</span><span className="api-muted">{result.env}</span><span className="api-mono">{all.reduce((sum, s) => sum + (s.duration_ms ?? 0), 0)} ms</span><span className="api-muted">{new Date(result.created_at).toLocaleString()}</span></div>
    {all.length === 1 ? <StepResult step={all[0]} /> : <Collapse defaultActiveKey={[String(Math.max(0, all.findIndex((s) => ["failed", "error"].includes(s.status))))]} items={all.map((s, i) => ({
      key: String(i), label: <span className="api-trace-label"><span className="api-step-number">{i + 1}</span>{s.name}<Tag bordered={false} color={s.status === "passed" ? "success" : s.status === "blocked" ? "default" : "error"}>{statusText[s.status]}</Tag><span className="api-muted api-mono">{s.duration_ms ?? 0} ms</span></span>, children: <StepResult step={s} />,
    }))} />}
  </section>;
}
