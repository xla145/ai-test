import type { ApiImportPreview } from "./apiWorkspace.js";

type ImportChange = ApiImportPreview["changes"][number];
type ModuleRow = Pick<ImportChange, "module" | "path" | "method">;
type ImportModuleCluster<T> = { label: string; modules: string[]; rows: T[] };

const businessPrefix = (name: string) => {
  // Explicit hierarchy separators; retain hyphens within names such as user-service.
  const parts = name.split(/\s+[-–—]\s+|[：:｜|]|\s*[-–—]\s*(?=[\u4e00-\u9fff])/u);
  const prefix = parts[0].trim();
  return parts.length > 1 && prefix.length >= 2 && !["管理", "接口", "服务", "未分组"].includes(prefix) ? prefix : undefined;
};

/** 用短词片和编辑距离识别近似模块名，避免依赖模型或后端状态。 */
const moduleSimilarity = (left: string, right: string) => {
  const normalize = (value: string) => value.trim().toLocaleLowerCase().replace(/[\s_./-]+/g, "");
  const lp = businessPrefix(left), rp = businessPrefix(right);
  if (lp && rp) return normalize(lp) === normalize(rp) ? 1 : 0;
  if (lp || rp) {
    if (normalize(lp ?? left) === normalize(rp ?? right)) return 1;
    return 0;
  }
  const a = normalize(left), b = normalize(right);
  if (!a || !b) return a === b ? 1 : 0;
  if (a === b) return 1;
  if (left === "未分组" || right === "未分组") return 0;
  // Strip only common suffixes; generic words alone must not join unrelated domains.
  const stem = (value: string) => value.replace(/(管理|模块|服务|接口|controller|service|api)$/, "");
  const as = stem(a), bs = stem(b);
  if (as.length >= 2 && as === bs) return 1;
  const shorter = a.length < b.length ? a : b;
  const longer = a.length < b.length ? b : a;
  if (shorter.length >= 2 && !["管理", "服务", "接口", "模块", "api"].includes(shorter)
      && longer.startsWith(shorter) && shorter.length / longer.length >= 0.5) return 0.8;
  const grams = (value: string) => new Set([...value].map((_, i) => value.slice(i, i + 2)).filter((v) => v.length === 2));
  const ag = grams(a), bg = grams(b);
  const union = new Set([...ag, ...bg]).size;
  const jaccard = union ? [...ag].filter((v) => bg.has(v)).length / union : 0;
  const distance = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let previous = distance[0]; distance[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const current = distance[j];
      distance[j] = a[i - 1] === b[j - 1] ? previous : Math.min(previous, distance[j], distance[j - 1]) + 1;
      previous = current;
    }
  }
  const edit = 1 - distance[b.length] / Math.max(a.length, b.length);
  return Math.max(jaccard, edit * 0.85);
};

export const clusterImportChanges = <T extends ModuleRow>(changes: T[]): ImportModuleCluster<T>[] => {
  const byModule = new Map<string, T[]>();
  changes.forEach((change) => {
    const module = change.module?.trim() || "未分组";
    if (!byModule.has(module)) byModule.set(module, []);
    byModule.get(module)!.push(change);
  });
  const modules = [...byModule.keys()].sort((a, b) => a.localeCompare(b, "zh-CN"));
  const clusters: ImportModuleCluster<T>[] = [];
  for (const module of modules) {
    const target = clusters.find((cluster) => cluster.modules.every((existing) => moduleSimilarity(existing, module) >= 0.65));
    if (target) { target.modules.push(module); target.rows.push(...(byModule.get(module) ?? [])); }
    else clusters.push({ label: module, modules: [module], rows: [...(byModule.get(module) ?? [])] });
  }
  return clusters.map((cluster) => ({
    ...cluster,
    modules: cluster.modules.sort((a, b) => a.localeCompare(b, "zh-CN")),
    label: cluster.modules.length > 1
      ? businessPrefix(cluster.modules[0]) ?? [...cluster.modules].sort((a, b) => a.length - b.length || a.localeCompare(b, "zh-CN"))[0]
      : cluster.modules[0],
    rows: cluster.rows.sort((a, b) => `${a.path}${a.method}`.localeCompare(`${b.path}${b.method}`, "zh-CN")),
  })).sort((a, b) => a.label.localeCompare(b.label, "zh-CN"));
};

