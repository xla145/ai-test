import { it, expect } from 'vitest';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserSession } from '../src/ui/browser.js';
import { checkCollection } from '../src/ui/components.js';
import { writeUiScript } from '../src/ui/codegen.js';
import { runUiSuite } from '../src/ui/runner.js';
import { listenLocal } from './fixtures/listen.js';

it('checks rules rather than captured result counts, including fresh generated replay after data changes', async () => {
  let values = ['match-a'];
  const server = createServer((_req, response) => {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(`<div data-testid="results">${values.map(value => `<div class="name">${value}</div>`).join('')}</div>`);
  });
  await listenLocal(server);
  const url = `http://127.0.0.1:${(server.address() as any).port}`;
  const session = new BrowserSession({ headless: true });
  const workspace = mkdtempSync(join(tmpdir(), 'collection-'));
  try {
    await session.navigate(url);
    const ref = (await session.snapshot()).elements.find(e => e.testId === 'results')!.ref;
    await session.expectCollection(ref, { selector: '.name', minCount: 1, contains: 'match-' });
    const steps = session.recording();
    writeUiScript(workspace, { caseId: 'tc_collection', title: 'result rules', steps, baseUrl: url });
    await session.close();
    const run = () => runUiSuite({ workspace, baseUrl: url, caseIds: ['tc_collection'], workers: 1,
      env: { AITEST_TEST_TIMEOUT: '8000', AITEST_ACTION_TIMEOUT: '1000', AITEST_EXPECT_TIMEOUT: '300' } });
    expect((await run()).results[0].status).toBe('passed');
    // More matching data and different order must not invalidate the script.
    values = ['match-c', 'match-new', 'match-a'];
    expect((await run()).results[0].status).toBe('passed');
    values.push('wrong');
    expect((await run()).results[0].status).toBe('failed');
    values = [];
    expect((await run()).results[0].status).toBe('failed');
  } finally {
    await session.close(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(workspace, { recursive: true, force: true });
  }
}, 90_000);

it('supports count ranges, rejects invalid rules and never uses expected text to select matching rows', async () => {
  const session = new BrowserSession({ headless: true });
  try {
    const page = await session.page();
    await page.setContent('<div data-testid="results"><p class="name">A</p><p class="name">B</p></div>');
    const ref = (await session.snapshot()).elements.find(e => e.testId === 'results')!.ref;
    const root = page.getByTestId('results');
    expect(await checkCollection(root, { selector: '.name', minCount: 2 })).toMatchObject({ matched: true });
    expect(await checkCollection(root, { selector: '.name', equals: 'A' })).toMatchObject({ matched: false });
    await expect(checkCollection(root, { selector: '.name', minCount: 3, maxCount: 1 })).rejects.toThrow('contradictory');
    await expect(session.expectCollection(ref, { selector: '.name[data-name="A"]', equals: 'A' })).rejects.toThrow('不能按预期值');
    await expect(checkCollection(root, { selector: '.missing' })).resolves.toMatchObject({ count: 0, matched: false });
    await expect(checkCollection(root, { selector: '.missing', minCount: 0, maxCount: 0 })).resolves.toMatchObject({ count: 0, matched: true });
  } finally { await session.close(); }
}, 10000);
