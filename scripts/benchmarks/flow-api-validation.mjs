// Validate the desktop's actual public API against an isolated local service.
import { createServer } from 'node:http';
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
const out = resolve('outputs/validation-plan-20261117/flow-acceptance');
mkdirSync(out, {recursive:true});
let healthy = true;
const server = createServer((_req, res) => { res.writeHead(200, {'content-type':'application/json'}); res.end(JSON.stringify({status: healthy ? 'ok' : 'broken', code:200})); });
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.connectOverCDP('http://127.0.0.1:9333');
const results = {scope:'AIProbe desktop API workflow against controlled local service', results:[]};
try {
 const page = browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().startsWith('http://localhost:5173/'));
 assert(page, 'AIProbe desktop must be running');
 const invoke=(method,...args)=>page.evaluate(({method,args})=>window.aitest[method](...args),{method,args});
 const project=await invoke('createProject',`流程验收-接口-${Date.now()}`,`${out}/api-workspace`,{test:{base_url:base}},{projectType:'api'});
 results.projectId=project.id;
 const draft={title:'健康检查-业务状态',kind:'single',steps:[{method:'GET',path:'/health',auth:false,expected_status:[200],assertions:[{path:'status',operator:'eq',value:'ok'}]}]};
 const debug=await invoke('debugApiRequest',project.id,'test',draft); assert.equal(debug.status,'passed');
 results.results.push({stage:'debug',status:debug.status});
 const saved=await invoke('saveApiCase',project.id,draft);
 await invoke('updateCase',saved.id,{status:'reviewed'},'agent');
 await invoke('writeReviewedApiSuite',project.id);
 const run=()=>invoke('runRegression',project.id,'test',{caseIds:[saved.id],autoTriage:false});
 const pass=await run(); assert.equal(pass.run.passed,1); results.results.push({stage:'regression',...pass.run});
 healthy=false; const fail=await run(); assert.equal(fail.run.failed,1); results.results.push({stage:'business-mismatch',...fail.run});
 healthy=true; const recovered=await run(); assert.equal(recovered.run.passed,1); results.results.push({stage:'recovery',...recovered.run});
 await invoke('saveApiCase',project.id,{...draft,id:saved.id,title:'健康检查-修改后的版本'});
 await invoke('updateCase',saved.id,{status:'reviewed'},'agent');
 let blocked=false;try { await run(); } catch(e) { blocked=/脚本版本已过期/.test(String(e)); }
 assert(blocked,'stale script must be rejected');results.results.push({stage:'stale-script',status:'correctly_blocked'});
 await invoke('writeReviewedApiSuite',project.id); const fresh=await run();assert.equal(fresh.run.passed,1);results.results.push({stage:'recompiled-recovery',...fresh.run});
 results.passed=true;
} catch(e) { results.passed=false;results.error=String(e);process.exitCode=1; }
finally {writeFileSync(`${out}/api-workflow.json`,JSON.stringify(results,null,2));console.log(JSON.stringify(results));await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
