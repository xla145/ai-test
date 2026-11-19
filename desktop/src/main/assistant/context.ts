import { matchesDefinitionScope } from "../../shared/apiDirectory.js";
import { createHash } from "node:crypto";
import type { AssistantContext, AssistantDraft, AssistantReference } from "../../shared/assistant.js";
import type { ApiDefinition } from "../../shared/apiWorkspace.js";
import type { ProjectInfo } from "../orchestrator/types.js";

type Row = Record<string, any>;
export interface ContextDeps {
  project(id: string): Promise<ProjectInfo>;
  listCases(projectId: string): Promise<Row[]>;
  listDefinitions(projectId: string): Promise<ApiDefinition[]>;
  listRuns(projectId: string): Promise<any[]>;
  runDetail(runId: string): Promise<any>;
}
export interface ResolvedContext {
  project: ProjectInfo;
  cases: Row[];
  definitions: ApiDefinition[];
  runs: Row[];
  context: AssistantContext;
  summary: string;
  notice?: string;
}
const pages = new Set(["home", "cases", "import", "api", "run", "performance", "ui", "app", "reports", "ops", "db", "settings"]);
export const idOfRun = (r: Row): string => String(r.id ?? r.run_id ?? "");
function removeSensitiveValues(text: string): string {
  const key = /\b(?:[a-z0-9_-]*(?:token|password|passwd|secret)|api[_-]?key|authorization|(?:set-)?cookie|headers?|body|credentials)\b["']?\s*[:=]\s*/gi;
  let result = "";
  let copied = 0;
  let match: RegExpExecArray | null;
  while ((match = key.exec(text))) {
    const start = key.lastIndex;
    let end = start;
    const first = text[start];
    if (first === "{" || first === "[") {
      const stack = [first];
      let quote = "";
      for (end = start + 1; end < text.length && stack.length; end++) {
        const ch = text[end];
        if (quote) { if (ch === "\\") end++; else if (ch === quote) quote = ""; }
        else if (ch === '"' || ch === "'") quote = ch;
        else if (ch === "{" || ch === "[") stack.push(ch);
        else if (ch === "}" || ch === "]") stack.pop();
      }
    } else if (first === '"' || first === "'") {
      for (end = start + 1; end < text.length; end++) {
        if (text[end] === "\\") end++;
        else if (text[end] === first) { end++; break; }
      }
    } else {
      while (end < text.length && !/[,;\n}]/.test(text[end])) end++;
    }
    result += text.slice(copied, match.index) + "[REDACTED]";
    copied = end;
    key.lastIndex = Math.max(end, key.lastIndex);
  }
  return result + text.slice(copied);
}
export function redact(value: unknown, limit = 300): string {
  return removeSensitiveValues(String(value ?? ""))
    .replace(/\bBearer\s+[^\s"'<>;,]+/gi, "Bearer [REDACTED]")
    .replace(/https?:\/\/[^\s<>"']+/gi, raw => {
      try { const url = new URL(raw); return `${url.protocol}//${url.host}${url.pathname}`; } catch { return "[URL]"; }
    })
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED]")
    .slice(0, limit);
}
export function fingerprint(value: unknown): string {
  const stable = (v: any): any => Array.isArray(v) ? v.map(stable)
    : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map(k => [k, stable(v[k])])) : v;
  return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}
export function validateContext(input: AssistantContext): AssistantContext {
  if (!input || !pages.has(input.page) || !Array.isArray(input.references) || input.references.length > 50
    || (input.env !== undefined && (typeof input.env !== "string" || input.env.length > 100))) throw new Error("助手上下文不合法或引用超过 50 条");
  const references: AssistantReference[] = [];
  const seen = new Set<string>();
  for (const ref of input.references) {
    if (!ref || !["case", "definition", "run"].includes(ref.kind) || typeof ref.id !== "string" || !ref.id.trim() || ref.id.length > 200) throw new Error("助手引用不合法");
    const key = `${ref.kind}:${ref.id}`;
    if (!seen.has(key)) { references.push({ kind: ref.kind, id: ref.id }); seen.add(key); }
  }
  return { page: input.page, ...(input.env !== undefined ? { env: input.env } : {}), references };
}
function owned(row: Row, projectId: string): boolean {
  return (!row.project_id || row.project_id === projectId) && (!row.projectId || row.projectId === projectId);
}
function runSummary(row: Row) {
  const nested = row.summary ?? row.result ?? row.run ?? row;
  const out: Row = { id: idOfRun(row.run ?? row), env: redact((row.run ?? row).env, 100) };
  for (const k of ["total", "passed", "failed", "error", "skipped"]) if (typeof nested[k] === "number" && Number.isFinite(nested[k])) out[k] = nested[k];
  if (Array.isArray(row.results)) out.results = row.results.slice(0, 30).map((r: Row) => ({ caseId: redact(r.case_id, 200), status: redact(r.status, 30), failureType: redact(r.failure_type, 50), message: redact(r.message, 600) }));
  return out;
}
export async function resolveContext(deps: ContextDeps, projectId: string, input: AssistantContext, report = false): Promise<ResolvedContext> {
  const context = validateContext(input);
  const [project, allCases, allDefinitions, allRuns] = await Promise.all([deps.project(projectId), deps.listCases(projectId), deps.listDefinitions(projectId), deps.listRuns(projectId)]);
  if (!project || project.id !== projectId) throw new Error("项目不存在或不匹配");
  const cases = allCases.filter(r => owned(r, projectId));
  const definitions = allDefinitions.filter(r => owned(r, projectId));
  const runs = allRuns.filter(r => owned(r, projectId));
  let notice: string | undefined;
  if (report && !context.references.some(r => r.kind === "run")) {
    const latest = [...runs].sort((a, b) => String(b.started_at ?? b.created_at ?? "").localeCompare(String(a.started_at ?? a.created_at ?? "")))[0];
    if (!latest) throw new Error("当前项目没有报告，请显式选择执行记录");
    context.references.push({ kind: "run", id: idOfRun(latest) });
    notice = `未选择执行记录，使用当前项目最近报告 ${idOfRun(latest)}。`;
  }
  const summaries: Row[] = [];
  for (const ref of context.references) {
    const row = ref.kind === "case" ? cases.find(c => c.id === ref.id)
      : ref.kind === "definition" ? definitions.find(d => d.id === ref.id)
      : runs.find(r => idOfRun(r) === ref.id);
    if (!row) throw new Error(`引用不属于当前项目或已不存在：${ref.kind}/${ref.id}`);
    // Never trust caller/model labels or unrestricted entity payloads.
    ref.label = redact(ref.kind === "run" ? `执行 ${ref.id} (${row.env ?? ""})` : row.title || row.summary || ref.id, 200);
    if (ref.kind === "case") summaries.push({ kind: ref.kind, id: ref.id, title: redact(row.title), priority: redact(row.priority, 10), status: redact(row.status, 30), executionMode: redact(row.execution_mode, 30), lintStatus: redact(row.lint_status, 30), steps: Array.isArray(row.steps) ? row.steps.slice(0, 12).map((v: unknown) => redact(v, 300)) : [], expected: Array.isArray(row.expected) ? row.expected.slice(0, 12).map((v: unknown) => redact(v, 300)) : [] });
    else if (ref.kind === "definition") summaries.push({ kind: ref.kind, id: ref.id, title: redact(row.title || row.summary), method: redact(row.method, 10), path: redact(String(row.path).split("?")[0], 200), revision: row.revision, removed: !!row.removed, params: Array.isArray(row.operation?.params) ? row.operation.params.slice(0, 30).map((p: Row) => ({ name: redact(p.name, 100), location: redact(p.location, 20), required: !!p.required, type: redact(p.schema?.type, 30) })) : [] });
    else {
      // Lookup is authorized by project-scoped list membership before the unscoped detail call.
      const detail = await deps.runDetail(ref.id);
      if (!detail || !owned(detail, projectId) || (detail.project?.id && detail.project.id !== projectId) || (detail.run && !owned(detail.run, projectId))
        || (idOfRun(detail.run ?? detail) && idOfRun(detail.run ?? detail) !== ref.id)) throw new Error("执行记录不属于当前项目");
      summaries.push({ kind: "run", ...runSummary(row), ...runSummary(detail), id: ref.id });
    }
  }
  if (!context.references.length) {
    summaries.push(...cases.slice(0, 12).map(c => ({ kind: "case", id: redact(c.id, 200), title: redact(c.title), status: redact(c.status, 30), priority: redact(c.priority, 10) })));
    summaries.push(...runs.slice(0, 3).map(runSummary));
  }
  const summary = JSON.stringify({ project: { id: projectId, name: redact(project.name) }, page: context.page, env: redact(context.env, 100), notice, entities: summaries });
  if (summary.length > 24_000) throw new Error("上下文过大，请减少引用");
  return { project, cases, definitions, runs, context, summary, notice };
}
export function regressionScope(resolved: ResolvedContext): { caseIds: string[]; fingerprint: string } {
  const { context, project, cases, definitions } = resolved;
  const env = context.env;
  if (!env || !Object.hasOwn(project.environments, env)) throw new Error("回归必须显式选择已配置的非生产环境");
  const config = project.environments[env];
  if (config.production || /(^|[-_\s])(prod(?:uction)?|live)(?=$|[-_\s])|生产/i.test(env)) throw new Error("AI 助手禁止执行生产环境回归");
  if (typeof config.base_url !== "string" || !config.base_url.trim()) throw new Error("环境缺少 API 地址配置");
  const selected = new Set(context.references.filter(r => r.kind === "case").map(r => r.id));
  const definitionIds = new Set(context.references.filter(r => r.kind === "definition").map(r => r.id));
  const requests = (c: Row): Row[] => [...(c.api ? [c.api] : []), ...(Array.isArray(c.api_flow) ? c.api_flow : []), ...(Array.isArray(c.api_cleanup) ? c.api_cleanup : [])];
  for (const c of cases) if (matchesDefinitionScope(c, definitions.filter(d => definitionIds.has(d.id)))) {
    if (c.status === "reviewed" && c.lint_status !== "blocked" && c.execution_mode === "api" && !c.api_needs_review) selected.add(c.id);
  }
  const caseIds = [...selected].sort();
  if (!caseIds.length || caseIds.length > 50) throw new Error("回归范围必须包含 1 至 50 条用例");
  const chosen = caseIds.map(id => {
    const c = cases.find(c => c.id === id);
    if (!c || c.status !== "reviewed" || c.lint_status === "blocked" || c.execution_mode !== "api" || c.api_needs_review) throw new Error("仅允许已审核、非阻断的当前项目 API 用例");
    const reqs = requests(c);
    if (!reqs.length || (!c.api && !c.api_flow?.length) || reqs.some(r => !r || typeof r.method !== "string" || !["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].includes(r.method.toUpperCase()) || typeof r.path !== "string" || !r.path.trim())) throw new Error("用例缺少可执行 API 配置");
    for (const req of reqs) if (req.definition_id) {
      const definition = definitions.find(d => d.id === req.definition_id);
      if (!definition || definition.removed || (req.definition_revision && req.definition_revision !== definition.revision)) throw new Error("用例关联的接口定义不存在、已移除或版本已变化");
    }
    return c;
  });
  const linked = new Set([...definitionIds, ...chosen.flatMap(c => requests(c).map(r => r.definition_id).filter(Boolean))]);
  return { caseIds, fingerprint: fingerprint({ projectId: project.id, workspace: project.workspace_path, env, config, cases: chosen, definitions: definitions.filter(d => linked.has(d.id)).sort((a, b) => a.id.localeCompare(b.id)) }) };
}
export function validateDrafts(input: unknown): AssistantDraft[] {
  if (!Array.isArray(input) || !input.length || input.length > 6) throw new Error("草稿必须为 1 至 6 条");
  return input.map(item => {
    if (!item || typeof item !== "object" || Object.keys(item).sort().join(",") !== "expected,priority,steps,title"
      || typeof item.title !== "string" || !item.title.trim() || item.title.length > 200 || !["P0", "P1", "P2", "P3"].includes(item.priority)) throw new Error("草稿 JSON 字段不合法");
    for (const key of ["steps", "expected"] as const) if (!Array.isArray(item[key]) || !item[key].length || item[key].length > 12
      || item[key].some((s: unknown) => typeof s !== "string" || !s.trim() || s.length > 1000)) throw new Error("草稿步骤或预期不合法");
    return { title: item.title, priority: item.priority, steps: [...item.steps], expected: [...item.expected] };
  });
}
export function parseDrafts(text: string): AssistantDraft[] {
  if (text.length > 30_000) throw new Error("草稿输出过长");
  let value: any;
  try { value = JSON.parse(text); } catch { throw new Error("模型必须返回严格 JSON 草稿，禁止 Markdown 或执行指令"); }
  if (!value || typeof value !== "object" || Object.keys(value).join(",") !== "drafts") throw new Error("模型必须返回 {drafts: [...]} JSON");
  return validateDrafts(value.drafts);
}
