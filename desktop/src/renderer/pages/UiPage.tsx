import { BugOutlined, CaretRightOutlined, CheckOutlined, CloseOutlined, LoginOutlined, MenuFoldOutlined, MenuUnfoldOutlined, PauseOutlined, PoweroffOutlined, RedoOutlined, StepForwardOutlined } from "@ant-design/icons";
import {
  Alert,
  App,
  Badge,
  Button,
  Card,
  Empty,
  Form,
  Input,
  List,
  Row,
  Col,
  Select,
  Space,
  Statistic,
  Steps,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import { useEffect, useRef, useState } from "react";
import type { GlobalSettingsView, UiDebugCommand, UiDebugState, UiScriptState } from "../../shared/ipc";
import { api, envOwner, type Project, type TestCase } from "../api";
import { EvidenceImage } from "../components/EvidenceImage";
import { BrowserDock } from "../components/BrowserDock";
import { CaseLink, CaseTitles } from "../components/CaseLink";
import { ScriptSteps, type StepRunState } from "../components/ScriptSteps";
import { DiffView } from "../components/DiffView";
import { EnvSelect, RunButton, useEnvChoice, NoEnvironment } from "../components/EnvPicker";
import { FAILURE, LabelTag, LINT, MODE } from "../components/labels";
import { useProjects } from "../components/ProjectSettings";
import { RoleAccounts } from "../components/RoleAccounts";
import { PageHeader } from "../components/PageHeader";
import { useAction, useKeyedAction, useLoad, useNarrow, usePaged, useDebounced, useProjectChanged, notifyProjectChanged } from "../hooks";

interface Proposal { id: string; case_id: string; script_path: string; diff: string; reason: string; status: string }
interface Review { id: string; case_id: string; kind: string; description: string; ai_verdict: string; evidence_paths: string[]; status: string }
interface UiFailure { case_id: string; status: string; failure_type: string; message: string; reason?: string }
interface UiRunResult {
  run: { run_id: string; total: number; passed: number; failed: number; error: number; reviews: number };
  heal?: { case_id: string; failure_type: string; reason?: string }[];
  /** 失败明细（规则判定 + agent 自愈结论） */
  failures?: UiFailure[];
  degraded: string[];
  missingData: string[];
  htmlReport: string;
}

export function UiPage({ project }: { project: Project }) {
  const [env, setEnv] = useEnvChoice(project);
  const [working, setWorking] = useState(false);
  const proposals = usePaged<Proposal>(
    (q) => api().pageProposals(project.id, { ...q, status: "pending" }) as Promise<{ items: Proposal[]; total: number }>,
    [project.id], 5);
  const reviews = usePaged<Review>(
    (q) => api().pageReviews(project.id, { ...q, status: "pending" }) as Promise<{ items: Review[]; total: number }>,
    [project.id], 10);
  const [tab, setTab] = useState("workspace");
  const [modelView, setModelView] = useState<GlobalSettingsView>();
  useEffect(() => {
    let disposed = false;
    const update = () => { void api().getGlobalSettings().then((v) => { if (!disposed) setModelView(v); }).catch(() => undefined); };
    update();
    window.addEventListener("aitest:settings", update);
    return () => { disposed = true; window.removeEventListener("aitest:settings", update); };
  }, []);
  const visionModel = modelView?.settings.models.find((m) => m.id === modelView.settings.visionModelId);
  if (!Object.keys(project.environments).length) return <NoEnvironment project={project} purpose="执行 UI 测试" />;
  return <>
    <PageHeader title="UI 测试工作台" description="AI 生成脚本，在内嵌浏览器中校验；确认后加入回归，日常执行不调用模型。"
      extra={<EnvSelect project={project} value={env} onChange={setEnv} disabled={working} showUrl width={260} />} />
    {modelView && <Alert style={{ marginBottom: 16 }} type={visionModel ? "success" : "info"} showIcon
      message={visionModel ? `Midscene 视觉模型已配置：${visionModel.name}` : "Midscene 已集成，尚未选择视觉模型"}
      description={visionModel ? "探索时可用视觉定位辅助生成脚本，视觉判定进入人工复核。实际可用性取决于模型服务；普通回归直接执行脚本。"
        : "在全局设置 → 模型中添加视觉模型并指定用途；启用后可在内嵌浏览器中辅助定位和校验。"} />}
    <Tabs activeKey={tab} onChange={(key) => { if (!working) setTab(key); }} type="card" items={[
      { key: "workspace", label: "生成与校验", forceRender: true, children: <UiWorkbench key={`${project.id}:${env}`} project={project} env={env}
        onWorking={setWorking} onUpdated={async () => { await Promise.all([proposals.reload(), reviews.reload()]); }}
        onProposals={() => setTab("proposals")} /> },
      { key: "proposals", label: <Badge count={proposals.total} size="small" offset={[10, 0]}>脚本修正建议</Badge>, children: <Proposals project={project} paged={proposals} /> },
      { key: "reviews", label: <Badge count={reviews.total} size="small" offset={[10, 0]}>人工复核</Badge>, children: <Reviews project={project} paged={reviews} /> },
      { key: "roles", label: "角色与登录", children: <Roles project={project} env={env} /> },
    ]} />
  </>;
}

/** UI 回归的失败明细与降级用例 */
function UiRunDetail({ project, result }: { project: Project; result: UiRunResult }) {
  const failures = result.failures ?? (result.heal ?? []).map((h) => ({ ...h, status: "failed", message: "" }));
  const rows = [
    ...failures.map((f) => ({ ...f, key: `f:${f.case_id}` })),
    ...result.degraded.map((id) => ({ key: `d:${id}`, case_id: id, status: "degraded", failure_type: "", message: "依赖的测试数据缺失且无法造数，本次未执行", reason: undefined as string | undefined })),
  ];
  if (!rows.length) return null;
  return (
    <Card size="small" title="失败与降级明细" style={{ marginBottom: 16 }}
      extra={<Typography.Text type="secondary">归因在「工程化 → 失败归因」确认</Typography.Text>}>
      <CaseTitles projectId={project.id} ids={rows.map((r) => r.case_id)}>
        <Table size="small" rowKey="key" dataSource={rows} scroll={{ x: 680 }}
          pagination={{ defaultPageSize: 10, size: "small", hideOnSinglePage: true, showTotal: (t) => `共 ${t} 条` }}
          columns={[
            { title: "用例", dataIndex: "case_id", width: 220, render: (id: string) => <CaseLink id={id} /> },
            { title: "结果", dataIndex: "status", width: 90, render: (s: string) =>
              s === "degraded" ? <Tag bordered={false}>降级手工</Tag> : <Tag color="red" bordered={false}>{s === "error" ? "出错" : "失败"}</Tag> },
            { title: "归因", dataIndex: "failure_type", width: 140, render: (v: string) => (v ? <LabelTag map={FAILURE} value={v} /> : "—") },
            { title: "说明", render: (_: unknown, r: { reason?: string; message: string }) => (
              <>
                {r.reason && <div>{r.reason}</div>}
                {r.message && (
                  <Typography.Paragraph type="secondary" className="mono" style={{ marginBottom: 0, fontSize: 12 }}
                    ellipsis={{ rows: 2, expandable: true, symbol: "展开" }}>{r.message}</Typography.Paragraph>
                )}
              </>
            ) },
          ]} />
      </CaseTitles>
    </Card>
  );
}

type Paged<T> = ReturnType<typeof usePaged<T>>;

function Proposals({ project, paged }: { project: Project; paged: Paged<Proposal> }) {
  const { items: data, loading, reload, pagination } = paged;
  const { busy, activeKey, run } = useKeyedAction();
  if (!loading && !data.length) return <Empty description="没有待处理的修改建议" />;
  return (
    <CaseTitles projectId={project.id} ids={data.map((p) => p.case_id)}>
    <List
      loading={loading}
      dataSource={data}
      pagination={{ ...pagination, pageSizeOptions: [5, 10, 20], align: "end" }}
      renderItem={(p) => (
        <Card size="small" style={{ marginBottom: 12 }}
          title={<Space size={12} style={{ minWidth: 0, maxWidth: "100%" }}><CaseLink id={p.case_id} />
            <Typography.Text type="secondary" className="mono" ellipsis style={{ maxWidth: 320 }}>{p.script_path}</Typography.Text></Space>}
          extra={<Space>
            <Button size="small" icon={<CloseOutlined />} loading={activeKey === `reject:${p.id}`} disabled={busy} onClick={() => run(`reject:${p.id}`, async () => { await api().resolveProposal(project.id, p.id, false); await reload(); notifyProjectChanged(project.id); }, "已拒绝")}>拒绝</Button>
            <Button size="small" type="primary" icon={<CheckOutlined />} loading={activeKey === `merge:${p.id}`} disabled={busy} onClick={() => run(`merge:${p.id}`, async () => { await api().resolveProposal(project.id, p.id, true); await reload(); notifyProjectChanged(project.id); }, "已合并并提交到 workspace 的 git")}>合并</Button>
          </Space>}
        >
          {p.reason && <Typography.Paragraph type="secondary">{p.reason}</Typography.Paragraph>}
          <DiffView diff={p.diff} />
        </Card>
      )}
    />
    </CaseTitles>
  );
}

function Reviews({ project, paged }: { project: Project; paged: Paged<Review> }) {
  const { items: data, loading, reload, pagination } = paged;
  const { busy, activeKey, run } = useKeyedAction();
  return (
    <CaseTitles projectId={project.id} ids={data.map((r) => r.case_id)}>
    <Table
      size="small"
      rowKey="id"
      loading={loading}
      dataSource={data}
      scroll={{ x: 720 }}
      locale={{ emptyText: <Empty description="没有待复核的 AI 判定" /> }}
      pagination={{ ...pagination, size: "small" }}
      columns={[
        { title: "用例", dataIndex: "case_id", width: 200, render: (id: string) => <CaseLink id={id} /> },
        { title: "判定内容", dataIndex: "description" },
        { title: "AI 结论", dataIndex: "ai_verdict", width: 100, render: (v: string) =>
          v ? <Tag color={v === "pass" ? "green" : "red"} bordered={false}>{v === "pass" ? "通过" : "不通过"}</Tag> : <Tag bordered={false}>未判定</Tag> },
        { title: "截图", dataIndex: "evidence_paths", width: 120, render: (paths: string[]) => paths?.length
          ? <Space wrap>{paths.map(path => <EvidenceImage key={path} projectId={project.id} path={path} />)}</Space>
          : <Typography.Text type="secondary">无截图</Typography.Text> },
        { title: "", width: 170, render: (_: unknown, r: Review) => (
          <Space>
            <Button size="small" type="primary" ghost loading={activeKey === `pass:${r.id}`} disabled={busy} onClick={() => run(`pass:${r.id}`, async () => { await api().resolveReview(r.id, true); await reload(); })}>通过</Button>
            <Button size="small" danger loading={activeKey === `fail:${r.id}`} disabled={busy} onClick={() => run(`fail:${r.id}`, async () => { await api().resolveReview(r.id, false); await reload(); })}>不通过</Button>
          </Space>
        ) },
      ]}
    />
    </CaseTitles>
  );
}

function UiWorkbench({ project, env, onWorking, onUpdated, onProposals }: {
  project: Project; env: string; onWorking: (working: boolean) => void; onUpdated: () => Promise<void>; onProposals: () => void;
}) {
  const [search, setSearch] = useState("");
  const query = useDebounced(search.trim());
  const [generationStatus, setGenerationStatus] = useState("all");
  const scripts = useLoad(() => api().uiScriptStates(project.id, env), [project.id, env]);
  const scriptIds = Object.entries(scripts.data ?? {}).filter(([, state]) => generationStatus === "ungenerated"
    || (generationStatus === "confirmed" ? state.status === "confirmed"
      : generationStatus === "validated" ? state.status !== "confirmed" && Boolean(state.validatedRunId)
        : state.status !== "confirmed" && !state.validatedRunId)).map(([id]) => id).sort().join(",");
  const cases = usePaged<TestCase>(async (q) => {
    if (generationStatus !== "all" && (!scripts.data || (generationStatus !== "ungenerated" && !scriptIds))) {
      return { items: [], total: 0 };
    }
    return api().pageCases(project.id, { ...q, query: query || undefined,
      filters: { execution_mode: "ui,capture", status: "draft,reviewed",
        ...(generationStatus === "all" ? {} : generationStatus === "ungenerated" ? { exclude_ids: scriptIds || undefined } : { ids: scriptIds }) },
    }) as Promise<{ items: TestCase[]; total: number }>;
  }, [project.id, query, generationStatus, generationStatus === "all" ? "" : scriptIds, Boolean(scripts.data)], 15);
  const [current, setCurrent] = useState<TestCase>();
  const [selected, setSelected] = useState<string[]>([]);
  const [listCollapsed, setListCollapsed] = useState(false);
  // 工作台较窄时自动收起用例列表，保证内嵌浏览器留在首屏
  const [benchRef, narrow] = useNarrow<HTMLDivElement>(1040);
  // 只恢复自动收起的列表；用户手动收起的保持不变
  const autoCollapsed = useRef(false);
  useEffect(() => {
    if (narrow && !listCollapsed) { autoCollapsed.current = true; setListCollapsed(true); }
    if (!narrow && autoCollapsed.current) { autoCollapsed.current = false; setListCollapsed(false); }
  }, [narrow]); // eslint-disable-line react-hooks/exhaustive-deps
  const toggleList = (collapsed: boolean) => { autoCollapsed.current = false; setListCollapsed(collapsed); };
  const [feedback, setFeedback] = useState("");
  const [result, setResult] = useState<UiRunResult>();
  const [conclusion, setConclusion] = useState("");
  /** AI 生成结束但没有保存出脚本时，结论按警告显示 */
  const [conclusionFailed, setConclusionFailed] = useState(false);
  const [logs, setLogs] = useState<{ title: string; status: string; caseId?: string }[]>([]);
  /** 当前用例每个脚本步骤的执行状态（来自 test.step 进度） */
  const [stepStates, setStepStates] = useState<Record<string, StepRunState>>({});
  /** 单步调试会话（主进程持有，页面重新进入时恢复） */
  const [debug, setDebug] = useState<UiDebugState | null>(null);
  const { busy, activeKey, run: runAction } = useKeyedAction();
  const [stopping, setStopping] = useState(false);
  const run = <T,>(key: string, action: () => Promise<T>, success?: string) => runAction(key, async () => {
    try { return await action(); }
    catch (error) {
      if (!(error as Error).message.includes("UI_TASK_STOPPED")) throw error;
      setLogs(old => old.map(log => log.status === "running" ? { ...log, status: "stopped" } : log));
      setStepStates(old => Object.fromEntries(Object.entries(old).filter(([, state]) => state.status !== "running")));
      setConclusionFailed(false);
      setConclusion("任务已停止，可继续操作。已保存的脚本会保留，请校验后再确认。");
      await refresh();
      return undefined;
    } finally { setStopping(false); }
  }, success);
  const stopAction = useAction();
  const stoppable = ["generate", "validate", "regression", "revise"].includes(activeKey ?? "");
  useEffect(() => { if (!stoppable) setStopping(false); }, [stoppable]);
  const stop = () => stopAction.run(async () => {
    setStopping(true);
    try { await api().stopUiTask(project.id, env); }
    catch (error) { setStopping(false); throw error; }
  });
  const locked = busy || Boolean(debug);
  const { modal } = App.useApp();
  const script = current && scripts.data?.[current.id];
  // 脚本内容变化（hash）后重新读取步骤
  const detail = useLoad(async () => current && script ? api().uiScriptDetail(project.id, env, current.id) : null,
    [project.id, env, current?.id, script?.hash]);
  useEffect(() => { onWorking(locked); return () => onWorking(false); }, [locked, onWorking]);
  useEffect(() => {
    let alive = true;
    void api().uiDebugState().then(async (s) => {
      if (!alive || !s || s.projectId !== project.id || s.env !== env) return;
      setDebug(s);
      const c = await api().getCase(s.caseId) as TestCase | undefined;
      if (alive && c) setCurrent(c);
    });
    return () => { alive = false; };
  }, [project.id, env]);
  useEffect(() => api().onEvent((event) => {
    const p = event.params as { projectId?: string; env?: string; stage?: string; title?: string; status?: string; caseId?: string;
      stepId?: string; kind?: string; error?: string; state?: UiDebugState };
    if (event.method === "aitest/progress" && p?.stage === "ui-debug" && p.state?.projectId === project.id && p.state.env === env) {
      setDebug(p.state.phase === "stopped" ? null : p.state);
      return;
    }
    if (event.method !== "aitest/progress" || p?.projectId !== project.id || p.env !== env || p.stage !== "ui-step" || !p.title) return;
    setLogs(old => [...old.slice(-99), { title: p.title!, status: p.status ?? "running", caseId: p.caseId }]);
    if (p.kind === "step" && p.stepId && p.caseId === current?.id) {
      const status = p.status === "failed" ? "failed" : p.status === "passed" ? "passed" : "running";
      setStepStates(old => ({ ...old, [p.stepId!]: { status, ...(p.error ? { error: p.error } : {}) } }));
    }
  }), [project.id, env, current?.id]);
  const refresh = async () => { await Promise.all([scripts.reload(), cases.reload(), onUpdated()]); };
  useProjectChanged(project.id, () => { if (!busy) void refresh(); });
  const choose = (c: TestCase) => { if (locked) return; setCurrent(c); setFeedback(""); setConclusion(""); setLogs([]); setStepStates({}); };
  const generate = (confirmProduction: boolean) => current && run("generate", async () => {
    setLogs([]); setConclusion(""); setStepStates({});
    const out = await api().exploreUiCase(project.id, env, current.id, { confirmProduction }) as { message?: string; status?: string; scriptGenerated?: boolean };
    setConclusionFailed(out?.scriptGenerated === false);
    setConclusion(out?.message || "生成任务已结束，请完成可视化校验并确认脚本。");
    await refresh();
    notifyProjectChanged(project.id);
  });
  const validate = (confirmProduction: boolean) => current && run("validate", async () => {
    setLogs([]); setStepStates({});
    setResult(await api().runUiRegression(project.id, env, true, { caseIds: [current.id], mode: "validate", embedded: true, confirmProduction }) as UiRunResult);
    await refresh();
    notifyProjectChanged(project.id);
  });
  const regress = (confirmProduction: boolean) => run("regression", async () => {
    setLogs([]); setStepStates({});
    setResult(await api().runUiRegression(project.id, env, false, { caseIds: selected, mode: "regression", confirmProduction }) as UiRunResult);
    await refresh();
    notifyProjectChanged(project.id);
  });
  const startDebug = (confirmProduction: boolean) => current && run("debug:start", async () => {
    setStepStates({}); setLogs([]);
    setDebug(await api().uiDebugStart(project.id, env, current.id, { confirmProduction }));
  });
  const debugCmd = (command: UiDebugCommand) => run(`debug:${command.type}`, async () => {
    const s = await api().uiDebugCommand(command);
    setDebug(s.phase === "stopped" ? null : s);
  });
  const debugging = debug && current && debug.caseId === current.id ? debug : undefined;
  const debugRunning = debugging?.phase === "running";
  const revise = (confirmProduction: boolean) => current && run("revise", async () => {
    const out = await api().reviseUiScript(project.id, env, current.id, feedback, { confirmProduction }) as { message?: string };
    setConclusionFailed(false);
    setConclusion(out?.message || "修正任务已结束，请查看脚本修正建议。");
    await refresh();
  });
  const stateTag = (s?: UiScriptState) => !s ? <Tag bordered={false}>未生成</Tag> : s.status === "confirmed"
    ? <Tag color="green" bordered={false}>已确认</Tag> : <Tag color="orange" bordered={false}>{s.validatedRunId ? "试跑通过 · 待确认" : "待校验"}</Tag>;
  const step = !script ? 0 : script.status === "confirmed" ? 3 : script.validatedRunId ? 2 : 1;
  return <>
    <Steps size="small" current={step} style={{ marginBottom: 16 }} items={[
      { title: "AI 生成" }, { title: "内嵌校验" }, { title: "确认脚本" }, { title: "执行回归" },
    ]} />
    {stoppable && <div style={{ marginBottom: 12, textAlign: "right" }}>
      <Button danger icon={<PoweroffOutlined />} loading={stopping} onClick={stop}>停止当前任务</Button>
    </div>}
    <div ref={benchRef} className={`ui-workbench ${listCollapsed ? "list-collapsed" : ""} ${narrow ? "narrow" : ""}`}>
      {listCollapsed ? (
        <div className="ui-case-rail">
          <Tooltip title="展开用例列表" placement="right">
            <Button size="small" type="text" icon={<MenuUnfoldOutlined />} aria-label="展开用例列表" onClick={() => toggleList(false)} />
          </Tooltip>
          <Typography.Text type="secondary" className="ui-case-rail-label">UI 用例 · {cases.pagination.total}</Typography.Text>
        </div>
      ) : (
      <Card size="small" title={`UI 用例 · ${cases.pagination.total}`} className="ui-case-list"
        extra={<Tooltip title="收起用例列表"><Button size="small" type="text" icon={<MenuFoldOutlined />} aria-label="收起用例列表" onClick={() => toggleList(true)} /></Tooltip>}>
        <Input.Search allowClear placeholder="搜索标题、模块或用例 ID" value={search} onChange={e => setSearch(e.target.value)} disabled={locked} style={{ marginBottom: 12 }} />
        <Select value={generationStatus} onChange={setGenerationStatus} disabled={locked}
          aria-label="生成状态" style={{ width: "100%", marginBottom: 12 }} options={[
            { value: "all", label: "全部生成状态" },
            { value: "ungenerated", label: "未生成" },
            { value: "pending", label: "待校验" },
            { value: "validated", label: "试跑通过 · 待确认" },
            { value: "confirmed", label: "已确认" },
          ]} />
        <Table size="small" rowKey="id" loading={cases.loading || scripts.loading} dataSource={cases.items}
          rowClassName={c => current?.id === c.id ? "ui-case-active" : ""}
          onRow={c => ({ onClick: () => choose(c), style: { cursor: locked ? "default" : "pointer" } })}
          rowSelection={{ selectedRowKeys: selected, preserveSelectedRowKeys: true, columnWidth: 32, onChange: keys => setSelected(keys as string[]),
            getCheckboxProps: c => ({ disabled: locked || c.status !== "reviewed" || scripts.data?.[c.id]?.status !== "confirmed" || c.lint_status === "blocked" }) }}
          pagination={{ ...cases.pagination, size: "small", simple: true, pageSizeOptions: [15, 30, 50, 100] }}
          columns={[
            { title: "标题", dataIndex: "title", render: (title: string, c: TestCase) => <div><Typography.Text>{title}</Typography.Text><div style={{ marginTop: 4 }}>
              {stateTag(scripts.data?.[c.id])}<LabelTag map={MODE} value={c.execution_mode} /><LabelTag map={LINT} value={c.lint_status} />{c.status !== "reviewed" && <Tag bordered={false}>用例待审核</Tag>}
            </div></div> },
          ]} />
        <div style={{ marginTop: 12 }}>
          <RunButton project={project} env={env} block loading={activeKey === "regression"} disabled={locked || !selected.length} onRun={regress}>执行选中回归（{selected.length}）</RunButton>
          <Typography.Text type="secondary" style={{ display: "block", marginTop: 6, fontSize: 12 }}>仅可选择已审核用例的已确认脚本</Typography.Text>
        </div>
      </Card>
      )}
      <Card size="small" title={current ? current.title : "用例校验"} className="ui-case-detail" extra={stateTag(script)}>
        {!current ? <Empty description="从左侧选择一条用例，生成并校验脚本" /> : <>
          <Space wrap style={{ marginBottom: 12 }}>
            <RunButton project={project} env={env} loading={activeKey === "generate"} disabled={locked || Boolean(script) || current.lint_status === "blocked"} onRun={generate}>AI 生成脚本</RunButton>
            <RunButton project={project} env={env} loading={activeKey === "validate"} disabled={locked || !script || current.lint_status === "blocked"} onRun={validate}>内嵌试跑校验</RunButton>
            <Tooltip title={detail.data && (!detail.data.steps || !detail.data.synced) ? "脚本没有结构化步骤或已被修改，无法单步调试" : "逐步回放到内嵌浏览器，失败时停住现场；不计入校验"}>
              <span><Button icon={<BugOutlined />} loading={activeKey === "debug:start"} disabled={locked || !detail.data?.steps || !detail.data.synced || current.lint_status === "blocked"}
                onClick={() => project.environments[env]?.production
                  ? modal.confirm({ title: `在生产环境「${env}」上调试？`, content: "回放会向线上地址发起真实操作。", okButtonProps: { danger: true }, okText: "确认", cancelText: "取消", onOk: () => startDebug(true) })
                  : startDebug(false)}>单步调试</Button></span>
            </Tooltip>
            <Button type="primary" icon={<CheckOutlined />} loading={activeKey === "confirm"} disabled={locked || !script?.validatedRunId || script.status === "confirmed"}
              onClick={() => script && run("confirm", async () => { await api().confirmUiScript(project.id, env, current.id, script.hash); await refresh(); setSelected([]); }, "当前脚本版本已确认，可加入回归")}>确认脚本</Button>
          </Space>
          {current.preconditions.length > 0 && <div><Typography.Text strong>前置条件</Typography.Text><ul className="case-steps">{current.preconditions.map((p, i) => <li key={i}>{p}</li>)}</ul></div>}
          {debugging && (
            <div className="debug-bar">
              <Tag bordered={false} color={debugRunning ? "processing" : debugging.phase === "finished" ? "success" : "warning"} style={{ marginInlineEnd: 0 }}>
                {debugRunning ? "执行中" : debugging.phase === "finished" ? "已执行完" : "已暂停"}
              </Tag>
              <Space size={4} wrap>
                <Tooltip title="连续执行，遇到断点、失败或暂停时停下"><Button size="small" type="primary" icon={<CaretRightOutlined />} disabled={busy || debugRunning || debugging.phase === "finished"} onClick={() => debugCmd({ type: "continue" })}>继续</Button></Tooltip>
                <Tooltip title="只执行游标处的一步（失败时即重试）"><Button size="small" icon={<StepForwardOutlined />} disabled={busy || debugRunning || debugging.phase === "finished"} onClick={() => debugCmd({ type: "step" })}>单步</Button></Tooltip>
                <Tooltip title="当前步骤执行完后停下"><Button size="small" icon={<PauseOutlined />} disabled={!debugRunning} onClick={() => debugCmd({ type: "pause" })}>暂停</Button></Tooltip>
                <Tooltip title="不执行游标处的步骤，直接到下一步"><Button size="small" disabled={busy || debugRunning || debugging.phase === "finished"} onClick={() => debugCmd({ type: "skip" })}>跳过</Button></Tooltip>
                <Tooltip title="清空状态，游标回到第一步（页面不重置，首步通常会重新打开页面）"><Button size="small" icon={<RedoOutlined />} disabled={busy || debugRunning} onClick={() => debugCmd({ type: "restart" })}>从头</Button></Tooltip>
                <Button size="small" danger icon={<PoweroffOutlined />} disabled={busy} onClick={() => debugCmd({ type: "stop" })}>结束调试</Button>
              </Space>
              {debugging.message && <Typography.Text type={Object.values(debugging.statuses).some((x) => x.status === "failed") && !debugRunning ? "danger" : "secondary"} style={{ fontSize: 12, width: "100%" }}>{debugging.message}</Typography.Text>}
              <Typography.Text type="secondary" style={{ fontSize: 12, width: "100%" }}>暂停时可直接在右侧浏览器中操作核对；调试结果不计入校验，确认脚本前仍需完整试跑一次。</Typography.Text>
            </div>
          )}
          <ScriptSteps caseSteps={current.steps} expected={current.expected} detail={detail.data}
            states={debugging ? debugging.statuses : stepStates}
            debug={debugging && {
              cursor: debugging.phase === "finished" ? undefined : debugging.cursor, breakpoints: debugging.breakpoints, running: debugRunning || busy,
              onBreakpoint: (id) => debugCmd({ type: "breakpoint", stepId: id }),
              onRunTo: (id) => debugCmd({ type: "runTo", stepId: id }),
              onSeek: (id) => debugCmd({ type: "seek", stepId: id }),
            }} />
          <Typography.Text strong style={{ display: "block", marginTop: 16, marginBottom: 6 }}>修正反馈</Typography.Text>
          <Input.TextArea value={feedback} onChange={e => setFeedback(e.target.value)} disabled={locked} maxLength={8000} showCount rows={3}
            placeholder="对照右侧浏览器描述需要修正的步骤，例如：S3 应点击近 30 日，并断言趋势图重新加载" />
          <Space wrap style={{ marginTop: 24 }}>
            <RunButton project={project} env={env} loading={activeKey === "revise"} disabled={locked || !script || !feedback.trim()} onRun={revise}>让 AI 提出修正</RunButton>
            <Button disabled={locked} onClick={onProposals}>查看修改差异</Button>
          </Space>
          {conclusion && (conclusionFailed
            ? <Alert type="warning" showIcon style={{ marginTop: 16 }} message={conclusion.split("\n")[0]}
                description={<Typography.Paragraph style={{ whiteSpace: "pre-wrap", marginBottom: 0 }} ellipsis={{ rows: 6, expandable: true }}>{conclusion.split("\n").slice(1).join("\n")}</Typography.Paragraph>} />
            : <Typography.Paragraph style={{ marginTop: 16, whiteSpace: "pre-wrap" }} ellipsis={{ rows: 5, expandable: true }}>{conclusion}</Typography.Paragraph>)}
        </>}
      </Card>
      <div className="ui-browser-col">
        <BrowserDock url={project.environments[env]?.base_url} />
        {((busy && (activeKey === "validate" || activeKey === "generate")) || debugRunning) && (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>执行中请勿操作浏览器，等待结束后再手动核对页面。</Typography.Text>
        )}
      </div>
    </div>
    {logs.length > 0 && <Card size="small" title={busy ? "执行过程" : "最近执行过程"} style={{ marginTop: 16 }}>
      <div className="ui-execution-log">{logs.map((log, i) => <div key={i}><Tag color={log.status === "failed" ? "red" : log.status === "passed" ? "green" : "blue"}>{log.status === "failed" ? "失败" : log.status === "passed" ? "通过" : log.status === "stopped" ? "已停止" : "执行中"}</Tag><Typography.Text className="mono">{log.title}</Typography.Text></div>)}</div>
    </Card>}
    {result && <Card size="small" title={`最近执行 · ${result.run.run_id}`} style={{ marginTop: 16 }}>
      <Space wrap size="large"><Statistic title="执行用例" value={result.run.total} /><Statistic title="通过" value={result.run.passed} /><Statistic title="失败 / 出错" value={result.run.failed + result.run.error} /><Statistic title="待人工复核" value={result.run.reviews} /></Space>
      {result.missingData.length > 0 && <Alert type="warning" style={{ marginTop: 12 }} message={`缺少测试数据：${result.missingData.join("、")}`} />}
      <div style={{ marginTop: 12 }}><Button disabled={locked} onClick={() => run("report", () => api().openPath(result.htmlReport))}>打开 Playwright 报告</Button></div>
      <UiRunDetail project={project} result={result} />
    </Card>}
  </>;
}

/** 角色账号与登录方式。子项目显示继承自大项目的角色；登录方式保存到环境所在的项目（继承的环境保存到大项目） */
export function Roles({ project, env }: { project: Project; env: string }) {
  const [loginForm] = Form.useForm();
  const { busy, run } = useAction();
  const { reload: reloadProjects, projects } = useProjects();
  const owner = env ? envOwner(project, env) : project.id;
  const ownerName = owner !== project.id ? projects.find((p) => p.id === owner)?.name : undefined;
  const login = (project.environments[env] as { login?: Record<string, string> })?.login ?? {
    url: "/login", username: "#username", password: "#password", submit: "button[type=submit]", success: "",
  };
  // 表单实例跨环境复用，切换环境（或保存后配置刷新）时必须换成该环境的值，否则会把上一个环境的登录方式存到当前环境
  const loginKey = JSON.stringify(login);
  useEffect(() => {
    loginForm.resetFields();
    loginForm.setFieldsValue(login);
  }, [env, loginKey]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="split">
      <div style={{ flex: "1 1 320px" }}>
        <RoleAccounts project={project} />
      </div>
      <div style={{ flex: "1.2 1 380px" }}>
        <Card size="small" title={`登录方式（${env} 环境${ownerName ? `，保存到大项目「${ownerName}」` : ""}）`} extra={<Typography.Text type="secondary">填写 CSS 选择器</Typography.Text>}>
          <Form form={loginForm} name="login-recipe" layout="vertical" initialValues={login} key={env}
            onFinish={(v) => run(async () => {
              await api().setEnvironment(owner, env, { ...project.environments[env], login: Object.fromEntries(Object.entries(v).filter(([, x]) => x)) });
              // 刷新项目数据，否则之后再保存环境配置会用旧值覆盖登录方式
              await reloadProjects();
            }, "登录方式已保存")}>
            <Form.Item name="url" label="登录页地址" rules={[{ required: true }]}><Input placeholder="/login" /></Form.Item>
            <Row gutter={8}>
              <Col span={8}><Form.Item name="username" label="账号输入框" rules={[{ required: true }]}><Input className="mono" /></Form.Item></Col>
              <Col span={8}><Form.Item name="password" label="密码输入框" rules={[{ required: true }]}><Input className="mono" /></Form.Item></Col>
              <Col span={8}><Form.Item name="submit" label="登录按钮" rules={[{ required: true }]}><Input className="mono" /></Form.Item></Col>
            </Row>
            <Form.Item name="success" label="登录成功后 URL 包含" extra="留空则等待页面网络空闲"><Input placeholder="/dashboard" /></Form.Item>
            <Button htmlType="submit" loading={busy}>保存登录方式</Button>
          </Form>
        </Card>
        <ManualLogin project={project} env={env} />
      </div>
    </div>
  );
}

/** 手动登录：验证码、扫码等无法自动登录时，用户在角色的内嵌浏览器里亲自登录一次 */
function ManualLogin({ project, env }: { project: Project; env: string }) {
  const roles = useLoad(() => api().listRoles(project.id), [project.id]);
  const sessions = useLoad(() => api().roleSessions(project.id), [project.id]);
  // 左侧新增角色后刷新可选角色
  useProjectChanged(project.id, () => { void roles.reload(); void sessions.reload(); });
  const [role, setRole] = useState<string>();
  const [opened, setOpened] = useState(false);
  const { busy, activeKey, run } = useKeyedAction();
  useEffect(() => { setOpened(false); }, [env, role]);
  const names = (roles.data ?? []).map((r) => r.role_name);
  const saved = sessions.data ?? {};
  return (
    <Card size="small" title="手动登录" style={{ marginTop: 16 }} extra={<Typography.Text type="secondary">适合验证码、扫码等无法自动登录的系统</Typography.Text>}>
      <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
        在内嵌浏览器中以某个角色亲自登录一次（{env} 环境）：AI 探索、单步调试、内嵌试跑直接沿用这份登录态；保存后无头回归也会使用。登录过期后重新登录即可。
      </Typography.Paragraph>
      {!names.length && !roles.loading ? <Alert type="info" showIcon message="先在左侧添加角色（只填角色名即可，不需要账号密码）" /> : <>
        <Space wrap>
          <Select placeholder="选择角色" style={{ width: 200 }} value={role} onChange={setRole} loading={roles.loading}
            options={names.map((n) => ({ value: n, label: saved[n] ? `${n}（已保存登录态）` : n }))} />
          <Button icon={<LoginOutlined />} disabled={!role || busy} loading={activeKey === "open"}
            onClick={() => run("open", async () => { await api().openRoleLogin(project.id, env, role!); setOpened(true); })}>打开登录页</Button>
          <Button type="primary" icon={<CheckOutlined />} disabled={!role || !opened || busy} loading={activeKey === "save"}
            onClick={() => run("save", async () => {
              const out = await api().saveRoleLogin(project.id, env, role!);
              await sessions.reload();
              return out;
            }, "登录态已保存")}>已完成登录，保存登录态</Button>
        </Space>
        {opened && <Alert type="warning" showIcon style={{ marginTop: 12 }}
          message="在右侧内嵌浏览器中完成登录（含验证码），看到登录后的页面再点「已完成登录，保存登录态」"
          description="AI 探索、单步调试和内嵌试跑共用这个角色的浏览器，不保存也会沿用；保存是为了让无头回归也能使用。" />}
        {Object.keys(saved).length > 0 && (
          <div style={{ marginTop: 12 }}>
            {Object.entries(saved).map(([n, at]) => (
              <div key={n}><Tag bordered={false} color="green">{n}</Tag><Typography.Text type="secondary">登录态保存于 {new Date(at).toLocaleString()}</Typography.Text></div>
            ))}
          </div>
        )}
      </>}
    </Card>
  );
}
