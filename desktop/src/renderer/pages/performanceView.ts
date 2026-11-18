import type { PerformanceOptions, PerformanceResult } from "../../shared/performance";

export const performanceTargetKey = (options: PerformanceOptions) => options.scenarioId
  ? `scenario:${options.scenarioId}` : `${options.method ?? "GET"}:${options.path}`;

/** 同一环境、目标和负载配置才连成一条趋势；不能把不同接口的 P95 串在一起。 */
export const performanceSeriesKey = (r: PerformanceResult) => JSON.stringify([
  r.env, r.options.definitionId ?? "", r.options.definitionRevision ?? 0,
  performanceTargetKey(r.options), r.options.vus, r.options.seconds,
  r.options.rampUp ?? 0, r.options.rampDown ?? 0, r.options.auth !== false, r.options.role ?? "",
  r.options.checkBusinessCode ?? false,
]);

export function performanceSeriesLabel(r: PerformanceResult): string {
  const o = r.options;
  const target = o.scenarioId ? `场景 ${o.scenarioId}` : `${o.method ?? "GET"} ${o.path}`;
  const load = (o.rampUp ?? 0) + (o.rampDown ?? 0) > 0
    ? `${o.rampUp ?? 0} + ${o.seconds} + ${o.rampDown ?? 0}s` : `${o.seconds}s`;
  return `${o.definitionName ? `${o.definitionName} · ` : ""}${target} · ${o.vus} VU · ${load}${o.definitionRevision ? ` · r${o.definitionRevision}` : ""}`;
}

export function performanceTrend(rows: PerformanceResult[], series: string, limit = 20): PerformanceResult[] {
  if (!Number.isInteger(limit) || limit < 1) return [];
  return rows.filter(r => performanceSeriesKey(r) === series
    && ["passed", "failed", "degraded"].includes(r.status)
    && typeof r.p95Ms === "number" && Number.isFinite(r.p95Ms) && r.p95Ms >= 0
    && Number.isFinite(Date.parse(r.startedAt)))
    .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt))
    .slice(-limit);
}
