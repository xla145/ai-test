import { z } from "zod";
import type { SecretResolver } from "./secrets.js";

/**
 * MCP 工具定义（架构文档第 5 节）。每个工具映射到引擎 CLI 的一个子命令。
 * agent 只通过这些工具访问测试能力，便于审计和替换引擎。
 */
export interface ToolDef {
  name: string;
  description: string;
  input: z.ZodRawShape;
  /** 把工具参数转换成引擎 CLI 参数 */
  toArgs: (input: Record<string, unknown>) => string[];
  /** 需要凭据的工具：返回 [projectId, envName]，由凭据代理换取后注入引擎进程 */
  secretScope?: (input: Record<string, unknown>) => [string, string];
}

export interface ServerDef {
  name: string;
  description: string;
  tools: ToolDef[];
}

const project = z.string().describe("项目 ID");
const caseId = z.string().describe("用例 ID");
const json = (v: unknown) => JSON.stringify(v);
const opt = (flag: string, v: unknown): string[] =>
  v === undefined || v === null || v === "" || v === false ? [] : v === true ? [flag] : [flag, String(v)];

const apiSpec = z.object({
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]),
  path: z.string().regex(/^\//),
  path_params: z.record(z.string(), z.unknown()).optional(),
  query: z.record(z.string(), z.unknown()).optional(),
  headers: z.record(z.string(), z.unknown()).optional(),
  body: z.unknown().optional(),
  auth: z.boolean().optional(),
  expected_status: z.array(z.number().int()).min(1),
  response_schema: z.record(z.string(), z.unknown()).nullable().optional(),
  expected_fields: z.record(z.string(), z.unknown()).optional(),
  extract: z.record(z.string(), z.string()).optional().describe("从响应提取变量，后续用例以 ${var} 引用"),
  operation_id: z.string().optional(),
});

const caseInput = z.object({
  title: z.string().describe("「模块-场景」"),
  type: z.enum(["api", "ui"]),
  priority: z.enum(["P0", "P1", "P2", "P3"]),
  category: z.enum(["功能测试", "安全相关", "兼容性", "其它"]).optional(),
  module_path: z.array(z.string()).optional(),
  execution_mode: z.enum(["ui", "api", "capture", "doc", "manual"]).optional(),
  requirement_ids: z.array(z.string()).optional(),
  preconditions: z.array(z.string()).optional(),
  data_refs: z.array(z.string()).optional(),
  steps: z.array(z.string()).min(1),
  expected: z.array(z.string()).min(1).describe("与 steps 按序号一一对应，必须是可判定结果"),
  api: apiSpec.optional(),
});

export const SERVERS: ServerDef[] = [
  {
    name: "doc-parser",
    description: "需求文档与接口文档解析",
    tools: [
      {
        name: "parse_requirement",
        description: "解析需求文档（Word / PDF / Markdown），转 Markdown 后按章节切块入库",
        input: { project_id: project, file: z.string().describe("文档路径（workspace 内）") },
        toArgs: (i) => ["parse-requirement", "--project", String(i.project_id), "--file", String(i.file)],
      },
      {
        name: "list_sections",
        description: "列出需求章节；传 query 过滤，full=true 返回正文（只取相关章节以节省上下文）",
        input: { project_id: project, query: z.string().optional(), full: z.boolean().optional() },
        toArgs: (i) => ["list-sections", "--project", String(i.project_id), ...opt("--query", i.query), ...opt("--full", i.full)],
      },
      {
        name: "parse_openapi",
        description: "解析 OpenAPI / Swagger：接口、参数类型与约束、状态码",
        input: { file: z.string() },
        toArgs: (i) => ["parse-openapi", "--file", String(i.file)],
      },
    ],
  },
  {
    name: "case-store",
    description: "用例库（本地 SQLite，写入时校验用例 JSON Schema）",
    tools: [
      {
        name: "create_case",
        description: "创建用例。未给 execution_mode 时按规则自动路由",
        input: { project_id: project, case: caseInput },
        toArgs: (i) => ["create-case", "--project", String(i.project_id), "--json", json(i.case)],
      },
      {
        name: "update_case",
        description: "更新用例字段（部分更新）",
        input: { case_id: caseId, patch: caseInput.partial().extend({ status: z.enum(["draft", "reviewed", "deprecated"]).optional() }) },
        toArgs: (i) => ["update-case", "--case", String(i.case_id), "--json", json(i.patch)],
      },
      {
        name: "list_cases",
        description: "按条件列出用例",
        input: {
          project_id: project,
          type: z.enum(["api", "ui"]).optional(),
          priority: z.enum(["P0", "P1", "P2", "P3"]).optional(),
          execution_mode: z.enum(["ui", "api", "capture", "doc", "manual"]).optional(),
          status: z.enum(["draft", "reviewed", "deprecated"]).optional(),
          lint_status: z.enum(["unchecked", "passed", "warned", "blocked"]).optional(),
        },
        toArgs: (i) => [
          "list-cases", "--project", String(i.project_id),
          ...opt("--type", i.type), ...opt("--priority", i.priority), ...opt("--execution-mode", i.execution_mode),
          ...opt("--status", i.status), ...opt("--lint-status", i.lint_status),
        ],
      },
      {
        name: "link_requirement",
        description: "把用例关联到需求点",
        input: { case_id: caseId, requirement_id: z.string() },
        toArgs: (i) => ["link-requirement", "--case", String(i.case_id), "--requirement", String(i.requirement_id)],
      },
      {
        name: "route_cases",
        description: "为项目用例判定执行方式（ui / api / capture / doc / manual）",
        input: { project_id: project, overwrite: z.boolean().optional() },
        toArgs: (i) => ["route", "--project", String(i.project_id), ...opt("--overwrite", i.overwrite)],
      },
    ],
  },
  {
    name: "case-import",
    description: "Excel 用例导入与规范检查",
    tools: [
      {
        name: "import_excel",
        description: "导入 Excel 用例（字段映射可配置），导入即做规范检查",
        input: {
          project_id: project,
          file: z.string(),
          sheet: z.string().optional(),
          column_map: z.record(z.string(), z.string()).optional().describe("Excel 列名 → TestCase 字段"),
        },
        toArgs: (i) => [
          "import-excel", "--project", String(i.project_id), "--file", String(i.file),
          ...opt("--sheet", i.sheet), ...(i.column_map ? ["--column-map", json(i.column_map)] : []),
        ],
      },
      {
        name: "lint_cases",
        description: "运行结构类规范检查（确定性，不耗模型）。语义类规则由 agent 自行复核",
        input: {
          project_id: project,
          case_ids: z.array(z.string()).optional(),
          p0_threshold: z.number().min(0).max(1).optional(),
          with_issues: z.boolean().optional(),
        },
        toArgs: (i) => [
          "lint", "--project", String(i.project_id),
          ...(Array.isArray(i.case_ids) && i.case_ids.length ? ["--case-ids", i.case_ids.join(",")] : []),
          ...opt("--p0-threshold", i.p0_threshold), ...opt("--with-issues", i.with_issues),
        ],
      },
      {
        name: "list_issues",
        description: "列出规范检查问题（可按用例过滤）",
        input: { case_id: caseId.optional() },
        toArgs: (i) => ["list-issues", ...opt("--case", i.case_id)],
      },
      {
        name: "apply_fix",
        description: "把人工确认后的修改建议回写到用例，并重新检查该用例",
        input: { case_id: caseId, field: z.string(), value: z.unknown() },
        toArgs: (i) => ["apply-fix", "--case", String(i.case_id), "--field", String(i.field), "--value", json(i.value)],
      },
      {
        name: "export_excel",
        description: "导出为原格式 Excel",
        input: { project_id: project, out: z.string() },
        toArgs: (i) => ["export-excel", "--project", String(i.project_id), "--out", String(i.out)],
      },
    ],
  },
  {
    name: "api-runner",
    description: "接口用例生成与执行（pytest + httpx）",
    tools: [
      {
        name: "generate_api_cases",
        description: "从 OpenAPI 生成基线接口用例：正向、必填缺失、边界值、类型错误、鉴权、幂等",
        input: { project_id: project, openapi: z.string(), operation_id: z.string().optional() },
        toArgs: (i) => ["generate-api-cases", "--project", String(i.project_id), "--openapi", String(i.openapi), ...opt("--operation", i.operation_id)],
      },
      {
        name: "write_api_suite",
        description: "生成数据驱动的 pytest 脚本（阻断级问题未修复的用例跳过），并在 workspace git 中提交",
        input: { project_id: project, suite: z.string().optional(), reviewed_only: z.boolean().optional() },
        toArgs: (i) => ["write-api-suite", "--project", String(i.project_id), ...opt("--suite", i.suite), ...opt("--reviewed-only", i.reviewed_only)],
      },
      {
        name: "run_api_suite",
        description: "在指定环境执行接口脚本。只传环境名，凭据由客户端在执行时注入",
        input: { project_id: project, env: z.string().describe("环境名，如 test / staging") },
        toArgs: (i) => ["run-api-suite", "--project", String(i.project_id), "--env", String(i.env)],
        secretScope: (i) => [String(i.project_id), String(i.env)],
      },
    ],
  },
  {
    name: "report",
    description: "执行结果与失败汇总",
    tools: [
      {
        name: "summarize_failures",
        description: "列出某次执行的失败用例与初步归因（environment / product_bug / unknown 需 agent 判断）",
        input: { run_id: z.string() },
        toArgs: (i) => ["summarize-failures", "--run", String(i.run_id)],
      },
    ],
  },
];

export function getServer(name: string): ServerDef {
  const s = SERVERS.find((x) => x.name === name);
  if (!s) throw new Error(`未知 MCP Server：${name}（可选：${SERVERS.map((x) => x.name).join(", ")}）`);
  return s;
}

export async function engineEnvFor(tool: ToolDef, input: Record<string, unknown>, secrets: SecretResolver) {
  if (!tool.secretScope) return {};
  const [projectId, env] = tool.secretScope(input);
  return secrets.resolve(projectId, env);
}
