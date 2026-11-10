import { describe, expect, it, vi } from "vitest";
import { generateSpec } from "../src/ui/codegen.js";
import { checkData, seedData, setServerClock } from "../src/ui/envSupport.js";
import { candidates, toCode } from "../src/ui/locator.js";
import { caseIdFromTitle, classifyUiFailure, parseReport } from "../src/ui/runner.js";

describe("locator priority", () => {
  it("prefers testid, then role, label, text, css; never xpath", () => {
    const c = candidates({ tag: "button", role: "button", name: "停用", text: "停用", testId: "disable", css: "td > button" });
    expect(c.map((x) => x.kind)).toEqual(["testid", "role", "text", "css"]);
    expect(candidates({ tag: "div", css: "/html/body/div" })).toEqual([]);
    expect(toCode({ kind: "role", role: "button", name: '说"明"' })).toBe('page.getByRole("button", { name: "说\\"明\\"", exact: true })');
  });
});

describe("codegen", () => {
  it("generates a single-role spec with storageState, capture, clock and visual check", () => {
    const spec = generateSpec({
      caseId: "tc_1", title: "标签管理-停用标签", baseUrl: "http://sut:8080", caseSteps: ["停用 TAG-1001"], expected: ["显示已停用"],
      steps: [
        { role: "admin", action: "installClock", time: "2026-01-01T00:00:00Z" },
        { role: "admin", action: "goto", url: "http://sut:8080/tags?x=1" },
        { role: "admin", action: "startCapture", name: "clicks", urlPattern: "/track" },
        { role: "admin", action: "click", target: { kind: "testid", value: "disable-TAG-1001" } },
        { role: "admin", action: "expectText", target: { kind: "testid", value: "status-TAG-1001" }, text: "已停用" },
        { role: "admin", action: "expectRequest", name: "clicks", fields: { event: "click" }, forbidden: ["phone"] },
        { role: "admin", action: "visualCheck", description: "缺失值显示灰色" },
        { role: "admin", action: "fill", target: { kind: "label", value: "密码" }, value: "", secretEnv: "AITEST_SECRET_PW" },
      ],
    });
    expect(spec).toContain("// 用例 ID：tc_1");
    expect(spec).toContain('test.use({ storageState: storageStateFor("admin") });');
    expect(spec).toContain('await page.goto("/tags?x=1");');
    expect(spec).toContain('const clicks = captureRequests(page, "/track");');
    expect(spec).toContain('await expectCaptured(clicks, {"event":"click"}, ["phone"]);');
    expect(spec).toContain('await page.clock.install({ time: new Date("2026-01-01T00:00:00Z") });');
    expect(spec).toContain('import { captureRequests, expectCaptured, storageStateFor, visualCheck } from "./aitest-fixtures";');
    expect(spec).toContain('process.env["AITEST_SECRET_PW"]');
    expect(spec).not.toMatch(/xpath/i);
  });

  it("uses one context per role for permission matrices", () => {
    const spec = generateSpec({
      caseId: "tc_2", title: "权限-菜单矩阵",
      steps: [
        { role: "admin", action: "goto", url: "/dashboard" },
        { role: "admin", action: "expectVisible", target: { kind: "testid", value: "menu-tags" } },
        { role: "viewer", action: "goto", url: "/dashboard" },
        { role: "viewer", action: "expectHidden", target: { kind: "testid", value: "menu-tags" } },
      ],
    });
    expect(spec).toContain('const rolePage1 = await openAs(browser, "admin");');
    expect(spec).toContain('const rolePage2 = await openAs(browser, "viewer");');
    expect(spec).toContain("async ({ page, browser }, testInfo)");
    expect(spec).toContain('await expect(rolePage2.getByTestId("menu-tags")).toBeHidden();');
  });
});

describe("runner report parsing", () => {
  it("maps playwright json to engine results with evidence and reviews", () => {
    const report = { suites: [{ suites: [{ specs: [
      { title: "tc_a 标题", file: "tc_a.spec.ts", tests: [{ annotations: [{ type: "ai-visual-check", description: "灰色" }],
        results: [{ status: "passed", duration: 1500, attachments: [{ name: "ai-visual-check", path: "/ws/reports/x/a.png", contentType: "image/png" }] }] }] },
      { title: "tc_b 标题", file: "tc_b.spec.ts", tests: [{ results: [{ status: "timedOut", duration: 30000,
        error: { message: "\u001b[31mlocator.click: Timeout\u001b[39m" },
        attachments: [{ name: "trace", path: "/ws/reports/x/trace.zip", contentType: "application/zip" }] }] }] },
    ] }] }] };
    const [a, b] = parseReport(JSON.stringify(report), "/ws");
    expect(a).toMatchObject({ case_id: "tc_a", status: "passed", duration: 1.5, reviews: [{ kind: "visual", description: "灰色", evidence_paths: ["reports/x/a.png"] }] });
    expect(b).toMatchObject({ case_id: "tc_b", status: "error", message: "locator.click: Timeout", evidence_paths: ["reports/x/trace.zip"] });
    expect(b.failure_type).toBeUndefined();
    expect(classifyUiFailure("page.goto: net::ERR_CONNECTION_REFUSED")).toBe("environment");
    expect(caseIdFromTitle("随便", "dir/tc_zz.spec.ts")).toBe("tc_zz");
  });
});

describe("env-support", () => {
  const env = { base_url: "http://sut", data_api: { check: "GET /__test/data/{key}", seed: "POST /__test/data" }, clock_api: { set: "POST /__test/clock" } };

  it("checks and seeds data through scripts or the environment API", async () => {
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      if (init.method === "GET") return new Response(null, { status: url.endsWith("DEM-1002") ? 200 : 404 });
      return new Response(null, { status: 201 });
    }) as unknown as typeof globalThis.fetch;
    const shell = vi.fn(async () => ({ code: 1, output: "missing" }));
    const status = await checkData(env, ["DEM-1002", "U1003", "S1"], [{ key: "S1", check_script: "./check S1" }], "/ws", { fetch, shell, authToken: "Bearer t" });
    expect(status.map((s) => [s.key, s.exists, s.via])).toEqual([["DEM-1002", true, "api"], ["U1003", false, "api"], ["S1", false, "script"]]);
    expect(shell).toHaveBeenCalledWith("./check S1", "/ws");
    expect((fetch as any).mock.calls[0][1].headers.Authorization).toBe("Bearer t");
    const seeded = await seedData(env, ["U1003"], [], "/ws", { fetch });
    expect(seeded).toEqual([{ key: "U1003", seeded: true, via: "api", detail: undefined }]);
    expect(JSON.parse((fetch as any).mock.calls.at(-1)[1].body)).toEqual({ key: "U1003" });
    expect(await seedData({ base_url: "x" }, ["K"], [], "/ws")).toMatchObject([{ seeded: false, via: "none" }]);
  });

  it("sets the server clock or explains the downgrade", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof globalThis.fetch;
    expect(await setServerClock(env, { offset_seconds: 86340 }, { fetch })).toEqual({ ok: true, detail: undefined });
    await expect(setServerClock({ base_url: "x" }, { offset_seconds: 1 })).rejects.toThrow("降级为手工");
  });
});
