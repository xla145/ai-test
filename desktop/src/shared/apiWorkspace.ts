export interface ApiAssertion {
  path: string;
  operator: "eq" | "ne" | "exists" | "not_empty" | "contains" | "gt" | "gte" | "lt" | "lte";
  value?: unknown;
}

export interface ApiRequest {
  name?: string;
  role?: string;
  method: string;
  path: string;
  path_params?: Record<string, unknown>;
  query?: Record<string, unknown>;
  headers?: Record<string, unknown>;
  body?: unknown;
  auth?: boolean;
  encrypt?: boolean;
  expected_status: number[];
  expected_fields?: Record<string, unknown>;
  response_schema?: Record<string, unknown> | null;
  assertions?: ApiAssertion[];
  extract?: Record<string, string>;
  operation_id?: string;
  definition_id?: string;
  definition_revision?: number;
  timeout?: number;
  db_setup?: Record<string, unknown>[];
  db_checks?: Record<string, unknown>[];
}

export interface ApiDefinition {
  id: string;
  source: string;
  title: string;
  version: string;
  method: string;
  path: string;
  summary: string;
  module: string;
  revision: number;
  removed: boolean;
  unsupported_body?: boolean;
  request: ApiRequest;
  operation: {
    params: { name: string; location: string; required: boolean; schema: Record<string, unknown> }[];
    body_schema?: Record<string, unknown> | null;
    responses: Record<string, unknown>;
  };
}

export interface ApiImportPreview {
  source: string;
  title: string;
  version: string;
  document: Record<string, unknown>;
  changes: { method: string; path: string; summary: string; change: "added" | "updated" | "unchanged" | "removed" }[];
}

export interface ApiCaseDraft {
  id?: string;
  title: string;
  kind: "single" | "flow";
  priority?: string;
  module_path?: string[];
  steps: ApiRequest[];
  cleanup?: ApiRequest[];
  inputs?: Record<string, unknown>;
}

export interface ApiCaseGenerationOptions {
  max_cases: number;
  seed: number;
  include_negative: boolean;
  response_mode: "http" | "business";
  code_path?: string;
  success_code?: unknown;
  error_code?: unknown;
}

export interface ApiCaseGenerationPreview {
  engine: string;
  seed: number;
  notices: string[];
  candidates: { key: string; title: string; scenario: string; polarity: "positive" | "negative"; request: ApiRequest; existing: boolean }[];
}

export interface ApiStepTrace {
  index: number;
  name: string;
  role?: string;
  status: "passed" | "failed" | "error" | "blocked" | "running";
  error?: string;
  duration_ms?: number;
  request?: { method: string; path: string; params?: unknown; headers?: unknown; json?: unknown };
  response?: { status_code: number; headers: Record<string, string>; body: unknown; truncated: boolean; size_bytes?: number };
  assertions?: { name: string; actual: unknown; expected: unknown; passed: boolean }[];
  variables?: Record<string, unknown>;
}

export interface ApiDebugResult {
  id: string;
  env: string;
  created_at: string;
  title: string;
  status: "passed" | "failed" | "error";
  steps: ApiStepTrace[];
  cleanup: ApiStepTrace[];
  snapshot?: { steps: ApiRequest[]; cleanup?: ApiRequest[]; inputs?: Record<string, unknown> };
}
