import type { ApiDefinition, ApiRequest } from "./apiWorkspace.js";
import type { PerformanceMethod, PerformanceOptions } from "./performance.js";

const METHODS = new Set(["GET", "POST", "PUT", "DELETE"]);
export function performanceDefinitionIssue(definition: ApiDefinition): string | undefined {
  if (definition.removed) return "接口来源已移除，请先在接口测试中更新";
  if (!METHODS.has(definition.method)) return `暂不支持 ${definition.method} 方法`;
  if (definition.unsupported_body) return "暂不支持此接口的请求体类型";
  if (definition.request.encrypt) return "当前性能执行器不支持加密正文，请勿按明文执行";
}

export function performanceRequestFromDefinition(definition: ApiDefinition): ApiRequest {
  return structuredClone({ ...definition.request, method: definition.method, path: definition.path,
    definition_id: definition.id, definition_revision: definition.revision });
}

export function resolvePerformancePath(path: string, params: Record<string, unknown> = {}): string {
  if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//") || /[?#\\\r\n]/.test(path)) throw new Error("接口路径必须为环境内的相对路径，不含查询参数");
  if (path.includes("${")) throw new Error("请为接口路径填写实际参数，不支持未解析的变量");
  const resolved = path.replace(/\{([^}]+)\}/g, (_, name: string) => {
    const value = params[name];
    if (value == null || value === "" || !["string", "number", "boolean"].includes(typeof value)) throw new Error(`请填写路径参数 ${name}`);
    if (value === "." || value === "..") throw new Error(`路径参数 ${name} 不能为 . 或 ..`);
    return encodeURIComponent(String(value));
  });
  if (/\$\{|[{}]/.test(resolved)) throw new Error("请为接口路径填写实际参数，不支持未解析的变量");
  return resolved;
}

function assertResolved(value: unknown): void {
  if (typeof value === "string" && /\$\{[^}]+\}/.test(value)) throw new Error("请填写实际测试数据，当前单接口压测不支持未解析的变量");
  if (value && typeof value === "object") Object.values(value).forEach(assertResolved);
}

/** UI 和主进程共用：方法、路径、版本只取当前项目的接口目录，不信任调用方的自定义路由。 */
export function bindPerformanceDefinition(definition: ApiDefinition, options: PerformanceOptions): PerformanceOptions {
  const issue = performanceDefinitionIssue(definition);
  if (issue) throw new Error(issue);
  if (options.definitionId !== definition.id) throw new Error("请选择当前项目接口列表中的接口");
  if (options.definitionRevision !== definition.revision) throw new Error("接口定义已更新，请重新选择接口并确认参数");
  const source = definition.request;
  const pathParams = options.pathParams ?? source.path_params ?? {};
  const query = options.query ?? source.query ?? {};
  const headers = options.headers ?? source.headers ?? {};
  const body = Object.hasOwn(options, "body") ? options.body : source.body;
  resolvePerformancePath(definition.path, pathParams);
  for (const [label, value] of [["路径参数", pathParams], ["Query 参数", query], ["Headers", headers]] as const) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}必须是 JSON 对象`);
    assertResolved(value);
  }
  assertResolved(body);
  const stringHeaders: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || value == null || !["string", "number", "boolean"].includes(typeof value) || /[\r\n]/.test(String(value))) {
      throw new Error("请求头名称或值无效");
    }
    stringHeaders[name] = String(value);
  }
  for (const p of definition.operation.params.filter(p => p.required)) {
    const value = p.location === "path" ? pathParams[p.name] : p.location === "query" ? query[p.name]
      : p.location === "header" ? Object.entries(stringHeaders).find(([key]) => key.toLowerCase() === p.name.toLowerCase())?.[1] : "unused";
    if (value == null || value === "") throw new Error(`请填写必填${p.location}参数 ${p.name}`);
  }
  if (definition.method === "GET" && body != null) throw new Error("当前性能执行器不支持 GET 请求体，请先确认接口定义");
  return {
    ...options, method: definition.method as PerformanceMethod, path: definition.path,
    definitionId: definition.id, definitionRevision: definition.revision, definitionName: definition.summary,
    pathParams, query, headers: stringHeaders, body,
    auth: options.auth ?? source.auth ?? true, role: options.role ?? source.role,
    timeoutSeconds: options.timeoutSeconds ?? source.timeout ?? 10,
    checkBusinessCode: options.checkBusinessCode ?? true,
    // 单接口选择不能夹带来自旧表单的场景步骤。
    scenarioId: undefined, scenarioSteps: undefined,
  };
}
