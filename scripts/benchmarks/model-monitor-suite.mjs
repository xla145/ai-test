// Drive AIProbe's own import, case editor, debugger, script compiler and runner.
import {chromium} from 'playwright-core';
import {readFileSync,writeFileSync} from 'node:fs';
const out='outputs/validation-plan-20261117/model-monitor-api', projectId='proj_6c93c648322b';
const b=await chromium.connectOverCDP('http://127.0.0.1:9333');
const p=b.contexts().flatMap(c=>c.pages()).find(p=>p.url().startsWith('http://localhost:5173/'));
const call=(m,...a)=>p.evaluate(({m,a})=>window.aitest[m](...a),{m,a});
const report={projectId,tests:[],runs:[],sourceRows:[99,100,101,102],exclusions:[103,104,105,106,107]};
const flush=()=>writeFileSync(`${out}/suite-results.json`,JSON.stringify(report,null,2));
const obj=(properties,required=Object.keys(properties))=>({type:'object',properties,required});
const num={type:'number',minimum:0}, count={type:'integer',minimum:0}, str={type:'string'};
const pct={type:'number',minimum:0,maximum:100,nullable:true};
const point=obj({label:str,value:{type:'number',nullable:true}});
const trend={type:'array',items:point,minItems:1};
const metrics={requests:count,successes:count,failures:count,successRate:pct};
const model=obj({upstreamModel:str,...metrics,minLatencyMs:{...count,nullable:true},avgLatencyMs:{...count,nullable:true},maxLatencyMs:{...count,nullable:true}});
const channel=obj({channelId:{type:['string','integer']},channelName:str,...metrics,models:{type:'array',items:model},recentRecords:{type:'array',maxItems:60}});
const endpoint=obj({upstreamModel:str,...metrics,requestTrend:trend,successRateTrend:trend,latencyTrend:trend,abnormalResponses:{type:'array'},probeRecords:{type:'array',maxItems:5}});
const resource=obj(Object.fromEntries([...['currentCpu','avgCpu','peakCpu','currentMemory','avgMemory','peakMemory'].map(k=>[k,{...pct,nullable:false}]),['cpuTrend',{...trend,minItems:60,maxItems:60}],['memoryTrend',{...trend,minItems:60,maxItems:60}],['updatedAt',str]]));
const envelope=data=>obj({code:{type:'integer',const:200},data},['code','data']);
const schemas={resource:envelope(resource),channels:envelope({type:'array',items:channel}),channel:envelope(channel),endpoint:envelope(endpoint)};
const req=(suffix,query={})=>({method:'GET',path:`/model/v2/monitor/${suffix}`,query,auth:true,expected_status:[200],response_schema:schemas[suffix],assertions:[{path:'code',operator:'eq',value:200}]});
async function add(title,steps,sourceRow,group='business'){
 const draft={title,kind:steps.length===1?'single':'flow',module_path:['模型服务 v2 - 运行监控',group],steps};
 const existing=(await call('listCases',projectId)).find(c=>c.title===title);if(existing)draft.id=existing.id;
 const debug=await call('debugApiRequest',projectId,'devApi',draft);
 const saved=await call('saveApiCase',projectId,draft);
 if(sourceRow) await call('updateCase',saved.id,{source_row:sourceRow},'agent');
 await call('updateCase',saved.id,{status:'reviewed'},'agent');
 report.tests.push({title,id:saved.id,sourceRow,group,debugId:debug.id,status:debug.status,steps:debug.steps.map(s=>({status:s.status,error:s.error,response:s.response,assertions:s.assertions}))});flush();console.log(title,debug.status);
}
try {
 const preview=await call('previewApiImport',projectId,'/tmp/aiprobe-openapi.json');preview.selected_keys=preview.changes.filter(x=>x.path.startsWith('/model/v2/monitor/')).map(x=>`${x.method}:${x.path}`);
 const imp=await call('importApiDefinitions',projectId,preview); const defs=imp.definitions.filter(d=>d.path.startsWith('/model/v2/monitor/'));
 const discovery=JSON.parse(readFileSync(`${out}/execution.json`)).discovery.find(x=>x.models?.length);
 if(!discovery)throw Error('没有真实渠道模型，详情用例前置阻塞');
 for(const d of defs){const suffix=d.path.split('/').at(-1);await add(`原始契约-${suffix}`,[{...d.request,auth:true,query:suffix==='resource'?{}:{dataSource:'current',days:7,range:'7d',channelId:discovery.channelId,channelName:discovery.channelName,upstreamModel:discovery.models[0].upstreamModel},assertions:[{path:'code',operator:'eq',value:200}]}],null,'contract');}
 await add('Excel102-资源指标与60分钟趋势',[req('resource')],102);
 for(const dataSource of ['current','demo']) for(const days of [7,15,30])await add(`Excel101-渠道列表-${dataSource}-${days}天`,[req('channels',{dataSource,days})],101);
 for(const range of ['1h','6h','24h','7d','15d','30d']){
  const list=req('channels',{dataSource:'current',days:30});list.extract={channelId:'data.0.channelId',channelName:'data.0.channelName',upstreamModel:'data.0.models.0.upstreamModel'};list.assertions.push({path:'data.0.models.0.upstreamModel',operator:'not_empty'});
  const query={dataSource:'current',range,channelId:'${channelId}',channelName:'${channelName}'};
  const detail=req('channel',query);detail.assertions.push({path:'data.channelName',operator:'eq',value:'${channelName}'});
  const ep=req('endpoint',{...query,upstreamModel:'${upstreamModel}'});ep.assertions.push({path:'data.upstreamModel',operator:'eq',value:'${upstreamModel}'});
  await add(`Excel100-渠道到端点动态下钻-${range}`,[list,detail,ep],100);
 }
 // Business envelopes often return HTTP 200 even for unauthenticated requests.
 for(const suffix of ['resource','channels','channel','endpoint'])await add(`鉴权-无凭据-${suffix}`,[{...req(suffix),auth:false,expected_status:[200,401,403],response_schema:obj({code:{type:'integer',enum:[401,403]}}),assertions:[{path:'code',operator:'ne',value:200}]}],null,'auth');
 await call('writeReviewedApiSuite',projectId);
 for(const group of ['business','auth','contract']){
  const ids=report.tests.filter(x=>x.group===group).map(x=>x.id);
  const result=await call('runRegression',projectId,'devApi',{caseIds:ids,autoTriage:false,preferEnvToken:group!=='auth'});report.runs.push({group,...result.run});flush();console.log('REGRESSION',group,JSON.stringify(result.run));
 }
 const repeat=await call('runRegression',projectId,'devApi',{caseIds:report.tests.filter(x=>x.group==='business').map(x=>x.id),autoTriage:false});report.runs.push({group:'business-repeat',...repeat.run});flush();
} catch(e){report.error=String(e);flush();console.error(String(e));process.exitCode=1} finally {await b.close()}
