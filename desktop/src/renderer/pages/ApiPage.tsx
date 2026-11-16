import { ApiCaseList } from "./api/ApiCaseList";
import { groupDefinitions, type ApiDirectoryNode } from "../../shared/apiDirectory";
import { clusterImportChanges } from "../../shared/apiImportClusters";
import { ApiOutlined, ArrowDownOutlined, ArrowRightOutlined, ArrowUpOutlined, CheckCircleFilled, CheckOutlined, CloudDownloadOutlined, DeleteOutlined, FileAddOutlined, FileTextOutlined, HistoryOutlined, InboxOutlined, LinkOutlined, MoreOutlined, FolderOutlined, PlusOutlined, ReloadOutlined, SaveOutlined, SearchOutlined, SendOutlined, StopOutlined, UploadOutlined } from "@ant-design/icons";
import { Alert, App, Button, Checkbox, Collapse, Drawer, Dropdown, Empty, Input, Modal, Select, Space, Spin, Steps, Table, Tabs, Tag, Tooltip, Tree, Typography, Upload } from "antd";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
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
  const [directoryWidth, setDirectoryWidth] = useState(() => {
    try { const value = Number(localStorage.getItem("aitest:api-directory-width")); return value >= 240 && value <= 520 ? value : 300; } catch { return 300; }
  });
  const resizeStart = useRef<{ x: number; width: number; max: number }>();
  const [resizingDirectory, setResizingDirectory] = useState(false);
  const [directoryLabels, setDirectoryLabels] = useState<Record<string, string>>(() => {
    try { const value = JSON.parse(localStorage.getItem(`aitest:api-directory-labels:${project.id}`) ?? "{}"); return value && typeof value === "object" && !Array.isArray(value) ? value : {}; } catch { return {}; }
  });
  const [editingDirectoryTitle, setEditingDirectoryTitle] = useState<{ key: string; value: string }>();
  const cancelTitleBlur = useRef(false);
  const saveDirectoryTitle = (key: string, value: string) => {
    if (cancelTitleBlur.current) return;
    setDirectoryLabels((labels) => {
      const next = { ...labels };
      if (value.trim()) next[key] = value.trim(); else delete next[key];
      try { localStorage.setItem(`aitest:api-directory-labels:${project.id}`, JSON.stringify(next)); } catch { /* Keep the current session editable. */ }
      return next;
    });
    setEditingDirectoryTitle(undefined);
  };
  useEffect(() => { try { localStorage.setItem("aitest:api-directory-width", String(directoryWidth)); } catch { /* Storage may be unavailable. */ } }, [directoryWidth]);
  const [collapsedModules, setCollapsedModules] = useState<string[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [checkedIds, setCheckedIds] = useState<string[]>([]);
  const [regressionDefinitions, setRegressionDefinitions] = useState<ApiDefinition[]>();
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
  const [importKeys, setImportKeys] = useState<string[]>([]);
  const acceptPreview = (next: ApiImportPreview) => {
    setPreview(next);
    setImportKeys(next.changes.map((c) => `${c.method}:${c.path}`));
  };
  const [casesDrawerOpen, setCasesDrawerOpen] = useState(false);
  const [addTo, setAddTo] = useState<"steps" | "cleanup">();
  const importClusters = useMemo(() => preview ? clusterImportChanges(preview.changes) : [], [preview]);
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
  const directoryNodes = useMemo(() => groupDefinitions(definitions.filter((d) =>
    `${d.method} ${d.path} ${d.summary} ${d.module}`.toLowerCase().includes(search.toLowerCase()))), [definitions, search]);
  const folderKeys = (nodes: ApiDirectoryNode[]): string[] => nodes.flatMap((node) => node.children ? [node.key, ...folderKeys(node.children)] : []);
  const modules = folderKeys(directoryNodes);
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
    acceptPreview(await api().previewApiImport(project.id, value.trim()));
  });
  /** 从响应树形视图快速添加断言到当前编辑的请求 */
  const addAssertionFromResponse = (path: string, value: unknown) => {
    const operator: "eq" | "not_empty" | "exists" = value === null || value === undefined ? "exists"
      : typeof value === "string" && String(value).length > 50 ? "not_empty" : "eq";
    const assertion = { path, operator, ...(operator === "eq" ? { value } : {}) };
    if (isFlow) {
      // 场景模式下不自动添加（步骤不确定），仅提示
      void message.info(`路径 ${path} 已复制，请在对应步骤手动添加断言`);
    } else {
      const step = single.steps[0];
      if (step) {
        setSingle({ ...single, steps: [{ ...step, assertions: [...(step.assertions ?? []), assertion] }] });
        setSingleDirty(true);
      }
    }
  };
  const caseRows = (rows: TestCase[]) => <ApiCaseList project={project} env={env} rows={rows} onEdit={loadCase} onChanged={refresh} />;
  const checkedDefinitions = currentDefinitions.filter((d) => checkedIds.includes(d.id));
  const generateBatch = () => modal.confirm({
    title: `为 ${checkedDefinitions.length} 个接口批量生成用例？`,
    content: "根据各接口的参数约束生成正向、必填缺失、边界和鉴权等用例。已有用例会跳过，新增用例保存为草稿，审核后可回归。",
    okText: "生成用例", cancelText: "取消",
    onOk: () => run("batch-generate", async () => {
      const out = await api().generateDefinitionCases(project.id, checkedDefinitions.map((d) => d.id));
      notifyProjectChanged(project.id); await refresh();
      void message.success(`已生成 ${out.generated} 条用例，跳过 ${out.skipped} 条已有用例`);
    }),
  });
  const renderDirectory = (nodes: ApiDirectoryNode[]): import("antd").TreeDataNode[] => nodes.map((node) => {
    const d = node.definition;
    return d ? {
      key: node.key, isLeaf: true, disableCheckbox: d.removed || busy,
      title: <span className="api-tree-endpoint" title={`${d.method} ${d.summary}\n${d.path}\n模块：${d.module}`}>
        <span className="api-directory-title"><Method method={d.method} /><span>{d.summary}</span>{d.removed && <span className="api-muted">已移除</span>}</span>
        <span className="api-directory-path">{d.path}</span>
      </span>,
    } : {
      key: node.key, selectable: false, disableCheckbox: busy,
      title: <span className="api-tree-module" title={`原始模块：${node.label}；双击标题修改显示名称`}><FolderOutlined />{editingDirectoryTitle?.key === node.key ? <Input
        className="api-tree-module-title-input" size="small" autoFocus maxLength={120} aria-label="修改模块标题" value={editingDirectoryTitle.value}
        onFocus={(event) => event.target.select()} onClick={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()}
        onChange={(event) => setEditingDirectoryTitle({ key: node.key, value: event.target.value })}
        onBlur={(event) => saveDirectoryTitle(node.key, event.target.value)}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); }
          if (event.key === "Escape") { event.preventDefault(); cancelTitleBlur.current = true; setEditingDirectoryTitle(undefined); }
        }} /> : <span className="api-tree-module-name" onDoubleClick={(event) => {
          event.stopPropagation(); cancelTitleBlur.current = false;
          setEditingDirectoryTitle({ key: node.key, value: directoryLabels[node.key] || node.label });
        }}>{directoryLabels[node.key] || node.label}</span>}<span className="api-tree-count">{node.rows.length}</span></span>,
      children: renderDirectory(node.children ?? []),
    };
  });
  const directory = <aside className="api-directory"><div className="api-directory-top"><Space size={8}><span>接口目录</span><span className="api-mono api-muted">{currentDefinitions.length}</span></Space><Button type="text" size="small" icon={<PlusOutlined />} aria-label="导入接口定义" title="导入接口定义" onClick={() => setImportOpen(true)} /></div>
    <Input aria-label="搜索接口" prefix={<SearchOutlined />} placeholder="搜索名称或路径" value={search} onChange={(e) => setSearch(e.target.value)} allowClear />
    <div className="api-directory-batch">
      <div className="api-directory-selection"><span className="api-selection-count">{checkedDefinitions.length ? <>已选 <strong>{checkedDefinitions.length}</strong> 个接口</> : "勾选接口以批量操作"}</span><Button type="text" size="small" disabled={busy || !checkedIds.length} onClick={() => setCheckedIds([])}>清空</Button></div>
      <div className="api-directory-actions">
      <Button size="small" loading={activeKey === "batch-generate"} disabled={busy || !checkedDefinitions.length || checkedDefinitions.some((d) => d.unsupported_body)} onClick={generateBatch}>批量生成</Button>
      <Button size="small" disabled={busy || !checkedDefinitions.length || !valid} onClick={() => { setRegressionDefinitions(checkedDefinitions); setTab("regression"); }}>接口回归</Button>
      </div>
    </div>
    <div className="api-directory-list api-directory-tree">
      {filtered.length ? <Tree blockNode checkable
        checkedKeys={checkedIds.map((id) => `api:${id}`)}
        onCheck={(keys) => {
          const next = (Array.isArray(keys) ? keys : keys.checked).map(String).filter((key) => key.startsWith("api:")).map((key) => key.slice(4));
          const visibleIds = new Set(filtered.filter((d) => !d.removed).map((d) => d.id));
          setCheckedIds((old) => [...new Set([...old.filter((id) => !visibleIds.has(id)), ...next])]);
        }}
        aria-label="接口目录" selectedKeys={selectedId ? [`api:${selectedId}`] : []}
        expandedKeys={modules.filter((module) => search.trim() || !collapsedModules.includes(module))}
        onExpand={(keys) => setCollapsedModules(modules.filter((module) => !keys.includes(module)))}
        onSelect={(keys) => { const d = filtered.find((item) => `api:${item.id}` === keys[0]); if (d) selectDefinition(d); }}
        treeData={renderDirectory(directoryNodes)} /> : <p className="api-muted api-directory-empty">{search ? "没有匹配的接口" : "导入接口后在这里选择"}</p>}
    </div>
    <div className="api-directory-resizer" role="separator" aria-label="调整接口目录宽度" aria-orientation="vertical"
      aria-valuemin={240} aria-valuemax={520} aria-valuenow={directoryWidth} tabIndex={0} title="拖动调整目录宽度，双击恢复默认"
      onDoubleClick={() => setDirectoryWidth(300)}
      onKeyDown={(event) => {
        if (!["ArrowLeft", "ArrowRight", "Home"].includes(event.key)) return;
        event.preventDefault();
        setDirectoryWidth((width) => event.key === "Home" ? 300 : Math.max(240, Math.min(520, width + (event.key === "ArrowLeft" ? -16 : 16))));
      }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        const aside = event.currentTarget.parentElement!;
        const max = Math.max(240, Math.min(520, (aside.parentElement?.clientWidth ?? 840) - 320));
        resizeStart.current = { x: event.clientX, width: aside.getBoundingClientRect().width, max };
        event.currentTarget.setPointerCapture(event.pointerId); setResizingDirectory(true);
      }}
      onPointerMove={(event) => { const start = resizeStart.current; if (start) setDirectoryWidth(Math.max(240, Math.min(start.max, start.width + event.clientX - start.x))); }}
      onPointerUp={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
      onLostPointerCapture={() => { resizeStart.current = undefined; setResizingDirectory(false); }} />
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
    const def = definitions.find((d) => d.id === request.definition_id);
    return <div className="api-step-editor">
      {sourceWarning(request, update)}
      {def?.unsupported_body && <Alert type="warning" message="该接口需要表单、文件或其他请求类型；当前执行器仅支持 JSON 请求体" />}
      {isFlow && <Input aria-label={`${target === "cleanup" ? "清理" : "业务"}步骤名称 ${index + 1}`} placeholder="步骤名称" value={request.name ?? ""} onChange={(e) => update({ ...request, name: e.target.value })} />}
      <div className="api-request-url"><Method method={request.method} /><span className="api-base-url" title={project.environments[env]?.base_url}>{project.environments[env]?.base_url ?? "未选择环境"}</span><Input aria-label={`请求路径 ${index + 1}`} value={request.path} onChange={(e) => update({ ...request, path: e.target.value })} /></div>
      {!isFlow && <Collapse className="api-input-variables" ghost items={[{ key: "inputs", label: "请求输入变量", children: <JsonField key={`single-inputs:${editorKey}`} label="请求输入变量" object value={single.inputs} onChange={(inputs) => setDraft({ ...single, inputs })} onValidity={(v) => validity("single:inputs", v)} rows={4} /> }]} />}
      <RequestEditor key={`${editorKey}:${target}:${index}:${request.definition_id ?? "manual"}`} request={request} onChange={update} roles={roles}
        sourceSchema={def?.request.response_schema} bodySchema={def?.operation.body_schema} paramSchema={def?.operation.params}
        lastResponse={!isFlow && index === 0 ? result?.steps[0]?.response?.body : undefined}
        initialTab={request.body != null ? "body" : "params"} onValidity={(key, ok) => validity(`${isFlow ? "flow" : "single"}:${target}:${index}:${key}`, ok)} />
    </div>;
  };
  const executionToolbar = <div className="api-editor-toolbar"><div className="api-editor-title"><Input aria-label={isFlow ? "场景名称" : "用例名称"} value={draft.title} placeholder={isFlow ? "例如：订单-创建后取消" : "用例名称"} onChange={(e) => setDraft({ ...draft, title: e.target.value })} /><span className="api-muted">{(isFlow ? flowDirty : singleDirty) ? "未保存" : draft.id ? "已保存" : "临时请求"}</span></div>
    <Space className="api-editor-actions">{!isFlow && single.steps[0]?.definition_id && <button className="api-toolbar-cases-badge" onClick={() => { if (related.length) setCasesDrawerOpen(true); }} title={related.length ? `${related.length} 条用例，点击查看` : "暂无用例"}><span className="api-toolbar-cases-count">{related.length}</span><span className="api-toolbar-cases-label">用例</span></button>}{!isFlow && <Dropdown trigger={["click"]} menu={{ items: [
      { key: "generate", label: "生成用例", icon: <PlusOutlined />, disabled: busy || !valid || !supported || !single.steps[0]?.definition_id, onClick: () => setGenerationDraft(clone(single)) },
      ...(single.steps[0]?.definition_id ? [{ key: "add-to-flow", label: "加入场景", icon: <LinkOutlined />, disabled: !valid, onClick: () => { setFlow((old) => ({ ...old, inputs: { ...single.inputs, ...old.inputs }, steps: [...old.steps, clone(single.steps[0])] })); setFlowDirty(true); setTab("flows"); resetEditor(); } }] : []),
    ] }}><Button type="text" icon={<MoreOutlined />} aria-label="更多操作" title="更多操作" /></Dropdown>}<Button aria-label={isFlow ? "保存场景" : "保存用例"} title={isFlow ? "保存场景" : "保存用例"} icon={<SaveOutlined />} disabled={busy || !valid || !draft.steps.length} loading={activeKey === "save"} onClick={save} />{activeKey === "send" && <Button icon={<StopOutlined />} aria-label="取消等待" title="取消等待" onClick={() => api().stopApiDebug(project.id, env)} />}<RunButton iconOnly project={project} env={env} loading={activeKey === "send"} disabled={busy || !valid || !supported || !env || !draft.steps.length} onRun={send}>{isFlow ? "试运行场景" : "发送请求"}</RunButton></Space>
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
    <PageHeader title="接口测试" extra={<Space wrap>
      {tab !== "regression" && (env ? <EnvSelect project={project} value={env} onChange={setEnv} disabled={busy} width={160} /> : <Button size="small" onClick={() => openSettings?.({ addEnv: true })}>配置环境</Button>)}
      <Dropdown trigger={["click"]} menu={{ items: [
        { key: "history", label: "调试历史", icon: <HistoryOutlined /> },
      ], onClick: ({ key }) => { if (key === "history") setHistoryOpen(true); } }}>
        <Button type="text" icon={<MoreOutlined />} aria-label="更多接口工具" title="更多工具" />
      </Dropdown>
      <Button icon={<UploadOutlined />} aria-label="导入接口" title="导入接口" onClick={() => { setPreview(undefined); setImportOpen(true); }} />
    </Space>} />
    {loadError && <Alert type="error" message="接口工作台加载失败" description={loadError} action={<Button onClick={() => void refresh()}>重试</Button>} />}
    <Tabs className="api-workspace-tabs" activeKey={tab} onChange={(next) => {
      if (!valid && ["request", "flows"].includes(tab)) { void message.warning("请先修正当前编辑器中的无效内容"); return; }
      setTab(next);
    }} items={[
      { key: "definitions", label: <span>接口文档{currentDefinitions.length > 0 && <span className="api-tab-badge">{currentDefinitions.length}</span>}</span> },
      { key: "request", label: <span>请求调试{result && <span className={`api-tab-dot ${result.status === "passed" ? "api-tab-dot-pass" : "api-tab-dot-fail"}`} />}</span> },
      { key: "flows", label: <span>业务场景{flows.length > 0 && <span className="api-tab-badge">{flows.length}</span>}</span> },
      { key: "regression", label: "回归执行" },
      { key: "login", label: "登录与加密" },
    ]} />
    {loading ? <div className="api-loading"><Spin tip="正在读取接口资产" /></div> : tab === "login" ? <ApiLoginWorkspace project={project} env={env} onProtocol={() => setProtocolOpen(true)} /> : tab === "regression" ? <div className="api-regression"><RunPage project={project} definitions={regressionDefinitions} onClearScope={() => setRegressionDefinitions(undefined)} /></div> : tab === "flows" ? <div className="api-workbench-layout api-flow-layout">
      <aside className="api-directory"><div className="api-directory-top"><span>业务场景</span><Button size="small" type="text" aria-label="新建业务场景" icon={<PlusOutlined />} onClick={() => askDiscard(flowDirty, () => { setFlow(newDraft("flow")); setFlowDirty(false); setFlowResult(undefined); resetEditor(); })} /></div><div className="api-directory-list">{flows.map((c) => <button className={`api-directory-row ${flow.id === c.id ? "selected" : ""}`} key={c.id} onClick={() => loadCase(c)}><span>{c.title}</span><span className="api-directory-path">{c.api_flow!.length} 个步骤 · {c.api_needs_review ? "接口待检查" : c.status === "reviewed" ? "已审核" : "草稿"}</span></button>)}{!flows.length && <p className="api-muted api-directory-empty">创建场景，将多个请求串成业务流程</p>}</div><div className="api-directory-note">测试集用于批量选择，业务场景负责顺序与依赖</div></aside>
      <main className="api-workbench-main">{executionToolbar}<div className="api-flow-editor"><Collapse ghost items={[{ key: "inputs", label: "场景输入参数", children: <JsonField key={`inputs:${editorKey}`} label="场景输入参数" object value={draft.inputs} onChange={(inputs) => setDraft({ ...draft, inputs })} onValidity={(v) => validity("flow:inputs", v)} rows={4} /> }]} />{flowSteps("steps")}{!flow.steps.length && <div className="api-flow-empty"><span className="api-step-number">1</span><h3>添加第一个业务请求</h3><p>从已导入的接口开始，再为后续步骤提取和引用变量</p><Button icon={<PlusOutlined />} disabled={!currentDefinitions.length} onClick={() => setAddTo("steps")}>选择接口</Button>{!currentDefinitions.length && <Button type="link" onClick={() => setImportOpen(true)}>先导入接口</Button>}</div>}{flowSteps("cleanup")}</div><ExecutionResult result={flowResult} />{flow.id && <div className="api-related-cases"><h4>当前场景</h4>{caseRows(cases.filter((c) => c.id === flow.id))}</div>}</main>
    </div> : <div className={`api-workbench-layout api-catalog-layout${resizingDirectory ? " is-resizing" : ""}`} style={{ "--api-directory-width": `${directoryWidth}px` } as CSSProperties}>{directory}<main className="api-workbench-main">
      {tab === "definitions" ? selected ? <><div className="api-definition-heading"><div><div className="api-overline">{selected.module} <span>定义版本 {selected.revision}</span></div><h2>{selected.summary}</h2><div className="api-definition-path"><Method method={selected.method} /><code>{selected.path}</code></div></div>
          <div className="api-definition-actions">
            <div className="api-definition-cases-badge" onClick={() => { if (related.length) setCasesDrawerOpen(true); }} role={related.length ? "button" : undefined} tabIndex={related.length ? 0 : undefined}>
              <span className="api-definition-cases-count">{related.length}</span>
              <span className="api-definition-cases-label">用例</span>
            </div>
            <Space size={8}>
              <Tooltip title="根据当前接口参数生成测试用例"><Button aria-label="生成用例" icon={<FileAddOutlined />} disabled={busy || selected.removed || selected.unsupported_body} onClick={() => setGenerationDraft(clone(single.steps[0]?.definition_id === selected.id ? single : { ...newDraft("single"), title: `${selected.module}-${selected.summary}`, steps: [selected.request] }))} /></Tooltip>
              <Tooltip title="打开请求调试"><Button type="primary" aria-label="调试此接口" icon={<ApiOutlined />} disabled={selected.removed} onClick={() => { if (!single.steps[0]?.definition_id) selectDefinition(selected, true); else setTab("request"); }} /></Tooltip>
            </Space>
          </div>
        </div>
        <div className="api-definition-meta"><span>来源 {selected.title || selected.source}</span><span>文档版本 {selected.version || "未声明"}</span><span>{selected.request.auth ? "需要鉴权" : "无需鉴权"}</span></div>
        <div className="api-definition-content"><h4>请求参数</h4>{selected.operation.params.length ? <Table size="small" locale={{ emptyText: <span className="api-muted">此接口未声明路径或查询参数</span> }} rowKey={(r) => `${r.location}:${r.name}`} pagination={false} dataSource={selected.operation.params} columns={[{ title: "参数名", dataIndex: "name", render: (v) => <code>{v}</code> }, { title: "位置", dataIndex: "location" }, { title: "类型", dataIndex: "schema", render: (v) => String(v.type ?? "—") }, { title: "必填", dataIndex: "required", render: (v) => v ? "是" : "否" }]} /> : <p className="api-muted api-no-params">无路径或查询参数</p>}
          {selected.operation.body_schema && <Collapse style={{ marginTop: 24 }} items={[{ key: "body", label: "请求体结构", children: <pre className="api-response-code">{JSON.stringify(selected.operation.body_schema, null, 2)}</pre> }]} />}
          <h4 className="api-section-heading">响应定义</h4><Collapse items={Object.entries(selected.operation.responses).map(([status, schema]) => ({ key: status, label: <span className="api-mono">HTTP {status}</span>, children: <pre className="api-response-code">{JSON.stringify(schema, null, 2)}</pre> }))} />
        </div></> : <div className="api-intro-empty">
          <div className="api-onboarding">
            <div className="api-onboarding-hero">
              <div className="api-empty-symbol"><ApiOutlined /></div>
              <h2>{definitions.length ? "选择一个接口开始测试" : "导入接口定义，开始接口测试"}</h2>
              <p className="api-onboarding-desc">{definitions.length ? "在左侧目录中选择接口查看参数与响应定义，或直接进入请求调试" : "支持 OpenAPI 3.x 与 Swagger 2.0，导入后自动保留接口目录与版本变更追踪"}</p>
            </div>
            <div className="api-workflow-steps">
              <Steps size="small" current={definitions.length ? (cases.length ? 2 : 1) : 0} items={[
                { title: "导入接口", description: `${currentDefinitions.length} 个接口`, icon: currentDefinitions.length ? <CheckCircleFilled style={{ color: "var(--console-success)" }} /> : undefined },
                { title: "调试与生成用例", description: `${cases.length} 条用例` },
                { title: "审核通过", description: `${cases.filter((c) => c.status === "reviewed").length} 条已审核` },
                { title: "回归执行", description: "持续验证" },
              ]} />
            </div>
            <div className="api-quick-actions">
              {!currentDefinitions.length ? <>
                <button className="api-action-card api-action-primary" onClick={() => setImportOpen(true)}>
                  <UploadOutlined className="api-action-icon" />
                  <div className="api-action-copy"><strong>导入 OpenAPI 文档</strong><span>从文件或 URL 导入 Swagger / OpenAPI 规范</span></div>
                  <ArrowRightOutlined />
                </button>
                <button className="api-action-card" disabled={busy} onClick={() => run("requirement", async () => {
                  const file = await api().pickFile([{ name: "需求文档", extensions: ["md", "docx", "pdf", "txt"] }]); if (!file) return;
                  await api().generateCases(project.id, file); notifyProjectChanged(project.id); goTab?.("cases");
                })}>
                  <FileTextOutlined className="api-action-icon" />
                  <div className="api-action-copy"><strong>从需求文档生成用例</strong><span>上传需求文档，AI 自动设计测试用例</span></div>
                  <ArrowRightOutlined />
                </button>
              </> : <>
                <button className="api-action-card api-action-primary" onClick={() => selectDefinition(currentDefinitions[0])}>
                  <SendOutlined className="api-action-icon" />
                  <div className="api-action-copy"><strong>打开第一个接口</strong><span>{currentDefinitions[0]?.summary}</span></div>
                  <ArrowRightOutlined />
                </button>
                <button className="api-action-card" onClick={() => setTab("request")}>
                  <ApiOutlined className="api-action-icon" />
                  <div className="api-action-copy"><strong>请求调试</strong><span>发送请求，查看响应和断言结果</span></div>
                  <ArrowRightOutlined />
                </button>
              </>}
            </div>
          </div>
        </div>
        : <>{executionToolbar}{requestEditor(single.steps[0], 0)}{!valid && <Alert type="error" message="请修正参数、JSON 或状态码后继续" />}<ExecutionResult result={result} onAddAssertion={addAssertionFromResponse} /></>}
    </main></div>}
    {generationDraft && <GenerateParameterCases projectId={project.id} draft={generationDraft} result={result} onClose={() => setGenerationDraft(undefined)} onSaved={async () => { notifyProjectChanged(project.id); await refresh(); }} />}
    <Drawer title="导入接口定义" className="api-import-drawer" width={720} footer={preview && <div className="api-import-footer"><span>已选择 <strong>{importKeys.length}</strong> 个接口</span><Button type="primary" loading={activeKey === "import"} disabled={busy || !importKeys.length} onClick={() => run("import", async () => {
          await api().importApiDefinitions(project.id, { ...preview, selected_keys: importKeys }); await refresh(); setImportOpen(false); setPreview(undefined); setImportKeys([]); setTab("definitions"); notifyProjectChanged(project.id);
        }, "接口目录已更新")}>确认导入（{importKeys.length} 项）</Button></div>} open={importOpen} onClose={() => { if (!busy) setImportOpen(false); }} extra={preview && <Button disabled={busy} onClick={() => { setPreview(undefined); setSource(""); }}>重新选择</Button>}>
      {!preview ? <div className="api-import-body">
        <div className="api-import-intro">
          <Typography.Text type="secondary">先预览变更，再确认导入。导入不会自动生成用例或脚本。</Typography.Text>
        </div>
        <div className="api-import-sources">
          {/* 文件导入卡片 */}
          <div className="api-import-source-card">
            <Upload.Dragger accept=".json,.yaml,.yml" showUploadList={false} maxCount={1} disabled={busy}
              customRequest={({ file }) => {
                const f = file as File & { path?: string };
                if (f.path) { void run("pick", async () => acceptPreview(await api().previewApiImport(project.id, f.path!))); }
              }}
              beforeUpload={() => false}>
              <p className="ant-upload-drag-icon"><InboxOutlined /></p>
              <p className="ant-upload-text">拖拽 OpenAPI 文件到此</p>
              <p className="ant-upload-hint">支持 JSON / YAML / YML 格式</p>
            </Upload.Dragger>
            <Button type="primary" ghost style={{ marginTop: 12, width: "100%" }} loading={activeKey === "pick"} disabled={busy}
              icon={<UploadOutlined />} onClick={() => run("pick", async () => {
                const file = await api().pickFile([{ name: "OpenAPI / Swagger", extensions: ["json", "yaml", "yml"] }]);
                if (file) acceptPreview(await api().previewApiImport(project.id, file));
              })}>选择文件</Button>
          </div>
          {/* URL 导入卡片 */}
          <div className="api-import-source-card">
            <div className="api-import-url-card">
              <div className="api-import-url-icon"><LinkOutlined /></div>
              <h4>从文档地址导入</h4>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>输入 Swagger / OpenAPI 规范的 JSON 或 YAML 地址</Typography.Text>
              <Input placeholder="https://example.com/v3/api-docs" value={source} disabled={busy}
                onChange={(e) => setSource(e.target.value)} onPressEnter={() => { if (source.trim()) previewSource(source); }} />
              <Typography.Text type="secondary" style={{ fontSize: 11 }}>请填写规范文件地址，非 Swagger UI 页面</Typography.Text>
              <Button type="primary" style={{ width: "100%", marginTop: 8 }} loading={activeKey === "preview"} disabled={busy || !source.trim()}
                icon={<CloudDownloadOutlined />} onClick={() => previewSource(source)}>预览接口变更</Button>
            </div>
          </div>
        </div>
      </div>
        : <><div className="api-import-summary"><div><h3>{preview.title}</h3><span className="api-muted">版本 {preview.version || "未声明"} · {preview.changes.length} 个接口</span></div></div>
          <div className="api-import-stats">{Object.entries(changeLabels).map(([key, label]) => {
            const count = preview.changes.filter((c) => c.change === key).length;
            return count > 0 && <span key={key} className={`api-import-stat api-import-stat-${key}`}>{label}<strong>{count}</strong></span>;
          })}</div>
          <div className="api-import-selection"><div><h4>选择要导入的模块</h4><p>展开模块可单独选择接口</p></div><Space size={0}><Button type="text" size="small" disabled={busy} onClick={() => setImportKeys(preview.changes.map((c) => `${c.method}:${c.path}`))}>全选</Button><Button type="text" size="small" disabled={busy} onClick={() => setImportKeys([])}>清空</Button></Space></div>
          <Collapse className="api-import-modules" expandIconPosition="end" items={importClusters.map((cluster) => {
            const rows = cluster.rows;
            const keys = rows.map((c) => `${c.method}:${c.path}`);
            const count = keys.filter((key) => importKeys.includes(key)).length;
            return {
              key: JSON.stringify(cluster.modules),
              label: <div className="api-import-module"><Checkbox aria-label={`选择模块 ${cluster.label}`} disabled={busy} checked={count === keys.length} indeterminate={count > 0 && count < keys.length}
                onClick={(e) => e.stopPropagation()} onChange={(e) => setImportKeys((old) => e.target.checked ? [...new Set([...old, ...keys])] : old.filter((key) => !keys.includes(key)))} /><FolderOutlined /><span>{cluster.label}</span>{cluster.modules.length > 1 && <span className="api-import-cluster-badge">相似模块</span>}<span className="api-import-module-count">{count} / {rows.length}</span></div>,
              children: <Table size="small" rowKey={(r) => `${r.method}:${r.path}`} dataSource={rows} pagination={{ pageSize: 10, hideOnSinglePage: true }}
                rowSelection={{ selectedRowKeys: importKeys, onChange: (selected) => setImportKeys((old) => [...old.filter((key) => !keys.includes(key)), ...selected.map(String).filter((key) => keys.includes(key))]), getCheckboxProps: () => ({ disabled: busy }) }}
                columns={[{ title: "接口", render: (_, c) => <><Method method={c.method} /><code className="api-import-path">{c.path}</code><div className="api-muted">{c.summary}{cluster.modules.length > 1 && ` · ${c.module}`}</div></> }, { title: "变更", dataIndex: "change", width: 108, render: (v: keyof typeof changeLabels) => changeLabels[v] }]} />,
            };
          })} /><div className="api-import-note">按文档标签分组，并将名称相似的模块聚类展示；无标签接口归入「未分组」。仅应用勾选项，更新后受影响用例需重新检查。{preview.changes.some((c) => c.change === "removed") && <p>勾选「来源已移除」会将对应接口标记为已移除。</p>}</div></>}
    </Drawer>
    <Drawer title={<span>调试历史 <span className="api-muted" style={{ fontWeight: 400 }}>· 最近 {history.length} 次</span></span>} width={860} open={historyOpen} onClose={() => setHistoryOpen(false)}>
      {!history.length ? <Empty description="暂无调试记录" /> : <>
        <div className="api-history-toolbar">
          <Typography.Text type="secondary">凭据字段已脱敏；点击展开查看响应详情</Typography.Text>
          <Button size="small" type="text" icon={<ReloadOutlined />} onClick={() => void refresh()}>刷新</Button>
        </div>
        <Collapse accordion items={history.map((item) => {
          const total = item.steps.length + item.cleanup.length;
          const passed = [...item.steps, ...item.cleanup].filter((s) => s.status === "passed").length;
          return {
            key: item.id,
            label: <div className="api-history-label">
              <Tag bordered={false} color={item.status === "passed" ? "success" : "error"}>{item.status === "passed" ? "通过" : "失败"}</Tag>
              <span className="api-history-title">{item.title}</span>
              <span className="api-muted api-mono">{passed}/{total}</span>
              <span className="api-muted">{item.env}</span>
              <span className="api-muted">{new Date(item.created_at).toLocaleString()}</span>
            </div>,
            children: <ExecutionResult result={item} />,
          };
        })} />
      </>}
    </Drawer>
    <Drawer title="接口登录与加密" open={protocolOpen} onClose={() => setProtocolOpen(false)} width={640} destroyOnClose><ApiLoginCard project={project} env={env} /></Drawer>
    <Drawer title={<span>此接口的用例 <span className="api-muted" style={{ fontWeight: 400 }}>· {related.length} 条</span></span>} width={800} open={casesDrawerOpen} onClose={() => setCasesDrawerOpen(false)} destroyOnClose>
      {caseRows(related)}
    </Drawer>
    <Modal title={`选择${addTo === "cleanup" ? "清理" : "业务"}接口`} open={Boolean(addTo)} footer={null} onCancel={() => setAddTo(undefined)} width={680}><Input aria-label="筛选场景接口" prefix={<SearchOutlined />} placeholder="搜索接口" value={search} onChange={(e) => setSearch(e.target.value)} /><div className="api-add-steps">{filtered.filter((d) => !d.removed).map((d) => <button key={d.id} onClick={() => {
      const target = addTo!; setFlow((old) => ({ ...old, [target]: [...(old[target] ?? []), { ...clone(d.request), name: d.summary }] })); setFlowDirty(true); setAddTo(undefined); resetEditor();
    }}><Method method={d.method} /><span>{d.summary}<code>{d.path}</code></span><PlusOutlined /></button>)}</div></Modal>
  </div>;
}
