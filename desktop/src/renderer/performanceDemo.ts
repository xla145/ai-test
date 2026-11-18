/** 仅由浏览器 mock 加载。合成数据不代表压测结果，不接触数据库或被测系统。 */
import type { AitestApi } from "../shared/ipc";
import type { ApiDefinition } from "../shared/apiWorkspace";
import type { PerformanceOptions, PerformanceResult } from "../shared/performance";
import { bindPerformanceDefinition, performanceDefinitionIssue } from "../shared/performanceSource";
import { performanceTargetKey } from "./pages/performanceView";

type DemoApi = Pick<AitestApi, "performanceHistory" | "perfTrend" | "perfGetBaseline" | "perfSetBaseline">;
const sampleMessage = "演示数据：仅用于评估界面，未执行 k6，也未发送请求。";
const load = { vus: 10, seconds: 30, p95Ms: 500, maxFailureRate: 0.01 };

function sourceOptions(d: ApiDefinition): PerformanceOptions {
  return bindPerformanceDefinition(d, { ...load, path: d.path, definitionId: d.id, definitionRevision: d.revision });
}
function sample(projectId: string, index: number, options: PerformanceOptions, p95: number, failureRate = 0,
  overrides: Partial<PerformanceResult> = {}): PerformanceResult {
  const startedAt = new Date(Date.UTC(2026, 10, 5 + index, 2)).toISOString();
  const count = Math.round(300 / (1 + p95 / 2000));
  const thresholdsPassed = p95 < options.p95Ms && failureRate <= options.maxFailureRate;
  return {
    id: `perf-demo-${projectId}-${index}`, env: "test", startedAt,
    finishedAt: new Date(Date.parse(startedAt) + 30000).toISOString(),
    status: thresholdsPassed ? "passed" : "failed", options: structuredClone(options),
    requests: count, requestsPerSecond: count / 30, failureRate,
    p50Ms: p95 * 0.5, p90Ms: p95 * 0.85, p95Ms: p95, p99Ms: p95 * 1.4,
    avgMs: p95 * 0.55, minMs: p95 * 0.1, maxMs: p95 * 2,
    dataSentBytes: count * 256, dataReceivedBytes: count * 1024,
    thresholdsPassed, reportPath: "", message: sampleMessage, ...overrides,
  };
}

/** 与「接口测试」共用目录，历史快照也保留定义 ID、修订和名称。 */
export function performanceDemoRows(projectId: string, definitions: ApiDefinition[]): PerformanceResult[] {
  const available = definitions.filter(d => !performanceDefinitionIssue(d));
  const first = available.find(d => d.method === "GET" && !d.path.includes("{")) ?? available[0];
  if (!first) return [];
  const options = sourceOptions(first);
  const baseline = sample(projectId, 0, options, 200);
  const trend = [200, 210, 205, 225, 280, 760, 220, 215].map((p95, i) =>
    sample(projectId, i, options, p95, i === 5 ? 0.035 : 0));
  trend[4] = {
    ...trend[4], status: "degraded", thresholdsPassed: true,
    message: `${sampleMessage} 绝对阈值达标，但 P95 相比基线退化 40%。`,
    degradation: {
      baselineId: baseline.id,
      baseline: { p95Ms: 200, rps: baseline.requestsPerSecond!, failureRate: 0 },
      current: { p95Ms: 280, rps: trend[4].requestsPerSecond!, failureRate: 0 },
      degraded: true, details: ["P95 由 200 ms 升至 280 ms，退化 40%（门槛 20%）"],
    },
  };
  trend[5].message = `${sampleMessage} P95 760 ms 超过 500 ms；失败率 3.5% 超过 1%。`;
  const other = available.filter(d => d.id !== first.id);
  const extra: PerformanceResult[] = [
    sample(projectId, 8, { ...sourceOptions(other[0] ?? first), rampUp: 10, rampDown: 10 }, 320, 0, {
      finishedAt: "2026-11-13T02:00:50.000Z", requests: 320, requestsPerSecond: 6.4,
    }),
    sample(projectId, 9, sourceOptions(other[1] ?? first), 240),
    sample(projectId, 10, sourceOptions(other[2] ?? first), 180, 0, {
      status: "stopped", thresholdsPassed: false, requests: 60, requestsPerSecond: 60 / 7,
      finishedAt: "2026-11-15T02:00:07.000Z",
      message: `${sampleMessage} 用户在 7 秒时停止；部分指标不能作为通过证据。`,
    }),
    sample(projectId, 11, options, 0, 0, {
      status: "error", thresholdsPassed: false, requests: null, requestsPerSecond: null, failureRate: null,
      p50Ms: null, p90Ms: null, p95Ms: null, p99Ms: null, avgMs: null, minMs: null, maxMs: null,
      dataSentBytes: null, dataReceivedBytes: null, finishedAt: "2026-11-16T02:00:01.000Z",
      message: `${sampleMessage} 执行器示例：未找到本地 k6，未产生任何请求。`,
    }),
  ];
  return [...trend, ...extra].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

/** 各项目隔离的内存态；刷新页面即重置，不冒充持久化结果。 */
export function createPerformanceDemo(listDefinitions: AitestApi["listApiDefinitions"]): DemoApi {
  const projects = new Map<string, Promise<PerformanceResult[]>>();
  const baselines = new Map<string, string>();
  const rowsFor = (projectId: string) => {
    if (!projects.has(projectId)) projects.set(projectId, listDefinitions(projectId).then(definitions => performanceDemoRows(projectId, definitions)));
    return projects.get(projectId)!;
  };
  return {
    performanceHistory: async (projectId) => structuredClone(await rowsFor(projectId)),
    perfTrend: async (projectId, path) => (await rowsFor(projectId))
      .filter(r => (!path || r.options.path === path) && r.p95Ms != null
        && ["passed", "failed", "degraded"].includes(r.status))
      .slice(0, 20).reverse().map(r => ({
        id: r.id, startedAt: r.startedAt, p95Ms: r.p95Ms,
        requestsPerSecond: r.requestsPerSecond, failureRate: r.failureRate, status: r.status,
      })),
    perfSetBaseline: async (projectId, targetKey, resultId) => {
      const result = (await rowsFor(projectId)).find(r => r.id === resultId);
      if (!result || result.status !== "passed" || !result.thresholdsPassed) throw new Error("只能将已通过的当前项目结果设为基线");
      if (performanceTargetKey(result.options) !== targetKey) throw new Error("基线必须属于同一目标");
      baselines.set(JSON.stringify([projectId, targetKey]), resultId);
    },
    perfGetBaseline: async (projectId, targetKey) => {
      const id = baselines.get(JSON.stringify([projectId, targetKey]));
      return structuredClone((await rowsFor(projectId)).find(r => r.id === id) ?? null);
    },
  };
}
