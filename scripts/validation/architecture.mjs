/** Local-only acceptance: launches the real Electron app against an isolated database and loopback HTTP target. */
import { _electron } from "playwright-core";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, delimiter } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import assert from "node:assert/strict";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(join(root,"package.json"));
const temporary = mkdtempSync(join(tmpdir(),"aiprobe-acceptance-"));
const output = process.env.AITEST_VALIDATION_OUTPUT || join(temporary,"screenshots");
mkdirSync(output,{recursive:true});
const workspace = join(temporary,"workspace"); mkdirSync(workspace);
const db = join(temporary,"test.db");
let requests = 0, app, page;
const target = createServer((_request,response)=>{requests++;response.writeHead(200,{"content-type":"application/json"});response.end('{"code":200,"message":"ok"}');});
await new Promise(resolve=>target.listen(0,"127.0.0.1",resolve));
const url = `http://127.0.0.1:${target.address().port}`;
const probe = createTcpServer(); await new Promise(resolve=>probe.listen(0,"127.0.0.1",resolve));const cdpPort = probe.address().port;await new Promise(resolve=>probe.close(resolve));
const python = process.env.AITEST_PYTHON || "python3";
const pythonEnv = { ...process.env, PYTHONPATH:[join(root,"engine"),join(root,".release/engine-deps")].join(delimiter) };
const init = JSON.parse(execFileSync(python,["-m","aitest","--db",db,"init-project","--name","本地架构验收","--workspace",workspace,"--environments",JSON.stringify({test:{base_url:url}})],{env:pythonEnv,encoding:"utf8"}).trim().split("\n").at(-1));
assert.equal(init.ok,true); const projectId = init.data.id;
const openapi = join(temporary,"openapi.json");
writeFileSync(openapi,JSON.stringify({openapi:"3.0.3",info:{title:"Local verification",version:"1"},paths:{"/health":{get:{summary:"本地健康检查",responses:{"200":{description:"OK"}}}}}}));
const bootstrap = join(temporary,"bootstrap.cjs");
writeFileSync(bootstrap,`const {app}=require('electron');app.setPath('appData',${JSON.stringify(temporary)});import(${JSON.stringify(pathToFileURL(join(root,"desktop/dist/main/index.js")).href)});`);
const { DEFAULT_SETTINGS } = await import(pathToFileURL(join(root,"desktop/dist/main/settings.js")));
mkdirSync(join(temporary,"aitest-desktop"));
writeFileSync(join(temporary,"aitest-desktop/settings.json"),JSON.stringify({...DEFAULT_SETTINGS,general:{...DEFAULT_SETTINGS.general,autoUpdate:false,theme:"system"}}));
const env = {...process.env,AITEST_DB:db,AITEST_PYTHON:python,AITEST_CDP_PORT:String(cdpPort),AITEST_DEV_SERVER:"",AITEST_UPDATE_URL:""};
delete env.ELECTRON_RUN_AS_NODE;
try {
  app = await _electron.launch({ executablePath:require("electron"), args:[bootstrap],cwd:root,env,timeout:30000 });
  page = await app.firstWindow();
  const waitForTask = async predicate => {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const snapshot = await page.evaluate(() => window.aitest.taskSnapshot());
      if (predicate(snapshot.tasks)) return snapshot;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error("Task state did not reach the expected terminal/running condition");
  };
  const pageErrors = []; page.on("pageerror",error=>pageErrors.push(error.message));
  await page.getByText("本地架构验收",{exact:true}).first().waitFor({timeout:30000});
  const safety = await app.evaluate(({BrowserWindow})=>{const p=BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();return {sandbox:p.sandbox,contextIsolation:p.contextIsolation};});
  assert.deepEqual(safety,{sandbox:true,contextIsolation:true});
  await page.evaluate(async ({projectId,openapi})=>{const preview=await window.aitest.previewApiImport(projectId,openapi);await window.aitest.importApiDefinitions(projectId,preview);},{projectId,openapi});
  await page.getByRole("menuitem").filter({hasText:"性能测试"}).click();
  await page.getByText("请求参数与鉴权",{exact:true}).click();
  await page.getByText("不鉴权",{exact:true}).click();
  await page.locator("#perf-vus").fill("1");await page.locator("#perf-seconds").fill("3");
  await page.getByRole("button",{name:"开始测试",exact:true}).click();
  await page.getByText("执行进度",{exact:true}).waitFor();
  await page.waitForFunction(()=>document.querySelectorAll('[aria-label="窗口 P95（ms）"] circle').length>0,{},{timeout:15000});
  await page.screenshot({animations:"disabled",path:join(output,"live-light.png")});
  await waitForTask(tasks => tasks.some(t=>t.source==="performance"&&t.status==="completed"));
  const tasks = await page.evaluate(()=>window.aitest.taskSnapshot());
  const completed = tasks.tasks.find(t=>t.source==="performance");
  const progress = await page.evaluate(id=>window.aitest.taskProgress(id),completed.id);
  assert(progress.events.some(e=>e.kind==="metric"&&e.data.samples>0));assert(requests>0);
  await page.emulateMedia({colorScheme:"dark"});await page.waitForFunction(()=>document.documentElement.dataset.theme==="dark");
  await page.screenshot({animations:"disabled",path:join(output,"live-dark.png")});
  const settings = await page.evaluate(()=>window.aitest.getGlobalSettings());
  await page.evaluate(async value=>{value.settings.general.theme="light"; const saved=await window.aitest.saveGlobalSettings(value.settings); window.dispatchEvent(new CustomEvent("aitest:settings",{detail:saved}));},settings);
  await page.waitForFunction(()=>document.documentElement.dataset.theme==="light");
  // Test persisted explicit preference via an actual renderer reload, without depending on event spelling.
  await page.reload();await page.getByText("本地架构验收",{exact:true}).first().waitFor();await page.waitForFunction(()=>document.documentElement.dataset.theme==="light");
  await page.getByRole("menuitem").filter({hasText:"性能测试"}).click();
  await page.getByText("请求参数与鉴权",{exact:true}).click();
  await page.getByText("不鉴权",{exact:true}).click();
  await page.locator("#perf-vus").fill("1");await page.locator("#perf-seconds").fill("30");
  await page.getByRole("button",{name:"开始测试",exact:true}).click();
  await waitForTask(tasks => tasks[0]?.source==="performance" && tasks[0]?.status==="running");
  await page.getByRole("menuitem").filter({hasText:"概览"}).click();
  await page.getByText(/个后台任务（含排队）/).waitFor();
  await page.getByRole("menuitem").filter({hasText:"性能测试"}).click();
  await page.getByRole("button",{name:"停止当前任务",exact:true}).first().click({timeout:5000});
  await waitForTask(tasks => tasks[0]?.status==="stopped");
  // Real API execution: reviewed deterministic script -> pytest -> Node -> sandbox IPC -> React table.
  const saved = await page.evaluate(async projectId => {
    const row = await window.aitest.saveApiCase(projectId,{title:"本地健康检查-状态校验",kind:"single",steps:[{method:"GET",path:"/health",auth:false,expected_status:[200],assertions:[{path:"code",operator:"eq",value:200}]}]});
    await window.aitest.updateCase(row.id,{status:"reviewed"});
    return row;
  }, projectId);
  await page.getByRole("menuitem").filter({hasText:"接口回归"}).click();
  await page.getByRole("combobox",{name:"批量执行调用身份"}).click();
  await page.getByText("按用例角色 / 鉴权设置",{exact:true}).click();
  await page.getByRole("switch",{name:"未知失败使用 AI 分析"}).uncheck();
  await page.getByRole("button",{name:/全量回归/}).click();
  const apiSnapshot = await waitForTask(tasks=>tasks.some(t=>t.source==="api"&&t.status==="completed"));
  const apiTask = apiSnapshot.tasks.find(t=>t.source==="api");
  const apiProgress = await page.evaluate(id=>window.aitest.taskProgress(id),apiTask.id);
  assert(apiProgress.events.some(event=>event.kind==="case"&&event.data.caseId===saved.id&&event.data.status==="passed"));
  await page.getByRole("columnheader",{name:"耗时（秒）"}).waitFor();
  await page.screenshot({animations:"disabled",path:join(output,"api-progress.png")});
  // Replace only the native save dialog in this isolated process, not production application behavior.
  const diagnosticFile = join(temporary,"diagnostics.json");
  await app.evaluate(({dialog},file)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:file});},diagnosticFile);
  await page.getByRole("button",{name:"导出诊断",exact:true}).click();
  await page.evaluate(()=>window.aitest.exportDiagnostics());
  const diagnostics = JSON.parse(readFileSync(diagnosticFile,"utf8"));assert(diagnostics.events.length>0);
  await page.setViewportSize({width:900,height:720});await page.screenshot({animations:"disabled",path:join(output,"live-narrow.png")});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),false);
  assert.deepEqual(pageErrors,[]);
  console.log(JSON.stringify({ok:true,sandbox:safety,requests,progressEvents:progress.events.length,diagnostics:diagnostics.events.length,apiCaseEvents:apiProgress.events.filter(event=>event.kind==="case").length,screenshots:output},null,2));
} catch (error) {
  if(page) { await page.screenshot({animations:"disabled",path:join(output,"failure.png")}).catch(()=>{}); console.error(await page.locator("body").innerText().catch(()=>"")); console.error(await page.evaluate(()=>window.aitest.taskSnapshot()).catch(()=>null)); }
  throw error;
} finally {
  if(page) await page.evaluate(async()=>{ for (const task of (await window.aitest.taskSnapshot()).tasks) if (["queued","running","stopping"].includes(task.status)) await window.aitest.stopExecutionTask(task.id); }).catch(()=>{});
  if(app)await app.close();await new Promise(resolve=>target.close(resolve));
  if(process.env.AITEST_VALIDATION_OUTPUT)rmSync(temporary,{recursive:true,force:true});
  else console.log(`Isolated validation files retained at ${temporary}`);
}
