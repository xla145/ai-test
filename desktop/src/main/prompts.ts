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
