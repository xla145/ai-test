import type { UiGroupCase } from "./ipc.js";

export interface UiModuleNode {
  key: string;
  name: string;
  modules: UiModuleNode[];
  cases: UiGroupCase[];
  descendants: UiGroupCase[];
}

/** 以完整路径标识模块，避免不同父级下的同名模块混在一起。 */
export function buildUiCaseTree(cases: UiGroupCase[]): UiModuleNode[] {
  const roots: UiModuleNode[] = [];
  const nodes = new Map<string, UiModuleNode>();
  for (const c of cases) {
    const path = (c.module_path ?? []).map((part) => part.trim()).filter(Boolean);
    if (!path.length) path.push("未分模块");
    let siblings = roots;
    let node: UiModuleNode | undefined;
    for (let i = 0; i < path.length; i++) {
      const key = JSON.stringify(path.slice(0, i + 1));
      node = nodes.get(key);
      if (!node) {
        node = { key, name: path[i], modules: [], cases: [], descendants: [] };
        nodes.set(key, node);
        siblings.push(node);
      }
      node.descendants.push(c);
      siblings = node.modules;
    }
    node!.cases.push(c);
  }
  return roots;
}
