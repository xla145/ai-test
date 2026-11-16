import type { ApiDefinition } from "./apiWorkspace.js";

export interface ApiDirectoryNode {
  key: string;
  label: string;
  rows: ApiDefinition[];
  definition?: ApiDefinition;
  children?: ApiDirectoryNode[];
}

/** Group endpoints by the OpenAPI operation tag (the imported `module`). */
export function groupDefinitions(definitions: ApiDefinition[]): ApiDirectoryNode[] {
  const modules = new Map<string, ApiDefinition[]>();
  for (const definition of definitions) {
    const module = definition.module?.trim() || "未分组";
    modules.set(module, [...(modules.get(module) ?? []), definition]);
  }
  return [...modules].sort(([a], [b]) => a.localeCompare(b, "zh-CN")).map(([label, rows]) => ({
    key: `module:${label}`,
    label,
    rows: [...rows].sort((a, b) => `${a.path}:${a.method}`.localeCompare(`${b.path}:${b.method}`, "zh-CN")),
    children: [...rows].sort((a, b) => `${a.path}:${a.method}`.localeCompare(`${b.path}:${b.method}`, "zh-CN")).map((definition) => ({
      key: `api:${definition.id}`, label: definition.summary || definition.request.operation_id || definition.path, rows: [definition], definition,
    })),
  }));
}

/** A directory selection runs only single-interface cases; flows have a wider scope. */
export function matchesDefinitionScope(
  item: { api?: { definition_id?: string; method: string; path: string } | null; api_flow?: unknown[] },
  definitions: ApiDefinition[],
) {
  if (item.api_flow?.length || !item.api) return false;
  const request = item.api;
  return definitions.some((d) => request.definition_id ? request.definition_id === d.id
    : request.method.toUpperCase() === d.method.toUpperCase() && request.path === d.path);
}

/** Keep every selected interface visible, including those without runnable cases. */
export function regressionDefinitionGroups<T extends Parameters<typeof matchesDefinitionScope>[0]>(
  definitions: ApiDefinition[], cases: T[], isEligible: (item: T) => boolean,
) {
  return definitions.map((definition) => {
    const related = cases.filter((item) => matchesDefinitionScope(item, [definition]));
    return { definition, related, eligible: related.filter(isEligible) };
  });
}
