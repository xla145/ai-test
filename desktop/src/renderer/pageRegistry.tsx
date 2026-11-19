import React, { lazy, Suspense, type ComponentType, type ReactNode } from "react";
import { ApiOutlined, AppstoreOutlined, DashboardOutlined, BarChartOutlined, ChromeOutlined, DatabaseOutlined, FileExcelOutlined, FileSearchOutlined, MobileOutlined, PlayCircleOutlined, ToolOutlined, ThunderboltOutlined } from "@ant-design/icons";
import type { ProjectType } from "../shared/ipc";
import type { Project } from "./api";
import type { ProjectTodos } from "./pages/HomePage";
export interface PageContext { project: Project; todos?: ProjectTodos; reload: () => Promise<void> }
export interface PageDefinition {
  key: string; label: string; icon: ReactNode; section: "overview" | "prepare" | "execute" | "analyze" | "config";
  order: number; projectTypes?: ProjectType[]; keepAlive?: boolean; action?: "settings";
  component?: ComponentType<PageContext>;
}
export class PageRegistry {
  private pages = new Map<string, PageDefinition>();
  register(page: PageDefinition) {
    if (this.pages.has(page.key)) throw new Error(`重复页面：${page.key}`);
    if (!page.component && !page.action) throw new Error(`页面缺少渲染器：${page.key}`);
    this.pages.set(page.key, page);
  }
  get(key: string) { return this.pages.get(key); }
  list(type?: ProjectType) { return [...this.pages.values()].filter(p => !type || !p.projectTypes || p.projectTypes.includes(type)).sort((a,b) => a.order-b.order); }
}
const page = (load: () => Promise<ComponentType<PageContext>>) => lazy(async () => ({ default: await load() }));
export const pages = new PageRegistry();
const BUILTIN_PAGES: PageDefinition[] = [
  { key: "home", label: "概览", icon: <DashboardOutlined />, section: "overview", order: 0,
    component: page(async () => { const { HomePage } = await import("./pages/HomePage"); return ({ project, todos }) => <HomePage project={project} todos={todos} />; }) },
  { key: "cases", label: "用例库", icon: <AppstoreOutlined />, section: "prepare", order: 10, component: page(async () => (await import("./pages/CasesPage")).CasesPage) },
  { key: "import", label: "导入与规范检查", icon: <FileExcelOutlined />, section: "prepare", order: 11, component: page(async () => (await import("./pages/ImportPage")).ImportPage) },
  { key: "api", label: "接口测试", icon: <ApiOutlined />, section: "prepare", order: 12, component: page(async () => (await import("./pages/ApiPage")).ApiPage) },
  { key: "run", label: "接口回归", icon: <PlayCircleOutlined />, section: "execute", order: 20, component: page(async () => (await import("./pages/RunPage")).RunPage) },
  { key: "performance", label: "性能测试", icon: <ThunderboltOutlined />, section: "execute", order: 21, component: page(async () => (await import("./pages/PerformancePage")).PerformancePage) },
  { key: "ui", label: "Web UI 测试", icon: <ChromeOutlined />, section: "execute", order: 22, projectTypes: ["web", "multi"], keepAlive: true, component: page(async () => (await import("./pages/UiPage")).UiPage) },
  { key: "app", label: "App 测试", icon: <MobileOutlined />, section: "execute", order: 23, projectTypes: ["app", "multi"], component: page(async () => (await import("./pages/AppPage")).AppPage) },
  { key: "reports", label: "测试报告", icon: <FileSearchOutlined />, section: "analyze", order: 30, component: page(async () => (await import("./pages/ReportsPage")).ReportsPage) },
  { key: "ops", label: "工程化", icon: <BarChartOutlined />, section: "analyze", order: 31, component: page(async () => (await import("./pages/OpsPage")).OpsPage) },
  { key: "db", label: "数据库", icon: <DatabaseOutlined />, section: "config", order: 40,
    component: page(async () => { const { DatabasePage } = await import("./pages/DatabasePage"); return ({ project, reload }) => <DatabasePage project={project} onChanged={reload} />; }) },
  { key: "settings", label: "项目设置", icon: <ToolOutlined />, section: "config", order: 41, action: "settings" },
];
BUILTIN_PAGES.forEach(definition => pages.register(definition));
export function RegisteredPage({ pageKey, ...context }: PageContext & { pageKey: string }) {
  const definition = pages.list(context.project.project_type ?? "multi").find(p => p.key === pageKey) ?? pages.get("home")!;
  const Component = definition.component;
  return Component ? <Suspense fallback={<div role="status">正在加载页面…</div>}><Component {...context} /></Suspense> : null;
}
