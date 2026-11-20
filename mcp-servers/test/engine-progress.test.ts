import { afterEach, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runEngine } from "../src/engine.js";
import { EngineProgressParser, type EngineProgress } from "../src/engineProgress.js";
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));
function fixture(source: string) { const dir = mkdtempSync(join(tmpdir(), "aiprobe-stream-")); dirs.push(dir); writeFileSync(join(dir,"aitest.py"),source); return dir; }
it("parses split lines and drops extra fields and oversized noise", () => {
  const events: EngineProgress[] = [], parser = new EngineProgressParser(event => events.push(event));
  parser.feed("noise\n" + "x".repeat(70000)); parser.feed("\nAITEST_PROG"); parser.feed('RESS:{"kind":"case","data":{"caseId":"c","status":"passed","duration":1,"password":"secret"}}\n');
  expect(events).toEqual([{ kind:"case",data:{caseId:"c",status:"passed",duration:1} }]);
});
it("delivers progress before the engine final response", async () => {
  const dir = fixture('import sys,time,json\nsys.stderr.write(\'AITEST_PROGRESS:{"kind":"case","data":{"caseId":"one","status":"passed","duration":0.1}}\\n\'); sys.stderr.flush()\ntime.sleep(.15)\nprint(json.dumps({"ok":True,"data":{"total":1}}))\n');
  let done = false; const events: EngineProgress[] = [];
  const result = await runEngine([], { env: { PYTHONPATH:dir }, onProgress: e => { expect(done).toBe(false); events.push(e); } }); done = true;
  expect(result).toEqual({ total:1 }); expect(events).toHaveLength(1);
});
it.skipIf(process.platform === "win32")("cancels the process group, including a detached-output pytest child", async () => {
  const dir = fixture('import subprocess,sys,time,json,os\nsubprocess.Popen([sys.executable,"-c", "import time,pathlib; time.sleep(1); pathlib.Path(\\\""+os.environ["MARKER"]+"\\\").write_text(\\\"alive\\\")"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)\nsys.stderr.write(\'AITEST_PROGRESS:{"kind":"case","data":{"caseId":"ready","status":"passed","duration":0}}\\n\'); sys.stderr.flush()\ntime.sleep(10)\n');
  // Keep the child script straightforward and avoid quoting it through a shell.
  const marker = join(dir,"child-survived");
  writeFileSync(join(dir,"aitest.py"), `import subprocess,sys,time,os\nsubprocess.Popen([sys.executable,"-c", "import time,pathlib; time.sleep(1); pathlib.Path("+repr(os.environ["MARKER"])+").write_text('alive')"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)\nsys.stderr.write('AITEST_PROGRESS:{"kind":"case","data":{"caseId":"ready","status":"passed","duration":0}}\\n'); sys.stderr.flush()\ntime.sleep(10)\n`);
  const controller = new AbortController();
  await expect(runEngine([], { env:{PYTHONPATH:dir,MARKER:marker}, signal:controller.signal, onProgress:()=>controller.abort() })).rejects.toThrow("取消");
  await new Promise(resolve=>setTimeout(resolve,1300)); expect(existsSync(marker)).toBe(false);
});
