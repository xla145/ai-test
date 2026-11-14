import { readFileSync, existsSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { Orchestrator, type EngineCall } from "../src/main/orchestrator.js";
import type { ApiCaseDraft } from "../src/shared/apiWorkspace.js";

const request: ApiCaseDraft = { title: "订单-创建", kind: "single", steps: [{ method: "POST", path: "/orders", expected_status: [201] }] };

function setup() {
  const payloads: { action: string; body: unknown; file: string; env: unknown }[] = [];
  const engine = vi.fn(async (args: string[], env?: Record<string, string>) => {
    if (args[0] === "list-projects") return [{ id: "p", environments: { test: { base_url: "https://test" }, prod: { base_url: "https://prod", production: true } } }];
    const file = args[args.indexOf("--file") + 1];
    payloads.push({ action: args[args.indexOf("--action") + 1], body: JSON.parse(readFileSync(file, "utf8")), file, env });
    return { status: "passed", steps: [] };
  });
  const agent = vi.fn();
  const orch = new Orchestrator({ engine: engine as unknown as EngineCall, agent, secretEnv: () => ({ AITEST_AUTH_TOKEN: "runtime-token" }) });
  return { orch, engine, agent, payloads };
}

describe("接口工作台编排", () => {
  it("previews and saves parameter cases without an agent or runtime credentials", async () => {
    const { orch, agent, payloads } = setup();
    const options = { max_cases: 30, seed: 42, include_negative: true, response_mode: "http" as const };
    await orch.previewApiParameterCases("p", request, options);
    await orch.saveApiParameterCases("p", request, options, ["tc_selected"]);
    expect(payloads.map((p) => p.action)).toEqual(["preview-parameter-cases", "save-parameter-cases"]);
    expect(payloads[0].body).toEqual({ draft: request, options });
    expect(payloads[1].body).toEqual({ draft: request, options, keys: ["tc_selected"] });
    expect(payloads.every((p) => p.env === undefined && !existsSync(p.file))).toBe(true);
    expect(agent).not.toHaveBeenCalled();
  });
  it("passes the exact trial through a private temporary file, injecting credentials only at runtime", async () => {
    const { orch, agent, payloads } = setup();
    await orch.debugApiRequest("p", "test", request);
    expect(payloads).toHaveLength(1);
    expect(payloads[0].action).toBe("debug");
    expect(payloads[0].body).toEqual({ env: "test", request });
    expect(JSON.stringify(payloads[0].body)).not.toContain("runtime-token");
    expect(payloads[0].env).toEqual({ AITEST_AUTH_TOKEN: "runtime-token" });
    expect(existsSync(payloads[0].file)).toBe(false);
    expect(agent).not.toHaveBeenCalled();
  });

  it("rejects an unknown environment and unconfirmed production before sending any request", async () => {
    const { orch, payloads } = setup();
    await expect(orch.debugApiRequest("p", "missing", request)).rejects.toThrow("环境");
    await expect(orch.debugApiRequest("p", "prod", request)).rejects.toThrow("生产环境");
    expect(payloads).toHaveLength(0);
    await orch.debugApiRequest("p", "prod", request, { confirmProduction: true });
    expect(payloads[0].body).toEqual({ env: "prod", request, confirmProduction: true });
  });

  it("cleans payload files even when the engine fails", async () => {
    const { orch, engine } = setup();
    let file = "";
    engine.mockImplementationOnce(async (args) => { file = args[args.indexOf("--file") + 1]; throw new Error("parse error"); });
    await expect(orch.previewApiImport("p", "broken.yaml")).rejects.toThrow("parse error");
    expect(existsSync(file)).toBe(false);
  });

  it("cancels only the matching project/environment task and releases its execution lock", async () => {
    const { orch, engine, agent } = setup();
    engine.mockImplementation((async (args: string[], _env: unknown, opts?: { signal?: AbortSignal }) => {
      if (args[0] === "list-projects") return [{ id: "p", environments: { test: { base_url: "https://test" } } }];
      return new Promise((_resolve, reject) => opts!.signal!.addEventListener("abort", () => reject(new Error("cancelled"))));
    }) as any);
    const running = orch.debugApiRequest("p", "test", request);
    await vi.waitFor(() => expect(engine.mock.calls.some(([args]) => args[0] === "api-workspace")).toBe(true));
    await expect(orch.debugApiRequest("p", "test", request)).rejects.toThrow("已有接口调试");
    orch.stopApiDebug("other", "test");
    orch.stopApiDebug("p", "test");
    await expect(running).rejects.toThrow("cancelled");
    engine.mockImplementationOnce(async () => [{ id: "p", environments: { test: { base_url: "https://test" } } }]);
    engine.mockImplementationOnce(async () => ({ status: "passed", steps: [] }));
    await expect(orch.debugApiRequest("p", "test", request)).resolves.toMatchObject({ status: "passed" });
    expect(agent).not.toHaveBeenCalled();
  });
});
