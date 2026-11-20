import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { Orchestrator, type EngineCall } from "../src/main/orchestrator";
import type { TaskProgress } from "../src/shared/taskProgress";

it.skipIf(process.env.AITEST_K6_SMOKE !== "1")("streams real local k6 metrics and stops the exact queued/running task", async () => {
  const workspace = mkdtempSync(join(tmpdir(),"aiprobe-k6-live-"));
  let requests = 0;
  const server = createServer((_req,res) => { requests++; res.writeHead(200,{"content-type":"application/json"}); res.end('{"code":200,"message":"ok"}'); });
  await new Promise<void>(resolve => server.listen(0,"127.0.0.1",resolve));
  const base = `http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const engine = (async (args: string[]) => args[0] === "list-projects" ? [{ id:"local",workspace_path:workspace,environments:{test:{base_url:base}} }]
    : [{id:"health",revision:1,method:"GET",path:"/health",summary:"本地健康检查",request:{auth:false},operation:{params:[]}}]) as EngineCall;
  const orch = new Orchestrator({engine,agent:async()=>{throw new Error("no model");},secretEnv:()=>({})});
  const events: TaskProgress[] = [];
  let completed = false, metricBeforeCompletion = false;
  orch.on("task-progress", (event: TaskProgress) => { events.push(event); if(event.kind==="metric" && event.data.samples>0 && !completed) metricBeforeCompletion=true; });
  const options = {definitionId:"health",definitionRevision:1,path:"/health",auth:false,vus:1,seconds:3,p95Ms:1000,maxFailureRate:.01};
  try {
    const result = await orch.runPerformance("local","test",options); completed=true;
    expect(result.status).toBe("passed"); expect(requests).toBeGreaterThan(0); expect(metricBeforeCompletion).toBe(true);
    expect(events.some(e=>e.kind==="metric" && e.data.p95Ms!==null)).toBe(true);
    expect(orch.tasks.diagnostics.export().events.map(e=>e.stepId)).toEqual(expect.arrayContaining(["validate","generate-plan","spawn","parse-summary","write-report","complete"]));
    const stopAtMetric = (e:TaskProgress) => { if(e.kind==="metric" && e.data.samples>0) orch.stopExecutionTask(e.taskId); };
    orch.on("task-progress",stopAtMetric);
    const stopped = await orch.runPerformance("local","test",{...options,seconds:15});
    orch.off("task-progress",stopAtMetric);
    expect(stopped.status).toBe("stopped"); expect(stopped.thresholdsPassed).toBe(false); expect(orch.uiTasks()[0].status).toBe("stopped");
    expect(orch.taskProgress(orch.uiTasks()[0].id).events.at(-1)?.kind).toBe("complete");
  } finally { await new Promise<void>(resolve=>server.close(()=>resolve())); rmSync(workspace,{recursive:true,force:true}); }
}, 30000);
