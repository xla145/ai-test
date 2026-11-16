// Same fixture and six actions as run-flow.mjs; no model, credentials or Electron.
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { BrowserSession } from '../../../mcp-servers/dist/ui/browser.js';
import { UI_SERVERS } from '../../../mcp-servers/dist/ui/tools.js';
import { tasks, fixtureHtml, contractFor, manifest } from './fixture.mjs';
import { executableRequest } from './contract.mjs';

const output = resolve(process.argv[2] || 'docs/evidence/ui-accuracy-2026-11-15/timing-followup');
mkdirSync(output); // Refuse to overwrite earlier measurements.
const localTime = () => new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Taipei' }) + ' CST (UTC+8)';
const report = { caseId: 'tc_contract_flow', startedAt: localTime(), requestedSamples: 3,
  environment: { electron: false, model: 'none', visionMock: 'deterministic DOM center',
    viewport: { width: 1280, height: 900 }, dpr: null, browser: null }, samples: [] };
const save = () => writeFileSync(join(output, 'results.json'), JSON.stringify(report, null, 2));
const ordered = ['search', 'edit', 'switch', 'select', 'option', 'save'].map(id => tasks.find(t => t.id === id));
const html = fixtureHtml(0, 'flow').replace(/(<input data-testid="(?:fallback|normal)-select"[^>]*><span class="el-select__selected-item">[^<]*<\/span>)/g,
  '<div class="el-select__selection">$1</div>');
const server = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html;charset=utf-8', 'cache-control': 'no-store' });
  res.end(html);
});
let session;
let stage = 'fixture-listen';
try {
  // Setup errors remain errors, never timeouts or successful samples.
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  stage = 'browser-start';
  session = new BrowserSession({ headless: true, baseUrl: `http://127.0.0.1:${server.address().port}` });
  const launchStart = performance.now();
  const page = await session.page();
  report.browserStartMs = performance.now() - launchStart;
  await page.setViewportSize(report.environment.viewport);
  report.environment.browser = page.context().browser().version();
  report.environment.dpr = await page.evaluate(() => devicePixelRatio);
  let currentTask;
  const vision = async () => ({ aiLocate: async () => {
    const box = await page.getByTestId(currentTask.oracle).boundingBox();
    if (!box) throw new Error('Fixture oracle is not visible');
    return { center: [box.x + box.width / 2, box.y + box.height / 2] };
  } });
  const tool = UI_SERVERS.find(s => s.name === 'browser').tools({ session, vision,
    engine: async () => { throw new Error('Business access prohibited'); },
    secrets: { resolve: async () => { throw new Error('Credentials prohibited'); } },
  }).find(t => t.name === 'ai_locate');
  for (let repetition = 1; repetition <= report.requestedSamples; repetition++) {
    const sample = { repetition, startedAt: localTime(), preparationMs: null, locateMs: 0, actionMs: 0, verificationMs: 0, steps: [], status: 'running' };
    report.samples.push(sample);
    try {
      stage = 'preparation';
      session.resetRecording();
      const prepStart = performance.now();
      await session.navigate('/models');
      await page.evaluate(() => document.fonts.ready);
      // Initial-state checks belong to preparation, not target location.
      if (await page.getByTestId('platform-search').inputValue() !== ''
        || await page.getByTestId('fallback-check').isChecked()
        || await page.evaluate(() => window.hits.length) !== 0) throw new Error('Fixture initial state mismatch');
      sample.preparationMs = performance.now() - prepStart;
      for (const task of ordered) {
        currentTask = task;
        const request = executableRequest(contractFor(task), manifest, 's1');
        const priorHits = await page.evaluate(() => window.hits.length);
        stage = `locate:${task.id}`;
        const startLocate = performance.now();
        const located = await tool.handler(request);
        const locateMs = performance.now() - startLocate;
        stage = `action:${task.id}`;
        const startAction = performance.now();
        if (task.action === 'fill') await session.type(located.ref, task.value);
        else if (task.action === 'check') await session.check(located.ref, task.value);
        else await session.click(located.ref);
        const actionMs = performance.now() - startAction;
        stage = `verification:${task.id}`;
        const startCheck = performance.now();
        const hits = (await page.evaluate(() => window.hits)).slice(priorHits);
        const actual = task.kind === 'value' ? await page.getByTestId(task.result).inputValue() : await page.getByTestId(task.result).innerText();
        if (actual !== task.expected || !hits.length || !hits.every(h => h === task.oracle)) throw new Error(`Wrong outcome: ${task.id}`);
        const verificationMs = performance.now() - startCheck;
        sample.steps.push({ task: task.id, locateMs, actionMs, verificationMs, correct: true });
        sample.locateMs += locateMs;
        sample.actionMs += actionMs;
        sample.verificationMs += verificationMs;
      }
      sample.status = 'passed';
    } catch (error) {
      sample.status = 'failed'; sample.failureStage = stage; sample.error = error.message;
      throw error; // Do not time later actions in an incorrect state.
    } finally { save(); }
  }
} catch (error) {
  report.blocked = { stage, code: error.code, message: error.message };
  process.exitCode = 1;
} finally {
  await session?.close();
  server.closeAllConnections();
  if (server.listening) await new Promise(resolve => server.close(resolve));
  report.finishedAt = localTime(); save();
  console.log(JSON.stringify(report, null, 2));
}
