import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeTarget, generateSpec, sha256, stepIdFromTitle, withStepIds, writeUiScript } from "../src/ui/codegen.js";
import { checkData, seedData, setServerClock } from "../src/ui/envSupport.js";
import { candidates, isPositional, specTexts, toCode } from "../src/ui/locator.js";
import { chooseBrowser } from "../src/ui/chromium.js";
import { resolveRole, UI_SERVERS } from "../src/ui/tools.js";
import { caseIdFromTitle, classifyUiFailure, parseReport, reportErrors } from "../src/ui/runner.js";

describe("locator priority", () => {
  it("prefers testid, then role, label, text, css; never xpath", () => {
    const c = candidates({ tag: "button", role: "button", name: "停用", text: "停用", testId: "disable", css: "td > button" });
    expect(c.map((x) => x.kind)).toEqual(["testid", "role", "text", "css"]);
    expect(candidates({ tag: "div", css: "/html/body/div" })).toEqual([]);
    expect(toCode({ kind: "role", role: "button", name: '说"明"' })).toBe('page.getByRole("button", { name: "说\\"明\\"", exact: true })');
  });

  it("puts row-scoped and text-filtered locators before positional CSS", () => {
    const c = candidates({ tag: "button", role: "button", name: "停用", css: "tbody > tr:nth-of-type(2) > td > button",
      cssLoose: "button.el-button", labelText: "停用", row: { css: "tr", key: "TAG-2002", inner: "button" } });
    expect(c.map((x) => toCode(x))).toEqual([
      'page.getByRole("button", { name: "停用", exact: true })',
      'page.locator("tr", { hasText: "TAG-2002" }).getByRole("button", { name: "停用", exact: true })',
      'page.locator("tr", { hasText: "TAG-2002" }).locator("button")',
      'page.locator("button.el-button", { hasText: "停用" })',
      'page.locator("tbody > tr:nth-of-type(2) > td > button")',
    ]);
    expect(c.map(isPositional)).toEqual([false, false, false, false, true]);
    // 断言文字出现在这些定位器的识别文字里时，断言等于定位器本身
    expect(specTexts(c[1])).toEqual(["停用", "TAG-2002"]);
    expect(specTexts(c[3])).toEqual(["停用"]);
    expect(describeTarget(c[1])).toBe("「TAG-2002」所在行的 button「停用」");
    expect(describeTarget(c[3])).toBe("button.el-button「停用」");
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
    expect(spec).toContain('const clicks = await test.step("[S3] 开始捕获请求 /track", async () => captureRequests(page, "/track"));');
    expect(spec).toContain('await test.step("[S4] 点击 testid「disable-TAG-1001」", async () => { await page.getByTestId("disable-TAG-1001").click(); });');
    expect(spec).toContain('在 标签「密码」 输入 （敏感值）');
    expect(spec).toContain('await expectCaptured(clicks, {"event":"click"}, ["phone"]);');
    expect(spec).toContain('await page.clock.install({ time: new Date("2026-01-01T00:00:00Z") });');
    expect(spec).toContain('import { captureRequests, expectCaptured, storageStateFor, visualCheck } from "./aitest-fixtures";');
    expect(spec).toContain('process.env["AITEST_SECRET_PW"]');
    expect(spec).toContain('await expect(page.getByTestId("status-TAG-1001")).toContainText("已停用", { useInnerText: true });');
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

describe("structured steps", () => {
  it("generates value and negative-text assertions", () => {
    const spec = generateSpec({ caseId: "tc_v", title: "取值", steps: [
      { action: "expectValue", target: { kind: "testid", value: "filter-keyword" }, value: "" },
      { action: "expectNoText", target: { kind: "testid", value: "rows" }, text: "Android" },
    ] });
    expect(spec).toContain('await test.step("[S1] 断言 testid「filter-keyword」 为空", async () => { await expect(page.getByTestId("filter-keyword")).toHaveValue(""); });');
    expect(spec).toContain('await expect(page.getByTestId("rows")).not.toContainText("Android", { useInnerText: true });');
  });

  it("keeps existing ids, fills gaps without collisions and parses ids back from step titles", () => {
    const ids = withStepIds([{ action: "press", key: "Enter" }, { id: "S1", action: "press", key: "Tab" }, { action: "press", key: "Escape" }]).map((s) => s.id);
    expect(ids).toEqual(["S2", "S1", "S3"]);
    expect(stepIdFromTitle("[S12] 点击 按钮")).toBe("S12");
    expect(stepIdFromTitle("locator.click")).toBeUndefined();
  });

  it("writes the spec and a steps file whose hash matches the generated spec", () => {
    const ws = mkdtempSync(join(tmpdir(), "aitest-steps-"));
    try {
      const out = writeUiScript(ws, { caseId: "tc_s", title: "步骤", steps: [
        { action: "goto", url: "/a", caseStep: 1 },
        { action: "expectUrl", pattern: "/a", caseStep: 1, source: "ai" },
      ] });
      expect(out).toEqual({ path: "scripts/ui/tc_s.spec.ts", stepsPath: "scripts/ui/tc_s.steps.json" });
      const code = readFileSync(join(ws, out.path), "utf8");
      const meta = JSON.parse(readFileSync(join(ws, out.stepsPath), "utf8"));
      expect(meta).toMatchObject({ version: 1, caseId: "tc_s", specHash: sha256(code), steps: [{ id: "S1", caseStep: 1 }, { id: "S2", caseStep: 1 }] });
      expect(code).toContain('await test.step("[S2] 断言 URL 包含 /a"');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

describe("browser tools", () => {
  const names = (vision: boolean) => UI_SERVERS.find((x) => x.name === "browser")!
    .tools({ session: {}, vision: vision ? (() => ({})) : undefined } as never).map((t) => t.name);
  it("offers vision tools only when a vision model is configured", () => {
    expect(names(false)).not.toContain("ai_locate");
    expect(names(false)).toContain("snapshot");
    expect(names(true)).toEqual(expect.arrayContaining(["ai_locate", "ai_assert", "ai_act"]));
  });
});

describe("role resolution", () => {
  it("requires an exact role instead of silently changing permissions", () => {
    expect(resolveRole("管理员", ["管理员", "运营"])).toBe("管理员");
    expect(() => resolveRole("运营管理员", ["管理员"])).toThrow("未配置");
    expect(() => resolveRole("运营管理员", ["管理员", "运营管理"])).toThrow("未配置");
    expect(() => resolveRole("运营", ["运营管理员"])).toThrow("未配置");
    expect(() => resolveRole("访客", ["管理员"])).toThrow("未配置");
  });
});

describe("browser choice", () => {
  const full = "/cache/ms-playwright/chromium-1243/chrome-mac-arm64/Chrome for Testing.app/Contents/MacOS/Chrome for Testing";
  const shell = "/cache/ms-playwright/chromium_headless_shell-1243";
  const sysChrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  const pick = (have: string[], opts: { headless?: boolean; env?: Record<string, string> } = {}) =>
    chooseBrowser({ platform: "darwin", env: { HOME: "/Users/u", ...opts.env }, headless: opts.headless, bundled: () => full, exists: (p) => have.includes(p) });
  it("prefers configured, then bundled, then bundled full chromium, then system Chrome", () => {
    expect(pick([full, shell, sysChrome], { env: { AITEST_CHROMIUM_PATH: "/x/chrome" } })).toEqual({ executablePath: "/x/chrome", source: "configured" });
    expect(pick([full, shell, sysChrome])).toEqual({ source: "bundled" });
    expect(pick([full, sysChrome])).toEqual({ executablePath: full, source: "bundled-full" });
    expect(pick([shell, sysChrome], { headless: false })).toEqual({ executablePath: sysChrome, source: "system" });
    expect(pick([sysChrome])).toEqual({ executablePath: sysChrome, source: "system" });
    expect(pick(["/Users/u/Applications/Chromium.app/Contents/MacOS/Chromium"]).source).toBe("system");
    expect(pick([])).toEqual({ source: "missing" });
  });
  it("knows where Windows and Linux install Chrome or Edge", () => {
    const win = chooseBrowser({ platform: "win32", env: { PROGRAMFILES: "C:\\PF" }, bundled: () => "", exists: (p) => p.endsWith("msedge.exe") });
    expect(win.source).toBe("system");
    expect(chooseBrowser({ platform: "linux", env: {}, bundled: () => "", exists: (p) => p === "/usr/bin/chromium" }).executablePath).toBe("/usr/bin/chromium");
  });
});

describe("runner report parsing", () => {
  it("exposes page-level 5xx evidence without turning every locator timeout into an environment verdict", () => {
    const dir = mkdtempSync(join(tmpdir(), "aitest-context-"));
    try {
      const path = join(dir, "error-context.md");
      writeFileSync(path, '# Page snapshot\n\n```yaml\n- alert: 系统接口502异常\n```');
      const report = (status: string) => JSON.stringify({ suites: [{ specs: [{ title: "tc_x", file: "tc_x.spec.ts", tests: [{ results: [{ status, duration: 1, error: { message: "locator.fill: Timeout" }, attachments: [{ name: "error-context", path }] }] }] }] }] });
      const result = parseReport(report("failed"), dir)[0];
      expect(result.environment_hint).toContain("5xx");
      expect(result.failure_type).toBeUndefined();
      expect(parseReport(report("passed"), dir)[0].environment_hint).toBeUndefined();
      writeFileSync(path, '# Page snapshot\n\n```yaml\n- textbox: 搜索模型名称\n```');
      expect(parseReport(report("failed"), dir)[0].environment_hint).toBeUndefined();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

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
    expect(reportErrors(JSON.stringify({ suites: [], errors: [{ message: "\u001b[31mError: locator.fill: selector\u001b[39m" }] })))
      .toEqual(["Error: locator.fill: selector"]);
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
