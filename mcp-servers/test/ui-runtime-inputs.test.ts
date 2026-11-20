import { it, expect, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BrowserSession } from "../src/ui/browser.js";
import { UI_SERVERS } from "../src/ui/tools.js";
import { createUiInputs, assertRuntimeInput, resolveInputParams } from "../src/ui/components.js";
import { validateExecutionContract } from "../src/ui/contract.js";
import { caseHash, sha256, generateSpec } from "../src/ui/codegen.js";
import { coverageIssues } from "../src/ui/coverage.js";
import { ExecutionGuard } from "../src/ui/executionGuard.js";

const source = { preconditions: ["两组不同的合法密码"], steps: ["填写密码"], expected: ["提示不一致"] };
const runtime = { valueRef: "other_password" as const, minLength: 6, maxLength: 32, maxUtf8Bytes: 72, differentFrom: "password" as const };
const check = { id: "P1.1", sourceIndices: [1], sourceQuotes: source.preconditions, statement: source.preconditions[0], expected: source.preconditions[0], method: "runtime" as const, runtime, dependsOn: [] };
const plan = { version: 1, status: "ready", issues: [], preconditions: source.preconditions, preconditionChecks: [check], steps: [{ index: 1, source: source.steps[0], expected: source.expected, actions: [{ action: "fill", instruction: "填写确认密码", targetHint: "确认密码", valueRef: "other_password" }] }] };

it("rejects ambiguous inputs, unsupported references and contradictory runtime rules", () => {
  expect(validateExecutionContract(plan, source, []).steps[0].actions[0].valueRef).toBe("other_password");
  const action = plan.steps[0].actions[0];
  const altered = (a: object) => ({ ...plan, steps: [{ ...plan.steps[0], actions: [a] }] });
  expect(() => validateExecutionContract(altered({ ...action, value: "literal" }), source, [])).toThrow("valueRef");
  expect(() => validateExecutionContract(altered({ ...action, valueRef: "missing" }), source, [])).toThrow();
  expect(() => validateExecutionContract({ ...plan, preconditionChecks: [{ ...check, runtime: undefined }] }, source, [])).toThrow("runtime");
  expect(() => validateExecutionContract({ ...plan, preconditionChecks: [{ ...check, runtime: { ...runtime, differentFrom: "other_password" } }] }, source, [])).toThrow("矛盾");
});

it("keeps generated values private, validates constraints and resolves SQL parameters without interpolation", () => {
  const inputs = createUiInputs();
  assertRuntimeInput(inputs, runtime);
  expect(() => assertRuntimeInput(inputs, { ...runtime, maxLength: 3 })).toThrow("ASSERTION_FAILED");
  expect(() => assertRuntimeInput({ ...inputs, other_password: inputs.password }, runtime)).toThrow("ASSERTION_FAILED");
  expect(() => assertRuntimeInput({ ...inputs, other_password: "中文" }, { valueRef: "other_password", maxUtf8Bytes: 5 })).toThrow();
  expect(() => assertRuntimeInput(inputs, { valueRef: "password" })).toThrow("explicit constraint");
  const query = { sql: "select id from users where name=:name", paramRefs: { name: "username" as const }, expect: { empty: true } };
  expect(resolveInputParams(query, inputs)).toEqual({ sql: query.sql, params: { name: inputs.username }, expect: query.expect });
  expect(() => resolveInputParams({ ...query, params: { name: "other" } }, inputs)).toThrow("duplicate");
  expect(JSON.stringify(query)).not.toContain(inputs.username);
});

it("requires runtime evidence, binds database and fill values, and regenerates once per replay", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "runtime-inputs-"));
  const session = new BrowserSession({ headless: true });
  const dir = join(workspace, ".aitest/ui-contracts"); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sha256(JSON.stringify(["p", "test", "c"]))}.json`), JSON.stringify({ sourceHash: caseHash(source), contract: plan }));
  let queried: string | undefined;
  const tools = UI_SERVERS.find(s => s.name === "browser")!.tools({ session, secrets: { resolve: async () => ({}) }, engine: (async (args: string[]) => {
    if (args[0] === "get-project") return { id: "p", name: "p", workspace_path: workspace, environments: { test: { base_url: "http://sut" } } };
    if (args[0] === "get-case") return source;
    if (args[0] === "db-check") { queried = JSON.parse(args.at(-1)!).params.name; return { ok: true, rows: [], errors: [] }; }
    return [];
  }) as any });
  const call = (name: string, args = {}): Promise<any> => tools.find(t => t.name === name)!.handler(args);
  try {
    await call("open_project", { project_id: "p", env: "test", case_id: "c" });
    await call("assertion_coverage", { expected: [], check_ids: ["P1.1"] });
    await call("expect_runtime_input");
    expect(session.currentPreconditionChecks).toEqual([]);
    await call("expect_db", { sql: "select id from users where name=:name", paramRefs: { name: "username" }, expect: { empty: true } });
    const page = await session.page();
    await page.setContent('<input aria-label="用户名">');
    const ref = (await session.snapshot()).elements[0].ref;
    await call("case_step", { index: 1 });
    await call("type", { ref, value_ref: "username" });
    expect(await page.locator("input").inputValue()).toBe(queried);
    await call("expect_value", { ref, value_ref: "username" });
    const steps = session.recording();
    const spec = generateSpec({ caseId: "c", title: "注册", steps });
    expect(spec.match(/const inputs = createUiInputs\(\)/g)).toHaveLength(1);
    expect(spec).toContain("resolveInputParams(");
    expect(spec).toContain('toHaveValue(inputs["username"])');
    expect(spec).toContain("assertRuntimeInput(inputs");
    expect(spec).not.toContain(queried!);
    expect(JSON.stringify(steps)).not.toContain(queried!);
    const guard = new ExecutionGuard("c", [check]);
    expect(guard.passed("P1.1", steps)).toBe(true);
    const forged = [{ action: "expectVisible" as const, target: { kind: "testid" as const, value: "x" }, preconditionCheckIds: ["P1.1"] }];
    expect(guard.passed("P1.1", forged)).toBe(false);
    expect(coverageIssues(forged, { ...source, preconditionChecks: [check] }).join()).toContain("不匹配");
    expect(coverageIssues(steps, { ...source, preconditionChecks: [check] }).join()).not.toContain("原子前置");
    session.resetRecording(true);
    let replayValue: unknown;
    for (const step of steps) await session.runStep(step, { dbCheck: async check => { replayValue = check.params?.name; } });
    expect(await page.locator("input").inputValue()).toBe(replayValue);
    expect(replayValue).not.toBe(queried);
    await expect(session.runStep(steps.find(s => s.action === "expectDb")!)).rejects.toThrow("DB_UNAVAILABLE");
  } finally { await session.close(); rmSync(workspace, { recursive: true, force: true }); }
}, 20000);


it('prevents browser access after project initialization fails', async () => {
  const snapshot = vi.fn();
  const tools = UI_SERVERS.find(server => server.name === 'browser')!.tools({
    session: { currentPreconditionChecks: [], snapshot } as any,
    secrets: {} as any,
    engine: async () => { throw new Error('project unavailable'); },
  });
  const call = (name: string, input = {}) => tools.find(tool => tool.name === name)!.handler(input);
  await expect(call('open_project', { project_id: 'missing', env: 'test' })).rejects.toThrow('project unavailable');
  await expect(call('snapshot')).rejects.toThrow('UI_INITIALIZATION_FAILED');
  expect(snapshot).not.toHaveBeenCalled();
});

it('validates data before any browser is created', async () => {
  const session = new BrowserSession({ headless: true });
  const page = vi.spyOn(session, 'page').mockRejectedValue(new Error('unexpected browser creation'));
  await session.runStep({ action: 'expectRuntimeInput', rule: runtime });
  await session.runStep({ action: 'expectDb', check: { sql: 'select :name', paramRefs: { name: 'username' } } }, {
    dbCheck: async query => { expect(query.params?.name).toMatch(/^ui_/); },
  });
  expect(page).not.toHaveBeenCalled();
});
