import { pages } from "./pageRegistry";
import { createContext, useContext } from "react";

/**
 * 项目内导航：按测试工作流分组（准备用例 → 执行 → 分析），资源与设置放最后。
 * key 与 visibleProjectTab 使用的页签 key 一致。
 */
export interface NavEntry {
  key: string;
  label: string;
}

export interface NavSection {
  key: string;
  /** 分组标题；概览不带标题 */
  title?: string;
  items: NavEntry[];
}

export const NAV_SECTIONS: NavSection[] = [
  { key: "overview" }, { key: "prepare", title: "用例" }, { key: "execute", title: "执行" },
  { key: "analyze", title: "结果" }, { key: "config", title: "配置" },
].map(section => ({ ...section, items: pages.list().filter(p => p.section === section.key).map(p => ({ key: p.key, label: p.label })) }));

export const navLabel = (key: string) =>
  NAV_SECTIONS.flatMap((s) => s.items).find((i) => i.key === key)?.label ?? key;

/** 页面之间互相跳转（如概览的待办 → 用例库） */
export const NavContext = createContext<{ go: (key: string) => void }>({ go: () => undefined });
export const useNav = () => useContext(NavContext);

const STORAGE_PREFIX = "aiprobe.nav.";

/** 记住每个项目上次打开的页面；存储不可用时回到概览 */
export function lastNav(projectId: string): string {
  try {
    return localStorage.getItem(STORAGE_PREFIX + projectId) ?? "home";
  } catch {
    return "home";
  }
}

export function rememberNav(projectId: string, key: string) {
  try {
    localStorage.setItem(STORAGE_PREFIX + projectId, key);
  } catch {
    // 忽略：只是便利功能
  }
}
