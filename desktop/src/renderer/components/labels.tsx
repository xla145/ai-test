import { Tag } from "antd";

export const LEVEL = {
  block: { text: "阻断", color: "red" },
  block_script: { text: "阻断脚本生成", color: "volcano" },
  warn: { text: "警告", color: "gold" },
  info: { text: "提示", color: "blue" },
} as Record<string, { text: string; color: string }>;

export const MODE = {
  ui: { text: "UI", color: "geekblue" },
  api: { text: "接口", color: "cyan" },
  capture: { text: "埋点抓包", color: "purple" },
  doc: { text: "文档核对", color: "default" },
  manual: { text: "手工", color: "default" },
  app: { text: "App", color: "magenta" },
} as Record<string, { text: string; color: string }>;

export const STATUS = {
  draft: { text: "草稿", color: "default" },
  reviewed: { text: "已审", color: "green" },
  deprecated: { text: "废弃", color: "default" },
} as Record<string, { text: string; color: string }>;

export const LINT = {
  unchecked: { text: "未检查", color: "default" },
  passed: { text: "通过", color: "green" },
  warned: { text: "有警告", color: "gold" },
  blocked: { text: "阻断", color: "red" },
} as Record<string, { text: string; color: string }>;

export const FAILURE = {
  product_bug: { text: "产品缺陷", color: "red" },
  script_error: { text: "脚本 / 页面改版", color: "orange" },
  environment: { text: "环境问题", color: "default" },
  unknown: { text: "待归因", color: "purple" },
} as Record<string, { text: string; color: string }>;

export const PURPOSE: Record<string, string> = {
  case_gen: "用例生成", api_script: "接口脚本", triage: "失败归因", explore: "UI 探索", heal: "自愈", app_explore: "App 探索",
};

export function LabelTag({ map, value }: { map: Record<string, { text: string; color: string }>; value?: string | null }) {
  if (!value) return null;
  const v = map[value] ?? { text: value, color: "default" };
  return <Tag color={v.color} bordered={false}>{v.text}</Tag>;
}
