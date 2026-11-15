import { it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { chromium } from 'playwright-core';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chooseBrowser } from '../src/ui/chromium.js';
import { runUiSuite } from '../src/ui/runner.js';
import { startDemoApp } from './fixtures/app.js';
const { numericEqual } = createRequire(import.meta.url)('../templates/ui/aitest-values.cjs');
it('compares decimals exactly and rejects missing, units, ranges and invalid tolerance', () => {
  expect(numericEqual('1.00000000', '1.0000')).toBe(true);
  expect(numericEqual('9007199254740993', '9007199254740992')).toBe(false);
  expect(numericEqual('0.3', '0.1', '0.2')).toBe(true);
  expect(numericEqual('-2e-3', '-0.002')).toBe(true);
  for (const value of ['', null, false, NaN, '1元', '1%', '1-2', '--', '1 000', 'Infinity']) {
    expect(() => numericEqual(value, 0)).toThrow('VALUE_INVALID');
  }
  expect(() => numericEqual(1, 1, -1)).toThrow();
});
it('restores both role sessions in isolated headless tests, five times per role', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'aitest-runtime-'));
  const app = await startDemoApp();
  const port = 10300 + Math.floor(Math.random() * 200);
  const host = await chromium.launch({ executablePath: chooseBrowser().executablePath, args: [`--remote-debugging-port=${port}`] });
  try {
    const viewMarkers: Record<string,string> = {};
    const bindings: Record<string,string> = {};
    const caseIds: string[] = [];
    mkdirSync(join(workspace, 'scripts/ui'), { recursive: true });
    for (const role of ['admin','viewer']) {
      const context = await host.newContext(); const page = await context.newPage();
      await page.goto(`${app.url}/login`);
      await page.locator('#username').fill(role === 'admin' ? 'alice' : 'bob');
      await page.locator('#password').fill(role === 'admin' ? 'pw-admin' : 'pw-viewer');
      await page.locator('#login').click(); await page.waitForURL('**/dashboard');
      viewMarkers[role] = `export-${role}`;
      await page.evaluate(role => { (window as any).__aitestViewMarker = `export-${role}`; sessionStorage.setItem('identity', role); localStorage.setItem('identity', role); }, role);
      for (let i=0; i<5; i++) {
        const id = `tc_${role}_${i}`; caseIds.push(id); bindings[id] = role;
        writeFileSync(join(workspace, `scripts/ui/${id}.spec.ts`), `import { test, expect } from '@playwright/test';
          test('${id} restore', async ({page}) => {
            await page.goto('/dashboard');
            await expect(page.getByTestId('current-role')).toHaveText('${role}');
            expect(await page.evaluate(() => sessionStorage.getItem('identity'))).toBe('${role}');
            expect(await page.evaluate(() => localStorage.getItem('identity'))).toBe('${role}');
            await page.evaluate(() => sessionStorage.setItem('identity', 'mutated'));
          });`);
      }
    }
    const out = await runUiSuite({workspace, baseUrl:app.url, caseIds, roleBindings:bindings, workers:2,
      sessionSource:{cdpEndpoint:`http://127.0.0.1:${port}`,viewMarkers},
      env:{ AITEST_LOGIN: JSON.stringify({url:'/login',username:'#username',password:'#password',submit:'#login',success:'/dashboard'}) }});
    expect(out.exitCode, JSON.stringify(out)).toBe(0);
    expect(out.results).toHaveLength(10);
    expect(out.results.every(r=>r.status === 'passed')).toBe(true);
    expect(host.isConnected()).toBe(true);
    for (const result of out.results) {
      expect(result.execution_context?.sessions).toEqual([expect.objectContaining({
        role: bindings[result.case_id], mode: 'isolated', restored: true, pageUrl: `${app.url}/dashboard`, sessionId: out.sessionId,
      })]);
    }
    // A named session must never degrade into an anonymous context.
    const defaultSession = await runUiSuite({workspace, baseUrl:app.url, caseIds:[caseIds[0]],
      sessionSource:{cdpEndpoint:`http://127.0.0.1:${port}`,viewMarkers:{default:viewMarkers.admin}}});
    expect(defaultSession.results[0].status, JSON.stringify(defaultSession)).toBe('passed');
    expect(defaultSession.results[0].execution_context?.sessions).toEqual([expect.objectContaining({role:'default', restored:true})]);
    const missing = await runUiSuite({workspace,baseUrl:app.url,caseIds:[caseIds[0]],roleBindings:{[caseIds[0]]:'absent'}});
    expect(missing.results[0].status).not.toBe('passed');
    expect(missing.results[0].message).toContain('AUTH_REQUIRED');
  } finally { await host.close(); await app.close(); rmSync(workspace,{recursive:true,force:true}); }
}, 90_000);
