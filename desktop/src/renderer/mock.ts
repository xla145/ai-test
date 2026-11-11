/**
 * 演示数据：在普通浏览器中预览界面（npm run preview:web）时替代 Electron 预加载脚本提供的 window.aitest。
 * 只在 window.aitest 不存在时动态加载，不进入桌面端的正常流程。
 */
import type { AitestApi, ApprovalRequest } from "../shared/ipc";

const delay = <T,>(v: T, ms = 250) => new Promise<T>((r) => setTimeout(() => r(structuredClone(v)), ms));

const projects = [
  {
    id: "proj_feature", name: "特征中心 v4.4", workspace_path: "/Users/demo/aitest/feature-center",
    environments: {
      test: { base_url: "https://feature-test.example.com", login: { url: "/login", username: "#username", password: "#password", submit: "button[type=submit]", success: "/overview" },
        databases: {
          main: { type: "mysql", host: "10.0.3.21", port: 3306, database: "feature_center", user: "qa_readonly", readonly: true },
          analytics: { type: "postgresql", host: "10.0.3.40", database: "tracking", user: "qa", readonly: false },
        } },
      prod: { base_url: "https://feature.example.com", production: true },
    },
  },
  { id: "proj_order", name: "订单服务", workspace_path: "/Users/demo/aitest/order-service", environments: { test: { base_url: "https://order-test.example.com" } } },
];

const mk = (id: string, title: string, mode: string, priority: string, lint: string, status: string, extra: Record<string, unknown> = {}) => ({
  id, title, type: mode === "api" ? "api" : "ui", priority, category: "功能测试", module_path: ["特征中心", title.split("-")[0]],
  execution_mode: mode, preconditions: ["存在启用中的标签 TAG-1001"], steps: ["进入标签管理页", "停用标签 TAG-1001"],
  expected: ["页面展示标签列表", "标签状态显示为已停用"], lint_status: lint, status, data_refs: ["TAG-1001"], ...extra,
});

const cases = [
  mk("tc_8f2a1c0e01", "标签管理-停用标签", "ui", "P0", "passed", "reviewed"),
  mk("tc_8f2a1c0e02", "标签管理-批量导入标签", "ui", "P1", "warned", "draft"),
  mk("tc_8f2a1c0e03", "综合总览-指标卡片展示", "ui", "P0", "passed", "reviewed"),
  mk("tc_8f2a1c0e04", "推荐配置-接口越权", "api", "P0", "passed", "reviewed"),
  mk("tc_8f2a1c0e05", "用户特征-数值核对", "ui", "P1", "blocked", "draft", { expected: ["若数值相同须记录说明"] }),
  mk("tc_8f2a1c0e06", "埋点-停用按钮 click 上报", "capture", "P1", "passed", "reviewed"),
  mk("tc_8f2a1c0e07", "数据清洗-规则启停", "ui", "P2", "passed", "draft"),
  mk("tc_8f2a1c0e08", "服务接口-授权停用", "api", "P1", "passed", "reviewed"),
  mk("tc_8f2a1c0e09", "多端-桌面客户端同步", "manual", "P3", "warned", "draft"),
  mk("tc_8f2a1c0e10", "埋点表-字段核对", "doc", "P2", "passed", "draft"),
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

const listeners: { approval?: (r: ApprovalRequest) => void; event?: (e: { method: string; params: unknown }) => void } = {};

const mockApi: AitestApi = {
  listProjects: () => delay(projects),
  createProject: async (name, workspace, environments) => {
    const p = { id: `proj_${Date.now()}`, name, workspace_path: workspace, environments: environments as never };
    projects.push(p as never);
    return delay(p);
  },
  importExcel: () => delay({ imported: 349 }, 600),
  lint: () => delay(lint, 400),
  listCases: () => delay(cases),
  updateCase: async (id, patch) => {
    Object.assign(cases.find((c) => c.id === id) ?? {}, patch);
    return delay({});
  },
  applyFix: () => delay({}),
  generateApiSuite: () => delay({ generated: { generated: 37 }, suite: { cases: 35, skipped: 2, test: "scripts/api/test_api.py", version: "a3f9c21d7e0b" } }, 800),
  generateCases: () => delay({ message: "新增 24 条用例：UI 16、接口 6、埋点抓包 2。仍有 3 条警告（预期写成操作）。用例为草稿，等待审核。", tokens: 18420 }, 900),
  runRegression: () => delay({
    run: { run_id: "run_8d2f", total: 35, passed: 33, failed: 2, error: 0, skipped: 0, pass_rate: 0.943 },
    triage: [
      { case_id: "tc_8f2a1c0e08", failure_type: "product_bug", reason: "停用后接口仍返回 200", suggestion: "提交缺陷：授权停用未生效" },
      { case_id: "tc_api_017", failure_type: "environment", reason: "确定性规则判定" },
    ],
  }, 900),
  tokenUsage: () => delay({ tokens: 412300 }),
  setEnvSecret: () => delay(undefined),
  setRoleSecret: () => delay(undefined),
  listRoles: () => delay([{ role_name: "管理员" }, { role_name: "运营" }, { role_name: "分析师" }, { role_name: "访客" }]),
  setEnvironment: () => delay({}),
  exploreUiCase: () => delay({ message: "已生成脚本 scripts/ui/tc_8f2a1c0e02.spec.ts，试跑通过" }, 900),
  runUiRegression: () => delay({
    run: { run_id: "run_9a7b", total: 28, passed: 25, failed: 2, error: 1, reviews: 2 },
    heal: [{ case_id: "tc_8f2a1c0e01", failure_type: "script_error", reason: "按钮 testid 变更" }],
    degraded: ["tc_8f2a1c0e07"], missingData: ["DEM-1002"], htmlReport: "reports/ui/html",
  }, 1000),
  listProposals: (status) => delay(proposals.filter((p) => !status || p.status === status)),
  resolveProposal: async (_p, id) => {
    proposals.splice(proposals.findIndex((p) => p.id === id), 1);
    return delay({});
  },
  listReviews: (status) => delay(reviews.filter((r) => !status || r.status === status)),
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
  getModelSettings: () => delay({ agent: { preset: "dashscope" }, vision: { preset: "private", baseUrl: "http://10.0.0.8:8000/v1", model: "Qwen3-VL-8B" }, hasAgentKey: true, hasVisionKey: false }),
  setModelSettings: (m) => delay(m),
  checkModel: (slot) => delay(slot === "agent"
    ? { ok: true, latencyMs: 312, detail: "服务可用" }
    : { ok: false, latencyMs: 15003, detail: "无法连接 http://10.0.0.8:8000/v1：timeout" }, 700),
  pickFile: () => delay("/Users/demo/Downloads/特征中心v4.4用例.xlsx"),
  pickDirectory: () => delay("/Users/demo/aitest/new-project"),
  openTestPage: () => delay(undefined),
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
  listRuns: (_p, framework) => delay(mockRuns.filter((r) => !framework || r.framework === framework)),
  runDetail: (id) => delay(mockDetail(id)),
  exportReport: (ids, format) => delay({ path: `/Users/demo/Documents/测试报告-${ids[0]}.${format}` }, 500),
  exportCasesExcel: (_p, name) => delay({ path: `/Users/demo/Documents/${name}-用例.xlsx`, cases: 349 }, 500),
  openPath: () => delay(undefined),
  showInFolder: () => delay(undefined),
  hideTestView: () => delay(undefined),
  onApprovalRequest: (cb) => {
    listeners.approval = cb;
    return () => (listeners.approval = undefined);
  },
  respondApproval: () => undefined,
  onEvent: (cb) => {
    listeners.event = cb;
    return () => (listeners.event = undefined);
  },
  onViewChange: () => () => undefined,
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
