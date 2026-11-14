/** Browser preview only. Electron always uses the real Python engine. */
import type { AitestApi } from "../../../shared/ipc";
import type { ApiCaseDraft, ApiCaseGenerationOptions, ApiCaseGenerationPreview, ApiDebugResult, ApiDefinition, ApiImportPreview, ApiRequest } from "../../../shared/apiWorkspace";

const copy = <T,>(v: T): T => JSON.parse(JSON.stringify(v));
const sample: ApiDefinition[] = [
  ["create", "POST", "/orders", "创建订单", { productId: "SKU-1024", quantity: 1 }],
  ["get", "GET", "/orders/{orderId}", "查询订单", null],
  ["cancel", "POST", "/orders/{orderId}/cancel", "取消订单", null],
  ["products", "GET", "/products", "商品列表", null],
].map(([id, method, path, summary, body], i): ApiDefinition => ({
  id: `api_${id}`, method: String(method), path: String(path), summary: String(summary), source: "order-api.yaml", title: "订单服务", version: "1.2.0", revision: 1, removed: false, module: i < 3 ? "订单" : "商品",
  request: { method: String(method), path: String(path), body, expected_status: [i === 0 ? 201 : 200], query: {}, headers: {}, auth: true, path_params: i === 1 || i === 2 ? { orderId: "ORD-20261113-0081" } : {},
    extract: i === 0 ? { orderId: "data.orderId" } : {}, definition_id: `api_${id}`, definition_revision: 1 },
  operation: { params: i === 1 || i === 2 ? [{ name: "orderId", location: "path", required: true, schema: { type: "string" } }] : [],
    body_schema: body ? { type: "object", required: ["productId", "quantity"], properties: { productId: { type: "string" }, quantity: { type: "integer", minimum: 1 } } } : null,
    responses: { [i === 0 ? "201" : "200"]: { type: "object", properties: { code: { type: "integer" }, data: { type: "object" } } } } },
}));

type Methods = "listApiDefinitions" | "previewApiImport" | "importApiDefinitions" | "saveApiCase" | "generateDefinitionCases" | "previewApiParameterCases" | "saveApiParameterCases" | "debugApiRequest" | "stopApiDebug" | "listApiDebugHistory";
export function workspaceMock(cases: any[]): Pick<AitestApi, Methods> {
  const definitions: Record<string, ApiDefinition[]> = {};
  const history: Record<string, ApiDebugResult[]> = {};
  const defs = (p: string) => definitions[p] ??= copy(sample);
  const parameterPreview = (p: string, draft: ApiCaseDraft, options: ApiCaseGenerationOptions): ApiCaseGenerationPreview => {
    const base = copy(draft.steps[0]);
    const d = defs(p).find((d) => d.id === base.definition_id)!;
    const variants: { scenario: string; request: ApiRequest; polarity: "positive" | "negative" }[] = [{ scenario: "当前参数正向", request: base, polarity: "positive" }];
    if (options.include_negative && base.body && typeof base.body === "object") {
      for (const name of (d.operation.body_schema?.required as string[] ?? [])) {
        const request = copy(base); delete (request.body as Record<string, unknown>)[name]; request.expected_fields = {}; request.assertions = []; request.expected_status = [400, 422];
        variants.push({ scenario: `body.${name} 缺少必填`, request, polarity: "negative" });
      }
    }
    return { engine: "Schemathesis · 界面演示数据", seed: options.seed, notices: ["浏览器预览使用演示数据；桌面端由 Schemathesis 实际生成"], candidates: variants.slice(0, options.max_cases).map((v) => {
      if (options.response_mode === "business") { v.request.expected_status = [200]; v.request.expected_fields = { [options.code_path!]: v.polarity === "positive" ? options.success_code : options.error_code }; }
      const hash = Array.from(JSON.stringify(v.request)).reduce((a, c) => Math.imul(a, 31) + c.charCodeAt(0) | 0, 0);
      const key = `tc_parameter_${base.definition_id}_${hash}`;
      return { ...v, key, title: `${(draft.title || d.summary).startsWith(d.module + "-") ? (draft.title || d.summary) : d.module + "-" + (draft.title || d.summary)}-${v.scenario}`, existing: cases.some((c) => c.id === key) };
    }) };
  };
  return {
    previewApiParameterCases: async (p, draft, options) => copy(parameterPreview(p, draft, options)),
    saveApiParameterCases: async (p, draft, options, keys) => {
      let generated = 0, skipped = 0;
      for (const candidate of parameterPreview(p, draft, options).candidates.filter((c) => keys.includes(c.key))) {
        if (candidate.existing) { skipped++; continue; }
        cases.push({ id: candidate.key, project_id: p, title: candidate.title, type: "api", execution_mode: "api", category: "功能测试", priority: "P1", module_path: ["订单"], status: "draft", lint_status: "passed", preconditions: [], steps: [candidate.scenario], expected: ["符合预期"], api: copy(candidate.request), api_inputs: copy(draft.inputs ?? {}) });
        generated++;
      }
      return { generated, skipped };
    },
    listApiDefinitions:  async (p) => copy(defs(p)),
    previewApiImport: async (_p, source): Promise<ApiImportPreview> => ({ source, title: "订单服务", version: "1.2.0", document: {}, changes: sample.map((d) => ({ method: d.method, path: d.path, summary: d.summary, change: "added" })) }),
    importApiDefinitions: async (p, preview) => { definitions[p] = copy(sample).map((d) => ({ ...d, source: preview.source })); return { definitions: definitions[p] }; },
    saveApiCase: async (p, draft) => {
      const id = draft.id ?? `tc_${Date.now().toString(16)}`;
      const row = { id, project_id: p, title: draft.title, type: "api", execution_mode: "api", category: "功能测试", priority: "P1", module_path: draft.module_path ?? ["订单"], status: "draft", lint_status: "passed", preconditions: ["测试环境可用"], steps: draft.steps.map((s) => s.name || s.path), expected: draft.steps.map(() => "符合预期"),
        api: draft.kind === "single" ? draft.steps[0] : null, api_flow: draft.kind === "flow" ? draft.steps : [], api_cleanup: draft.cleanup ?? [], api_inputs: draft.inputs ?? {}, api_variable_scope: "case" };
      const index = cases.findIndex((c) => c.id === id); if (index >= 0) cases[index] = row; else cases.push(row);
      return copy(row);
    },
    generateDefinitionCases: async (p, ids) => {
      let generated = 0;
      for (const d of defs(p).filter((d) => ids.includes(d.id))) {
        const id = `tc_preview_${d.id}`;
        if (cases.some((c) => c.id === id)) continue;
        cases.push({ id, project_id: p, title: `${d.module}-${d.summary}-正常请求`, type: "api", execution_mode: "api", category: "功能测试", priority: "P1", module_path: [d.module], status: "draft", lint_status: "passed", preconditions: [], steps: [d.summary], expected: ["符合预期"], api: copy(d.request) }); generated++;
      }
      return { generated, skipped: ids.length - generated };
    },
    debugApiRequest: async (p, env, draft: ApiCaseDraft) => {
      const step = (s: ApiRequest, i: number) => ({ index: i + 1, name: s.name || `${s.method} ${s.path}`, role: s.role,
        status: "passed" as const, duration_ms: 48 + i * 12, request: { method: s.method, path: s.path, params: s.query, headers: {}, json: s.body },
        response: { status_code: s.expected_status[0] ?? 200, headers: { "content-type": "application/json" }, body: { code: 0, data: { orderId: "ORD-20261113-0081", status: s.path.includes("cancel") ? "cancelled" : "pending" } }, truncated: false },
        assertions: [{ name: "HTTP 状态码", actual: s.expected_status[0] ?? 200, expected: s.expected_status, passed: true }], variables: s.extract?.orderId ? { orderId: "ORD-20261113-0081" } : {},
      });
      const result: ApiDebugResult = { id: `debug_${Date.now()}`, title: draft.title || "预览请求", env, created_at: new Date().toISOString(), status: "passed", steps: draft.steps.map(step), cleanup: (draft.cleanup ?? []).map(step) };
      history[p] = [result, ...(history[p] ?? [])].slice(0, 50); return result;
    },
    stopApiDebug: async () => undefined,
    listApiDebugHistory: async (p) => copy(history[p] ?? []),
  };
}
