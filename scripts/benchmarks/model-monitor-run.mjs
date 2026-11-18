import {chromium} from 'playwright-core';
import {readFileSync,writeFileSync} from 'node:fs';
const out='outputs/validation-plan-20261117/model-monitor-api';
const projectId='proj_6c93c648322b';
const b=await chromium.connectOverCDP('http://127.0.0.1:9333');
const p=b.contexts().flatMap(c=>c.pages()).find(p=>p.url().startsWith('http://localhost:5173/'));
const call=(m,...a)=>p.evaluate(({m,a})=>window.aitest[m](...a),{m,a});
const result={projectId,checks:[]};
try {
const preview=await call('previewApiImport',projectId,'/tmp/aiprobe-openapi.json');
preview.selected_keys=preview.changes.filter(x=>x.path.startsWith('/model/v2/monitor/')).map(x=>`${x.method}:${x.path}`);
const imp=await call('importApiDefinitions',projectId,preview);
const defs=imp.definitions.filter(x=>x.path.startsWith('/model/v2/monitor/'));
result.definitions=defs.map(x=>({id:x.id,path:x.path,revision:x.revision,hasSchema:!!x.request.response_schema}));
async function debug(name,steps,kind='single') {
 const r=await call('debugApiRequest',projectId,'devApi',{title:name,kind,steps});
 result.checks.push({name,id:r.id,status:r.status,steps:r.steps.map(x=>({status:x.status,error:x.error,response:x.response,assertions:x.assertions}))});
 writeFileSync(`${out}/execution.json`,JSON.stringify(result,null,2));
 console.log(name,r.status);return r;
}
function req(suffix,query={},schema=true){const d=defs.find(x=>x.path.endsWith('/'+suffix));return {...d.request,auth:true,query,expected_status:[200],response_schema:schema?d.request.response_schema:null,assertions:[{path:'code',operator:'eq',value:200},{path:'data',operator:'exists'}]};}
await debug('原始文档契约-资源', [req('resource')]);
const list=await debug('真实数据发现-渠道列表',[req('channels',{dataSource:'current',days:7},false)]);
const body=list.steps[0]?.response?.body;
result.discovery=Array.isArray(body?.data)?body.data.map(x=>({channelId:x.channelId,channelName:x.channelName,models:x.models?.map(m=>({upstreamModel:m.upstreamModel,modelName:m.modelName}))})):body;
writeFileSync(`${out}/execution.json`,JSON.stringify(result,null,2));
} finally {await b.close();}
