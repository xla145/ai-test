import { chromium } from 'playwright-core';
const b=await chromium.connectOverCDP('http://127.0.0.1:9333');
try { const p=b.contexts().flatMap(c=>c.pages()).find(p=>p.url().startsWith('http://localhost:5173/')); const id='proj_d5a78499644f'; const caseId='tc_ab02df2bf220'; const out=await p.evaluate(({id,caseId})=>window.aitest.exploreUiCase(id,'dev',caseId,{selectedRole:'超级管理员'}),{id,caseId}); console.log(JSON.stringify(out,null,2)); } finally {await b.close()}
