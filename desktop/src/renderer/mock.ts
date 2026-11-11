let mockUiStopped = false;
/**
 * 演示数据：在普通浏览器中预览界面（npm run preview:web）时替代 Electron 预加载脚本提供的 window.aitest。
 * 只在 window.aitest 不存在时动态加载，不进入桌面端的正常流程。
 */
import type { UiStep } from "@ai-test/mcp-servers";
import { UiDebugSession } from "../main/uiDebug";
import type { AitestApi, ApiTestSet, ApprovalRequest, GlobalSettings, GlobalSettingsView, Page, PageQuery, UpdateState, UiScriptState, UiStepView } from "../shared/ipc";

const delay = <T,>(v: T, ms = 250) => new Promise<T>((r) => setTimeout(() => r(structuredClone(v)), ms));

/** 模拟引擎分页 */
const page = <T,>(rows: T[], q: PageQuery, extra: Partial<Page<T>> = {}): Promise<Page<T>> =>
  delay({ items: rows.slice((q.page - 1) * q.pageSize, q.page * q.pageSize), total: rows.length, page: q.page, page_size: q.pageSize, ...extra });
const matches = (value: string, filter?: string) => !filter || filter.split(",").includes(value);

const projects: any[] = [
  {
    id: "grp_feature", name: "特征中心", workspace_path: "", kind: "group", parent_id: "",
    environments: {
      test: { base_url: "https://feature-test.example.com", app: { android: "com.example.feature.test", ios: "com.example.feature.test" }, login: { url: "/login", username: "#username", password: "#password", submit: "button[type=submit]", success: "/overview" },
        databases: {
          main: { type: "mysql", host: "10.0.3.21", port: 3306, database: "feature_center", user: "qa_readonly", readonly: true },
          analytics: { type: "postgresql", host: "10.0.3.40", database: "tracking", user: "qa", readonly: false },
        } },
      prod: { base_url: "https://feature.example.com", production: true },
    },
  },
  { id: "proj_feature", name: "v4.4", workspace_path: "/Users/demo/aitest/feature-v44", parent_id: "grp_feature", kind: "project", environments: {} },
  {
    id: "proj_feature45", name: "v4.5", workspace_path: "/Users/demo/aitest/feature-v45", parent_id: "grp_feature", kind: "project",
    environments: { test: { base_url: "https://feature-test-v45.example.com" } },
  },
  { id: "proj_order", name: "订单服务", workspace_path: "/Users/demo/aitest/order-service", kind: "project", parent_id: "", environments: { test: { base_url: "https://order-test.example.com" } } },
];

/** 与引擎一致的项目视图：子项目继承大项目的环境 */
const view = (p: any) => {
  const parent = p.parent_id ? projects.find((x) => x.id === p.parent_id) : undefined;
  const inherited = Object.fromEntries(Object.keys(parent?.environments ?? {}).filter((k) => !(k in p.environments)).map((k) => [k, parent.id]));
  return {
    ...p, own_environments: p.environments, environments: { ...(parent?.environments ?? {}), ...p.environments },
    inherited_environments: inherited, parent_name: parent?.name ?? "",
    children: p.kind === "group" ? projects.filter((x) => x.parent_id === p.id).map((x) => x.id) : [],
  };
};


const mk = (id: string, title: string, mode: string, priority: string, lint: string, status: string, extra: Record<string, unknown> = {}) => ({
  id, title, type: mode === "api" ? "api" : "ui", priority, category: "功能测试", module_path: ["特征中心", title.split("-")[0]],
  execution_mode: mode, preconditions: ["存在启用中的标签 TAG-1001"], steps: ["进入标签管理页", "停用标签 TAG-1001"],
  expected: ["页面展示标签列表", "标签状态显示为已停用"], lint_status: lint, status, data_refs: ["TAG-1001"], ...extra,
});

const cases = [
  mk("tc_8f2a1c0e01", "标签管理-停用标签", "ui", "P0", "passed", "reviewed"),
  mk("tc_8f2a1c0e02", "标签管理-批量导入标签", "ui", "P1", "warned", "draft"),
  mk("tc_8f2a1c0e03", "综合总览-指标卡片展示", "ui", "P0", "passed", "reviewed"),
  mk("tc_8f2a1c0e04", "推荐配置-接口越权", "api", "P0", "passed", "reviewed", {
    api: { method: "POST", path: "/recommendations", expected_status: [403] },
  }),
  mk("tc_8f2a1c0e05", "用户特征-数值核对", "ui", "P1", "blocked", "draft", { expected: ["若数值相同须记录说明"] }),
  mk("tc_8f2a1c0e06", "埋点-停用按钮 click 上报", "capture", "P1", "passed", "reviewed"),
  mk("tc_8f2a1c0e07", "数据清洗-规则启停", "ui", "P2", "passed", "draft"),
  mk("tc_8f2a1c0e08", "服务接口-授权停用", "api", "P1", "passed", "reviewed", {
    api: { method: "POST", path: "/authorizations/disable", expected_status: [200] },
  }),
  mk("tc_8f2a1c0e09", "多端-桌面客户端同步", "manual", "P3", "warned", "draft"),
  mk("tc_8f2a1c0e10", "埋点表-字段核对", "doc", "P2", "passed", "draft"),
  mk("tc_8f2a1c0e11", "订单-退款审核流程", "api", "P0", "passed", "reviewed", {
    type: "api", module_path: ["特征中心", "订单"],
    steps: ["买家下单", "买家支付", "买家申请退款", "运营审核退款", "买家查看订单"],
    expected: ["下单成功", "支付成功", "状态为退款中", "审核通过", "订单状态为已退款"],
    api_flow: [
      { name: "买家下单", role: "买家", method: "POST", path: "/orders", expected_status: [201], extract: { order_id: "data.id" } },
      { name: "买家支付", role: "买家", method: "POST", path: "/orders/${order_id}/pay", expected_status: [200], expected_fields: { "data.status": "paid" } },
      { name: "买家申请退款", role: "买家", method: "POST", path: "/orders/${order_id}/refund", expected_status: [200], expected_fields: { "data.status": "refunding" } },
      { name: "运营审核退款", role: "运营", method: "POST", path: "/admin/refunds/${order_id}/approve", expected_status: [200] },
      { name: "买家查看订单", role: "买家", method: "GET", path: "/orders/${order_id}", expected_status: [200], expected_fields: { "data.status": "refunded" } },
    ],
  }),
  mk("tc_app_001", "标签管理-App端停用标签", "app", "P0", "passed", "reviewed", { type: "app" }),
  mk("tc_app_003", "综合总览-App端指标卡片", "app", "P1", "passed", "reviewed", { type: "app" }),
  mk("tc_app_007", "登录-iOS 面容登录", "app", "P1", "warned", "draft", { type: "app" }),
  // 批量导入的用例，用来演示分页
  ...Array.from({ length: 56 }, (_, i) => mk(`tc_imp${String(i + 1).padStart(4, "0")}`,
    `${["标签管理", "综合总览", "推荐配置", "数据清洗"][i % 4]}-导入场景 ${i + 1}`,
    ["ui", "api", "ui", "manual"][i % 4], ["P1", "P2", "P2", "P3"][i % 4], i % 9 === 0 ? "warned" : "passed", "draft")),
];

const lint = {
  total: 349, blocked_case_ids: ["tc_8f2a1c0e05", "tc_x1", "tc_x2", "tc_x3", "tc_x4", "tc_x5", "tc_x6", "tc_x7"],
  stats: { p0_ratio: 0.375 },
  rule_hits: { group_not_subdivided: 349, p0_ratio: 131, expected_is_action: 50, category_other: 42, precondition_duplicates_step: 22, title_format: 14, conditional_expected: 8, undeclared_test_data: 8 },
  issues: [
    { id: "l1", case_id: "tc_8f2a1c0e05", rule: "conditional_expected", level: "block_script", message: "条件式预期：「若数值相同须记录说明」", suggestion: "在前置条件中固定数据状态，使预期只有一种结果" },
    { id: "l2", case_id: "tc_8f2a1c0e02", rule: "expected_is_action", level: "warn", message: "预期写成了操作：「记录导入结果」", suggestion: "改写为可判定的结果，如「页面显示导入成功 20 条」" },
    { id: "l3", case_id: "tc_8f2a1c0e02", rule: "undeclared_test_data", level: "warn", message: "步骤引用了未声明的测试数据：DEM-1002", suggestion: "在前置条件中声明：存在测试数据 DEM-1002" },
    { id: "l4", case_id: "tc_8f2a1c0e09", rule: "title_format", level: "warn", message: "标题「多端同步」不符合「模块-场景」格式", suggestion: "改为「模块-场景」，如「标签管理-停用标签」" },
    { id: "l5", case_id: "tc_8f2a1c0e01", rule: "p0_ratio", level: "info", message: "P0 占比 37.5% 超过阈值 25%", suggestion: "复核 P0 定级，仅保留核心链路用例" },
    { id: "l6", case_id: "tc_8f2a1c0e07", rule: "category_other", level: "info", message: "用例类型为「其它」", suggestion: "归入 功能测试 / 安全相关 / 兼容性" },
    ...Array.from({ length: 34 }, (_, i) => ({
      id: `lg${i}`, case_id: `tc_imp${String(i + 1).padStart(4, "0")}`, rule: "group_not_subdivided", level: "warn",
      message: "分组只有一级，没有按功能细分", suggestion: "按功能点拆分到二级分组",
    })),
  ],
};

const proposals = [{
  id: "heal_1", case_id: "tc_8f2a1c0e01", script_path: "scripts/ui/tc_8f2a1c0e01.spec.ts", status: "pending",
  reason: "页面改版：停用按钮的 data-testid 由 disable-TAG-1001 改为 tag-disable-btn-TAG-1001，文案改为「停用标签」",
  diff: [
    "--- a/scripts/ui/tc_8f2a1c0e01.spec.ts", "+++ b/scripts/ui/tc_8f2a1c0e01.spec.ts", "@@ -12,7 +12,7 @@",
    ' test("tc_8f2a1c0e01 标签管理-停用标签", async ({ page }, testInfo) => {', '   await page.goto("/tags");',
    '-  await page.getByTestId("disable-TAG-1001").click();', '+  await page.getByTestId("tag-disable-btn-TAG-1001").click();',
    '   await expect(page.getByTestId("status-TAG-1001")).toContainText("已停用");', " });",
  ].join("\n"),
}];

const reviews = [
  { id: "rev_1", case_id: "tc_8f2a1c0e03", kind: "visual", description: "缺失值显示为灰色「--」", ai_verdict: "pass", evidence_paths: [], status: "pending" },
  { id: "rev_2", case_id: "tc_8f2a1c0e03", kind: "visual", description: "窄视口（375px）下指标卡片不重叠、不截断", ai_verdict: "fail", evidence_paths: [], status: "pending" },
];

const attributions = [
  { run_id: "run_5c1e", case_id: "tc_8f2a1c0e01", auto_type: "script_error", source: "agent", reason: "按钮 testid 变更，属于页面改版" },
  { run_id: "run_5c1e", case_id: "tc_8f2a1c0e08", auto_type: "product_bug", source: "agent", reason: "停用后接口仍返回 200，未校验授权状态" },
  { run_id: "run_5c1e", case_id: "tc_8f2a1c0e04", auto_type: "environment", source: "rule", reason: "确定性规则判定" },
];

const mockRuns = [
  { id: "run_9a7b", env: "test", mode: "regression", started_at: "2026-11-10T15:12:04+08:00", framework: "playwright" as const, total: 28, passed: 25, failed: 3, skipped: 0, pass_rate: 0.893, html_report: "/Users/demo/aitest/feature-center/reports/ui-1/html" },
  { id: "run_8d2f", env: "test", mode: "regression", started_at: "2026-11-10T15:05:41+08:00", framework: "pytest" as const, total: 35, passed: 33, failed: 2, skipped: 0, pass_rate: 0.943, junit: "/Users/demo/aitest/feature-center/reports/run_8d2f.xml" },
  { id: "run_77c1", env: "test", mode: "regression", started_at: "2026-11-09T18:20:13+08:00", framework: "playwright" as const, total: 28, passed: 28, failed: 0, skipped: 0, pass_rate: 1, html_report: "/Users/demo/aitest/feature-center/reports/ui-0/html" },
  { id: "run_5c1e", env: "test", mode: "regression", started_at: "2026-11-09T10:02:55+08:00", framework: "pytest" as const, total: 35, passed: 35, failed: 0, skipped: 0, pass_rate: 1 },
];

const mockDetail = (id: string) => {
  const run = mockRuns.find((r) => r.id === id) ?? mockRuns[0];
  const failed = run.failed ? [
    { case_id: "tc_8f2a1c0e01", title: "标签管理-停用标签", module: "特征中心 / 标签管理", priority: "P0", status: "failed", duration: 8.2,
      message: 'locator.click: Timeout 5000ms exceeded.\nCall log:\n  - waiting for getByTestId("disable-TAG-1001")',
      failure_type: "script_error", attribution_confirmed: false, attribution_reason: "按钮 testid 变更，属于页面改版",
      evidence_paths: ["reports/ui-1/artifacts/trace.zip"], reviews: [] },
    { case_id: "tc_8f2a1c0e08", title: "服务接口-授权停用", module: "特征中心 / 服务接口", priority: "P1", status: "failed", duration: 0.4,
      message: "状态码 200 不在预期 [403] 中；响应：{\"ok\":true}", failure_type: "product_bug", attribution_confirmed: true,
      attribution_reason: "停用后接口仍返回 200，未校验授权状态", evidence_paths: [], reviews: [] },
    { case_id: "tc_8f2a1c0e04", title: "推荐配置-接口越权", module: "特征中心 / 推荐配置", priority: "P0", status: "error", duration: 30,
      message: "page.goto: net::ERR_CONNECTION_REFUSED", failure_type: "environment", attribution_confirmed: false,
      attribution_reason: "确定性规则判定", evidence_paths: [], reviews: [] },
  ].slice(0, run.failed) : [];
  const passed = Array.from({ length: Math.min(run.passed, 12) }, (_, i) => ({
    case_id: `tc_pass_${i}`, title: cases[i % cases.length].title, module: cases[i % cases.length].module_path.join(" / "),
    priority: cases[i % cases.length].priority, status: "passed", duration: 1 + (i % 5) * 0.7, message: "", failure_type: undefined,
    attribution_confirmed: false, attribution_reason: "", evidence_paths: [],
    reviews: i === 2 ? [{ description: "缺失值显示为灰色「--」", ai_verdict: "pass", status: "pending" }] : [],
  }));
  return {
    run: { ...run, base_url: "https://feature-test.example.com" },
    project: projects[0],
    summary: { total: run.total, passed: run.passed, failed: run.failed, skipped: 0, pass_rate: run.pass_rate, duration: 214.6,
      failure_types: Object.fromEntries(failed.map((f) => [f.failure_type, 1])), pending_reviews: run.framework === "playwright" ? 1 : 0 },
    results: [...failed, ...passed],
  };
};

let globalSettings: GlobalSettings = {
  version: 2,
  models: [
    { id: "agent", name: "百炼 qwen-max", preset: "dashscope", model: "qwen-max" },
    { id: "vision", name: "私有化 Qwen3-VL", preset: "private", baseUrl: "http://10.0.0.8:8000/v1", model: "Qwen3-VL-8B" },
    { id: "m_ds", name: "DeepSeek", preset: "deepseek", model: "deepseek-chat" },
  ],
  agentModelId: "agent",
  visionModelId: "vision",
  general: { theme: "system" },
};
const modelKeys: Record<string, boolean> = { agent: true, m_ds: true };
const globalView = (): GlobalSettingsView => ({
  settings: globalSettings,
  hasKey: Object.fromEntries(globalSettings.models.map((m) => [m.id, Boolean(modelKeys[m.id])])),
  runtime: {
    appVersion: "0.3.5", dataDir: "/Users/demo/Library/Application Support/aitest-desktop",
    dbPath: "/Users/demo/Library/Application Support/aitest-desktop/aitest.db",
    python: { path: globalSettings.general.pythonPath || "python3", source: globalSettings.general.pythonPath ? "settings" : "default" },
    codex: globalSettings.general.codexPath ? { path: globalSettings.general.codexPath, source: "settings" }
      : { path: "/Applications/AIProbe.app/Contents/Resources/codex/bin/codex", source: "bundled" },
    taskTokenLimit: { value: globalSettings.general.taskTokenLimit ?? 200000, source: globalSettings.general.taskTokenLimit ? "settings" : "default" },
    maestro: { path: globalSettings.general.maestroPath || "maestro", source: globalSettings.general.maestroPath ? "settings" : "default" },
    pinky: { path: globalSettings.general.pinkyPath || "pinkyctl", enabled: Boolean(globalSettings.general.pinkyEnabled) },
    envOverrides: [],
  },
});

/** 与主进程一致：生产环境未确认时拒绝执行 */
const requireConfirm = (id: string, env: string, opts?: { confirmProduction?: boolean }) => {
  const p = projects.find((x) => x.id === id);
  return p && view(p).environments[env]?.production && !opts?.confirmProduction
    ? Promise.reject(new Error(`「${env}」是生产环境，需要确认后才能执行`)) : undefined;
};

const roleSecrets: Record<string, { account: boolean; token: boolean; inherited: boolean }> = {
  管理员: { account: true, token: false, inherited: true },
  运营: { account: true, token: true, inherited: true },
};

/** 本次预览中新建、还没导入用例的项目：用例、执行记录都为空，用来演示新建后的引导 */
const fresh = new Set<string>();
/** 新建后还没执行过回归的项目 */
const neverRun = new Set<string>();

const listeners: {
  approval?: (r: ApprovalRequest) => void;
  event?: (e: { method: string; params: unknown }) => void;
  view?: (v: { visible: boolean; docked?: boolean; shown?: boolean }) => void;
  update?: (s: UpdateState) => void;
} = {};

let updateState: UpdateState = { status: "idle", current: "0.3.11", feedUrl: "https://download.classktv.com/aitest-desktop" };
const setUpdate = (next: Partial<UpdateState>) => {
  updateState = { ...updateState, ...next };
  listeners.update?.(updateState);
};

const apiTestSets: Record<string, ApiTestSet[]> = {};
const uiScripts: Record<string, UiScriptState> = {
  tc_8f2a1c0e01: { path: "scripts/ui/tc_8f2a1c0e01.spec.ts", hash: "demo-1", status: "pending" },
};
/** 演示脚本步骤：按用例步骤分组，最后一步故意失败以展示定位效果 */
const demoSteps = (caseId: string): UiStepView[] => [
  { id: "S1", caseStep: 1, action: "goto", description: "打开 /tags", role: "管理员", source: "ai" },
  { id: "S2", caseStep: 1, action: "expectVisible", description: "断言可见 table「标签列表」", role: "管理员", source: "ai" },
  { id: "S3", caseStep: 2, action: "fill", description: "在 占位「搜索标签」 输入「TAG-1001」", role: "管理员", source: "ai" },
  { id: "S4", caseStep: 2, action: "click", description: `点击 testid「disable-TAG-1001」`, role: "管理员", source: "ai" },
  { id: "S5", caseStep: 3, action: "expectText", description: `断言 testid「status-TAG-1001」 包含「已停用」`, role: "管理员", source: caseId.endsWith("1") ? "ai" : "user" },
];
let debugSession: UiDebugSession | undefined;
const roleSessionTimes: Record<string, string> = {};
const debugFailed = new Set<string>();
let viewState = { visible: false, docked: false };
const setView = (next: Partial<typeof viewState>) => { viewState = { ...viewState, ...next }; listeners.view?.(viewState); };
const eventListeners = new Set<(e: { method: string; params: unknown }) => void>();
listeners.event = event => eventListeners.forEach(cb => cb(event));
const mockApi: AitestApi = {
  listProjects: () => delay(projects.map(view)),
  createProject: async (name, workspace, environments, opts) => {
    const p = { id: `proj_${Date.now()}`, name, workspace_path: opts?.kind === "group" ? "" : workspace,
      environments, kind: opts?.kind ?? "project", parent_id: opts?.parent ?? "", project_type: opts?.projectType ?? "multi" };
    projects.push(p);
    fresh.add(p.id);
    neverRun.add(p.id);
    return delay(view(p));
  },
  moveProject: async (id, parent) => {
    const p = projects.find((x) => x.id === id);
    if (p) p.parent_id = parent;
    return delay(view(p));
  },
  projectOverview: (id) => delay({
    children: projects.filter((x) => x.parent_id === id).map((c, i) => ({
      id: c.id, name: c.name, workspace_path: c.workspace_path, cases: [66, 41][i] ?? 0, reviewed: [24, 12][i] ?? 0, blocked: [8, 1][i] ?? 0,
      last_run: i === 0 ? { run_id: "run_8d2f", started_at: "2026-11-10T15:20:00Z", env: "test", framework: "pytest", total: 35, passed: 33, pass_rate: 0.943 } : null,
      month_tokens: [412300, 86000][i] ?? 0,
    })),
    budget: { month_used: 498300, monthly_budget: 2000000, allowed: true },
  }),
  getSettingsDetail: (id) => {
    const p = projects.find((x) => x.id === id);
    const group = { monthly_token_budget: 2000000, price_per_mtok: 20, currency: "CNY", stability_threshold: 0.95 };
    if (p?.kind === "group" || !p?.parent_id) return delay({ effective: group, own: group, inherited: {}, parent_id: "", parent_name: "" });
    const own = { per_task_token_limit: 200000 };
    return delay({ effective: { ...group, ...own }, own, inherited: group, parent_id: p.parent_id, parent_name: "特征中心" });
  },
  importExcel: (p) => {
    fresh.delete(p);
    return delay({ imported: 349 }, 600);
  },
  lint: (p) => delay(fresh.has(p) ? { total: 0, rule_hits: {}, blocked_case_ids: [], stats: {} } : (({ issues: _, ...summary }) => summary)(lint), 400),
  listCases: () => delay(cases),
  pageCases: (p, q) => {
    if (fresh.has(p)) return page([], q);
    const f = q.filters ?? {};
    const text = q.query ?? "";
    return page(cases.filter((c) =>
      (!text || c.title.includes(text) || c.id.includes(text) || c.module_path.join("/").includes(text)) &&
      matches(c.id, f.ids) && (!f.exclude_ids || !f.exclude_ids.split(",").includes(c.id)) &&
      matches(c.execution_mode, f.execution_mode) && matches(c.priority, f.priority) &&
      matches(c.status, f.status) && matches(c.lint_status, f.lint_status)), q);
  },
  pageIssues: (p, q) => {
    if (fresh.has(p)) return page([], q, { levels: {} });
    const levels: Record<string, number> = {};
    for (const i of lint.issues) levels[i.level] = (levels[i.level] ?? 0) + 1;
    return page(lint.issues.filter((i) => matches(i.level, q.level)), q, { levels });
  },
  updateCase: async (id, patch) => {
    Object.assign(cases.find((c) => c.id === id) ?? {}, patch);
    return delay({});
  },
  applyFix: () => delay({}),
  generateApiSuite: (p) => (fresh.delete(p), delay({ generated: { generated: 37 }, suite: { cases: 35, skipped: 2, test: "scripts/api/test_api.py", version: "a3f9c21d7e0b" } }, 800)),
  generateCases: () => delay({ message: "新增 24 条用例：UI 16、接口 6、埋点抓包 2。仍有 3 条警告（预期写成操作）。用例为草稿，等待审核。", tokens: 18420 }, 900),
  writeReviewedApiSuite: () => delay({ cases: 3 }),
  listApiTestSets: (p) => delay(apiTestSets[p] ?? []),
  saveApiTestSet: (p, name, ids) => {
    const entry = { name, case_ids: ids };
    apiTestSets[p] = [...(apiTestSets[p] ?? []).filter((s) => s.name !== name), entry];
    return delay(entry);
  },
  runRegression: (id, env, opts) => requireConfirm(id, env, opts) ?? (neverRun.delete(id), delay({
    run: opts?.caseIds ? { run_id: "run_selected", total: opts.caseIds.length, passed: opts.caseIds.length,
      failed: 0, error: 0, skipped: 0, pass_rate: 1 } :
      { run_id: "run_8d2f", total: 35, passed: 33, failed: 2, error: 0, skipped: 0, pass_rate: 0.943 },
    triage: opts?.caseIds ? [] : [
      { case_id: "tc_8f2a1c0e08", failure_type: "product_bug", reason: "停用后接口仍返回 200", suggestion: "提交缺陷：授权停用未生效" },
      { case_id: "tc_api_017", failure_type: "environment", reason: "确定性规则判定" },
    ],
  }, 900)),
  tokenUsage: () => delay({ tokens: 412300 }),
  setEnvSecret: () => delay(undefined),
  setRoleSecret: async (_p, role, username, _password, token) => {
    roleSecrets[role] = { account: Boolean(username) || roleSecrets[role]?.account || false, token: Boolean(token) || roleSecrets[role]?.token || false, inherited: false };
    return delay(undefined);
  },
  roleSecretStatus: () => delay(roleSecrets),
  listRoles: (id) => delay(id === "grp_feature" || projects.find((x) => x.id === id)?.parent_id === "grp_feature"
    ? [{ role_name: "管理员" }, { role_name: "运营" }, { role_name: "分析师" }, { role_name: "访客" }]
        .map((r) => (id === "grp_feature" ? r : { ...r, inherited_from: "grp_feature" }))
    : [{ role_name: "管理员" }]),
  setEnvironment: async (id, env, cfg) => {
    const p = projects.find((x) => x.id === id);
    if (p) p.environments[env] = cfg;
    return delay({});
  },
  deleteEnvironment: async (id, env) => {
    const p = projects.find((x) => x.id === id);
    if (p) delete p.environments[env];
    return delay({});
  },
  renameProject: async (id, name) => {
    const p = projects.find((x) => x.id === id);
    if (p) p.name = name;
    return delay({});
  },
  setProjectType: async (id, projectType) => {
    const p = projects.find((x) => x.id === id);
    if (p) p.project_type = projectType;
    return delay({});
  },
  clearCases: async (id) => {
    const n = cases.length;
    cases.splice(0, n);
    fresh.add(id);
    return delay({ id, deleted: { testcase: n } }, 500);
  },
  deleteProject: async (id) => {
    const i = projects.findIndex((x) => x.id === id);
    const [p] = projects.splice(i, 1);
    return delay({ id, workspace_path: p?.workspace_path ?? "" });
  },
  getCase: (id) => delay(cases.find((c) => c.id === id)),
  scriptMap: (framework) => delay<Record<string, string>>(framework === "maestro"
    ? { tc_app_001: "scripts/app/tc_app_001.yaml", tc_app_003: "scripts/app/tc_app_003.yaml" }
    : framework === "pytest" ? { tc_8f2a1c0e04: "scripts/api/test_api.py", tc_8f2a1c0e08: "scripts/api/test_api.py", tc_8f2a1c0e11: "scripts/api/test_api.py" } : {}),
  caseTitles: (_p, ids) => delay(Object.fromEntries(cases.filter((c) => ids.includes(c.id)).map((c) => [c.id, c.title]))),
  uiScriptStates: (_id, _env) => delay(uiScripts),
  // 单步调试：复用主进程的调试状态机，浏览器换成假的（S4 第一次执行失败，用于演示失败停住）
  uiDebugStart: async (id, env, caseId, opts) => {
    const blocked = requireConfirm(id, env, opts); if (blocked) return blocked as never;
    if (debugSession) throw new Error("已有调试会话，请先结束调试");
    const steps = demoSteps(caseId).map((st) => ({ id: st.id, caseStep: st.caseStep, role: st.role, action: "press", key: st.description })) as UiStep[];
    debugSession = new UiDebugSession({
      projectId: id, env, caseId, file: { version: 1, caseId, title: "", specHash: "", steps },
      browser: {
        runStep: async (st) => {
          await delay(null, 450);
          if ((st as { id?: string }).id === "S4" && !debugFailed.has(caseId)) {
            debugFailed.add(caseId);
            throw new Error("TimeoutError: locator.click: Timeout 5000ms exceeded.\n  - waiting for getByTestId('disable-TAG-1001')");
          }
          return (st as { id?: string }).id === "S2" ? { note: "演示：这一步只截图，视觉判定需人工确认" } : {};
        },
        resetCaptures: () => undefined,
        close: async () => undefined,
      },
      prepareRole: async () => { setView({ visible: true }); },
      runOptions: {},
      emit: (state) => listeners.event?.({ method: "aitest/progress", params: { projectId: id, env, stage: "ui-debug", caseId, state } }),
    });
    setView({ visible: true });
    return debugSession.state();
  },
  uiDebugCommand: async (cmd) => {
    if (!debugSession) throw new Error("没有进行中的调试");
    const state = await debugSession.command(cmd);
    if (state.phase === "stopped") debugSession = undefined;
    return state;
  },
  uiDebugState: async () => debugSession?.state() ?? null,
  stopUiTask: async () => { mockUiStopped = true; },
  openRoleLogin: async () => { setView({ visible: true }); },
  saveRoleLogin: async (_p, _e, role) => { roleSessionTimes[role] = new Date().toISOString(); return delay({ cookies: 3, localStorage: 1, url: "https://feature-test.example.com/index", savedAt: roleSessionTimes[role] }, 300); },
  roleSessions: async () => delay({ ...roleSessionTimes }),
  uiScriptDetail: (_id, _env, caseId) => delay(uiScripts[caseId] ? {
    path: uiScripts[caseId].path, synced: true, steps: demoSteps(caseId),
    code: `// 用例 ID：${caseId}\nimport { expect, test } from "@playwright/test";\n\ntest("${caseId}", async ({ page }) => {\n${demoSteps(caseId).map((st) => `  await test.step("[${st.id}] ${st.description}", async () => { /* … */ });`).join("\n")}\n});\n`,
  } : null),
  confirmUiScript: async (_id, _env, caseId, hash) => {
    if (!uiScripts[caseId]?.validatedRunId || uiScripts[caseId].hash !== hash) throw new Error("请先完成校验");
    uiScripts[caseId].status = "confirmed";
  },
  reviseUiScript: async (id, env, caseId, feedback, opts) => {
    mockUiStopped = false;
    const blocked = requireConfirm(id, env, opts); if (blocked) return blocked;
    await delay(null, 500);
    if (mockUiStopped) throw new Error("UI_TASK_STOPPED");
    proposals.unshift({ id: `proposal_${Date.now()}`, case_id: caseId, script_path: uiScripts[caseId]?.path ?? "", diff: `@@ -1 +1 @@\n-// 原脚本\n+// 修正：${feedback}`, reason: feedback, status: "pending" });
    return { message: "已提交脚本修改建议，请审核差异，应用后重新试跑。" };
  },
  exploreUiCase: async (id, env, caseId, opts) => {
    mockUiStopped = false;
    const blocked = requireConfirm(id, env, opts); if (blocked) return blocked;
    await delay(null, 600);
    if (mockUiStopped) throw new Error("UI_TASK_STOPPED");
    uiScripts[caseId] = { path: `scripts/ui/${caseId}.spec.ts`, hash: `demo-${Date.now()}`, status: "pending" };
    return { message: "脚本已生成，请在内嵌浏览器中试跑校验。" };
  },
  runUiRegression: async (id, env, _headed, opts) => {
    mockUiStopped = false;
    const blocked = requireConfirm(id, env, opts); if (blocked) return blocked;
    const ids = opts?.caseIds ?? [];
    for (const caseId of ids) {
      for (const st of demoSteps(caseId)) {
        const title = `[${st.id}] ${st.description}`;
        listeners.event?.({ method: "aitest/progress", params: { projectId: id, env, stage: "ui-step", caseId, title, status: "running", stepId: st.id, kind: "step" } });
        await delay(null, 260);
        if (mockUiStopped) throw new Error("UI_TASK_STOPPED");
        listeners.event?.({ method: "aitest/progress", params: { projectId: id, env, stage: "ui-step", caseId, title, status: "passed", stepId: st.id, kind: "step" } });
      }
      if (opts?.mode === "validate" && uiScripts[caseId]) uiScripts[caseId].validatedRunId = "run_demo";
    }
    return { run: { run_id: "run_demo", total: ids.length, passed: ids.length, failed: 0, error: 0, reviews: 0 }, failures: [], degraded: [], missingData: [], htmlReport: "reports/ui/html" };
  },
  listProposals: (status) => delay(proposals.filter((p) => !status || p.status === status)),
  pageProposals: (_p, q) => page(proposals.filter((p) => matches(p.status, q.status)), q),
  resolveProposal: async (_p, id, accept) => {
    const index = proposals.findIndex((p) => p.id === id);
    const proposal = proposals[index];
    if (accept && proposal && uiScripts[proposal.case_id]) {
      uiScripts[proposal.case_id] = { ...uiScripts[proposal.case_id], hash: `demo-${Date.now()}`, status: "pending", validatedRunId: undefined };
    }
    if (index >= 0) proposals.splice(index, 1);
    return delay({});
  },
  listReviews: (status) => delay(reviews.filter((r) => !status || r.status === status)),
  pageReviews: (_p, q) => page(reviews.filter((r) => matches(r.status, q.status)), q),
  resolveReview: async (id) => {
    reviews.splice(reviews.findIndex((r) => r.id === id), 1);
    return delay({});
  },
  usageReport: () => delay({
    days: 30, total_tokens: 412300, agent_tasks: 23, estimated_cost: 8.25, currency: "CNY",
    by_purpose: { case_gen: 186000, explore: 121500, heal: 64300, triage: 31000, api_script: 9500 }, by_day: {}, all_time_tokens: 412300,
  }),
  checkBudget: () => delay({ month_used: 412300, monthly_budget: 2000000, remaining: 1587700, allowed: true, per_task_limit: 200000 }),
  getSettings: () => delay({ monthly_token_budget: 2000000, per_task_token_limit: 200000, price_per_mtok: 20, currency: "CNY", stability_threshold: 0.95 }),
  setSettings: (_p, s) => delay(s as Record<string, unknown>),
  metrics: () => delay({
    first_pass_rate: 0.733, first_pass: { passed: 22, measured: 30 },
    attribution_accuracy: 0.857, attribution: { correct: 12, confirmed: 14 },
    interventions_per_case: 1.4, interventions: { total: 42, cases: 30, by_kind: {} },
    ui_gate: { passed: false, runs: 4, avg_pass_rate: 0.962, threshold: 0.95, flaky_cases: ["tc_8f2a1c0e07"], reasons: ["不稳定用例 1 条"] },
  }),
  stability: () => delay({ window: 10, cases: [], flaky: [] }),
  listAttributions: () => delay(attributions),
  pageAttributions: (_p, q) => page(attributions, q),
  confirmAttribution: async (run, caseId) => {
    attributions.splice(attributions.findIndex((a) => a.run_id === run && a.case_id === caseId), 1);
    return delay({});
  },
  exportWorkspace: () => delay({ cases: 349, scripts: 30 }),
  importWorkspace: () => delay({ cases: 349 }),
  initCi: () => delay("/Users/demo/aitest/feature-center/.github/workflows/aitest.yml"),
  modelPresets: () => delay([
    { id: "openai", name: "OpenAI（默认）", baseUrl: "https://api.openai.com/v1", model: "", visionFamily: "openai", note: "Codex 默认配置；国内使用需先确认可用性与合规" },
    { id: "dashscope", name: "阿里云百炼（通义千问）", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-max", visionModel: "qwen-vl-max", visionFamily: "qwen-vl", note: "OpenAI 兼容模式" },
    { id: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat", note: "无视觉模型，视觉定位需另配" },
    { id: "ark", name: "火山方舟（豆包）", baseUrl: "https://ark.cn-beijing.volces.com/api/v3", model: "", visionFamily: "doubao-vision", note: "模型名填方舟上的推理接入点 ID" },
    { id: "private", name: "私有化部署（OpenAI 兼容）", baseUrl: "", model: "", visionFamily: "qwen-vl", note: "如 vLLM / SGLang 部署的 Qwen3、Qwen3-VL" },
  ]),
  getGlobalSettings: () => delay(globalView()),
  saveGlobalSettings: async (s, keys) => {
    if (s.models.some((m, i) => s.models.findIndex((x) => x.name === m.name) !== i)) throw new Error("模型名称重复");
    for (const id of Object.keys(modelKeys)) if (!s.models.some((m) => m.id === id)) delete modelKeys[id];
    for (const [id, k] of Object.entries(keys ?? {})) if (k) modelKeys[id] = true;
    globalSettings = structuredClone(s);
    return delay(globalView());
  },
  checkRuntime: () => delay({
    python: { ok: true, detail: "Python 3.12.4" }, codex: { ok: true, detail: "codex-cli 0.167.0" },
    maestro: { ok: true, detail: "2.1.0" }, pinky: { ok: true, detail: "pinkyctl 0.4.2" },
  }, 500),
  runAppRegression: (id, env, platform, opts) => requireConfirm(id, env, opts) ?? delay({
    platform, report: "reports/app-android-2026-11-11",
    run: { run_id: "run_app1", total: 12, passed: 10, failed: 1, error: 1, skipped: 0, pass_rate: 0.833 },
    failures: [
      { case_id: "tc_app_003", status: "failed", failure_type: "unknown", message: "Assertion is false: \"已停用\" is visible" },
      { case_id: "tc_app_007", status: "error", failure_type: "environment", message: platform === "ios" ? "App com.example.feature is not installed on the device" : "Device emulator-5554 not found" },
    ],
  }, 1200),
  exploreAppCase: () => delay({ message: "已在 Android 上走通 5 步，生成 scripts/app/tc_app_001.yaml，试跑通过；「删除标签」一步由你在 Pinky 中确认。", tokens: 21400 }, 1200),
  openDataDir: () => delay(""),
  getUserInfo: () => delay({ name: "张晓", email: "zhangxiao@example.com", source: "git" as const }),
  checkModel: (id) => delay(id !== "vision"
    ? { ok: true, latencyMs: 312, detail: "服务可用" }
    : { ok: false, latencyMs: 15003, detail: "无法连接 http://10.0.0.8:8000/v1：timeout" }, 700),
  pickFile: () => delay("/Users/demo/Downloads/特征中心v4.4用例.xlsx"),
  pickDirectory: () => delay("/Users/demo/aitest/new-project"),
  // 预览时模拟内嵌浏览器：界面收窄到左半屏
  openTestPage: async () => setView({ visible: true }),
  hideTestView: async () => setView({ visible: false }),
  dockTestView: async (dock) => { if (Boolean(dock) !== viewState.docked) setView({ docked: Boolean(dock) }); },
  saveDatabase: () => delay({}),
  removeDatabase: () => delay({}),
  testDatabase: (_p, _e, name) => name === "main" ? delay({ ok: true, elapsed_ms: 23.4 }, 400)
    : new Promise((_, rej) => setTimeout(() => rej(new Error("无法连接 analytics（postgresql）：timeout")), 600)),
  queryDatabase: () => delay({
    columns: ["code", "name", "status", "updated_at", "updated_by"],
    rows: [
      { code: "TAG-1001", name: "高价值用户", status: "disabled", updated_at: "2026-11-10T15:12:09", updated_by: "admin" },
      { code: "TAG-1002", name: "沉睡用户", status: "active", updated_at: "2026-11-08T10:01:44", updated_by: null },
    ],
    row_count: 2, truncated: false, elapsed_ms: 18.6,
  }, 400),
  hasDbPassword: () => delay(true),
  listRuns: (p, framework) => delay(neverRun.has(p) ? [] : mockRuns.filter((r) => !framework || r.framework === framework)),
  runDetail: (id) => delay(mockDetail(id)),
  exportReport: (ids, format) => delay({ path: `/Users/demo/Documents/测试报告-${ids[0]}.${format}` }, 500),
  exportCasesExcel: (_p, name) => delay({ path: `/Users/demo/Documents/${name}-用例.xlsx`, cases: 349 }, 500),
  openPath: () => delay(undefined),
  showInFolder: () => delay(undefined),
  onApprovalRequest: (cb) => {
    listeners.approval = cb;
    return () => (listeners.approval = undefined);
  },
  respondApproval: () => undefined,
  onEvent: (cb) => {
    eventListeners.add(cb);
    return () => { eventListeners.delete(cb); };
  },
  getUpdateState: () => delay(updateState),
  checkForUpdates: async () => {
    // 演示：发现新版本 → 后台下载 → 下载完成
    setUpdate({ status: "checking" });
    await delay(null, 600);
    setUpdate({ status: "downloading", version: "0.3.12", progress: 0 });
    for (const p of [18, 42, 67, 90]) {
      await delay(null, 350);
      setUpdate({ progress: p });
    }
    await delay(null, 350);
    setUpdate({ status: "downloaded", progress: 100, checkedAt: new Date().toISOString() });
    return updateState;
  },
  installUpdate: async () => {
    setUpdate({ status: "idle", current: updateState.version ?? updateState.current, version: undefined });
  },
  onUpdate: (cb) => {
    listeners.update = cb;
    return () => (listeners.update = undefined);
  },
  onViewChange: (cb) => {
    listeners.view = cb;
    return () => (listeners.view = undefined);
  },
};

export function installMock(): void {
  window.aitest = mockApi;
  // 演示：活动记录与审批弹窗（?approval=1）
  setTimeout(() => {
    listeners.event?.({ method: "aitest/progress", params: { stage: "explore" } });
    listeners.event?.({ method: "item/started", params: { item: { type: "mcpToolCall", server: "browser", tool: "snapshot" } } });
    listeners.event?.({ method: "turn/completed", params: {} });
  }, 300);
  if (new URLSearchParams(location.search).has("approval")) {
    setTimeout(() => listeners.approval?.({
      id: "a1", kind: "command", reason: "访问生产环境 feature.example.com",
      detail: { command: "curl -X POST https://feature.example.com/api/tags/TAG-1001/disable", cwd: "/Users/demo/aitest/feature-center" },
    }), 600);
  }
}
