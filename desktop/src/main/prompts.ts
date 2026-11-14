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
    "最后输出一个 JSON 数组：[{\"case_id\": \"...\", \"failure_type\": \"product_bug|script_error|environment\", \"reason\": \"...\", \"suggestion\": \"...\"}]",
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
}

export function explorePrompt(projectId: string, env: string, caseId: string, roles: string[] = [], brief?: ExploreCaseBrief, locateStrategy: "dom-first" | "midscene-first" = "dom-first"): string {
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
    ? "用例尚未绑定 data_refs，不代表没有数据依赖。先核对前置条件中的角色、业务对象、初始状态及数据准备；依赖未绑定或不存在时报告阻塞，不能自行换数据。明确无数据依赖后才能跳过数据检查。"
    : "env-support.check_data 检查依赖数据；缺失时只按已声明的准备配方 seed_data，无法准备则阻塞。";
  return [
    `任务：探索模式。为项目 ${projectId} 的 UI 用例 ${caseId} 在内嵌浏览器中生成确定性 Playwright 脚本。执行环境：${env}。`,
    ...caseBlock,
    `1. ${dataLine}`,
    `2. browser.open_project（project_id=${projectId}, env=${env}）；需要登录时 browser.new_role_context 只传角色名。`,
    `   已配置的角色：${roles.length ? roles.join("、") : "（无）"}。角色必须精确匹配；缺少用例要求的角色就报告阻塞，不按名称相近替代；不需要登录的页面不用建角色会话。`,
    "   new_role_context 返回 loggedIn=false 且带 hint 时，说明登录未配置：立即停止，结论中写明 hint，不要在代码库或文件里查找账号。",
    "3. 每开始一个用例步骤先调用 browser.case_step（index 从 1 开始），再逐步操作并把该步的预期结果落成 expect_* 断言；埋点用 start_capture + expect_request；视觉类预期用 visual_check。",
    "   执行前检查每个步骤是否能触发对应预期。按页面、区域、业务对象、控件、单个动作、输入/目标状态、结果证据整理；步骤与预期错位或运行时结果缺少触发和观察方式时停止，列出待澄清项，不自行重排或减少覆盖。下拉选择拆成打开下拉框、选择关联选项两次操作；开关使用 check 设置明确状态。",
    "   少走往返：navigate / click / select / press 的返回值已带操作后的页面快照，不要每次操作后再调 snapshot；连续按键用 press 一次传数组；互不依赖的断言在同一轮里一起发出。",
    locateStrategy === "midscene-first"
      ? "   定位策略：优先 Midscene。需要定位新的操作目标时先调用 browser.ai_locate，描述目标及所在区域，再用返回的 ref 调用 click / type / press 等可录制操作；已有定位结果可复用。不要先尝试 DOM 定位。视觉工具未提供或定位失败时才回退 snapshot / browser.find_text。"
      : "   定位策略：优先 DOM。可交互元素用快照里的 ref；表格单元格、状态徽标、统计文字等非交互文字用 browser.find_text 取 ref。snapshot 与 find_text 都找不到时再用 browser.ai_locate。",
    "   断言落在显示结果的那个元素上：某行的状态、数量文字用 find_text 取该单元格（按 context 挑对的行）再 expect_text，不要对整个列表区断言「包含」；不要对按某段文字找到的元素再断言包含同一段文字（等于断言可见），同一断言不要重复做。",
    "   ai_locate（若提供）返回可录制的 ref；目标上有文字时传 text 让它校验结果；text 只填目标自身文字或 placeholder，不填旁边参照物文字；输入框传 intent=fill，开关传 intent=check，点击传 intent=click；报「视觉定位不准」时按提示改用 find_text，不要换说法反复重试；不要用 ai_act。",
    '   ai_locate 优先传 target，例如 {"page":"模型管理","scope":[{"kind":"region","name":"平台模型"},{"kind":"row","name":"模型记录","key":"实际模型编号"}],"control":"button","text":"编辑"}。按当前页面实际名称填写，不照抄示例数据。scope 从外到内，支持 region/dialog/row/form_item/listbox；关联标签放 label，placeholder 单列。工具会编译描述并校验范围与身份；不要在范围校验失败后删除 target 改成全局定位来绕过检查。',
    "   expect_value 必须绑定原输入框/下拉框的 ref，不能先按预期值寻找另一元素；目标变化后重新限定同一业务对象。多处同名控件须带区域和表单项，预期值只用于比较。",
    "   入口或指定数据缺失时只做一次有依据的补充检查，仍缺失则停止并报告阻塞，不遍历系统管理菜单、不替换测试数据或削弱断言。同一目标同类操作失败后只允许一次不同方法的恢复，仍失败就停止该步骤。",
    "   页面显示系统接口502异常、服务不可用或回到登录页时，先报告环境或会话阻塞，不重复定位缺失控件。",
    "   不要用 shell 翻看工作区里的其它脚本或配置，所需信息都在本提示与工具返回值里。",
    `4. browser.save_ui_script（case_id=${caseId}），再 browser.run_playwright_script 试跑，失败则修正后重新保存。`,
    "   脚本只能由 save_ui_script 生成，不要手工编辑 scripts/ui 下的 spec 或 steps 文件；缺断言就继续录制（输入框、下拉框取值用 expect_value，不应出现的内容用 expect_no_text），再以 append=true 保存。",
    "   试跑因环境缺失失败（如浏览器未安装）时不要安装任何软件，在结论中说明，用户会在内嵌浏览器中试跑校验。",
    "   run_playwright_script 是未入库试跑，没有 run_id；不要从报告目录猜测 run_id 或调用 record_attribution，归因写入最终结论。",
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
    "最后输出一个 JSON 数组：[{\"case_id\": \"...\", \"failure_type\": \"product_bug|script_error|environment\", \"reason\": \"...\", \"suggestion\": \"...\"}]",
    "",
    body,
  ].join("\n");
}
