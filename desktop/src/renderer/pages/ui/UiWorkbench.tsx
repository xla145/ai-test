import { useAssistantPageContext } from "../../assistant/AssistantContext";
import { readIssue, writeIssue } from "./issueHistory";
import { useUiTasks, isUiTaskActive } from "../../components/UiTasks";
import {
  ArrowUpOutlined, BugOutlined, CodeOutlined, CaretRightOutlined, CheckCircleFilled, CheckOutlined, CloseOutlined, ExclamationCircleFilled, LoadingOutlined,
  MenuFoldOutlined, MenuUnfoldOutlined, PauseOutlined, BranchesOutlined, PoweroffOutlined, RedoOutlined, MoreOutlined, SearchOutlined, SettingOutlined, StepForwardOutlined, WarningFilled,
} from "@ant-design/icons";
import { App, Button, Checkbox, Dropdown, Empty, Input, Popover, Progress, Segmented, Select, Space, Spin, Switch, Table, Tag, Tooltip, Typography } from "antd";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { UiCaseGroup, UiDebugCommand, UiDebugState, UiGroupCase, UiScriptState } from "../../../shared/ipc";
import { reviewedUiGroups } from "../../../shared/reviewedUiGroups";
import { UiCaseTree } from "./UiCaseTree";
import { api, type Project, type TestCase } from "../../api";
import { BrowserDock } from "../../components/BrowserDock";
import { CaseLink, CaseTitles } from "../../components/CaseLink";
import { FAILURE, LabelTag } from "../../components/labels";
import { ExecutionIssue } from "../../components/ExecutionIssue";
import { CaseEditor } from "../../components/CaseEditor";
import { ScriptSteps, type StepRunState } from "../../components/ScriptSteps";
import { notifyProjectChanged, useAction, useKeyedAction, useLoad, useProjectChanged } from "../../hooks";

interface UiFailure { case_id: string; status: string; failure_type: string; message: string; reason?: string }
interface UiRunResult {
  run: { run_id: string; total: number; passed: number; failed: number; error: number; reviews: number; acceptance?: Record<string, number> };
  heal?: { case_id: string; failure_type: string; reason?: string }[];
  /** 失败明细（规则判定 + agent 自愈结论） */
  failures?: UiFailure[];
  degraded: string[];
  missingData: string[];
  htmlReport: string;
  sessionId?: string;
  validationIssues?: Record<string, string>;
}

/** 脚本所处阶段：未生成 → 待校验 → 待确认（试跑通过）→ 已确认 */
type Stage = "none" | "pending" | "validated" | "confirmed";
const stageOf = (s?: UiScriptState): Stage => (!s ? "none" : s.status === "confirmed" ? "confirmed" : s.validatedRunId ? "validated" : "pending");
const STAGES: { key: Stage; label: string; hint: string }[] = [
  { key: "none", label: "未生成", hint: "还没有脚本，交给 AI 生成" },
  { key: "pending", label: "待校验", hint: "脚本已生成，需要试跑一次" },
  { key: "validated", label: "待确认", hint: "试跑通过，确认后加入回归" },
  { key: "confirmed", label: "已确认", hint: "可执行回归，不再调用模型" },
];
const STAGE_LABEL = Object.fromEntries(STAGES.map((s) => [s.key, s.label])) as Record<Stage, string>;
const FLOW_SHORT = ["生成", "试跑", "确认", "回归"];
const FLOW_INDEX: Record<Stage, number> = { none: 0, pending: 1, validated: 2, confirmed: 3 };

const AUTO_VALIDATE_KEY = "aitest:ui:auto-validate";
const WORKERS_KEY = "aitest:ui:workers";
const pref = (key: string) => { try { return localStorage.getItem(key); } catch { return null; } };
const savePref = (key: string, value: string) => { try { localStorage.setItem(key, value); } catch { /* 仅偏好，存不了就用默认值 */ } };
const isStopped = (error: unknown) => (error as Error)?.message?.includes("UI_TASK_STOPPED");
const passed = (r: UiRunResult) => r.run.passed > 0 && r.run.passed === r.run.total && r.run.failed + r.run.error === 0 && !r.run.reviews && !r.degraded.length && !Object.keys(r.validationIssues ?? {}).length;
const cleanError = (error: unknown) => String((error as Error)?.message ?? error).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

type Phase = "explore" | "validate" | "derive" | "batch";
interface PipelineProgress { done: number; total: number; title: string; phase: Phase }
interface PipelineSummary {
  total: number;
  /** AI 探索生成的脚本数 */
  explored: number;
  /** 按参数替换生成的脚本数 */
  derived: number;
  validated: number;
  failed: { id: string; title: string; reason: string }[];
  stopped: boolean;
  autoValidate: boolean;
}
const PHASE_TEXT: Record<Phase, string> = { explore: "AI 正在探索并生成", validate: "正在试跑", derive: "按参数生成同组脚本", batch: "并行试跑" };

export function UiWorkbench({ project, env, pendingProposals, onWorking, onUpdated, onInbox }: {
  project: Project; env: string; pendingProposals: number;
  onWorking: (working: boolean) => void; onUpdated: () => Promise<void>; onInbox: () => void;
}) {
  const { modal, message } = App.useApp();
  const benchRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const bench = benchRef.current;
    const page = bench?.closest<HTMLElement>(".page");
    if (!bench || !page) return;
    const measure = () => {
      // 使用滚动前的布局位置，滚动页面不会反过来改变面板高度。
      const top = bench.getBoundingClientRect().top - page.getBoundingClientRect().top + page.scrollTop;
      const available = Math.max(280, Math.floor(page.clientHeight - top - 16));
      bench.style.setProperty("--uix-available-height", `${available}px`);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(page);
    // 顶部提示、工具栏等高度变化时重新计算，但不监听面板自身，避免反馈循环。
    let ancestor: HTMLElement | null = bench;
    while (ancestor && ancestor !== page) {
      for (let sibling = ancestor.previousElementSibling; sibling; sibling = sibling.previousElementSibling) observer.observe(sibling);
      ancestor = ancestor.parentElement;
    }
    measure();
    return () => observer.disconnect();
  });

  const production = Boolean(project.environments[env]?.production);
  const baseUrl = project.environments[env]?.base_url;
  const roles = useLoad(() => api().listRoles(project.id), [project.id]);
  const rolePreference = `aitest:ui:role:${JSON.stringify([project.id, env])}`;
  const [selectedRole, setSelectedRole] = useState<string | undefined>(() => pref(rolePreference) || undefined);
  const changeRole = (role?: string) => run("session", async () => {
    if (baseUrl) await api().openTestPage(baseUrl, { projectId: project.id, env, role });
    setSelectedRole(role); savePref(rolePreference, role ?? "");
  });
  useProjectChanged(project.id, () => { void roles.reload(); });

  // ---- 数据：脚本状态 + 用例分组（同脚本、不同参数的用例归为一组） ----
  const [search, setSearch] = useState("");
  const query = search.trim().toLowerCase();
  const [filter, setFilter] = useState<Stage | "all">("all");
  const scripts = useLoad(() => api().uiScriptStates(project.id, env), [project.id, env]);
  const groupsLoad = useLoad(() => api().uiCaseGroups(project.id), [project.id]);
  const groups = useMemo(() => reviewedUiGroups(groupsLoad.data ?? []), [groupsLoad.data]);
  const stageById = (id: string) => stageOf(scripts.data?.[id]);
  const index = useMemo(() => {
    const groupOf = new Map<string, UiCaseGroup>();
    const caseOf = new Map<string, UiGroupCase>();
    for (const g of groups) for (const c of g.cases) { groupOf.set(c.id, g); caseOf.set(c.id, c); }
    return { groupOf, caseOf };
  }, [groups]);
  const counts = useMemo(() => {
    if (!scripts.data || !groupsLoad.data) return undefined;
    const out = { all: 0, none: 0, pending: 0, validated: 0, confirmed: 0 };
    for (const g of groups) for (const c of g.cases) { out.all++; out[stageOf(scripts.data[c.id])]++; }
    return out;
  }, [groups, scripts.data, groupsLoad.data]);
  /** 筛选后的列表：组内只保留匹配的成员 */
  const visible = useMemo(() => groups.map((g) => ({
    group: g,
    cases: g.cases.filter((c) => (filter === "all" || stageOf(scripts.data?.[c.id]) === filter)
      && (!query || `${c.title} ${c.id} ${c.variant} ${g.label} ${(c.module_path ?? []).join(" / ")}`.toLowerCase().includes(query))),
  })).filter((v) => v.cases.length), [groups, scripts.data, filter, query]);
  const visibleCount = visible.reduce((n, v) => n + v.cases.length, 0);
  /** 一组里可以当模板的脚本：优先已确认，其次试跑通过 */
  const templateOf = (g: UiCaseGroup, except?: string) => {
    const rank: Record<Stage, number> = { confirmed: 3, validated: 2, pending: 1, none: 0 };
    return g.cases.filter((c) => c.id !== except && stageById(c.id) !== "none").sort((a, b) => rank[stageById(b.id)] - rank[stageById(a.id)])[0];
  };

  // ---- 当前用例与界面状态 ----
  const [current, setCurrent] = useState<TestCase>();
  const [editing, setEditing] = useState<TestCase>();
  const currentId = useRef<string>();
  currentId.current = current?.id;
  const [selected, setSelected] = useState<Record<string, UiGroupCase>>({});
  useAssistantPageContext({ projectId: project.id, page: "ui", env, references: (Object.keys(selected).length ? Object.keys(selected) : current ? [current.id] : []).map(id => ({ kind: "case", id })) });
  const [listCollapsed, setListCollapsed] = useState(false);
  const [compactPanel, setCompactPanel] = useState<"cases" | "steps">("cases");
  const toggleList = (collapsed: boolean) => setListCollapsed(collapsed);
  const [autoValidate, setAutoValidate] = useState(() => pref(AUTO_VALIDATE_KEY) !== "0");
  const changeAutoValidate = (on: boolean) => { setAutoValidate(on); savePref(AUTO_VALIDATE_KEY, on ? "1" : "0"); };
  /** 无头试跑 / 回归的并行数；内嵌浏览器里的探索与试跑始终逐条执行 */
  const [workers, setWorkers] = useState(() => Math.min(6, Math.max(1, Number(pref(WORKERS_KEY)) || 3)));
  const changeWorkers = (n: number) => { setWorkers(n); savePref(WORKERS_KEY, String(n)); };
  const [feedback, setFeedback] = useState("");
  const [result, setResult] = useState<UiRunResult>();
  const loginPromptRun = useRef<string>();
  useEffect(() => {
    if (!result || loginPromptRun.current === result.run.run_id || !result.failures?.some(f => /AUTH_REQUIRED|登录态失效|登录未完成/.test(f.message))) return;
    loginPromptRun.current = result.run.run_id;
    modal.info({ title: "请完成执行角色登录", content: "在右侧浏览器选择脚本对应的角色并完成登录，再重新试跑。本次运行已停止，不会自动重放操作。", okText: "去登录" });
  }, [result, modal]);
  const [resultOpen, setResultOpen] = useState(false);
  const [conclusion, setConclusion] = useState("");
  /** AI 生成结束但没有保存出脚本时，结论按警告显示 */
  const [conclusionFailed, setConclusionFailed] = useState(false);
  const [savedIssue, setSavedIssue] = useState<{ message: string; at: string }>();
  useEffect(() => {
    setConclusion(""); setConclusionFailed(false);
    setSavedIssue(current ? readIssue(project.id, env, current.id) : undefined);
  }, [project.id, env]);
  const [logs, setLogs] = useState<{ title: string; status: string; caseId?: string }[]>([]);
  const [logsOpen, setLogsOpen] = useState(false);
  /** 当前用例每个脚本步骤的执行状态（来自 test.step 进度） */
  const [stepStates, setStepStates] = useState<Record<string, StepRunState>>({});
  /** 单步调试会话（主进程持有，页面重新进入时恢复） */
  const [debug, setDebug] = useState<UiDebugState | null>(null);
  const [progress, setProgress] = useState<PipelineProgress>();
  const [summary, setSummary] = useState<PipelineSummary>();
  const cancelled = useRef(false);

  // ---- 操作：互斥执行，可停止 ----
  const { busy, activeKey, run: runAction } = useKeyedAction();
  const [stopping, setStopping] = useState(false);
  const refresh = async () => { await Promise.all([scripts.reload(), groupsLoad.reload(), onUpdated()]); };
  const markStopped = () => {
    setLogs((old) => old.map((log) => (log.status === "running" ? { ...log, status: "stopped" } : log)));
    setStepStates((old) => Object.fromEntries(Object.entries(old).filter(([, state]) => state.status !== "running")));
  };
  const run = <T,>(key: string, action: () => Promise<T>, success?: string) => runAction(key, async () => {
    try { return await action(); }
    catch (error) {
      if (!isStopped(error)) {
        if (["pipeline", "validate", "regression", "revise"].includes(key) && currentId.current) {
          const reason = cleanError(error);
          writeIssue(project.id, env, currentId.current, reason);
          setConclusionFailed(true); setConclusion(reason);
          setSavedIssue(readIssue(project.id, env, currentId.current));
        }
        throw error;
      }
      markStopped();
      setConclusionFailed(false);
      setConclusion("任务已停止，可继续操作。已保存的脚本会保留，请校验后再确认。");
      await refresh();
      return undefined;
    } finally { setStopping(false); setProgress(undefined); }
  }, success);
  const stopAction = useAction();
  const stoppable = ["pipeline", "validate", "regression", "revise"].includes(activeKey ?? "");
  useEffect(() => { if (!stoppable) setStopping(false); }, [stoppable]);
  const stop = () => stopAction.run(async () => {
    setStopping(true);
    cancelled.current = true;
    try { await api().stopUiTask(project.id, env); }
    catch (error) { setStopping(false); throw error; }
  });
  const backgroundBusy = useUiTasks().some(isUiTaskActive);
  const locked = busy || Boolean(debug) || backgroundBusy || Boolean(editing);
  useEffect(() => { onWorking(locked); return () => onWorking(false); }, [locked, onWorking]);

  /** 生产环境：执行前二次确认，确认后以 confirmProduction 调用（主进程同样会拒绝未确认的执行） */
  const guard = (action: (confirmProduction: boolean) => unknown, what = "执行") => {
    if (!production) return void action(false);
    modal.confirm({
      title: `在生产环境「${env}」上${what}？`,
      icon: <WarningFilled style={{ color: "var(--console-error)" }} />,
      content: <>
        <Typography.Paragraph>会向 <Typography.Text code>{baseUrl}</Typography.Text> 发起真实操作，可能创建、修改或删除线上数据。</Typography.Paragraph>
        <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>确认用例只做只读操作，或已获得授权后再继续。</Typography.Paragraph>
      </>,
      okText: "确认在生产环境执行", okButtonProps: { danger: true }, cancelText: "取消",
      onOk: () => { void action(true); },
    });
  };

  const script = current && scripts.data?.[current.id];
  const stage = stageOf(script);
  // 脚本内容变化（hash）后重新读取步骤
  const detail = useLoad(async () => (current && script ? api().uiScriptDetail(project.id, env, current.id) : null),
    [project.id, env, current?.id, script?.hash]);

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
    setLogs((old) => [...old.slice(-99), { title: p.title!, status: p.status ?? "running", caseId: p.caseId }]);
    if (p.kind === "step" && p.stepId && p.caseId === currentId.current) {
      const status = p.status === "failed" ? "failed" : p.status === "passed" ? "passed" : "running";
      setStepStates((old) => ({ ...old, [p.stepId!]: { status, ...(p.error ? { error: p.error } : {}) } }));
    }
  }), [project.id, env]);
  useProjectChanged(project.id, () => { if (!busy) void refresh(); });
  useEffect(() => {
    if (!locked && groupsLoad.data && current && !index.caseOf.has(current.id)) setCurrent(undefined);
    setSelected((old) => Object.fromEntries(Object.entries(old).filter(([id]) => index.caseOf.has(id))));
  }, [index, locked, groupsLoad.data, current]);

  const resetRunView = () => { setLogs([]); setStepStates({}); setConclusion(""); setConclusionFailed(false); setSavedIssue(undefined); };
  /** 列表里只有摘要，详情（步骤、预期、前置条件）按需读取 */
  const show = async (id: string) => {
    const c = await api().getCase(id) as TestCase | undefined;
    if (c) {
      setCurrent(c); setListCollapsed(true); setCompactPanel("steps"); setFeedback(""); resetRunView();
      setSavedIssue(readIssue(project.id, env, c.id));
    }
    return c;
  };
  const choose = (c: UiGroupCase) => { if (!locked && c.id !== current?.id) void show(c.id); };

  /**
   * 生成流水线（单条与批量共用）。按组处理，尽量少调用模型：
   *   1. 组内已有脚本 → 直接按参数替换生成其余用例的脚本；
   *   2. 组内没有脚本 → AI 只探索一条作模板（内嵌浏览器，逐条），再按参数生成其余的；
   *   3. 参数替换不了的用例，仍由 AI 逐条探索；
   *   4. 开启「自动试跑」时，参数生成的脚本最后统一无头并行试跑。
   * 某条失败不影响其它用例；停止后已生成的脚本保留。
   */
  const pipeline = (list: UiGroupCase[], confirmProduction: boolean, opts: { forceAi?: boolean } = {}) => run("pipeline", async () => {
    cancelled.current = false;
    setSummary(undefined); setResult(undefined);
    const single = list.length === 1;
    const out: PipelineSummary = { total: list.length, explored: 0, derived: 0, validated: 0, failed: [], stopped: false, autoValidate };
    const fail = (c: { id: string; title: string }, reason: string) => {
      out.failed.push({ id: c.id, title: c.title, reason });
      writeIssue(project.id, env, c.id, reason);
      if (c.id === currentId.current) setSavedIssue(readIssue(project.id, env, c.id));
    };
    // 脚本状态在流水线内自行跟踪：setState 后的 scripts.data 要到下次渲染才更新
    let states: Record<string, UiScriptState> = { ...(scripts.data ?? {}) };
    const sync = async () => { states = await api().uiScriptStates(project.id, env); scripts.setData(states); };
    const byGroup = new Map<UiCaseGroup, UiGroupCase[]>();
    for (const c of list) {
      const g = index.groupOf.get(c.id);
      if (g) byGroup.set(g, [...(byGroup.get(g) ?? []), c]);
    }
    const total = byGroup.size + (autoValidate && !single ? 1 : 0);
    let done = 0;
    let lastMessage = "";
    const derivedIds: string[] = [];

    /** AI 探索一条用例；开启自动试跑时在内嵌浏览器里校验。返回脚本是否可用作模板 */
    const explore = async (c: UiGroupCase): Promise<boolean> => {
      await show(c.id);
      setProgress({ done, total, title: c.title, phase: "explore" });
      const gen = await api().exploreUiCase(project.id, env, c.id, { confirmProduction, selectedRole }) as { message?: string; scriptGenerated?: boolean };
      lastMessage = gen?.message ?? "";
      await sync();
      if (gen?.scriptGenerated === false) {
        fail(c, gen.message ?? "AI 没有保存出脚本");
        if (single) { setConclusionFailed(true); setConclusion(gen.message || "AI 没有保存出脚本，请补充用例步骤或登录态后重试。"); }
        return false;
      }
      out.explored++;
      if (!autoValidate) return true;
      setProgress({ done, total, title: c.title, phase: "validate" });
      const r = await api().runUiRegression(project.id, env, true, { caseIds: [c.id], mode: "validate", embedded: true, selectedRole, confirmProduction }) as UiRunResult;
      await sync();
      if (passed(r)) { out.validated++; return true; }
      if (single) setResult(r);
      fail(c, Object.values(r.validationIssues ?? {})[0] || r.failures?.[0]?.reason || r.failures?.[0]?.message?.split("\n")[0] || "试跑未通过");
      return false;
    };

    try {
      for (const [group, targets] of byGroup) {
        if (cancelled.current) { out.stopped = true; break; }
        let rest = targets;
        let source = opts.forceAi || selectedRole ? undefined : templateOf(group)?.id;
        if (!source) {
          // 组内还没有脚本：探索第一条作模板；模板没走通就不再往下复制
          const [first, ...others] = targets;
          rest = others;
          const usable = await explore(first).catch((error) => { if (isStopped(error)) throw error; fail(first, cleanError(error)); return false; });
          if (usable) source = first.id;
          else for (const c of rest.splice(0)) fail(c, "同组模板脚本没有走通，先处理模板用例后再生成");
        }
        if (selectedRole && rest.length) {
          // 所选角色属于本次执行条件，不能直接沿用其它角色的模板。
          for (const c of rest) {
            if (cancelled.current) break;
            await explore(c).catch((error) => { if (isStopped(error)) throw error; fail(c, cleanError(error)); });
          }
        } else if (source && rest.length) {
          setProgress({ done, total, title: `${group.label}（${rest.length} 条）`, phase: "derive" });
          const d = await api().deriveUiScripts(project.id, env, source, { targetIds: rest.map((c) => c.id) })
            .catch((error) => ({ derived: [] as string[], skipped: rest.map((c) => ({ caseId: c.id, reason: cleanError(error) })) }));
          out.derived += d.derived.length;
          derivedIds.push(...d.derived);
          if (d.derived.length) await sync();
          // 替换不了的仍交给 AI 逐条探索
          for (const s of d.skipped) {
            const c = index.caseOf.get(s.caseId);
            if (!c || c.lint_status === "blocked") continue;
            if (cancelled.current) break;
            await explore(c).catch((error) => { if (isStopped(error)) throw error; fail(c, cleanError(error)); });
          }
        }
        done++;
      }
      if (autoValidate && derivedIds.length && !cancelled.current) {
        if (single) {
          // 单条：和 AI 生成的一样，在内嵌浏览器里可见地试跑
          await show(derivedIds[0]);
          setProgress({ done, total, title: list[0].title, phase: "validate" });
          const r = await api().runUiRegression(project.id, env, true, { caseIds: derivedIds, mode: "validate", embedded: true, selectedRole, confirmProduction }) as UiRunResult;
          if (passed(r)) out.validated++;
          else { setResult(r); fail(list[0], Object.values(r.validationIssues ?? {})[0] || r.failures?.[0]?.reason || r.failures?.[0]?.message?.split("\n")[0] || "试跑未通过"); }
        } else {
          setProgress({ done, total, title: `${derivedIds.length} 个参数化脚本 · ${workers} 路并行`, phase: "batch" });
          const r = await api().runUiRegression(project.id, env, false, { caseIds: derivedIds, mode: "validate", workers, confirmProduction }) as UiRunResult;
          await sync();
          for (const id of derivedIds) {
            if (states[id]?.validatedRunId) out.validated++;
            else fail(index.caseOf.get(id) ?? { id, title: id }, states[id]?.validationReason || r.validationIssues?.[id] || "试跑未完整通过");
          }
          if (!passed(r)) setResult(r);
        }
      }
    } catch (error) {
      if (!isStopped(error)) throw error;
      out.stopped = true; markStopped();
    }
    if (!single || out.stopped) setSummary(out);
    else if (!out.failed.length) {
      setConclusion(out.derived
        ? `脚本已按参数从同组用例生成，没有调用模型${autoValidate ? "，并试跑通过" : ""}。核对右侧页面无误后确认脚本。`
        : autoValidate ? "脚本已生成并试跑通过，核对右侧页面无误后确认脚本。" : lastMessage || "脚本已生成，请试跑校验。");
    } else if (out.explored || out.derived) {
      setConclusionFailed(true);
      const failure = `脚本已生成，但试跑未通过：${out.failed[0].reason}\n可以单步调试定位、让 AI 重新探索生成，或在下方告诉 AI 哪里需要修正。`;
      setConclusion(failure); writeIssue(project.id, env, out.failed[0].id, failure);
      if (out.failed[0].id === current?.id) setSavedIssue(readIssue(project.id, env, current.id));
    }
    await refresh();
    notifyProjectChanged(project.id);
  });

  /** 还没有脚本、可以生成的用例（跳过被规范检查阻断的） */
  const pendingGeneration = useMemo(() => groups.flatMap((g) => g.cases).filter((c) => stageById(c.id) === "none" && c.lint_status !== "blocked"),
    [groups, scripts.data]); // eslint-disable-line react-hooks/exhaustive-deps
  /** 其中需要 AI 探索的次数：组内已有脚本的直接按参数生成 */
  const exploreCount = useMemo(() => new Set(pendingGeneration.map((c) => index.groupOf.get(c.id)).filter((g) => g && !templateOf(g)).map((g) => g!.id)).size,
    [pendingGeneration, index]); // eslint-disable-line react-hooks/exhaustive-deps

  const validate = (confirmProduction: boolean, embedded = true) => current && run("validate", async () => {
    resetRunView(); setSummary(undefined);
    const r = await api().runUiRegression(project.id, env, true, { caseIds: [current.id], mode: "validate", embedded, selectedRole, confirmProduction }) as UiRunResult;
    // 通过时只在用例旁提示下一步；失败才展开结果条
    if (passed(r)) { setResult(undefined); setConclusion("试跑通过，核对右侧页面无误后确认脚本。"); }
    else {
      const reason = [r.validationIssues?.[current.id], ...(r.failures ?? []).filter(f => f.case_id === current.id).map(f => f.reason || f.message)].filter(Boolean).join("\n") || "试跑未完整通过，请查看运行结果。";
      setResult(r); setConclusionFailed(true); setConclusion(reason);
      writeIssue(project.id, env, current.id, reason); setSavedIssue(readIssue(project.id, env, current.id));
    }
    await refresh();
    notifyProjectChanged(project.id);
  });
  const regress = (ids: string[], confirmProduction: boolean) => run("regression", async () => {
    resetRunView(); setSummary(undefined);
    const r = await api().runUiRegression(project.id, env, false, { caseIds: ids, mode: "regression", workers: ids.length > 1 ? workers : 1, confirmProduction }) as UiRunResult;
    setResult(r);
    for (const failure of r.failures ?? []) writeIssue(project.id, env, failure.case_id, failure.reason || failure.message);
    for (const [id, reason] of Object.entries(r.validationIssues ?? {})) writeIssue(project.id, env, id, reason);
    if (current) setSavedIssue(readIssue(project.id, env, current.id));
    await refresh();
    notifyProjectChanged(project.id);
  });
  const confirmScripts = (ids: string[]) => run("confirm", async () => {
    for (const id of ids) {
      const s = scripts.data?.[id];
      if (s) await api().confirmUiScript(project.id, env, id, s.hash);
    }
    await refresh();
    notifyProjectChanged(project.id);
  }, ids.length > 1 ? `已确认 ${ids.length} 个脚本，可加入回归` : "脚本已确认，可加入回归");
  const startDebug = (confirmProduction: boolean) => current && run("debug:start", async () => {
    resetRunView();
    setDebug(await api().uiDebugStart(project.id, env, current.id, { confirmProduction }));
  });
  const debugCmd = (command: UiDebugCommand) => run(`debug:${command.type}`, async () => {
    const s = await api().uiDebugCommand(command);
    setDebug(s.phase === "stopped" ? null : s);
  });
  const debugging = debug && current && debug.caseId === current.id ? debug : undefined;
  const debugRunning = debugging?.phase === "running";
  const revise = (confirmProduction: boolean) => current && feedback.trim() && run("revise", async () => {
    const out = await api().reviseUiScript(project.id, env, current.id, feedback, { confirmProduction }) as { message?: string };
    setConclusionFailed(false);
    setConclusion(out?.message || "修正任务已结束，请查看脚本修正建议。");
    setFeedback("");
    await refresh();
  });

  // ---- 多选：按所选用例的阶段给出可做的批量操作 ----
  const picked = Object.keys(selected).flatMap((id) => index.caseOf.get(id) ? [index.caseOf.get(id)!] : []);
  const blocked = (c: { lint_status: string }) => c.lint_status === "blocked";
  const canGenerate = picked.filter((c) => stageById(c.id) === "none" && !blocked(c));
  const canConfirm = picked.filter((c) => stageById(c.id) === "validated");
  const canRegress = picked.filter((c) => stageById(c.id) === "confirmed" && c.status === "reviewed" && !blocked(c));
  const pick = (list: UiGroupCase[], on: boolean) => setSelected((old) => {
    const next = { ...old };
    for (const c of list) { if (on) next[c.id] = c; else delete next[c.id]; }
    return next;
  });
  const shown = visible.flatMap((v) => v.cases);
  const allSelected = shown.length > 0 && shown.every((c) => selected[c.id]);
  const currentGroup = current && index.groupOf.get(current.id);
  const currentBrief = current && index.caseOf.get(current.id);
  /** 同组里可直接复用的脚本（当前用例还没有脚本时） */
  const reusable = !selectedRole && currentGroup && current && !scripts.data?.[current.id] ? templateOf(currentGroup, current.id) : undefined;

  const scriptRoles = [...new Set(detail.data?.steps?.map(step => step.role ?? "default") ?? [])];
  const scriptRoleLabel = scriptRoles.map(role => role === "default" ? "默认会话" : role).join("、");
  const debugTip = !script ? "先生成脚本" : detail.data && (!detail.data.steps || !detail.data.synced)
    ? "脚本没有结构化步骤或已被修改，无法单步调试" : "逐步回放到内嵌浏览器，失败时停住现场；不计入校验";
  const canDebug = Boolean(detail.data?.steps && detail.data.synced) && !!current && !blocked(current);

  /** 当前用例只给一个主操作：按阶段推进到下一步 */
  const primary = (c: TestCase): ReactNode => {
    if (blocked(c)) return <Tooltip title="用例被规范检查阻断，先在「导入与规范检查」中修正"><Button disabled>规范检查未通过</Button></Tooltip>;
    if (stage === "none") {
      const brief = currentBrief ?? { id: c.id, title: c.title, priority: c.priority, status: c.status, lint_status: c.lint_status, execution_mode: c.execution_mode, variant: "" };
      return <Tooltip title={reusable ? `同组「${reusable.variant || reusable.title}」已有脚本，按参数替换直接生成，不调用模型` : ""}>
        <Button type="primary" className={production ? "" : "uix-ai-btn"} danger={production} icon={<CodeOutlined />} disabled={locked}
          onClick={() => guard((ok) => pipeline([brief], ok), "生成脚本")}>{reusable ? "按参数生成" : autoValidate ? "AI 生成并试跑" : "AI 生成脚本"}</Button>
      </Tooltip>;
    }
    if (stage === "pending") {
      return <Button type="primary" danger={production} icon={<CaretRightOutlined />} disabled={locked}
        onClick={() => guard(validate, "试跑")}>试跑校验</Button>;
    }
    if (stage === "validated") {
      return <Button type="primary" icon={<CheckOutlined />} disabled={locked} onClick={() => confirmScripts([c.id])}>确认脚本</Button>;
    }
    return <Tooltip title={c.status !== "reviewed" ? "用例审核通过后才能加入回归" : ""}>
      <Button type="primary" danger={production} icon={<CaretRightOutlined />} disabled={locked || c.status !== "reviewed"}
        onClick={() => guard((ok) => regress([c.id], ok), "执行回归")}>执行回归</Button>
    </Tooltip>;
  };

  const activity = activeKey === "pipeline" ? (progress?.phase === "validate" ? "正在内嵌浏览器中试跑脚本…" : progress?.phase === "derive" ? "正在按参数生成同组脚本…"
      : progress?.phase === "batch" ? "正在无头并行试跑参数化脚本…" : "AI 正在探索页面并生成脚本…")
    : activeKey === "validate" ? "正在内嵌浏览器中试跑脚本…" : activeKey === "regression" ? "正在执行回归…"
    : activeKey === "revise" ? "AI 正在根据反馈修正脚本…" : activeKey === "confirm" ? "正在确认脚本…" : "";
  const lastLog = logs[logs.length - 1];
  const noneCount = counts?.none ?? 0;
  const failures = result ? [
    ...(result.failures ?? (result.heal ?? []).map((h) => ({ ...h, status: "failed", message: "" }))).map((f) => ({ ...f, key: `f:${f.case_id}` })),
    ...Object.entries(result.validationIssues ?? {}).filter(([id]) => !(result.failures ?? []).some(f => f.case_id === id)).map(([id, message]) => ({ key: `v:${id}`, case_id: id, status: "incomplete", failure_type: "", message, reason: undefined as string | undefined })),
    ...result.degraded.map((id) => ({ key: `d:${id}`, case_id: id, status: "degraded", failure_type: "", message: "依赖的测试数据缺失且无法造数，本次未执行", reason: undefined as string | undefined })),
  ] : [];

  const stageFilters = (
<div className="uix-stats" role="group" aria-label="按脚本阶段筛选">
        {STAGES.map((s) => (
          <Tooltip key={s.key} title={s.hint} mouseEnterDelay={0.4}>
            <button type="button" aria-pressed={filter === s.key} className={`uix-stat ${s.key} ${filter === s.key ? "active" : ""}`}
              disabled={locked} onClick={() => setFilter(filter === s.key ? "all" : s.key)}>
              <span className="uix-stat-value">{counts ? counts[s.key] : "–"}</span>
              <span className="uix-stat-label"><i className={`uix-dot ${s.key}`} />{s.label}</span>
            </button>
          </Tooltip>
        ))}
      </div>
  );

  return <>
    {/* 顶部：一键生成 + 四个阶段的数量（点击即筛选） */}
    <div className={`uix-hero ${progress ? "running" : ""}`}>
      {progress ? (
        <div className="uix-hero-main">
          <div className="uix-hero-icon"><LoadingOutlined /></div>
          <div className="uix-hero-text">
            <div className="uix-hero-title">
              {PHASE_TEXT[progress.phase]}
              {progress.total > 1 && <span className="uix-hero-step">第 {Math.min(progress.done + 1, progress.total)} / {progress.total} 组</span>}
            </div>
            <Typography.Text type="secondary" ellipsis style={{ display: "block" }}>{progress.title}</Typography.Text>
            <Progress percent={Math.round(((progress.done + (progress.phase === "explore" ? 0.15 : 0.6)) / progress.total) * 100)} showInfo={false} size="small"
              strokeColor="var(--console-accent)" style={{ margin: "8px 0 0" }} />
          </div>
          <Button danger icon={<PoweroffOutlined />} loading={stopping} onClick={stop}>停止</Button>
        </div>
      ) : (
        <div className="uix-workflow-toolbar">
          {stageFilters}
          <div className="uix-workflow-actions">
            <Popover trigger="click" placement="bottomRight" title="执行设置" content={
              <div className="uix-run-settings">
                <label><span>生成后自动试跑</span><Switch size="small" checked={autoValidate} onChange={changeAutoValidate} disabled={locked} aria-label="生成后自动试跑" /></label>
                <label><span>后台并行数</span><Select size="small" value={workers} onChange={changeWorkers} disabled={locked} aria-label="并行数"
                  options={[1, 2, 3, 4, 6].map(n => ({ value: n, label: `${n} 路` }))} /></label>
                <Typography.Text type="secondary">仅后台试跑和回归并行；AI 探索与内嵌试跑逐条执行。</Typography.Text>
              </div>
            }>
              <Button type="text" aria-label="执行设置" title="执行设置" icon={<SettingOutlined />} disabled={locked}><span className="uix-settings-text">执行设置</span></Button>
            </Popover>
            {stoppable ? <Button danger icon={<PoweroffOutlined />} loading={stopping} onClick={stop}>停止</Button> :
              <Tooltip title={pendingGeneration.length
                ? selectedRole ? `按所选登录态逐条探索 ${pendingGeneration.length} 条用例` : `AI 探索 ${exploreCount} 次，其余按参数生成；仅处理审核通过且未被规范检查阻断的 UI 用例`
                : noneCount ? "剩余用例被规范检查阻断，修正后才能生成" : "没有待生成的用例，可选择已有脚本试跑"}>
                <Button type="primary" danger={production} icon={<CodeOutlined />} disabled={locked || !pendingGeneration.length}
                  onClick={() => guard((ok) => pipeline(pendingGeneration, ok), "批量生成脚本")}>
                  {pendingGeneration.length ? `生成 ${pendingGeneration.length} 条脚本` : "生成脚本"}
                </Button>
              </Tooltip>}
          </div>
        </div>
      )}
      {progress && stageFilters}
    </div>

    {/* 批量生成 / 最近一次执行的结果 */}
    {summary && (
      <div className={`uix-banner ${summary.failed.length ? "warn" : "ok"}`}>
        {summary.failed.length ? <ExclamationCircleFilled className="uix-banner-icon" /> : <CheckCircleFilled className="uix-banner-icon" />}
        <div className="uix-banner-text">
          <strong>{summary.stopped ? "已停止" : "生成完成"}</strong>
          <span>共 {summary.total} 条 · AI 探索 {summary.explored} · 按参数生成 {summary.derived}{summary.autoValidate && ` · 试跑通过 ${summary.validated}`}{summary.failed.length > 0 && ` · 未完成 ${summary.failed.length}`}</span>
          {summary.failed.length > 0 && (
            <Typography.Text type="secondary" ellipsis style={{ minWidth: 0 }}>{summary.failed.slice(0, 2).map((f) => `${f.title}：${f.reason}`).join("；")}</Typography.Text>
          )}
        </div>
        {summary.validated > 0 && <Button size="small" type="primary" disabled={locked} onClick={() => { setFilter("validated"); setSummary(undefined); }}>去确认 {summary.validated} 个脚本</Button>}
        <Button size="small" type="text" icon={<CloseOutlined />} aria-label="关闭" onClick={() => setSummary(undefined)} />
      </div>
    )}
    {result && !summary && (
      <div className={`uix-banner ${result.run.failed + result.run.error ? "warn" : "ok"}`}>
        {result.run.failed + result.run.error ? <ExclamationCircleFilled className="uix-banner-icon" /> : <CheckCircleFilled className="uix-banner-icon" />}
        <div className="uix-banner-text">
          <strong>{result.run.failed + result.run.error ? "执行有失败" : "执行通过"}</strong>
          <span>共 {result.run.total} 条 · 验收通过 {result.run.acceptance?.verified_pass ?? 0} · 执行成功 {result.run.passed} · 失败 {result.run.failed + result.run.error}{result.run.reviews > 0 && ` · 待人工复核 ${result.run.reviews}`}</span>
          {result.missingData.length > 0 && <Typography.Text type="warning" ellipsis style={{ minWidth: 0 }}>缺少测试数据：{result.missingData.join("、")}</Typography.Text>}
        </div>
        {failures.length > 0 && <Button size="small" onClick={() => setResultOpen(!resultOpen)}>{resultOpen ? "收起明细" : `查看明细（${failures.length}）`}</Button>}
        <Button size="small" disabled={locked} onClick={() => run("report", () => api().openPath(result.htmlReport))}>打开报告</Button>
        <Button size="small" type="text" icon={<CloseOutlined />} aria-label="关闭" onClick={() => { setResult(undefined); setResultOpen(false); }} />
      </div>
    )}
    {result && !summary && resultOpen && failures.length > 0 && (
      <div className="uix-panel uix-result-table">
        <CaseTitles projectId={project.id} ids={failures.map((r) => r.case_id)}>
          <Table size="small" rowKey="key" dataSource={failures} scroll={{ x: 680 }}
            pagination={{ defaultPageSize: 10, size: "small", hideOnSinglePage: true, showTotal: (t) => `共 ${t} 条` }}
            columns={[
              { title: "用例", dataIndex: "case_id", width: 220, render: (id: string) => <CaseLink id={id} /> },
              { title: "结果", dataIndex: "status", width: 90, render: (s: string) =>
                s === "degraded" ? <Tag bordered={false}>降级手工</Tag> : <Tag color="red" bordered={false}>{s === "error" ? "出错" : "失败"}</Tag> },
              { title: "归因", dataIndex: "failure_type", width: 140, render: (v: string) => (v ? <LabelTag map={FAILURE} value={v} /> : "—") },
              { title: "说明", render: (_: unknown, r: { reason?: string; message: string }) => <>
                {r.reason && <div>{r.reason}</div>}
                {r.message && <Typography.Paragraph type="secondary" className="mono uix-result-message"
                  ellipsis={{ rows: 2, expandable: true, symbol: "展开" }}>{r.message}</Typography.Paragraph>}
              </> },
            ]} />
        </CaseTitles>
      </div>
    )}

    <div ref={benchRef} className={`uix-bench compact-${compactPanel} ${!current ? "no-current" : ""} ${summary || result ? "has-banner" : ""} ${listCollapsed ? "list-collapsed" : ""}`}>
      <div className="uix-compact-nav">
        <Segmented<"cases" | "steps"> value={compactPanel} onChange={(panel) => { setCompactPanel(panel); if (panel === "cases") setListCollapsed(false); }} options={[
          { value: "cases", label: `用例 · ${visibleCount}` },
          { value: "steps", label: "步骤与结果", disabled: !current },
        ]} />
        {current && <Typography.Text type="secondary" ellipsis title={current.title}>{current.title}</Typography.Text>}
      </div>
      {/* 用例列表 */}
      {listCollapsed ? (
        <div className="uix-rail">
          <Tooltip title="展开用例列表" placement="right">
            <Button size="small" type="text" icon={<MenuUnfoldOutlined />} aria-label="展开用例列表" onClick={() => toggleList(false)} />
          </Tooltip>
          <Typography.Text type="secondary" className="uix-rail-label">用例 · {visibleCount}</Typography.Text>
        </div>
      ) : (
        <section className="uix-panel uix-list">
          <div className="uix-panel-head">
            <Checkbox checked={allSelected} indeterminate={!allSelected && shown.some((c) => selected[c.id])} disabled={locked || !shown.length}
              aria-label="全选" onChange={(e) => pick(shown, e.target.checked)} />
            <span className="uix-panel-title">{filter === "all" ? "已审核 UI 用例" : STAGE_LABEL[filter]}</span>
            <span className="uix-count">{visibleCount}</span>
            {filter !== "all" && <Button size="small" type="link" disabled={locked} onClick={() => setFilter("all")} style={{ padding: 0 }}>看全部</Button>}
            <span style={{ flex: 1 }} />
            <Tooltip title="收起用例列表"><Button size="small" type="text" icon={<MenuFoldOutlined />} aria-label="收起用例列表" onClick={() => toggleList(true)} /></Tooltip>
          </div>
          <div className="uix-list-search">
            <Input allowClear variant="filled" prefix={<SearchOutlined />} placeholder="搜索标题、模块或用例 ID" value={search} onChange={(e) => setSearch(e.target.value)} disabled={locked} />
          </div>
          <div className="uix-list-body">
            <Spin spinning={(groupsLoad.loading && !groupsLoad.data) || (scripts.loading && !scripts.data)}>
              {!visible.length && groupsLoad.data && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={query ? "没有匹配的用例" : !groups.length ? "暂无审核通过的 UI 用例，请先到用例库审核" : "这个阶段没有用例"} style={{ marginTop: 40 }} />}
              <UiCaseTree key={`${filter}:${query}`} cases={shown} selected={selected} currentId={current?.id} query={query} locked={locked}
                onPick={pick} onChoose={choose} renderMeta={(c) => {
                  const st = stageById(c.id);
                  return <>
                    <i className={`uix-dot ${st}`} />
                    <span>{STAGE_LABEL[st]}</span><span className="uix-sep">·</span><span>{c.priority}</span>
                    {c.execution_mode === "capture" && <span>埋点</span>}
                    {blocked(c) && <Tag bordered={false} color="red">规范阻断</Tag>}
                    {c.status !== "reviewed" && <Tag bordered={false}>待审核</Tag>}
                  </>;
                }} />
            </Spin>
          </div>
          {picked.length > 0 ? (
            <div className="uix-list-foot uix-bulk">
              <div className="uix-bulk-head">
                <span>已选 {picked.length} 条</span>
                <Button size="small" type="link" disabled={locked} onClick={() => setSelected({})} style={{ padding: 0 }}>清除</Button>
              </div>
              <div className="uix-bulk-actions">
                {canGenerate.length > 0 && <Button size="small" type="primary" className={production ? "" : "uix-ai-btn"} danger={production} icon={<CodeOutlined style={{ fontSize: 13 }} />} disabled={locked}
                  onClick={() => guard((ok) => { const list = canGenerate; setSelected({}); return pipeline(list, ok); }, "批量生成脚本")}>生成 {canGenerate.length}</Button>}
                {canConfirm.length > 0 && <Button size="small" icon={<CheckOutlined />} disabled={locked}
                  onClick={() => { const ids = canConfirm.map((c) => c.id); setSelected({}); void confirmScripts(ids); }}>确认 {canConfirm.length}</Button>}
                {canRegress.length > 0 && <Button size="small" danger={production} icon={<CaretRightOutlined />} disabled={locked}
                  onClick={() => guard((ok) => regress(canRegress.map((c) => c.id), ok), "执行回归")}>回归 {canRegress.length}</Button>}
                {!canGenerate.length && !canConfirm.length && !canRegress.length && (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>所选用例需先单独试跑校验</Typography.Text>
                )}
              </div>
            </div>
          ) : null}
        </section>
      )}

      {/* 用例详情：步骤对照 + 一个主操作 + 修正输入 */}
      <section className="uix-panel uix-detail">
        {!current ? (
          <div className="uix-detail-empty">
            <div className="uix-empty-mark"><CodeOutlined /></div>
            <div className="uix-empty-title">选择用例，查看执行步骤</div>
            <Typography.Text type="secondary">生成脚本、试跑和结果都在这里。</Typography.Text>
          </div>
        ) : <>
          <div className="uix-detail-head">
            <div className="uix-detail-title">
              <div className="uix-title-line"><Typography.Text strong className="uix-current-title">{current.title}</Typography.Text>
                {((conclusionFailed && conclusion) || savedIssue) && <ExecutionIssue key={`${current.id}:${conclusionFailed ? conclusion : savedIssue?.at}`} title={conclusionFailed ? "执行未完成" : "上次执行问题（历史记录）"}
                  message={conclusionFailed ? conclusion : `记录时间：${new Date(savedIssue!.at).toLocaleString()}\n${savedIssue!.message}`} />}
              </div>
              <div className="uix-flow" aria-label={`当前阶段：${STAGE_LABEL[stage]}`}>
                {FLOW_SHORT.map((f, i) => (
                  <span key={f} className={i < FLOW_INDEX[stage] ? "done" : i === FLOW_INDEX[stage] ? "now" : ""}>
                    {i < FLOW_INDEX[stage] ? <CheckOutlined /> : <i />}{f}
                  </span>
                ))}
              </div>
            </div>
            <div className="uix-detail-actions">
              <Button disabled={locked} onClick={() => setEditing(current)}>编辑用例</Button>
              {primary(current)}
              {script && <Dropdown trigger={["click"]} menu={{ items: [
                ...(stage !== "pending" && !blocked(current) ? [{ key: "validate", label: "重新试跑", icon: <RedoOutlined />, onClick: () => guard(validate, "试跑") }] : []),
                ...(stage !== "confirmed" && currentBrief && !blocked(current) ? [{ key: "generate", label: "AI 重新生成", icon: <CodeOutlined />, onClick: () => modal.confirm({
                  title: "让 AI 重新生成这条脚本？", content: "AI 会重新探索页面并覆盖当前脚本，需要调用模型。", okText: "重新生成", cancelText: "取消",
                  onOk: () => { guard((ok) => pipeline([currentBrief], ok, { forceAi: true }), "生成脚本"); },
                }) }] : []),
                { key: "validate-background", label: "按回归配置后台校验", onClick: () => guard((ok) => validate(ok, false), "后台校验") },
                { key: "debug", label: "单步调试", icon: <BugOutlined />, disabled: !canDebug, title: debugTip, onClick: () => guard(startDebug, "调试") },
              ] }}>
                <Button icon={<MoreOutlined />} aria-label="更多操作" title="更多操作" disabled={locked} />
              </Dropdown>}
            </div>
          </div>
          {scriptRoleLabel && <div className="uix-script-session">
            <span>脚本执行角色</span><strong>{scriptRoleLabel}</strong>{scripts.data?.[current.id]?.executionRole && scripts.data[current.id].executionRole !== scriptRoleLabel && <span>默认会话绑定：{scripts.data[current.id].executionRole}</span>}
            {selectedRole && !scriptRoles.includes(selectedRole) && <span>{scriptRoles.includes("default") ? `默认会话本次使用「${selectedRole}」的登录态。` : "此脚本指定了角色，将使用脚本角色的登录态。"}</span>}
          </div>}
          <div className="uix-panel-body">
            {scripts.data?.[current.id]?.validationReason && <Typography.Paragraph type="warning" role="status">{scripts.data[current.id].validationReason}</Typography.Paragraph>}
            {activity && !progress && (
              <div className="uix-activity" role="status">
                <LoadingOutlined />
                <span className="uix-activity-text">{activity}</span>
                {lastLog && <Typography.Text type="secondary" className="mono" ellipsis style={{ minWidth: 0, flex: 1 }}>{lastLog.title}</Typography.Text>}
              </div>
            )}
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
            {conclusion && !conclusionFailed && (
              <div className="uix-note">
                <div className="uix-note-mark">{conclusionFailed ? <ExclamationCircleFilled /> : <CodeOutlined style={{ fontSize: 14 }} />}</div>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <Typography.Paragraph style={{ whiteSpace: "pre-wrap", marginBottom: 0 }} ellipsis={{ rows: 5, expandable: true, symbol: "展开" }}>{conclusion}</Typography.Paragraph>
                  {pendingProposals > 0 && !conclusionFailed && (
                    <Button size="small" type="link" style={{ padding: 0, marginTop: 4 }} disabled={locked} onClick={onInbox}>查看 {pendingProposals} 条修正建议 →</Button>
                  )}
                </div>
              </div>
            )}
            {currentGroup && currentGroup.cases.length > 1 && (
              <div className="uix-pre">
                <span className="uix-pre-label"><BranchesOutlined /> 同组 {currentGroup.cases.length} 条</span>
                <span>
                  {currentBrief?.variant ? <>本条参数：<b className="uix-em">{currentBrief.variant}</b>。</> : null}
                  {detail.data?.derivedFrom
                    ? <>脚本由「{index.caseOf.get(detail.data.derivedFrom)?.variant || index.caseOf.get(detail.data.derivedFrom)?.title || detail.data.derivedFrom}」的脚本按参数替换生成。</>
                    : script ? "本条脚本可作为同组其它用例的模板。" : reusable ? "同组已有脚本，可直接按参数生成。" : "生成后，同组其它用例按参数复用这份脚本。"}
                </span>
              </div>
            )}
            {current.preconditions.length > 0 && (
              <div className="uix-pre">
                <span className="uix-pre-label">前置条件</span>
                <span>{current.preconditions.join("；")}</span>
              </div>
            )}
            <ScriptSteps key={current.id} caseSteps={current.steps} expected={current.expected} preconditions={current.preconditions} detail={detail.data}
              states={debugging ? debugging.statuses : stepStates}
              debug={debugging && {
                cursor: debugging.phase === "finished" ? undefined : debugging.cursor, breakpoints: debugging.breakpoints, running: debugRunning || busy,
                onBreakpoint: (id) => debugCmd({ type: "breakpoint", stepId: id }),
                onRunTo: (id) => debugCmd({ type: "runTo", stepId: id }),
                onSeek: (id) => debugCmd({ type: "seek", stepId: id }),
              }} />
            {logs.length > 0 && (
              <div className="uix-logs">
                <button type="button" className="uix-logs-toggle" onClick={() => setLogsOpen(!logsOpen)}>
                  {logsOpen ? "收起" : "展开"}执行过程（{logs.length}）
                </button>
                {logsOpen && <div className="uix-logs-body">{logs.map((log, i) => (
                  <div key={i}><i className={`uix-dot log-${log.status}`} /><span className="mono">{log.title}</span></div>
                ))}</div>}
              </div>
            )}
          </div>
          <div className={`uix-composer ${script ? "" : "off"}`}>
            <Input.TextArea aria-label="脚本修正说明" variant="borderless" autoSize={{ minRows: 1, maxRows: 5 }} maxLength={8000} value={feedback} disabled={locked || !script}
              onChange={(e) => setFeedback(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); guard(revise, "修正脚本"); } }}
              placeholder={script ? "描述需要修正的步骤，交给 AI 调整…" : "生成脚本后，可以在这里用一句话让 AI 修正"} />
            <Tooltip title={script ? "发送给 AI（Enter 发送，Shift + Enter 换行）" : ""}>
              <Button type="primary" shape="circle" className="uix-ai-btn" icon={<ArrowUpOutlined />} aria-label="让 AI 修正"
                disabled={locked || !script || !feedback.trim()} onClick={() => guard(revise, "修正脚本")} />
            </Tooltip>
          </div>
        </>}
      </section>

      {/* 内嵌浏览器 */}
      <div className="uix-browser">
        <BrowserDock url={baseUrl} session={{ projectId: project.id, env, role: selectedRole }} controls={
          <div className="uix-session-controls">
            <span>登录角色</span>
            <Select aria-label="浏览器登录态角色" placeholder="按用例选择" allowClear
              value={selectedRole} disabled={locked} loading={roles.loading}
              onChange={changeRole} options={(roles.data ?? []).map(r => ({ value: r.role_name, label: r.role_name }))} />
            <Tooltip title="选择后打开对应会话，生成和内嵌试跑复用其登录态。试跑中默认会话使用所选角色，脚本明确指定的角色不变；确认后，默认会话的角色绑定会随脚本用于无头回归。">
              <Button type="text" size="small" aria-label="登录态使用说明" icon={<ExclamationCircleFilled />} />
            </Tooltip>
          </div>
        } />
        {((busy && (activeKey === "validate" || activeKey === "pipeline")) || debugRunning) && (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>执行中请勿操作浏览器，等待结束后再手动核对页面。</Typography.Text>
        )}
      </div>
    </div>
    {editing && <CaseEditor key={editing.id} value={editing} onClose={() => setEditing(undefined)} onSaved={(updated) => {
      setCurrent(updated); setEditing(undefined); resetRunView();
      notifyProjectChanged(project.id);
      void refresh();
      message.success("用例已保存");
    }} />}
  </>;
}
