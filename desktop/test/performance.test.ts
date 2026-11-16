import { describe, expect, it } from "vitest";
import { performancePlan } from "../src/main/performance.js";

describe("performance plan", () => {
  const base = "http://localhost:3000";
  it("creates a bounded GET workload and thresholds", () => {
    const plan = performancePlan(base, { path: "/health", vus: 5, seconds: 10, p95Ms: 500, maxFailureRate: .01 });
    expect(plan.target).toBe("http://localhost:3000/health");
    expect(plan.code).toContain("http.get(__ENV.AIPROBE_TARGET");
    expect(plan.code).toContain("p(95)<500");
  });
  it.each(["/health?token=x", "//other", "http://other/health"]) ("rejects unsafe target %s", (path) => {
    expect(() => performancePlan(base, { path, vus: 1, seconds: 1, p95Ms: 100, maxFailureRate: .1 })).toThrow();
  });
  it("bounds load and duration before spawning k6", () => {
    expect(() => performancePlan(base, { path: "/", vus: 101, seconds: 1, p95Ms: 100, maxFailureRate: .1 })).toThrow();
    expect(() => performancePlan(base, { path: "/", vus: 1, seconds: 301, p95Ms: 100, maxFailureRate: .1 })).toThrow();
  });
});
