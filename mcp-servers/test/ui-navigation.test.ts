import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it, expect } from 'vitest';
import { runUiSuite } from '../src/ui/runner.js';
import { listenLocal } from './fixtures/listen.js';
it('replays against DOM readiness when a nonessential resource never completes', async () => {
  const server = createServer((req,res) => {
    if(req.url === '/hanging-image') return;
    res.writeHead(200, {'content-type':'text/html'});
    res.end('<button>Ready</button><img src="/hanging-image">');
  });
  await listenLocal(server);
  const workspace=mkdtempSync(join(tmpdir(),'aitest-navigation-'));
  mkdirSync(join(workspace,'scripts/ui'),{recursive:true});
  writeFileSync(join(workspace,'scripts/ui/tc_ready.spec.ts'),`import {test,expect} from '@playwright/test';
    test('tc_ready DOM',async({page})=>{await page.goto('/');await expect(page.getByRole('button',{name:'Ready'})).toBeVisible();});`);
  try {
    const result=await runUiSuite({workspace,baseUrl:`http://127.0.0.1:${(server.address() as any).port}`,caseIds:['tc_ready'],env:{AITEST_TEST_TIMEOUT:'8000'}});
    expect(result.results[0].status,JSON.stringify(result)).toBe('passed');
  } finally {server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));rmSync(workspace,{recursive:true,force:true});}
},30000);
