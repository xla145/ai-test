/**
 * 发给 Codex 的任务提示。用例格式、脚本规范等固化在 workspace 的 AGENTS.md 与技能文件里，
 * 这里只描述本次任务，并且只传必要上下文（上下文裁剪）。
 */
export function caseGenerationPrompt(projectId: string, requirementFile: string): string {
  return [
    `任务：根据需求文档生成结构化测试用例。项目 ID：${projectId}。`,
    `1. 调用 doc-parser.parse_requirement 解析 ${requirementFile}，再用 doc-parser.list_sections 按功能点逐节读取（只读相关章节）。`,
    "2. 按 .agents/skills/test-design.md 设计用例，用 case-store.create_case 写入，并用 case-store.link_requirement 关联需求章节。",
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

export function explorePrompt(projectId: string, env: string, caseId: string): string {
  return [
    `任务：探索模式。为项目 ${projectId} 的 UI 用例 ${caseId} 在内嵌浏览器中生成确定性 Playwright 脚本。执行环境：${env}。`,
    "按 .agents/skills/ui-explore.md：",
    `1. case-store.list_cases 读取该用例；env-support.check_data 检查依赖数据，缺失则 seed_data。`,
    `2. browser.open_project（project_id=${projectId}, env=${env}）；需要登录时 browser.new_role_context 只传角色名。`,
    "3. 逐步操作并把每个预期结果落成 expect_* 断言；埋点用 start_capture + expect_request；视觉类预期用 visual_check。",
    `4. browser.save_ui_script（case_id=${caseId}），再 browser.run_playwright_script 试跑，失败则修正后重新保存。`,
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
