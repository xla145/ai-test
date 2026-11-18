import { it, expect } from 'vitest';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listenLocal } from './fixtures/listen.js';
import { BrowserSession } from '../src/ui/browser.js';
import { generateSpec, writeUiScript, type UiStep } from '../src/ui/codegen.js';
import { runUiSuite } from '../src/ui/runner.js';
import { coverageIssues } from '../src/ui/coverage.js';
it('rejects ambiguous or missing expectation sources before exploration and script generation', async () => {
  const session = new BrowserSession({baseUrl:'http://invalid',headless:true});
  const target = {kind:'testid' as const,value:'status'};
  for (const options of [{name:'state',expected:'enabled'}, {}, {name:''}]) {
    await expect(session.expectObserved('unused', options)).rejects.toThrow('VALUE_INVALID');
    expect(() => generateSpec({caseId:'tc_invalid',title:'invalid',steps:[
      {action:'readValue',target,name:'state',valueSource:'text'},
      {action:'expectObserved',target,valueSource:'text',...options},
    ]})).toThrow('VALUE_INVALID');
  }
  expect(() => generateSpec({caseId:'tc_missing',title:'missing',steps:[
    {action:'expectObserved',target,name:'missing',valueSource:'text'},
  ]})).toThrow('尚未录制来源值');
});
it('rejects missing expected/precondition coverage, invalid indices and inherited-page-only scripts', () => {
  const source = {steps:['open'],expected:['value'],preconditions:['signed in']};
  expect(coverageIssues([{action:'click',target:{kind:'testid',value:'x'},caseStep:1}],source)).toEqual(expect.arrayContaining(['预期 1 未映射到断言','前置条件 1 未映射到断言','角色「default」缺少独立回放入口，请先录制导航']));
  expect(coverageIssues([{action:'goto',url:'/',caseStep:1},{action:'expectVisible',target:{kind:'testid',value:'x'},expectedIndices:[1],preconditionIndices:[1]}],source)).toEqual([]);
  expect(coverageIssues([{action:'goto',url:'/',expectedIndices:[1]}],source)).toContain('步骤 goto 不是断言，不能证明预期或前置条件');
});
it('debug and generated replay share strict numeric, checked, selected and cross-page comparisons', async () => {
  const server = createServer((_req,res)=>res.end(`<html><body>
    <input data-testid="price" value="1.00000000"><p data-testid="shown">1.0000</p>
    <input data-testid="switch" type="checkbox" checked>
    <div data-testid="select" class="el-select"><input value="search text"><span class="el-select__selected-item">A</span><span class="el-select__selected-item">B</span></div>
    <p data-testid="invalid">--</p><div style="height:1800px"></div><button data-testid="bottom">bottom</button>
  </body></html>`));
  await listenLocal(server);
  const url = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
  const session = new BrowserSession({baseUrl:url,headless:true});
  const workspace = mkdtempSync(join(tmpdir(),'aitest-values-'));
  const target = (value:string) => ({kind:'testid' as const,value});
  const steps: UiStep[] = [
    {action:'goto',url:'/',caseStep:1},
    {action:'readValue',target:target('price'),name:'price',valueSource:'input'},
    {action:'goto',url:'/?second-page',caseStep:1},
    {action:'expectObserved',target:target('shown'),name:'price',valueSource:'text',normalize:'number',expectedIndices:[1]},
    {action:'expectNumber',target:target('shown'),value:'1.0000000000000000',expectedIndices:[1]},
    {action:'expectObserved',target:target('switch'),expected:true,valueSource:'checked',expectedIndices:[1]},
    {action:'expectObserved',target:target('select'),expected:['B','A'],valueSource:'selected',normalize:'set',expectedIndices:[1]},
    {action:'reveal',target:target('bottom')},
  ];
  try {
    for (const step of steps) await session.runStep(step);
    // A matching stored value must not hide a contradictory explicit expectation.
    await expect(session.runStep({action:'expectObserved',target:target('shown'),name:'price',expected:'999',valueSource:'text'},{timeoutMs:50})).rejects.toThrow('VALUE_INVALID');
    await expect(session.runStep({action:'expectObserved',target:target('shown'),expected:'999',valueSource:'text'},{timeoutMs:50})).rejects.toThrow('ASSERTION_FAILED');
    await expect(session.runStep({action:'expectObserved',target:target('shown'),name:'missing',valueSource:'text'},{timeoutMs:50})).rejects.toThrow('尚未录制来源值');
    await expect(session.runStep({action:'expectNumber',target:target('invalid'),value:0},{timeoutMs:50})).rejects.toThrow('VALUE_INVALID');
    await expect(session.runStep({action:'expectNumber',target:target('shown'),value:2},{timeoutMs:50})).rejects.toThrow();
    const caseIds = Array.from({length:5},(_,i)=>`tc_values_${i}`);
    for (const id of caseIds) writeUiScript(workspace,{caseId:id,title:'values',steps,caseSteps:['open'],expected:['fields equal']});
    const out = await runUiSuite({workspace,baseUrl:url,caseIds,workers:2});
    expect(out.exitCode,JSON.stringify(out)).toBe(0);
    expect(out.results).toHaveLength(5);
    expect(out.results.every(r=>r.acceptance_status==='verified_pass')).toBe(true);
  } finally {await session.close();await new Promise<void>(r=>server.close(()=>r()));rmSync(workspace,{recursive:true,force:true});}
},60_000);
