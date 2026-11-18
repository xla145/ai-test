import { it, expect } from 'vitest';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserSession } from '../src/ui/browser.js';
import { writeUiScript } from '../src/ui/codegen.js';
import { runUiSuite } from '../src/ui/runner.js';
import { listenLocal } from './fixtures/listen.js';

it('records disabled state and rejects an enabled or missing button on fresh replay', async () => {
  let state = 'disabled';
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(state === 'missing' ? '<main>missing</main>'
      : `<button data-testid="delete-key" ${state}>Delete</button>`);
  });
  await listenLocal(server);
  const url = `http://127.0.0.1:${(server.address() as any).port}`;
  const workspace = mkdtempSync(join(tmpdir(), 'aitest-enabled-'));
  const session = new BrowserSession({ headless: true });
  try {
    await session.navigate(url);
    const ref = (await session.snapshot()).elements.find(e => e.testId === 'delete-key')!.ref;
    await session.expectEnabled(ref, false);
    expect(session.recording().find(s => s.action === 'expectEnabled'))
      .toMatchObject({ action: 'expectEnabled', enabled: false });
    writeUiScript(workspace, { caseId: 'tc_disabled', title: 'disabled state', baseUrl: url, steps: session.recording() });
    await session.close();
    const run = () => runUiSuite({ workspace, baseUrl: url, caseIds: ['tc_disabled'], workers: 1,
      env: { AITEST_TEST_TIMEOUT: '15000', AITEST_EXPECT_TIMEOUT: '500' } });
    expect((await run()).results[0].status).toBe('passed');
    state = '';
    expect((await run()).results[0].status).toBe('failed');
    state = 'missing';
    expect((await run()).results[0].status).toBe('failed');
  } finally {
    await session.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(workspace, { recursive: true, force: true });
  }
}, 90_000);
