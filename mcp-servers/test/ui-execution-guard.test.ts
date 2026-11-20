import { it, expect, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExecutionGuard, type PreconditionCheck } from '../src/ui/executionGuard.js';
import { coverageIssues } from '../src/ui/coverage.js';
import { BrowserSession } from '../src/ui/browser.js';
import { UI_SERVERS } from '../src/ui/tools.js';
import { caseHash, sha256, type UiStep } from '../src/ui/codegen.js';
import { UiReadiness } from '../src/ui/readiness.js';

const checks: PreconditionCheck[] = ['first', 'second'].map((text, i) => ({ id: `P1.${i + 1}`, sourceIndices: [1], sourceQuotes: [text], statement: text, expected: text, method: 'ui', dependsOn: i ? ['P1.1'] : [] }));
const evidence = (id: string): UiStep => ({ action: 'expectVisible', target: { kind: 'testid', value: id }, preconditionIndices: [1], preconditionCheckIds: [id] });

it('requires database evidence to use the planned runtime parameter references', () => {
  const check: PreconditionCheck = { ...checks[0], method: 'database', paramRefs: { name: 'username' } };
  const gate = new ExecutionGuard('c', [check]);
  const step: UiStep = { action: 'expectDb', check: { sql: 'select id from users where name=:name', paramRefs: { name: 'username' } }, preconditionCheckIds: [check.id], preconditionIndices: [1] };
  expect(gate.passed(check.id, [step])).toBe(true);
  expect(gate.passed(check.id, [evidence(check.id)])).toBe(false);
  const wrong: UiStep = { ...step, check: { ...step.check, paramRefs: { name: 'email' } } };
  expect(gate.passed(check.id, [wrong])).toBe(false);
  const literal: UiStep = { ...step, check: { ...step.check, params: { name: 'fixed' } } };
  expect(gate.passed(check.id, [literal])).toBe(false);
  expect(coverageIssues([wrong], { preconditions: ['first'], preconditionChecks: [check], expected: ['result'] }).join()).toContain('数据库参数引用与计划不匹配');
});

it('waits without repeating the action and only recovers transient readiness blocks', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'guard-wait-'));
  const source = { preconditions: [], steps: ['open'], expected: ['visible'] };
  const contract = { version: 1, status: 'ready', issues: [], preconditions: [], preconditionChecks: [],
    steps: [{ index: 1, source: 'open', actions: [{ action: 'observe', instruction: 'read' }], expected: ['visible'] }] };
  const dir = join(workspace, '.aitest/ui-contracts'); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sha256(JSON.stringify(['p', 'test', 'c']))}.json`), JSON.stringify({ sourceHash: caseHash(source), contract }));
  const session = { configure() {}, resetRecording() {}, recording: () => [], currentPreconditionChecks: [],
    targetIdentity: () => 'target', click: vi.fn(async () => {}), snapshotAfterAction: vi.fn(),
    waitUntilReady: vi.fn(async () => {}), snapshot: async () => ({ text: 'loaded' }) };
  const tools = UI_SERVERS.find(s => s.name === 'browser')!.tools({ session, secrets: {}, engine: async (args: string[]) =>
    args[0] === 'get-project' ? { id: 'p', name: 'p', workspace_path: workspace, environments: { test: { base_url: 'http://sut' } } }
      : args[0] === 'get-case' ? source : [] } as any);
  const call = (name: string, input = {}): Promise<any> => tools.find(t => t.name === name)!.handler(input);
  try {
    await call('open_project', { project_id: 'p', env: 'test', case_id: 'c' });
    session.snapshotAfterAction.mockRejectedValueOnce(new Error('UI_RESULT_NOT_READY: loading'));
    await expect(call('click', { ref: 'e1' })).rejects.toThrow('UI_RESULT_NOT_READY');
    await expect(call('click', { ref: 'e1' })).rejects.toThrow('UI_RESULT_NOT_READY');
    expect(session.click).toHaveBeenCalledTimes(1);
    session.waitUntilReady.mockRejectedValueOnce(new Error('UI_RESULT_NOT_READY: loading'));
    await expect(call('wait_ready')).rejects.toThrow('UI_RESULT_NOT_READY');
    await expect(call('wait_ready', { timeout_ms: 500 })).resolves.toMatchObject({ ready: true });
    expect(session.waitUntilReady).toHaveBeenLastCalledWith(500);
    expect(session.click).toHaveBeenCalledTimes(1);
    session.snapshotAfterAction.mockRejectedValueOnce(new Error('UI_ENVIRONMENT_BLOCKED: 502'));
    await expect(call('click', { ref: 'e1' })).rejects.toThrow('UI_ENVIRONMENT_BLOCKED');
    await expect(call('wait_ready')).rejects.toThrow('UI_ENVIRONMENT_BLOCKED');
    expect(session.waitUntilReady).toHaveBeenCalledTimes(2);
  } finally { rmSync(workspace, { recursive: true, force: true }); }
});

it('requires atomic evidence, enforces dependencies and revokes evidence after undo', () => {
  const gate = new ExecutionGuard('c', checks);
  const steps: UiStep[] = [{ action: 'goto', url: '/' }, evidence('P1.1')];
  expect(() => gate.select(['unknown'], steps)).toThrow('UNKNOWN');
  expect(() => gate.select(['P1.2'], [])).toThrow('DEPENDENCY');
  expect(() => gate.assertReady(steps)).toThrow('P1.2');
  steps.push(evidence('P1.2'));
  expect(() => gate.assertReady(steps)).toThrow('PRECONDITION_BLOCKED');
  const fresh = new ExecutionGuard('c', checks);
  expect(() => fresh.assertReady(steps)).not.toThrow();
  steps.pop();
  expect(() => fresh.assertReady(steps)).toThrow('P1.2');
  fresh.failChecks(['P1.2'], 'data missing');
  expect(() => fresh.assertReady([...steps, evidence('P1.2')])).toThrow('data missing');
});

it('rejects checks recorded after body steps and persists the blocked result', () => {
  const dir = mkdtempSync(join(tmpdir(), 'guard-'));
  try {
    const gate = new ExecutionGuard('c', checks, join(dir, 'run.json'));
    const steps: UiStep[] = [{ action: 'goto', url: '/', caseStep: 1 }, evidence('P1.1'), evidence('P1.2')];
    expect(coverageIssues(steps, { steps: ['open'], expected: ['visible'], preconditions: ['first second'], preconditionChecks: checks }).join()).toContain('正文前');
    gate.failChecks(['P1.2'], 'unverified'); gate.persist(steps);
    expect(JSON.parse(readFileSync(gate.path!, 'utf8')).checks[1]).toMatchObject({ status: 'blocked', reason: 'unverified' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it('allows one different recovery and then blocks further actions', () => {
  const gate = new ExecutionGuard('c', []);
  gate.failedAttempt('target', 'ai_locate');
  expect(() => gate.beforeAttempt('target', 'ai_locate')).toThrow('RECOVERY_REQUIRED');
  expect(() => gate.beforeAttempt('target', 'DOM')).not.toThrow();
  gate.failedAttempt('target', 'DOM');
  expect(() => gate.assertActive()).toThrow('RECOVERY_EXHAUSTED');
});

it('binds the plan through tools, consumes coverage once and blocks case steps until all checks pass', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'guard-tools-'));
  const session = new BrowserSession({ headless: true });
  const source = { id: 'c', title: 'check', preconditions: ['first second'], steps: ['open'], expected: ['visible'] };
  const contract = { version: 1, status: 'ready', issues: [], preconditions: source.preconditions, preconditionChecks: checks,
    steps: [{ index: 1, source: 'open', actions: [{ action: 'observe', instruction: 'read' }], expected: source.expected }] };
  const path = join(workspace, '.aitest/ui-contracts'); mkdirSync(path, { recursive: true });
  writeFileSync(join(path, `${sha256(JSON.stringify(['p', 'test', 'c']))}.json`), JSON.stringify({ sourceHash: caseHash(source), contract }));
  const tools = UI_SERVERS.find(s => s.name === 'browser')!.tools({ session, secrets: {}, engine: async (args: string[]) =>
    args[0] === 'get-project' ? { id: 'p', name: 'p', workspace_path: workspace, environments: { test: { base_url: 'http://sut' } } }
      : args[0] === 'get-case' ? source : [] } as any);
  const call = (name: string, input = {}): Promise<any> => tools.find(t => t.name === name)!.handler(input);
  try {
    await call('open_project', { project_id: 'p', env: 'test', case_id: 'c' });
    await (await session.page()).setContent('<div data-testid="ready">ready</div>');
    const ref = (await session.findText('ready', { exact: true }))[0].ref;
    for (const id of ['P1.1', 'P1.2']) {
      await call('assertion_coverage', { expected: [], check_ids: [id] });
      await call('expect_visible', { ref, visible: true });
      expect(session.currentPreconditionChecks).toEqual([]);
    }
    await expect(call('case_step', { index: 1 })).resolves.toMatchObject({ case_step: 1 });
    await call('undo', { n: 1 });
    await expect(call('case_step', { index: 1 })).rejects.toThrow('P1.2');
    for (const name of ['click', 'snapshot', 'assertion_coverage', 'visual_check', 'undo']) {
      await expect(call(name, { ref, expected: [] })).rejects.toThrow('PRECONDITION_BLOCKED');
    }
    expect((await call('precondition_status')).blocked).toContain('P1.2');
    await expect(call('open_project', { project_id: 'p', env: 'test', case_id: 'c' })).rejects.toThrow('不能重置');
  } finally { await session.close(); rmSync(workspace, { recursive: true, force: true }); }
}, 20000);

it('waits for asynchronous data and blocks gateway errors without inspecting business text', async () => {
  const session = new BrowserSession({ headless: true });
  try {
    const page = await session.page();
    await page.route('https://fixture.test/**', async route => {
      if (route.request().url().includes('/data')) {
        await new Promise(r => setTimeout(r, 550));
        return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
      }
      if (route.request().url().includes('/error')) return route.fulfill({ status: 502, body: 'gateway' });
      return route.fulfill({ contentType: 'text/html', body: '<div id="result">old</div>' });
    });
    await page.goto('https://fixture.test/');
    const readiness = new UiReadiness(page);
    await page.evaluate(() => { void fetch('/data').then(() => { document.querySelector('#result')!.textContent = 'new'; }); });
    await readiness.wait();
    expect(await page.locator('#result').innerText()).toBe('new');
    await page.evaluate(async () => { await fetch('/error?token=secret'); });
    await expect(readiness.wait()).rejects.toThrow('UI_ENVIRONMENT_BLOCKED');
    await expect(readiness.wait()).rejects.not.toThrow('secret');
  } finally { await session.close(); }
}, 20000);

it('reports unresolved loading instead of returning a stale empty snapshot', async () => {
  const session = new BrowserSession({ headless: true });
  try {
    const page = await session.page();
    await page.setContent('<div aria-busy="true">loading</div>');
    await expect(new UiReadiness(page).wait(150)).rejects.toThrow('UI_RESULT_NOT_READY');
  } finally { await session.close(); }
}, 10000);
