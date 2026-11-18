import { chromium } from 'playwright-core';
import { writeFileSync } from 'node:fs';
const b = await chromium.connectOverCDP('http://127.0.0.1:9333');
const p = b.contexts().flatMap(c => c.pages()).find(x => x.url().startsWith('http://localhost:5173/'));
await p.evaluate(() => window.aitest.openRoleLogin('proj_d5a78499644f', 'dev', '超级管理员'));
const out = await p.evaluate(({id}) => window.aitest.runUiRegression(id, 'dev', true, {caseIds:['tc_3a1771c60a7b'], mode:'validate', embedded:true, selectedRole:'超级管理员'}), {id:'proj_d5a78499644f'});
writeFileSync('outputs/validation-plan-20261117/desktop-native/key-strict-run.json', JSON.stringify(out,null,2));
console.log(JSON.stringify(out));
await b.close();
