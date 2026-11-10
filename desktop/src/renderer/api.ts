import type { AitestApi } from "../shared/ipc";

declare global {
  interface Window {
    aitest: AitestApi;
  }
}

export const api = (): AitestApi => window.aitest;

export interface Project {
  id: string;
  name: string;
  workspace_path: string;
  environments: Record<string, { base_url: string; production?: boolean }>;
}

export interface TestCase {
  id: string;
  title: string;
  type: string;
  priority: string;
  category: string;
  module_path: string[];
  execution_mode: string;
  preconditions: string[];
  steps: string[];
  expected: string[];
  lint_status: string;
  status: string;
  data_refs?: string[];
}

export interface LintIssue {
  id: string;
  case_id: string;
  rule: string;
  level: string;
  message: string;
  suggestion: string;
}

export const LEVEL_LABEL: Record<string, string> = {
  block: "阻断",
  block_script: "阻断脚本生成",
  warn: "警告",
  info: "提示",
};

export const MODE_LABEL: Record<string, string> = {
  ui: "UI",
  api: "接口",
  capture: "埋点抓包",
  doc: "文档核对",
  manual: "手工",
};

export const STATUS_LABEL: Record<string, string> = { draft: "草稿", reviewed: "已审", deprecated: "废弃" };
