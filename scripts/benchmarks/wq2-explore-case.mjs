import { chromium } from 'playwright-core';
import { writeFileSync } from 'node:fs';
const b=await chromium.connectOverCDP('http://127.0.0.1:9333');
try {
 const p=b.contexts().flatMap(c=>c.pages()).find(p=>p.url().startsWith('http://localhost:5173/'));
 const id='proj_d5a78499644f'; const caseId=process.argv[2] ?? 'tc_ab02df2bf220';
 await p.evaluate(({id})=>window.aitest.openRoleLogin(id,'dev','超级管理员'),{id});
 const out=await p.evaluate(({id,caseId})=>window.aitest.exploreUiCase(id,'dev',caseId,{selectedRole:'超级管理员'}),{id,caseId});
 writeFileSync(`outputs/validation-plan-20261117/desktop-native/${caseId}-exploration.json`,JSON.stringify(out,null,2));
 console.log(JSON.stringify(out,null,2));
} finally {await b.close()}
