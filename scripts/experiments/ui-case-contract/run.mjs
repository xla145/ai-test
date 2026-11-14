import { createServer } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { BrowserSession } from '../../../mcp-servers/dist/ui/browser.js';
import { midsceneFactory } from '../../../mcp-servers/dist/ui/midscene.js';
import { UI_SERVERS } from '../../../mcp-servers/dist/ui/tools.js';
import { writeUiScript } from '../../../mcp-servers/dist/ui/codegen.js';
import { runUiSuite } from '../../../mcp-servers/dist/ui/runner.js';
import { fixtureHtml, tasks, contractFor, manifest } from './fixture.mjs';
import { executableRequest, jsonSchema } from './contract.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const control = process.argv.includes('--control');
const mode = control ? 'control' : 'live';
const artifactDir = resolve(process.env.CONTRACT_OUTPUT_DIR || join(root, '.release/ui-case-contract', mode));
mkdirSync(artifactDir, { recursive: true });
process.env.MIDSCENE_RUN_DIR = join(artifactDir, 'midscene');
const rounds = control ? 1 : Number(process.env.CONTRACT_ROUNDS || 3);
const onlyTask = process.env.CONTRACT_TASK;
const selectedTasks = tasks.filter(t => !onlyTask || t.id === onlyTask);
const report = {
  version: 1, mode, startedAt: new Date().toISOString(), timezone: 'Asia/Taipei',
  model: control ? 'deterministic DOM center (NOT a visual model)' : process.env.MIDSCENE_MODEL_NAME,
  family: control ? null : process.env.MIDSCENE_MODEL_FAMILY,
  sdk: JSON.parse(readFileSync(join(root, 'node_modules/@midscene/web/package.json'))).version,
  fixtureSha256: createHash('sha256').update(readFileSync(join(here, 'fixture.mjs'))).digest('hex'),
  viewport: { width: 1280, height: 900 }, cache: false, rounds, observations: [], replays: [],
};
const redact = s => String(s).replaceAll(process.env.MIDSCENE_MODEL_API_KEY || '__no_key__', '[REDACTED]');
const save = () => writeFileSync(join(artifactDir, 'results.json'), JSON.stringify(report, null, 2));
writeFileSync(join(artifactDir, 'contract.schema.json'), JSON.stringify(jsonSchema, null, 2));
writeFileSync(join(artifactDir, 'fixture-contracts.json'), JSON.stringify(tasks.map(contractFor), null, 2));
if (!control && !process.env.MIDSCENE_MODEL_API_KEY) {
  report.blocked = 'MIDSCENE_MODEL_API_KEY 未注入，未运行真实模型'; save(); process.exit(2);
}
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  res.writeHead(200, { 'content-type': 'text/html;charset=utf-8', 'cache-control': 'no-store' });
  res.end(fixtureHtml(Number(url.searchParams.get('round') || 0), url.searchParams.get('task') || ''));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const baseUrl = `http://127.0.0.1:${server.address().port}`;
const workspace = join(artifactDir, 'workspace');
const generatedIds = [];

async function centerOf(page, id) {
  const b = await page.getByTestId(id).boundingBox();
  if (!b) throw new Error(`夹具目标不可见:${id}`);
  return { box: b, center: [b.x + b.width / 2, b.y + b.height / 2] };
}
function inBox([x, y], b) { return x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + b.height; }

try {
  let abort = false;
  for (let round = 0; round < rounds && !abort; round++) {
    for (const task of selectedTasks) {
      const arms = control ? ['structured'] : ((round + tasks.indexOf(task)) % 2 ? ['structured', 'brief'] : ['brief', 'structured']);
      for (const arm of arms) {
        const session = new BrowserSession({ headless: true, baseUrl });
        const record = { round: round + 1, task: task.id, arm, rawHit: false, mappedHit: false, actionCompleted: false, correctOutcome: false };
        const start = performance.now();
        try {
          const c = contractFor(task);
          const request = executableRequest(c, manifest, 's1');
          if (arm === 'brief') request.prompt = task.brief;
          record.request = request;
          const page = await session.page();
          await page.setViewportSize(report.viewport);
          await session.navigate(`/models?round=${round}&task=${task.id}`);
          await page.evaluate(() => document.fonts.ready);
          record.dpr = await page.evaluate(() => devicePixelRatio);
          record.browser = page.context().browser().version();
          const expected = await centerOf(page, task.oracle);
          record.targetBox = expected.box;
          if (task.id === 'select') record.acceptedWrapperBox = (await centerOf(page, 'fallback-wrapper')).box;
          await page.screenshot({ path: join(artifactDir, `${round + 1}-${task.id}-${arm}-before.png`) });
          let visual;
          if (!control) visual = await midsceneFactory(`contract-${round}-${task.id}-${arm}`)(page);
          const wrappedVision = async () => ({
            aiAct: async () => { throw new Error('本实验禁止 aiAct'); },
            aiAssert: async () => { throw new Error('本实验不使用视觉断言代替行为证据'); },
            aiLocate: async prompt => {
              const before = performance.now();
              const result = control ? { center: expected.center } : await visual.aiLocate(prompt);
              record.locateMs = Math.round(performance.now() - before);
              record.center = result.center;
              record.rawHit = inBox(result.center, expected.box) || Boolean(record.acceptedWrapperBox && inBox(result.center, record.acceptedWrapperBox));
              record.reportFile = visual?.reportFile;
              return result;
            },
          });
          const ctx = { session, vision: wrappedVision, engine: async () => { throw new Error('不允许访问业务引擎'); }, secrets: { resolve: async () => ({}) } };
          const locateTool = UI_SERVERS.find(x => x.name === 'browser').tools(ctx).find(x => x.name === 'ai_locate');
          let timer;
          const located = await Promise.race([
            locateTool.handler(request),
            new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('MODEL_TIMEOUT_60S')), 60_000); }),
          ]).finally(() => clearTimeout(timer));
          record.mappedTarget = { testId: located.testId, role: located.role, name: located.name, note: located.note };
          record.mappedHit = located.testId === task.oracle || (task.id === 'select' && located.testId === 'fallback-wrapper');
          // No oracle correction: perform the actual returned ref's operation on the disposable fixture.
          if (task.action === 'fill') await session.type(located.ref, task.value);
          else if (task.action === 'check') await session.check(located.ref, task.value);
          else await session.click(located.ref);
          record.actionCompleted = true;
          record.hits = await page.evaluate(() => window.hits);
          record.actual = task.kind === 'value' ? await page.getByTestId(task.result).inputValue() : await page.getByTestId(task.result).innerText();
          record.correctOutcome = record.actual === task.expected && record.hits.length > 0 && record.hits.every(id => id === task.oracle);
          if (task.action === 'check') record.checked = await page.getByTestId(task.oracle).isChecked();
          // Record independent result assertions only for correctly completed structured samples.
          if (arm === 'structured' && record.correctOutcome) {
            const resultCenter = await centerOf(page, task.result);
            const resultRef = (await session.locateAt(...resultCenter.center)).element?.ref;
            if (!resultRef) throw new Error('无法记录结果断言');
            if (task.kind === 'value') await session.expectValue(resultRef, task.expected);
            else await session.expectText(resultRef, task.expected);
            if (task.action === 'check') {
              await session.check(located.ref, true);
              if (!await page.getByTestId(task.oracle).isChecked()) throw new Error('幂等状态检查失败');
              await session.expectText(resultRef, task.expected);
            }
            const caseId = `tc_contract_${task.id}_${round + 1}`;
            const saved = writeUiScript(workspace, { caseId, title: c.title, steps: session.recording(), baseUrl });
            record.script = saved.path;
            generatedIds.push(caseId);
          }
          await page.screenshot({ path: join(artifactDir, `${round + 1}-${task.id}-${arm}-after.png`) });
        } catch (e) {
          record.error = redact(e.message).slice(0, 1600);
          if (/MODEL_TIMEOUT|401|403|insufficient|quota|model.*not.*found/i.test(record.error)) abort = true;
        } finally {
          record.elapsedMs = Math.round(performance.now() - start);
          await session.close();
          report.observations.push(record); save();
          console.log(JSON.stringify({ mode, round: round + 1, task: task.id, arm, rawHit: record.rawHit, mappedHit: record.mappedHit, correctOutcome: record.correctOutcome, locateMs: record.locateMs, error: record.error }));
        }
        if (abort) break;
      }
      if (abort) break;
    }
  }
  if (generatedIds.length) {
    const repetitions = control ? 1 : 3;
    for (let i = 0; i < repetitions; i++) {
      const out = await runUiSuite({ workspace, baseUrl, caseIds: generatedIds, workers: 1, env: { AITEST_ACTION_TIMEOUT: '3000', AITEST_TEST_TIMEOUT: '10000' } });
      report.replays.push({ repetition: i + 1, exitCode: out.exitCode, results: out.results, errors: out.errors, reportJson: out.reportJson });
      save();
      console.log(JSON.stringify({ replay: i + 1, passed: out.results.filter(r => r.status === 'passed').length, total: generatedIds.length }));
    }
  }
} catch (e) {
  report.fatal = redact(e.message);
} finally {
  server.closeAllConnections();
  await new Promise(r => server.close(r));
  report.finishedAt = new Date().toISOString();
  report.summary = Object.fromEntries(['brief', 'structured'].map(arm => {
    const rows = report.observations.filter(x => x.arm === arm);
    const latencies = rows.map(x => x.locateMs).filter(x => x != null).sort((a, b) => a - b);
    const n = latencies.length;
    return [arm, { total: rows.length, rawHit: rows.filter(x => x.rawHit).length, mappedHit: rows.filter(x => x.mappedHit).length, correctOutcome: rows.filter(x => x.correctOutcome).length, errors: rows.filter(x => x.error).length, locateMedianMs: n ? (latencies[Math.floor((n - 1) / 2)] + latencies[Math.floor(n / 2)]) / 2 : null }];
  }));
  save();
  console.log(JSON.stringify({ artifactDir, summary: report.summary, fatal: report.fatal }));
}
if (report.fatal || report.replays.some(r => r.exitCode !== 0)) process.exitCode = 1;
