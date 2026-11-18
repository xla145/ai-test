import { describe, expect, it } from "vitest";
import { compareWithBaseline, performancePlan, scenarioPlan } from "../src/main/performance.js";
import type { PerformanceResult } from "../src/shared/performance.js";

describe("performance plan", () => {
  const base = "http://localhost:3000";
  const defaults = { path: "/health", vus: 5, seconds: 10, p95Ms: 500, maxFailureRate: .01 };

  // ---- existing tests (backward-compatible: method defaults to GET) ----

  it("creates a bounded GET workload and thresholds", () => {
    const plan = performancePlan(base, defaults);
    expect(plan.target).toBe("http://localhost:3000/health");
    expect(plan.code).toContain("http.get(__ENV.AIPROBE_TARGET");
    expect(plan.code).toContain("p(95)<500");
    expect(plan.code).toContain("handleSummary");
  });

  it.each(["/health?token=x", "//other", "http://other/health"])("rejects unsafe target %s", (path) => {
    expect(() => performancePlan(base, { ...defaults, path })).toThrow();
  });

  it("bounds load and duration before spawning k6", () => {
    expect(() => performancePlan(base, { ...defaults, vus: 101 })).toThrow();
    expect(() => performancePlan(base, { ...defaults, seconds: 301 })).toThrow();
  });

  // ---- Phase 1: multi-method ----

  it("generates POST with JSON body", () => {
    const plan = performancePlan(base, { ...defaults, method: "POST", body: { goodsId: 1001 } });
    expect(plan.code).toContain("http.post(__ENV.AIPROBE_TARGET, body,");
    expect(JSON.parse(plan.env.AIPROBE_BODY)).toEqual({ goodsId: 1001 });
    expect(plan.code).not.toContain("goodsId");
    expect(plan.code).toContain("Content-Type");
  });

  it("generates PUT with body", () => {
    const plan = performancePlan(base, { ...defaults, method: "PUT", body: { name: "test" } });
    expect(plan.code).toContain("http.put(__ENV.AIPROBE_TARGET, body,");
  });

  it("generates DELETE without body", () => {
    const plan = performancePlan(base, { ...defaults, method: "DELETE" });
    expect(plan.code).toContain("http.del(__ENV.AIPROBE_TARGET, null,");
    expect(plan.code).not.toContain("Content-Type");
  });

  it("generates DELETE with body", () => {
    const plan = performancePlan(base, { ...defaults, method: "DELETE", body: { id: 42 } });
    expect(plan.code).toContain("http.del(__ENV.AIPROBE_TARGET, body,");
    expect(plan.code).toContain("Content-Type");
  });

  // ---- Phase 1: auth ----

  it("includes auth token injection from env var by default", () => {
    const plan = performancePlan(base, defaults);
    expect(plan.code).toContain("__ENV.AIPROBE_AUTH_TOKEN");
    expect(plan.code).toContain("__ENV.AIPROBE_AUTH_HEADER");
  });

  it("omits auth when auth=false", () => {
    const plan = performancePlan(base, { ...defaults, auth: false });
    expect(plan.code).not.toContain("AIPROBE_AUTH_TOKEN");
    expect(plan.code).not.toContain("AIPROBE_AUTH_HEADER");
  });

  // ---- Phase 1: custom headers ----

  it("injects custom headers at runtime rather than writing them to the script", () => {
    const plan = performancePlan(base, { ...defaults, headers: { "X-Client-Id": "abc" } });
    expect(JSON.parse(plan.env.AIPROBE_HEADERS)).toEqual({ "X-Client-Id": "abc" });
    expect(plan.code).toContain("__ENV.AIPROBE_HEADERS");
    expect(plan.code).not.toContain('"abc"');
  });

  // ---- Phase 1: handleSummary ----

  it("uses handleSummary to export full metrics", () => {
    const plan = performancePlan(base, defaults);
    expect(plan.code).toContain("export function handleSummary(data)");
    expect(plan.code).toContain("__ENV.AIPROBE_SUMMARY");
  });

  // ---- security: tokens never in script ----

  it("never puts actual token values in the generated script", () => {
    const plan = performancePlan(base, { ...defaults, role: "admin" });
    expect(plan.code).not.toContain("Bearer");
    expect(plan.code).toContain("__ENV.AIPROBE_AUTH_TOKEN");
  });
});

// ---- Phase 2: ramping VUs ----

describe("ramping VUs", () => {
  const base = "http://localhost:3000";
  const defaults = { path: "/health", vus: 10, seconds: 30, p95Ms: 500, maxFailureRate: .01 };

  it("generates stages config when rampUp is set", () => {
    const plan = performancePlan(base, { ...defaults, rampUp: 20, rampDown: 10 });
    expect(plan.code).toContain('"stages"');
    expect(plan.code).toContain('"target":10');
    expect(plan.code).toContain('"target":0');
    // Flat mode uses top-level "vus" key; ramping mode does not
    expect(plan.code).not.toContain('"vus":');
  });

  it("uses flat duration when rampUp is 0 or absent", () => {
    const plan = performancePlan(base, { ...defaults, rampUp: 0 });
    expect(plan.code).toContain('"duration":"30s"');
    expect(plan.code).not.toContain('"stages"');
  });

  it("rejects when total time exceeds 300s", () => {
    expect(() => performancePlan(base, { ...defaults, seconds: 250, rampUp: 40, rampDown: 20 })).toThrow("300");
  });

  it("rejects negative rampUp", () => {
    expect(() => performancePlan(base, { ...defaults, rampUp: -5 })).toThrow();
  });
});

// ---- Phase 2: scenario plan ----

describe("scenario plan", () => {
  const base = "http://localhost:3000";
  const defaults = { path: "/", vus: 5, seconds: 10, p95Ms: 500, maxFailureRate: .01 };

  it("generates a multi-step k6 script with groups", () => {
    const plan = scenarioPlan(base, {
      ...defaults,
      scenarioSteps: [
        { name: "创建订单", method: "POST", path: "/orders", body: { goodsId: 1001 }, extract: { orderId: "data.orderId" } },
        { name: "查询订单", method: "GET", path: "/orders/${orderId}" },
      ],
    });
    expect(plan.code).toContain("import { group, sleep }");
    expect(plan.code).toContain("import { Trend, Rate }");
    // JSON.stringify uses double quotes for group names
    expect(plan.code).toContain('group("1-创建订单"');
    expect(plan.code).toContain('group("2-查询订单"');
    expect(plan.code).toContain("http.post(");
    expect(plan.code).toContain("http.get(");
    expect(plan.code).toContain("vars.orderId");
    expect(plan.code).toContain("__ENV.AIPROBE_BASE");
    expect(plan.code).toContain("step_0_dur.add");
    expect(plan.code).toContain("step_1_fail.add");
  });

  it("rejects empty steps", () => {
    expect(() => scenarioPlan(base, { ...defaults, scenarioSteps: [] })).toThrow("至少需要一个步骤");
  });

  it("rejects steps with invalid path", () => {
    expect(() => scenarioPlan(base, {
      ...defaults,
      scenarioSteps: [{ name: "bad", method: "GET", path: "relative" }],
    })).toThrow("以 / 开头");
  });

  it("supports ramping VUs in scenario mode", () => {
    const plan = scenarioPlan(base, {
      ...defaults, rampUp: 10, rampDown: 5,
      scenarioSteps: [{ name: "ping", method: "GET", path: "/ping" }],
    });
    expect(plan.code).toContain('"stages"');
  });

  it("includes auth and custom headers", () => {
    const plan = scenarioPlan(base, {
      ...defaults,
      headers: { "X-Trace": "abc" },
      scenarioSteps: [{ name: "ping", method: "GET", path: "/ping" }],
    });
    expect(plan.code).toContain("__ENV.AIPROBE_AUTH_TOKEN");
    expect(plan.code).toContain('"X-Trace"');
  });

  it("does not discard response bodies (needed for extraction)", () => {
    const plan = scenarioPlan(base, {
      ...defaults,
      scenarioSteps: [{ name: "ping", method: "GET", path: "/ping" }],
    });
    expect(plan.code).toContain('"discardResponseBodies":false');
  });
});

// ---- Phase 3: baseline comparison ----

describe("compareWithBaseline", () => {
  const base: PerformanceResult = {
    id: "baseline-1", env: "test", startedAt: "", finishedAt: "", status: "passed",
    options: { path: "/", vus: 10, seconds: 30, p95Ms: 500, maxFailureRate: 0.01 },
    requests: 300, requestsPerSecond: 10, failureRate: 0.005,
    p50Ms: 100, p90Ms: 200, p95Ms: 250, p99Ms: 400, avgMs: 150, minMs: 10, maxMs: 500,
    dataSentBytes: 1000, dataReceivedBytes: 5000, thresholdsPassed: true, reportPath: "",
  };

  it("detects no degradation when current is similar", () => {
    const current: PerformanceResult = { ...base, id: "run-1", p95Ms: 260, requestsPerSecond: 9.5, failureRate: 0.006 };
    const result = compareWithBaseline(current, base);
    expect(result.degraded).toBe(false);
    expect(result.details).toHaveLength(0);
  });

  it("detects P95 degradation over 20%", () => {
    const current: PerformanceResult = { ...base, id: "run-2", p95Ms: 350 };
    const result = compareWithBaseline(current, base);
    expect(result.degraded).toBe(true);
    expect(result.details.some(d => d.includes("P95"))).toBe(true);
  });

  it("detects RPS drop below 80%", () => {
    const current: PerformanceResult = { ...base, id: "run-3", requestsPerSecond: 7 };
    const result = compareWithBaseline(current, base);
    expect(result.degraded).toBe(true);
    expect(result.details.some(d => d.includes("RPS"))).toBe(true);
  });

  it("detects failure rate increase over 2x", () => {
    const current: PerformanceResult = { ...base, id: "run-4", failureRate: 0.02 };
    const result = compareWithBaseline(current, base);
    expect(result.degraded).toBe(true);
    expect(result.details.some(d => d.includes("失败率"))).toBe(true);
  });

  it("detects failure rate when baseline was zero", () => {
    const zeroBase: PerformanceResult = { ...base, failureRate: 0 };
    const current: PerformanceResult = { ...zeroBase, id: "run-5", failureRate: 0.02 };
    const result = compareWithBaseline(current, zeroBase);
    expect(result.degraded).toBe(true);
  });

  it("reports multiple degradation factors", () => {
    const current: PerformanceResult = { ...base, id: "run-6", p95Ms: 500, requestsPerSecond: 5, failureRate: 0.05 };
    const result = compareWithBaseline(current, base);
    expect(result.degraded).toBe(true);
    expect(result.details.length).toBeGreaterThanOrEqual(3);
  });

  it("includes baseline id in result", () => {
    const current: PerformanceResult = { ...base, id: "run-7" };
    const result = compareWithBaseline(current, base);
    expect(result.baselineId).toBe("baseline-1");
  });
});
