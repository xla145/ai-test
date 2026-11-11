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
  /** 生效的环境：子项目含继承自大项目的 */
  environments: Record<string, { base_url: string; production?: boolean }>;
  /** 自己定义的环境（子项目覆盖或新增的部分） */
  own_environments?: Record<string, { base_url: string; production?: boolean }>;
  /** 继承来的环境 → 大项目 ID */
  inherited_environments?: Record<string, string>;
  /** "group" 为大项目：不含用例，只存放共享配置 */
  kind?: "project" | "group";
  parent_id?: string;
  parent_name?: string;
  children?: string[];
}

export const isGroup = (p?: Project) => p?.kind === "group";

/** 环境配置实际保存在哪个项目：继承来的在大项目，否则在本项目 */
export const envOwner = (p: Project, env: string) => p.inherited_environments?.[env] ?? p.id;

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
