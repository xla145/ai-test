import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { k6Executable, performancePlan } from "../src/main/performance.js";

const options = { path: "/read-only", vus: 1, seconds: 3, p95Ms: 1000, maxFailureRate: 0.01 };
function evaluateResponse(status: number, body: unknown, headers: Record<string, string> = {}, checkBusinessCode = true) {
  const values = new Map<string, (boolean | number)[]>();
  class Metric {
    name: string;
    constructor(name: string) { this.name = name; values.set(name, []); }
    add(value: boolean | number) { values.get(this.name)!.push(value); }
  }
  const plan = performancePlan("http://localhost", { ...options, checkBusinessCode });
  const source = plan.code.replace(/^import[^\n]*\n/gm, "")
    .replace("export const options", "const options")
    .replace("export default function ()", "function executeRequest()")
    .replace("export function handleSummary", "function handleSummary");
  runInNewContext(source + "\nexecuteRequest();", {
    __ENV: plan.env, Rate: Metric, Counter: Metric, sleep: () => {},
    http: { get: () => ({ status, headers, json: () => { if (body instanceof Error) throw body; return body; } }) },
  });
  return values;
}

describe("真实执行前的 k6 发现", () => {
  it("finds Homebrew k6 even if the desktop PATH lacks Homebrew", () => {
    expect(k6Executable({ PATH: "/usr/bin" }, "darwin", p => p === "/opt/homebrew/bin/k6")).toBe("/opt/homebrew/bin/k6");
    expect(k6Executable({}, "darwin", p => p === "/usr/local/bin/k6")).toBe("/usr/local/bin/k6");
  });
  it("respects an explicit executable and otherwise uses PATH", () => {
    expect(k6Executable({ AITEST_K6_BIN: "/tools/k6" }, "darwin", () => true)).toBe("/tools/k6");
    expect(k6Executable({}, "linux", () => false)).toBe("k6");
  });
});

describe("实际生成脚本的业务失败判定", () => {
  it.each([401, 403])("does not count HTTP 200 / business %i as a pass", code => {
    const values = evaluateResponse(200, { code, msg: "not authorized" });
    expect(values.get("aiprobe_request_failed")).toEqual([true]);
    expect(values.get("aiprobe_business_failed")).toEqual([true]);
    expect(values.get("aiprobe_auth_failures")).toEqual([1]);
  });
  it.each([0, 200, "200"])("accepts a success envelope with code %s", code => {
    const values = evaluateResponse(200, { code, message: "ok", data: [] });
    expect(values.get("aiprobe_request_failed")).toEqual([false]);
    expect(values.get("aiprobe_auth_failures")).toEqual([0]);
  });
  it("counts HTTP failure even without a business envelope", () => {
    const values = evaluateResponse(503, new Error("not json"));
    expect(values.get("aiprobe_request_failed")).toEqual([true]);
  });
  it("blocks opaque encrypted response bodies instead of treating HTTP 200 as validation", () => {
    const values = evaluateResponse(200, "encrypted-string", { "Encrypt-Key": "cipher-key", "Content-Type": "application/json" });
    expect(values.get("aiprobe_response_errors")).toEqual([1]);
    expect(values.get("aiprobe_request_failed")).toEqual([true]);
    // 未解密意味着无法验证，不能伪称服务端返回了业务错误。
    expect(values.get("aiprobe_business_failed")).toEqual([false]);
  });
  it("accepts plain JSON even when a proxy retains the encryption header", () => {
    const values = evaluateResponse(200, { code: 200, msg: "ok" }, { "encrypt-key": "retained" });
    expect(values.get("aiprobe_response_errors")).toEqual([0]);
    expect(values.get("aiprobe_request_failed")).toEqual([false]);
  });
  it("rejects malformed JSON responses and supports an explicit HTTP-only mode", () => {
    const invalid = evaluateResponse(200, new Error("not json"), { "Content-Type": "application/json" });
    expect(invalid.get("aiprobe_response_errors")).toEqual([1]);
    const httpOnly = evaluateResponse(200, { code: 401, msg: "no auth" }, {}, false);
    expect(httpOnly.get("aiprobe_request_failed")).toEqual([false]);
    const plan = performancePlan("http://localhost", options);
    expect(plan.code).toContain('"aiprobe_auth_failures":["count==0"]');
    expect(plan.code).toContain('"aiprobe_response_errors":["count==0"]');
    expect(plan.code).toContain('"discardResponseBodies":false');
  });
});
