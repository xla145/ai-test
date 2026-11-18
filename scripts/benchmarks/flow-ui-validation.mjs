import { chromium } from 'playwright-core';
import { writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9333');
const result={scope:'AIProbe real dev: isolated trial and two model-free regressions',runs:[]};
try {
 const page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().startsWith('http://localhost:5173/'));
 const invoke=(method,...args)=>page.evaluate(({method,args})=>window.aitest[method](...args),{method,args});
 const project='proj_d5a78499644f', cid='tc_3a1771c60a7b';
 const trial=await invoke('runUiRegression',project,'dev',false,{caseIds:[cid],mode:'validate',selectedRole:'超级管理员'});
 result.runs.push({stage:'isolated-validation',...trial});assert.equal(trial.run.acceptance.verified_pass,1);
 const states=await invoke('uiScriptStates',project,'dev');
 await invoke('confirmUiScript',project,'dev',cid,states[cid].hash);
 for(let i=0;i<2;i++) {
  const run=await invoke('runUiRegression',project,'dev',false,{caseIds:[cid],mode:'regression',workers:1});
  result.runs.push({stage:`regression-${i+1}`,...run});assert.equal(run.run.acceptance.verified_pass,1);
 }
 result.passed=true;
} catch(e){result.passed=false;result.error=String(e);process.exitCode=1;}
finally{writeFileSync('outputs/validation-plan-20261117/flow-acceptance/ui-workflow.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));await browser.close();}
