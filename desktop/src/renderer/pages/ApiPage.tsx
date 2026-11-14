import { ApiOutlined, ArrowDownOutlined, ArrowRightOutlined, ArrowUpOutlined, CheckOutlined, DeleteOutlined, FileTextOutlined, HistoryOutlined, FolderOutlined, PlusOutlined, ReloadOutlined, SaveOutlined, SearchOutlined, UploadOutlined } from "@ant-design/icons";
import { Alert, App, Button, Collapse, Drawer, Empty, Input, Modal, Select, Space, Spin, Table, Tabs, Tag, Tree, Typography } from "antd";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type Project, type TestCase } from "../api";
import type { ApiCaseDraft, ApiDebugResult, ApiDefinition, ApiImportPreview, ApiRequest } from "../../shared/apiWorkspace";
import { ApiLoginCard } from "../components/ApiLogin";
import { ApiLoginWorkspace } from "../components/ApiLoginWorkspace";
import { PageHeader } from "../components/PageHeader";
import { EnvSelect, RunButton, useEnvChoice } from "../components/EnvPicker";
import { useProjects } from "../components/ProjectSettings";
import { notifyProjectChanged, useKeyedAction, useProjectChanged } from "../hooks";
import { RunPage } from "./RunPage";
import { JsonField, RequestEditor } from "./api/RequestEditor";
import { ExecutionResult } from "./api/ExecutionResult";
import { GenerateParameterCases } from "./api/GenerateParameterCases";

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
const blank = (): ApiRequest => ({ method: "GET", path: "/", expected_status: [200], auth: true, path_params: {}, query: {}, headers: {}, body: null, extract: {}, expected_fields: {}, assertions: [] });
const newDraft = (kind: "single" | "flow"): ApiCaseDraft => ({ title: "", kind, steps: kind === "single" ? [blank()] : [], cleanup: [], inputs: {} });
const changeLabels = { added: "新增", updated: "更新", unchanged: "未变化", removed: "来源已移除" };

export function Method({ method }: { method: string }) { return <span className={`api-method api-method-${method.toLowerCase()}`}>{method}</span>; }

export function ApiPage({ project }: { project: Project }) { return <ApiWorkspace key={project.id} project={project} />; }

function ApiWorkspace({ project }: { project: Project }) {
  const { modal, message } = App.useApp();
  const { goTab, openSettings } = useProjects();
  const { busy, activeKey, run } = useKeyedAction();
  const [tab, setTab] = useState("definitions");
  const [definitions, setDefinitions] = useState<ApiDefinition[]>([]);
  const [cases, setCases] = useState<TestCase[]>([]);
  const [roles, setRoles] = useState<string[]>([]);
  const [history, setHistory] = useState<ApiDebugResult[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [search, setSearch] = useState("");
  const [collapsedModules, setCollapsedModules] = useState<string[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [single, setSingle] = useState<ApiCaseDraft>(newDraft("single"));
  const [flow, setFlow] = useState<ApiCaseDraft>(newDraft("flow"));
  const [singleDirty, setSingleDirty] = useState(false);
  const [flowDirty, setFlowDirty] = useState(false);
  const [editorKey, setEditorKey] = useState(0);
  const [invalid, setInvalid] = useState<Record<string, boolean>>({});
  const [result, setResult] = useState<ApiDebugResult>();
  const [flowResult, setFlowResult] = useState<ApiDebugResult>();
  const [protocolOpen, setProtocolOpen] = useState(false);
  const [generationDraft, setGenerationDraft] = useState<ApiCaseDraft>();
  const [historyOpen, setHistoryOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [source, setSource] = useState("");
  const [preview, setPreview] = useState<ApiImportPreview>();
  const [addTo, setAddTo] = useState<"steps" | "cleanup">();
  const [env, setEnv] = useEnvChoice(project);
  const selected = definitions.find((d) => d.id === selectedId);
  const isFlow = tab === "flows";
  const draft = isFlow ? flow : single;
  const setDraft = (next: ApiCaseDraft) => {
    if (isFlow) { setFlow(next); setFlowDirty(true); } else { setSingle(next); setSingleDirty(true); }
  };
  const supported = ![...draft.steps, ...(draft.cleanup ?? [])].some((s) => definitions.find((d) => d.id === s.definition_id)?.unsupported_body);
  const valid = !Object.entries(invalid).some(([key, bad]) => key.startsWith(isFlow ? "flow:" : "single:") && bad);
  const validity = (key: string, ok: boolean) => setInvalid((old) => ({ ...old, [key]: !ok }));
  const resetEditor = () => { setEditorKey((v) => v + 1); setInvalid({}); };
  const refresh = useCallback(async () => {
    try {
      const [defs, cs, rs, hs] = await Promise.all([api().listApiDefinitions(project.id), api().listCases(project.id, { execution_mode: "api" }), api().listRoles(project.id), api().listApiDebugHistory(project.id)]);
      setDefinitions(defs); setCases(cs as TestCase[]); setRoles(rs.map((r) => r.role_name)); setHistory(hs); setLoadError("");
    } catch (e) { setLoadError((e as Error).message); } finally { setLoading(false); }
  }, [project.id]);
  useEffect(() => { void refresh(); }, [refresh]);
  useProjectChanged(project.id, () => { void refresh(); });
  const currentDefinitions = definitions.filter((d) => !d.removed);
  const filtered = definitions.filter((d) => `${d.method} ${d.path} ${d.summary} ${d.module}`.toLowerCase().includes(search.toLowerCase()));
  const modules = useMemo(() => [...new Set(filtered.map((d) => d.module))], [definitions, search]);
  const flows = cases.filter((c) => c.api_flow?.length);
  const related = cases.filter((c) => c.api?.definition_id === selectedId);
  const askDiscard = (dirty: boolean, action: () => void) => {
    if (!dirty) return action();
    modal.confirm({ title: "替换未保存的修改？", content: "当前编辑内容尚未保存为用例", okText: "替换", cancelText: "继续编辑", onOk: action });
  };
  const selectDefinition = (definition: ApiDefinition, open = false) => askDiscard(singleDirty, () => {
    setSelectedId(definition.id); setSingle({ ...newDraft("single"), title: `${definition.module}-${definition.summary}`, module_path: [definition.module], steps: [clone(definition.request)] });
    setSingleDirty(false); resetEditor(); setResult(undefined); if (open) setTab("request");
  });
  const loadCase = (c: TestCase) => {
    const flowCase = Boolean(c.api_flow?.length);
    askDiscard(flowCase ? flowDirty : singleDirty, () => {
      const next: ApiCaseDraft = { id: c.id, title: c.title, kind: flowCase ? "flow" : "single", priority: c.priority, module_path: c.module_path,
        steps: clone(flowCase ? c.api_flow! : [c.api!]), cleanup: clone(c.api_cleanup ?? []), inputs: clone(c.api_inputs ?? {}) };
      if (flowCase) { setFlow(next); setFlowDirty(false); setFlowResult(undefined); setTab("flows"); }
      else { setSingle(next); setSingleDirty(false); setSelectedId(c.api?.definition_id ?? ""); setResult(undefined); setTab("request"); }
      resetEditor();
    });
  };
  const save = () => run("save", async () => {
    const saved = await api().saveApiCase(project.id, draft) as TestCase;
    const next = { ...draft, id: saved.id };
    if (isFlow) { setFlow(next); setFlowDirty(false); } else { setSingle(next); setSingleDirty(false); }
    notifyProjectChanged(project.id); await refresh();
  }, "已保存为草稿，可在用例库或下方审核");
  const send = (confirmProduction: boolean) => run("send", async () => {
    const res = await api().debugApiRequest(project.id, env, draft, { confirmProduction });
    if (isFlow) setFlowResult(res); else setResult(res);
    await refresh();
  });
  const previewSource = (value: string) => run("preview", async () => {
    if (!value.trim()) throw new Error("请选择文件或输入规范文档地址");
    setPreview(await api().previewApiImport(project.id, value.trim()));
  });
  const review = (c: TestCase) => run(`review:${c.id}`, async () => {
    await api().updateCase(c.id, { status: "reviewed" }); notifyProjectChanged(project.id); await refresh();
  }, "已审核，可生成脚本并回归");
  const caseRows = (rows: TestCase[]) => <Table size="small" rowKey="id" dataSource={rows} pagination={{ pageSize: 8, hideOnSinglePage: true }} columns={[
    { title: "用例", dataIndex: "title", render: (v, c) => <Button type="link" className="api-case-link" onClick={() => loadCase(c)}>{v}</Button> },
    { title: "状态", dataIndex: "status", width: 116, render: (v, c) => <span className="api-muted">{c.api_needs_review ? "接口待检查" : v === "reviewed" ? "已审核" : v === "deprecated" ? "已废弃" : "草稿"}</span> },
    { title: "操作", width: 108, render: (_, c) => c.status === "draft" && <Button size="small" icon={<CheckOutlined />} disabled={busy || c.api_needs_review} onClick={() => review(c)}>审核</Button> },
  ]} />;
  const directory = <aside className="api-directory"><div className="api-directory-top"><span>接口目录</span><span className="api-mono api-muted">{currentDefinitions.length}</span></div>
    <Input aria-label="搜索接口" prefix={<SearchOutlined />} placeholder="搜索名称或路径" value={search} onChange={(e) => setSearch(e.target.value)} allowClear />
    <div className="api-directory-list api-directory-tree">
      {filtered.length ? <Tree blockNode showLine={{ showLeafIcon: false }}
        aria-label="接口目录" selectedKeys={selectedId ? [`api:${selectedId}`] : []}
        expandedKeys={modules.filter((module) => search.trim() || !collapsedModules.includes(module)).map((module) => `module:${module}`)}
        onExpand={(keys) => setCollapsedModules(modules.filter((module) => !keys.includes(`module:${module}`)))}
        onSelect={(keys) => { const d = filtered.find((item) => `api:${item.id}` === keys[0]); if (d) selectDefinition(d); }}
        treeData={modules.map((module) => ({
          key: `module:${module}`, selectable: false,
          title: <span className="api-tree-module"><FolderOutlined /><span>{module || "未分组"}</span><span className="api-tree-count">{filtered.filter((d) => d.module === module).length}</span></span>,
          children: filtered.filter((d) => d.module === module).map((d) => ({
            key: `api:${d.id}`, isLeaf: true,
            title: <span className="api-tree-endpoint" title={`${d.method} ${d.summary}\n${d.path}`}>
              <span className="api-directory-title"><Method method={d.method} /><span>{d.summary}</span>{d.removed && <span className="api-muted">已移除</span>}</span>
              <span className="api-directory-path">{d.path}</span>
            </span>,
          })),
        }))} /> : <p className="api-muted api-directory-empty">{search ? "没有匹配的接口" : "导入接口后在这里选择"}</p>}
    </div>
    <button className="api-directory-import" onClick={() => setImportOpen(true)}><PlusOutlined /> 导入接口定义</button>
  </aside>;
  const sourceWarning = (s: ApiRequest, update: (r: ApiRequest) => void) => {
    const d = definitions.find((v) => v.id === s.definition_id);
    if (!s.definition_id || !d || (!d.removed && d.revision === s.definition_revision)) return null;
    return <Alert type="warning" showIcon message={d.removed ? "该接口已从来源文档移除" : `来源已更新为 v${d.revision}，当前请求保留 v${s.definition_revision} 配置`} action={!d.removed && <Button size="small" onClick={() => {
      modal.confirm({ title: "确认使用当前接口版本？", content: "保留已编辑的参数、断言和提取规则。请检查新增必填字段和响应变化后再审核", onOk: () => update({ ...s, definition_revision: d.revision }), okText: "确认版本", cancelText: "取消" });
    }}>检查后确认</Button>} />;
  };
  const requestEditor = (request: ApiRequest, index: number, target: "steps" | "cleanup" = "steps") => {
    const update = (next: ApiRequest) => setDraft({ ...draft, [target]: (draft[target] ?? []).map((s, i) => i === index ? next : s) });
    return <div className="api-step-editor">
      {sourceWarning(request, update)}
      {definitions.find((d) => d.id === request.definition_id)?.unsupported_body && <Alert type="warning" message="该接口需要表单、文件或其他请求类型；当前执行器仅支持 JSON 请求体" />}
      {isFlow && <Input aria-label={`${target === "cleanup" ? "清理" : "业务"}步骤名称 ${index + 1}`} placeholder="步骤名称" value={request.name ?? ""} onChange={(e) => update({ ...request, name: e.target.value })} />}
      <div className="api-request-url"><Method method={request.method} /><span className="api-base-url" title={project.environments[env]?.base_url}>{project.environments[env]?.base_url ?? "未选择环境"}</span><Input aria-label={`请求路径 ${index + 1}`} value={request.path} onChange={(e) => update({ ...request, path: e.target.value })} /></div>
      <RequestEditor key={`${editorKey}:${target}:${index}:${request.definition_id ?? "manual"}`} request={request} onChange={update} roles={roles} sourceSchema={definitions.find((d) => d.id === request.definition_id)?.request.response_schema} initialTab={request.body != null ? "body" : "params"} onValidity={(key, ok) => validity(`${isFlow ? "flow" : "single"}:${target}:${index}:${key}`, ok)} />
    </div>;
  };
  const executionToolbar = <div className="api-editor-toolbar"><div className="api-editor-title"><Input aria-label={isFlow ? "场景名称" : "用例名称"} value={draft.title} placeholder={isFlow ? "例如：订单-创建后取消" : "用例名称"} onChange={(e) => setDraft({ ...draft, title: e.target.value })} /><span className="api-muted">{(isFlow ? flowDirty : singleDirty) ? "未保存" : draft.id ? "已保存" : "临时请求"}</span></div>
    <Space>{!isFlow && <Button disabled={busy || !valid || !supported || !single.steps[0]?.definition_id} onClick={() => setGenerationDraft(clone(single))}>根据参数生成用例</Button>}<Button icon={<SaveOutlined />} disabled={busy || !valid || !draft.steps.length} loading={activeKey === "save"} onClick={save}>保存{isFlow ? "场景" : "用例"}</Button>{activeKey === "send" && <Button onClick={() => api().stopApiDebug(project.id, env)}>取消等待</Button>}<RunButton project={project} env={env} loading={activeKey === "send"} disabled={busy || !valid || !supported || !env || !draft.steps.length} onRun={send}>{isFlow ? "试运行场景" : "发送请求"}</RunButton></Space>
  </div>;
  const flowSteps = (target: "steps" | "cleanup") => <>
    <div className="api-flow-section-title"><h4>{target === "steps" ? "业务步骤" : "执行后清理"}</h4><span className="api-muted">{target === "steps" ? "按顺序执行，变量在本场景内传递" : "业务失败后仍尝试执行"}</span><Button size="small" icon={<PlusOutlined />} disabled={busy || !valid || !currentDefinitions.length} onClick={() => setAddTo(target)}>添加{target === "steps" ? "步骤" : "清理"}</Button></div>
    <Collapse className="api-flow-steps" defaultActiveKey={["0"]} items={(draft[target] ?? []).map((s, i) => ({ key: String(i), label: <span className="api-flow-step-label"><span className="api-step-number">{i + 1}</span><Method method={s.method} /><span>{s.name || s.path}</span>{s.role && <span className="api-muted">{s.role}</span>}</span>,
      extra: <Space size={0} onClick={(e) => e.stopPropagation()}>{[-1, 1].map((delta) => <Button key={delta} type="text" size="small" aria-label={`${delta < 0 ? "上移" : "下移"}步骤 ${i + 1}`} disabled={busy || !valid || i + delta < 0 || i + delta >= (draft[target]?.length ?? 0)} icon={delta < 0 ? <ArrowUpOutlined /> : <ArrowDownOutlined />} onClick={() => {
        const next = [...(draft[target] ?? [])]; [next[i], next[i + delta]] = [next[i + delta], next[i]]; setDraft({ ...draft, [target]: next }); resetEditor();
      }} />)}<Button type="text" size="small" aria-label={`删除步骤 ${i + 1}`} icon={<DeleteOutlined />} disabled={busy || !valid} onClick={() => { setDraft({ ...draft, [target]: draft[target]!.filter((_, n) => n !== i) }); resetEditor(); }} /></Space>, children: requestEditor(s, i, target),
    }))} />
  </>;

  return <div className="api-workspace">
    <PageHeader title="接口测试" description="从一个请求开始，验证接口，再串联完整业务" extra={<Space><Button onClick={() => setTab("login")}>登录与加密</Button><Button icon={<HistoryOutlined />} onClick={() => setHistoryOpen(true)}>调试历史</Button><Button icon={<UploadOutlined />} onClick={() => { setPreview(undefined); setImportOpen(true); }}>导入接口</Button></Space>} />
    <div className="api-workspace-context"><div className="api-workspace-counts"><span><strong>{currentDefinitions.length}</strong> 个接口</span><span><strong>{cases.filter((c) => c.api).length}</strong> 条单接口用例</span><span><strong>{flows.length}</strong> 个业务场景</span></div><div className="api-environment">{env ? <><span className="api-muted">执行环境</span><EnvSelect project={project} value={env} onChange={setEnv} disabled={busy} width={180} /></> : <Button size="small" onClick={() => openSettings?.({ addEnv: true })}>配置执行环境</Button>}</div></div>
    {loadError && <Alert type="error" message="接口工作台加载失败" description={loadError} action={<Button onClick={() => void refresh()}>重试</Button>} />}
    <Tabs className="api-workspace-tabs" activeKey={tab} onChange={(next) => {
      if (!valid && ["request", "flows"].includes(tab)) { void message.warning("请先修正当前编辑器中的无效内容"); return; }
      setTab(next);
    }} items={[
      { key: "definitions", label: "接口管理" }, { key: "request", label: "单接口测试" }, { key: "flows", label: "业务场景" }, { key: "regression", label: "回归执行" }, { key: "login", label: "登录与加密" },
    ]} />
    {loading ? <div className="api-loading"><Spin tip="正在读取接口资产" /></div> : tab === "login" ? <ApiLoginWorkspace project={project} env={env} onProtocol={() => setProtocolOpen(true)} /> : tab === "regression" ? <div className="api-regression"><RunPage project={project} /></div> : tab === "flows" ? <div className="api-workbench-layout api-flow-layout">
      <aside className="api-directory"><div className="api-directory-top"><span>业务场景</span><Button size="small" type="text" aria-label="新建业务场景" icon={<PlusOutlined />} onClick={() => askDiscard(flowDirty, () => { setFlow(newDraft("flow")); setFlowDirty(false); setFlowResult(undefined); resetEditor(); })} /></div><div className="api-directory-list">{flows.map((c) => <button className={`api-directory-row ${flow.id === c.id ? "selected" : ""}`} key={c.id} onClick={() => loadCase(c)}><span>{c.title}</span><span className="api-directory-path">{c.api_flow!.length} 个步骤 · {c.api_needs_review ? "接口待检查" : c.status === "reviewed" ? "已审核" : "草稿"}</span></button>)}{!flows.length && <p className="api-muted api-directory-empty">创建场景，将多个请求串成业务流程</p>}</div><div className="api-directory-note">测试集用于批量选择，业务场景负责顺序与依赖</div></aside>
      <main className="api-workbench-main">{executionToolbar}<div className="api-flow-editor"><Collapse ghost items={[{ key: "inputs", label: "场景输入参数", children: <JsonField key={`inputs:${editorKey}`} label="场景输入参数" object value={draft.inputs} onChange={(inputs) => setDraft({ ...draft, inputs })} onValidity={(v) => validity("flow:inputs", v)} rows={4} /> }]} />{flowSteps("steps")}{!flow.steps.length && <div className="api-flow-empty"><span className="api-step-number">1</span><h3>添加第一个业务请求</h3><p>从已导入的接口开始，再为后续步骤提取和引用变量</p><Button icon={<PlusOutlined />} disabled={!currentDefinitions.length} onClick={() => setAddTo("steps")}>选择接口</Button>{!currentDefinitions.length && <Button type="link" onClick={() => setImportOpen(true)}>先导入接口</Button>}</div>}{flowSteps("cleanup")}</div><ExecutionResult result={flowResult} />{flow.id && <div className="api-related-cases"><h4>当前场景</h4>{caseRows(cases.filter((c) => c.id === flow.id))}</div>}</main>
    </div> : <div className="api-workbench-layout">{directory}<main className="api-workbench-main">
      {tab === "definitions" ? selected ? <><div className="api-definition-heading"><div><div className="api-overline">{selected.module} <span>定义版本 {selected.revision}</span></div><h2>{selected.summary}</h2><div className="api-definition-path"><Method method={selected.method} /><code>{selected.path}</code></div></div><Button type="primary" icon={<ArrowRightOutlined />} iconPosition="end" disabled={selected.removed} onClick={() => { if (!single.steps[0]?.definition_id) selectDefinition(selected, true); else setTab("request"); }}>调试此接口</Button></div>
        <div className="api-definition-meta"><span>来源 {selected.title || selected.source}</span><span>文档版本 {selected.version || "未声明"}</span><span>{selected.request.auth ? "需要鉴权" : "无需鉴权"}</span></div>
        <div className="api-definition-content"><h4>请求参数</h4><Table size="small" rowKey={(r) => `${r.location}:${r.name}`} pagination={false} dataSource={selected.operation.params} columns={[{ title: "参数名", dataIndex: "name", render: (v) => <code>{v}</code> }, { title: "位置", dataIndex: "location" }, { title: "类型", dataIndex: "schema", render: (v) => String(v.type ?? "—") }, { title: "必填", dataIndex: "required", render: (v) => v ? "是" : "否" }]} />
          {selected.operation.body_schema && <Collapse style={{ marginTop: 24 }} items={[{ key: "body", label: "请求体结构", children: <pre className="api-response-code">{JSON.stringify(selected.operation.body_schema, null, 2)}</pre> }]} />}
          <h4 className="api-section-heading">响应定义</h4><Collapse items={Object.entries(selected.operation.responses).map(([status, schema]) => ({ key: status, label: <span className="api-mono">HTTP {status}</span>, children: <pre className="api-response-code">{JSON.stringify(schema, null, 2)}</pre> }))} />
          <div className="api-section-toolbar"><h4>关联单接口用例</h4><Button size="small" icon={<PlusOutlined />} disabled={busy || selected.removed || selected.unsupported_body} onClick={() => setGenerationDraft(clone(single.steps[0]?.definition_id === selected.id ? single : { ...newDraft("single"), title: `${selected.module}-${selected.summary}`, steps: [selected.request] }))}>根据参数生成用例</Button></div>{caseRows(related)}
        </div></> : <div className="api-intro-empty"><div className="api-empty-symbol"><ApiOutlined /></div><h2>{definitions.length ? "选择一个接口" : "先导入接口，再验证业务"}</h2><p>{definitions.length ? "查看参数与响应定义，或进入单接口测试发送请求" : "支持 OpenAPI 3.x 与 Swagger 2.0，导入后保留接口目录和版本"}</p><Button type="primary" icon={<UploadOutlined />} onClick={() => setImportOpen(true)}>导入接口定义</Button><div className="api-empty-sequence"><span>接口定义</span><ArrowRightOutlined /><span>单接口用例</span><ArrowRightOutlined /><span>业务场景</span></div><Button type="text" icon={<FileTextOutlined />} disabled={busy} onClick={() => run("requirement", async () => {
          const file = await api().pickFile([{ name: "需求文档", extensions: ["md", "docx", "pdf", "txt"] }]); if (!file) return;
          await api().generateCases(project.id, file); notifyProjectChanged(project.id); goTab?.("cases");
        })}>从需求文档设计用例（调用模型）</Button></div>
        : <>{executionToolbar}<Collapse ghost items={[{ key: "inputs", label: "请求输入变量", children: <JsonField key={`single-inputs:${editorKey}`} label="请求输入变量" object value={single.inputs} onChange={(inputs) => setDraft({ ...single, inputs })} onValidity={(v) => validity("single:inputs", v)} rows={4} /> }]} />{requestEditor(single.steps[0], 0)}{!valid && <Alert type="error" message="请修正参数、JSON 或状态码后继续" />}<ExecutionResult result={result} /><div className="api-related-cases"><div className="api-section-toolbar"><h4>此接口的用例</h4>{single.steps[0]?.definition_id && <Button size="small" disabled={!valid} onClick={() => { setFlow((old) => ({ ...old, inputs: { ...single.inputs, ...old.inputs }, steps: [...old.steps, clone(single.steps[0])] })); setFlowDirty(true); setTab("flows"); resetEditor(); }}>加入业务场景</Button>}</div>{caseRows(related)}</div></>}
    </main></div>}
    {generationDraft && <GenerateParameterCases projectId={project.id} draft={generationDraft} result={result} onClose={() => setGenerationDraft(undefined)} onSaved={async () => { notifyProjectChanged(project.id); await refresh(); }} />}
    <Drawer title="导入接口定义" width={680} open={importOpen} onClose={() => { if (!busy) setImportOpen(false); }} extra={<Button disabled={busy} onClick={() => { setPreview(undefined); setSource(""); }}>重新选择</Button>}>
      {!preview ? <div className="api-import-body"><p className="api-muted">先预览变更，再确认导入。此操作不会自动生成用例或脚本</p><button className="api-import-file" disabled={busy} onClick={() => run("pick", async () => {
        const file = await api().pickFile([{ name: "OpenAPI / Swagger", extensions: ["json", "yaml", "yml"] }]); if (file) setPreview(await api().previewApiImport(project.id, file));
      })}><UploadOutlined /><strong>选择 OpenAPI 文件</strong><span>JSON / YAML / YML</span></button><div className="api-import-divider">或从文档地址导入</div><label htmlFor="api-source-url">规范文档地址</label><Input id="api-source-url" placeholder="https://example.com/v3/api-docs" value={source} disabled={busy} onChange={(e) => setSource(e.target.value)} /><p className="api-muted">请填写规范 JSON/YAML 地址，非 Swagger UI 页面</p><Button type="primary" loading={busy} disabled={!source.trim()} onClick={() => previewSource(source)}>预览接口变更</Button></div>
        : <><div className="api-import-summary"><h3>{preview.title}</h3><span className="api-muted">版本 {preview.version || "未声明"} · {preview.changes.length} 项</span></div><Space wrap>{Object.entries(changeLabels).map(([key, label]) => <span className="api-muted" key={key}>{label} {preview.changes.filter((c) => c.change === key).length}</span>)}</Space><Table style={{ marginTop: 24 }} rowKey={(r) => `${r.method}:${r.path}`} size="small" dataSource={preview.changes} pagination={{ pageSize: 10 }} columns={[{ title: "接口", render: (_, c) => <><Method method={c.method} /><code className="api-import-path">{c.path}</code><div className="api-muted">{c.summary}</div></> }, { title: "变更", dataIndex: "change", width: 108, render: (v: keyof typeof changeLabels) => changeLabels[v] }]} /><Alert type="info" message="接口更新保留人工用例配置，受影响用例会回到待检查状态" /><Button type="primary" className="api-import-confirm" loading={activeKey === "import"} disabled={busy} onClick={() => run("import", async () => {
          await api().importApiDefinitions(project.id, preview); await refresh(); setImportOpen(false); setTab("definitions"); notifyProjectChanged(project.id);
        }, "接口目录已更新")}>确认导入</Button></>}
    </Drawer>
    <Drawer title="调试历史" width={800} open={historyOpen} onClose={() => setHistoryOpen(false)}>{!history.length ? <Empty description="暂无调试记录" /> : <Collapse items={history.map((item) => ({ key: item.id, label: <span>{item.title} <span className="api-muted">{new Date(item.created_at).toLocaleString()} · {item.env}</span></span>, children: <ExecutionResult result={item} /> }))} />}<p className="api-muted">保留最近 50 次调试，凭据字段已脱敏</p></Drawer>
    <Drawer title="接口登录与加密" open={protocolOpen} onClose={() => setProtocolOpen(false)} width={640} destroyOnClose><ApiLoginCard project={project} env={env} /></Drawer>
    <Modal title={`选择${addTo === "cleanup" ? "清理" : "业务"}接口`} open={Boolean(addTo)} footer={null} onCancel={() => setAddTo(undefined)} width={680}><Input aria-label="筛选场景接口" prefix={<SearchOutlined />} placeholder="搜索接口" value={search} onChange={(e) => setSearch(e.target.value)} /><div className="api-add-steps">{filtered.filter((d) => !d.removed).map((d) => <button key={d.id} onClick={() => {
      const target = addTo!; setFlow((old) => ({ ...old, [target]: [...(old[target] ?? []), { ...clone(d.request), name: d.summary }] })); setFlowDirty(true); setAddTo(undefined); resetEditor();
    }}><Method method={d.method} /><span>{d.summary}<code>{d.path}</code></span><PlusOutlined /></button>)}</div></Modal>
  </div>;
}
