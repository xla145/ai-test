import type { ExecutionContract } from "@ai-test/mcp-servers";
/**
 * 发给 Codex 的任务提示。用例格式、脚本规范等固化在 workspace 的 AGENTS.md 与技能文件里，
 * 这里只描述本次任务，并且只传必要上下文（上下文裁剪）。
 */
export function caseGenerationPrompt(projectId: string, requirementFile: string): string {
  return [
    `任务：根据需求文档生成结构化测试用例。项目 ID：${projectId}。`,
    `1. 调用 doc-parser.parse_requirement 解析 ${requirementFile}，再用 doc-parser.list_sections 按功能点逐节读取（只读相关章节）。`,
    "2. 按 .agents/skills/test-design.md 设计用例，用 case-store.create_case 写入，并用 case-store.link_requirement 关联需求章节。UI 步骤按「页面 → 区域 → 唯一业务对象 → 控件 → 单个动作 → 明确结果」整理；固定角色、测试数据、输入值与初始状态。配置保存与运行时行为分别设计，未知条件明确标记待澄清，不能编造。",
    "3. 调用 case-import.lint_cases 自检，修复所有阻断级问题。",
    "4. 最后输出：新增用例数、各执行方式条数、仍存在的警告。用例保持草稿状态，等待人工审核。",
  ].join("\n");
}

export function apiScriptPrompt(projectId: string, openapiFile: string): string {
  return [
    `任务：为项目 ${projectId} 补充接口测试脚本。`,
    `1. 已用 api-runner.generate_api_cases 从 ${openapiFile} 生成基线用例；用 case-store.list_cases 查看。`,
    "2. 结合需求章节补充业务场景用例（接口间依赖用 extract + ${var}），按 .agents/skills/api-script.md 规范。",
    "3. 调用 api-runner.write_api_suite 生成脚本。不要执行 run_api_suite，回归由客户端调度。",
  ].join("\n");
}

export interface FailureBrief {
  case_id: string;
  failure_type: string | null;
  message: string;
}

export function triagePrompt(projectId: string, runId: string, failures: FailureBrief[]): string {
  const body = failures
    .map((f, i) => `### ${i + 1}. ${f.case_id}\n\`\`\`\n${f.message.slice(0, 1200)}\n\`\`\``)
    .join("\n\n");
  return [
    `任务：对项目 ${projectId} 的执行 ${runId} 中的失败用例做归因，按 .agents/skills/failure-triage.md 判断。`,
    "可用 case-store.list_cases 查看用例定义。产品缺陷不要修改脚本；脚本或用例错误给出修改建议，不要直接改。",
    "最后输出一个 JSON 数组：[{\"case_id\": \"...\", \"failure_type\": \"product_bug|script_error|environment|data|auth|model|unknown\", \"reason\": \"...\", \"suggestion\": \"...\"}]。证据不足时必须使用 unknown，不要强行归因。",
    "",
    body,
  ].join("\n");
}

/** 探索任务直接带上的用例内容：省去 agent 读技能文件、查用例的几轮往返 */
export interface ExploreCaseBrief {
  title?: string;
  preconditions?: string[];
  steps?: string[];
  expected?: string[];
  data_refs?: string[];
  available_data?: { key: string; bound: boolean; canCheck: boolean; canSeed: boolean; facts: string[] }[];
  capabilities?: { database: boolean; dataApi: boolean };
}

/** 裁剪合约 JSON：移除 sourceQuotes 和 verificationHint 以减少探索 prompt 体积 */
function slimContract(contract: ExecutionContract): unknown {
  return {
    ...contract,
    preconditionChecks: contract.preconditionChecks?.map(
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      ({ sourceQuotes: _sq, verificationHint: _vh, ...rest }) => rest,
    ),
  };
}

export function explorePrompt(projectId: string, env: string, caseId: string, roles: string[] = [], brief?: ExploreCaseBrief, locateStrategy: "dom-first" | "midscene-first" = "dom-first", contract?: ExecutionContract, selectedRole?: string): string {
  const list = (items: string[] | undefined) => (items?.length ? items.map((t, i) => `   ${i + 1}. ${t}`).join("\n") : "   （无）");
  const caseBlock = brief?.steps?.length
    ? [
      `用例内容（已给出，不必再调用 case-store.list_cases，也不必再读 .agents/skills/ui-explore.md，规则以本提示为准）：`,
      `  标题：${brief.title ?? caseId}`,
      `  前置条件：\n${list(brief.preconditions)}`,
      `  步骤：\n${list(brief.steps)}`,
      `  预期（与步骤一一对应）：\n${list(brief.expected)}`,
    ]
    : [`先用 case-store.list_cases 读取该用例（规则见 .agents/skills/ui-explore.md）。`];
  const dataLine = brief && !brief.data_refs?.length
    ? "用例尚未绑定 data_refs，不代表没有数据依赖。先核对前置条件中的角色、业务对象、初始状态及数据准备；用例已给出对象筛选条件时，先按条件观察页面并确认对象；指定数据不存在时报告阻塞。明确无数据依赖后才能跳过数据检查。"
    : "env-support.check_data 检查依赖数据；缺失时只按已声明的准备配方 seed_data，无法准备则阻塞。";
  return [
    `任务：探索模式。为项目 ${projectId} 的 UI 用例 ${caseId} 在内嵌浏览器中生成确定性 Playwright 脚本。执行环境：${env}。`,

    // ── 用例与数据 ──
    ...(contract ? ["已转换并缓存的执行用例（直接复用，运行时仍检查数据、会话和页面状态）：", JSON.stringify(slimContract(contract)), "已绑定数据：" + JSON.stringify(brief?.data_refs ?? []), "项目可用数据配方：" + JSON.stringify(brief?.available_data ?? [])] : caseBlock),
    ...(contract && brief ? ["覆盖索引以以下原始列表为准：", `原始前置条件：\n${list(brief.preconditions)}`, `原始预期：\n${list(brief.expected)}`] : []),
    ...(selectedRole ? [`本次选择的登录态角色：${JSON.stringify(selectedRole)}。原文未明确角色的已登录操作使用此角色并调用 browser.new_role_context(require_login=true)；用例明确指定其它角色或匿名测试时按用例执行。录制步骤必须保留实际使用的角色。`] : []),

    // ── 1. 数据准备 ──
    `1. ${contract && brief?.data_refs?.length ? "桌面端已完成绑定数据的检查或准备，仍须验证用例要求的业务状态。" : dataLine}`,
    "数据规则：只使用用例声明的 data_refs 和 valueRef 变量。配方键仅在原文明确指定或可唯一核对时选择，配方只表示能力而非通过证据。临时用户名/邮箱/密码用 browser.type 的 value_ref（username/email/password/other_password），同一用例只生成一次；有效账号和已有邮箱必须来自真实基线。",
    '变量绑定：valueRef 对应 browser.type 的 value_ref。method=runtime 的原子检查先 assertion_coverage 再 expect_runtime_input；数据库查询通过 expect_db 的 paramRefs 引用同一变量。随机值不证明尚未注册，仍按原文完成唯一性验证。',

    // ── 2. 项目初始化与前置条件 ──
    `2. browser.open_project（project_id=${projectId}, env=${env}, case_id=${caseId}）。`,
    `   已配置的角色：${roles.length ? roles.join("、") : "（无）"}。角色必须精确匹配；缺少用例要求的角色报告阻塞；匿名页面无需建角色会话。`,
    '   前置条件要求已登录时，先调用 browser.new_role_context（角色名 + require_login=true）。loggedIn=false 且带 hint 时立即停止并写明 hint。',
    '   原子检查逐项执行：先 assertion_coverage({check_ids:["ID"]}) 再做对应 expect_* 断言；precondition_status 查看证据或报告不满足。全部通过前 case_step 和保存脚本会被拒绝。前置条件是硬门禁：任一不满足或无法验证，立即停止并报告阻塞。检查方法以当前可用能力和原文要求为准；原文要求数据库或后台行为时须对应证据。',

    // ── 3. 步骤执行 ──
    "3. 每开始一个用例步骤先调用 browser.case_step（index 从 1 开始）。每个预期或前置条件必须先 browser.assertion_coverage 传入原文序号，紧接着执行对应断言。assertion_coverage 与断言必须串行。埋点用 start_capture + expect_request。",
    contract
      ? "   用例已完成转换，按 index/actions/expected 执行。targetHint 是待页面确认的业务定位描述：先观察页面再解析实际控件。这属于定位而非重新转换；无法确定业务对象或页面确实不匹配时停止并报告。"
      : "   执行前检查每个步骤是否能触发对应预期。按页面、区域、业务对象、控件、单个动作、结果证据整理；步骤与预期错位时停止。下拉选择拆成打开下拉框、选择关联选项两次操作；开关使用 check 设置明确状态。",
    "   业务对象解析：修改操作前用页面证据核对全部条件和候选范围。唯一匹配时记录稳定标识并固定；多匹配仅用例明确允许任选时才选定一个；无匹配报告数据阻塞。后续操作和断言始终绑定选定对象。",

    // ── 定位策略 ──
    locateStrategy === "midscene-first"
      ? "   定位策略：优先 Midscene。需要定位新的操作目标时先调用 browser.ai_locate，描述目标及所在区域，再用返回的 ref 调用 click / type / press 等可录制操作；已有定位结果可复用。视觉工具未提供或定位失败时才回退 snapshot / browser.find_text。"
      : "   定位策略：优先 DOM。可交互元素用快照里的 ref；非交互文字用 browser.find_text 取 ref。两者都找不到时再用 browser.ai_locate。",

    // ── 定位与断言细则 ──
    "   效率：navigate/click/select/press 返回值已带操作后快照；只有需要查找未出现的元素时才调用 snapshot；连续按键用 press 一次传数组。截图仅用于证据留档或视觉类预期。",
    '   ai_locate 优先传 target，例如 {"page":"模型管理","scope":[{"kind":"region","name":"平台模型"},{"kind":"row","name":"模型记录","key":"实际编号"}],"control":"button","text":"编辑"}。目标上有文字时传 text 让它校验结果；text 只填目标自身文字或 placeholder；输入框传 intent=fill，开关传 intent=check，点击传 intent=click。scope 校验失败时不删除 target 改全局定位。',
    "   断言落在显示结果的元素上：某行的状态/数量文字用 find_text 按 context 取该单元格再 expect_text。同一断言不重复做。禁用/可用状态必须用 expect_enabled；数量要求用 expect_collection。",
    "   expect_value 必须绑定 snapshot 中 role 为 textbox/combobox 的原控件 ref，不能先按预期值寻找另一元素；下拉框必须使用页面实际的 label/name/placeholder。",
    '   expect_observed 的 name 是 read_value 保存的来源变量名；常量比较只传 expected，跨页比较只传 name，两者互斥。',
    '   数据可变性：仅用例明确指定的输入和预期允许固定。搜索验证关键词规则而非固定条数；分页按运行时总数和页容量验证；跨步骤一致性用 read_value + expect_observed。',
    '   对已加载列表使用 expect_collection：定位稳定的结果容器，contains/equals 检查每条结果，min_count/max_count 检查原文要求的数量范围。',

    // ── 恢复与终止 ──
    "   恢复限制：入口或数据缺失只做一次补充检查；同一目标同类操作失败后只允许一次不同方法的恢复。502/服务不可用/回到登录页时报告环境阻塞。UI_RESULT_NOT_READY 时只调一次 wait_ready。网关错误、PRECONDITION_BLOCKED 和 RECOVERY_EXHAUSTED 必须立即结束任务。",

    // ── 4. 保存与试跑 ──
    `4. browser.save_ui_script（case_id=${caseId}），再 browser.run_playwright_script 试跑，失败则修正后重新保存。`,
    "   保存前调用 recording 核对覆盖。COVERAGE_INCOMPLETE 时按缺项补录真实断言。脚本只能由 save_ui_script 生成；缺断言就继续录制再以 append=true 保存。试跑因环境缺失失败时在结论中说明。run_playwright_script 是未入库试跑，没有 run_id。",
    "最后输出：脚本路径、试跑结果、仍需人工处理的步骤。",
  ].join("\n");
}

export function appExplorePrompt(projectId: string, env: string, platform: string, caseId: string, appId: string): string {
  const name = platform === "ios" ? "iOS" : "Android";
  return [
    `任务：App 探索模式。为项目 ${projectId} 的用例 ${caseId} 在 ${name} 设备上走通一遍，生成确定性的 Maestro 脚本。`,
    `执行环境：${env}；平台：${platform}；App：${appId}。`,
    "按 .agents/skills/app-explore.md：",
    `1. case-store.list_cases 读取该用例；app.app_info（project_id=${projectId}, env=${env}, platform=${platform}）确认 App 与可用变量。`,
    `2. 用 pinky 的手机工具打开 ${appId}，按用例步骤逐步操作并记录定位方式（优先 accessibility id，其次可见文字）。`,
    "   Pinky 要求用户确认的步骤被拒绝或超时时不要绕过，在结论中说明。",
    `3. 写成 Maestro 脚本（appId: \${APP_ID}，每个预期结果都要有 assertVisible / assertNotVisible，账号只用变量），`,
    `   app.save_app_flow（case_id=${caseId}）保存，再 app.run_app_flow（platform=${platform}）试跑，失败则修正后重新保存。`,
    "最后输出：脚本路径、试跑结果、仍需人工处理的步骤。",
  ].join("\n");
}

export interface UiFailureBrief {
  case_id: string;
  message: string;
  script?: string;
  evidence_paths: string[];
}

export function healPrompt(projectId: string, env: string, runId: string, failures: UiFailureBrief[]): string {
  const body = failures
    .map((f, i) => [
      `### ${i + 1}. ${f.case_id}`,
      `脚本：${f.script ?? "（未登记）"}`,
      `证据：${f.evidence_paths.join(", ") || "无"}`,
      "```",
      f.message.slice(0, 1500),
      "```",
    ].join("\n"))
    .join("\n\n");
  return [
    `任务：自愈模式。项目 ${projectId} 在环境 ${env} 的 UI 回归 ${runId} 有失败用例，按 .agents/skills/ui-heal.md 处理，只处理失败步骤。`,
    `先 browser.open_project（project_id=${projectId}, env=${env}）在内嵌浏览器里复现到失败步骤。`,
    "页面改版（script_error）：用 report.propose_script_fix 提交完整的新脚本，只改失败相关的行，等待用户审核 diff。",
    "产品缺陷（product_bug）不修改脚本；环境问题（environment）说明原因。",
    "最后输出一个 JSON 数组：[{\"case_id\": \"...\", \"failure_type\": \"product_bug|script_error|environment|data|auth|model|unknown\", \"reason\": \"...\", \"suggestion\": \"...\"}]。证据不足时必须使用 unknown，不要强行归因。",
    "",
    body,
  ].join("\n");
}

/** 首次转换单独成任务；只输出结构化计划，不访问被测页面。 */
export function uiContractPrompt(brief: ExploreCaseBrief, roles: string[], selectedRole?: string): string {
  return [
    '任务：仅把 UI 用例转换成可复用的结构化执行计划。不要执行测试、打开浏览器、读写文件、调用任何工具或查询项目。只返回 JSON，不加解释。严格按 outputSchema 输出：可选字段统一用 {"$optional":[]} 表示无值，或 {"$optional":[实际值]} 表示有值；value 的实际值用 {"string":[],"boolean":[],"number":[]} 三槽表示且只填一个槽，例如 {"string":["abc"],"boolean":[],"number":[]}。paramRefs 的实际值用 [{"parameter":"参数名","valueRef":"username"}] 表示。以下示例描述业务结构，输出时必须按 schema 封装；工具执行前会还原为业务结构。',
    "原始用例：" + JSON.stringify(brief),
    "项目可用数据配方（只用于选择绑定项，不含凭据）：" + JSON.stringify(brief.available_data ?? []),
    "当前环境验证能力：" + JSON.stringify(brief.capabilities ?? { database: false, dataApi: false }) + "。只能规划能由这些能力或浏览器真实证据验证的检查；不要为没有连接的数据库臆造 SQL。",
    "已配置角色：" + JSON.stringify(roles),
    ...(selectedRole ? [`用户选择的登录态角色：${JSON.stringify(selectedRole)}。原文未明确角色的已登录操作绑定此角色；不得覆盖原文明确的其它角色、匿名访问或登录测试。`] : []),

    // ── 格式 ──
    '格式：{"version":1,"status":"ready|needs_clarification","issues":[],"preconditions":["原始前置条件"],"preconditionChecks":[{"id":"P1.1","sourceIndices":[1],"sourceQuotes":["原文片段"],"statement":"可独立验证的事实","expected":"保留原要求","method":"session|ui|api|database|manual|runtime","verificationHint":"判定提示","dependsOn":[]}],"steps":[{"index":1,"source":"原始步骤","actions":[{"action":"navigate|click|fill|check|select|press|observe|capture|clock|database","instruction":"单个动作说明","role":"角色或default","value":"输入值","targetHint":"自然语言定位描述","target":{"page":"页面名","scope":[{"kind":"...","name":"...","key":"..."}],"control":"textbox|checkbox|combobox|button|option","name":"控件名"}}],"expected":["原始预期"]}]}',

    // ── 数据与变量 ──
    '动态 fill 使用 valueRef（username/email/password/other_password），不同时提供 value。四个内置变量在用例开始时生成一次：username=ui_+16位hex，email=该用户名@example.com，两组密码分别为 Aa1/Bb2+16位hex。超出格式能力的要求不得假定满足。',
    '纯输入约束使用 method:"runtime"，runtime:{valueRef,minLength?,maxLength?,maxUtf8Bytes?,differentFrom?}；runtime 不能只写 valueRef，至少声明一项实际约束。唯一用户名/未注册邮箱仍需真实证据。数据库验证需 paramRefs:{参数名:"变量名"}。',
    '配方 facts 是声明的检查能力，不是已通过的证据。paramRefs 只能出现在 method="database" 的前置检查或 action="database" 的动作中，值限于四个内置变量。',
    '可选 dataRefs 为计划需要的配方键数组；已有 data_refs 必须保留。只在原文明确绑定或唯一匹配时选择。配方 key 不是邮箱或密码，不从名称猜测账号身份。',

    // ── 原文保留 ──
    "preconditions、source 和 expected 必须原样保留。preconditionChecks 是对原文的原子检查计划；每个原文前置条件至少被一个检查项引用。index 按原步骤从 1 连续编号，所有 expected 按原顺序覆盖。issues 必须是字符串数组，sourceIndices 从 1 开始。",

    // ── 定位与动作 ──
    "页面标题、DOM 类型、区域名称、弹窗/抽屉形式、菜单层级是 UI 实现细节，不应仅因这些信息未知就标记待澄清。交互动作优先使用 targetHint 描述原文目标及上下文；只有确切已知完整定位结构才提供 target。每次一个动作，下拉展开与选项点击分开。",
    '执行策略（浏览器类型、不建立角色会话等）放进相关检查的 verificationHint；可选诊断方法不单独建硬检查。真实状态（匿名、环境健康、数据存在）仍须有证据。原文只有策略而无状态要求时，needs_clarification 说明缺少可验证状态。',

    // ── needs_clarification 边界 ──
    "needs_clarification 只用于缺失必要业务条件（要求角色未配置、特定对象既无标识也无筛选条件、必要输入值缺失、业务预期矛盾）。对象条件与标识分阶段处理：原文给出页面可核对的筛选条件时用 targetHint 保留条件；实际无匹配或多匹配留到探索阶段。",
    "原始预期明确允许 A 或 B 时保留这个验收规则，计划可 observe 当前状态按实际验证对应分支。角色精确匹配配置；匿名使用 default。前置条件在执行阶段仍须核对。保留范围、集合匹配、前后比较等原始规则语义。",
  ].join("\n");
}
