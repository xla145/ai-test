import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { BrowserSession } from '../../../mcp-servers/dist/ui/browser.js';
import { midsceneFactory } from '../../../mcp-servers/dist/ui/midscene.js';
import { UI_SERVERS } from '../../../mcp-servers/dist/ui/tools.js';
import { writeUiScript } from '../../../mcp-servers/dist/ui/codegen.js';
import { runUiSuite } from '../../../mcp-servers/dist/ui/runner.js';
import { tasks, fixtureHtml, manifest, contractFor } from './fixture.mjs';
import { executableRequest, validateContract } from './contract.mjs';

// Separate sequential smoke test: preserve state between actions, unlike A/B trials.
const ordered = ['search', 'edit', 'switch', 'select', 'option', 'save'].map(id => tasks.find(t => t.id === id));
const control = process.argv.includes('--control');
const contracts = ordered.map(contractFor);
const contract = {
  ...contracts[0], id: 'tc_contract_flow', title: '本地夹具-模型与故障切换配置操作流程',
  source: { caseId: 'fixture-config-flow', stepIndexes: ordered.map((_, i) => i + 1), expectedIds: contracts.flatMap(c => c.source.expectedIds) },
  targets: Object.fromEntries(contracts.flatMap((c, i) => [[`target${i}`, c.targets.target], [`result${i}`, c.targets.result]])),
  steps: contracts.map((c, i) => ({ ...c.steps[0], id: `s${i + 1}`, sourceStep: i + 1, target: `target${i}`, assertions: c.steps[0].assertions.map(a => ({ ...a, target: `result${i}` })) })),
  coverage: contracts.map((c, i) => ({ expectedId: c.source.expectedIds[0], stepIds: [`s${i + 1}`] })),
};
const output = resolve(process.env.CONTRACT_OUTPUT_DIR || `.release/ui-case-contract/${control ? 'flow-control' : 'flow'}`);
mkdirSync(output, { recursive: true });
process.env.MIDSCENE_RUN_DIR = join(output, 'midscene');
const nativeTarget = process.env.CONTRACT_NATIVE_TARGET === '1';
const report = { startedAt: new Date().toISOString(), mode: control ? 'sequential-control' : 'sequential-live', targetMode: nativeTarget ? 'production-structured-target' : 'compiled-prompt', model: control ? 'deterministic DOM center (NOT a visual model)' : process.env.MIDSCENE_MODEL_NAME, family: control ? null : process.env.MIDSCENE_MODEL_FAMILY, fixtureVariant: 'base fixture plus el-select__selection container for selected-value assertion', observations: [], replays: [], validation: validateContract(contract, manifest) };
const save = () => writeFileSync(join(output, 'results.json'), JSON.stringify(report, null, 2));
writeFileSync(join(output, 'flow-contract.json'), JSON.stringify(contract, null, 2));
if (!report.validation.ready || (!control && !process.env.MIDSCENE_MODEL_API_KEY)) throw new Error('流程或模型尚未就绪');
const server = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html;charset=utf-8', 'cache-control': 'no-store' });
  // The sequential test additionally exercises selected-value adaptation. Match
  // that adapter's documented Element Plus selection container in this fixture.
  res.end(fixtureHtml(0, 'flow').replace(/(<input data-testid="(?:fallback|normal)-select"[^>]*><span class="el-select__selected-item">[^<]*<\/span>)/g,
    '<div class="el-select__selection">$1</div>'));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const baseUrl = `http://127.0.0.1:${server.address().port}`;
const session = new BrowserSession({ headless: true, baseUrl });
try {
  const page = await session.page();
  await page.setViewportSize({ width: 1280, height: 900 });
  await session.navigate('/models');
  await page.evaluate(() => document.fonts.ready);
  let currentTask;
  const vision = control ? async () => ({ aiLocate: async () => {
    const b = await page.getByTestId(currentTask.oracle).boundingBox();
    return { center: [b.x + b.width / 2, b.y + b.height / 2] };
  } }) : midsceneFactory('contract-sequential');
  const tool = UI_SERVERS.find(x => x.name === 'browser').tools({ session, vision, engine: async () => { throw new Error('不访问业务引擎'); }, secrets: { resolve: async () => ({}) } }).find(x => x.name === 'ai_locate');
  for (let i = 0; i < ordered.length; i++) {
    const task = ordered[i];
    currentTask = task;
    const step = contract.steps[i];
    session.currentCaseStep = i + 1;
    const compiled = executableRequest(contract, manifest, step.id);
    const request = nativeTarget ? { target: contract.targets[step.target], intent: compiled.intent } : compiled;
    const previousHits = await page.evaluate(() => window.hits.length);
    const start = performance.now();
    const located = await tool.handler(request);
    if (task.action === 'fill') await session.type(located.ref, task.value);
    else if (task.action === 'check') await session.check(located.ref, task.value);
    else await session.click(located.ref);
    const hits = (await page.evaluate(() => window.hits)).slice(previousHits);
    const actual = task.kind === 'value' ? await page.getByTestId(task.result).inputValue() : await page.getByTestId(task.result).innerText();
    const correct = actual === task.expected && hits.length > 0 && hits.every(h => h === task.oracle);
    const record = { step: step.id, task: task.id, request, elapsedMs: Math.round(performance.now() - start), actual, hits, correct };
    report.observations.push(record); save();
    console.log(JSON.stringify(record));
    if (!correct) throw new Error(`步骤 ${step.id} 结果不符，停止后续步骤`);
    const box = await page.getByTestId(task.result).boundingBox();
    const resultRef = (await session.locateAt(box.x + box.width / 2, box.y + box.height / 2)).element.ref;
    if (task.kind === 'value') await session.expectValue(resultRef, task.expected);
    else await session.expectText(resultRef, task.expected);
    if (task.id === 'option') {
      const selectBox = await page.getByTestId('fallback-select').boundingBox();
      const selectRef = (await session.locateAt(selectBox.x + selectBox.width / 2, selectBox.y + selectBox.height / 2)).element.ref;
      await session.expectValue(selectRef, '阿里云源');
      record.componentSelectedValueVerified = true;
    }
    await page.screenshot({ path: join(output, `${step.id}-${task.id}.png`) });
  }
  const workspace = join(output, 'workspace');
  report.script = writeUiScript(workspace, { caseId: contract.id, title: contract.title, steps: session.recording(), baseUrl });
  // Closing the exploration browser ensures replay cannot reuse transient refs/state.
  await session.close();
  for (let i = 0; i < 3; i++) {
    const out = await runUiSuite({ workspace, baseUrl, caseIds: [contract.id], workers: 1, env: { AITEST_ACTION_TIMEOUT: '3000', AITEST_TEST_TIMEOUT: '15000' } });
    report.replays.push({ repetition: i + 1, exitCode: out.exitCode, results: out.results, errors: out.errors, reportJson: out.reportJson }); save();
    console.log(JSON.stringify({ replay: i + 1, status: out.results[0]?.status }));
  }
} catch (e) {
  report.error = String(e.message).replaceAll(process.env.MIDSCENE_MODEL_API_KEY || '__no_key__', '[REDACTED]');
} finally {
  await session.close();
  server.closeAllConnections();
  await new Promise(r => server.close(r));
  report.finishedAt = new Date().toISOString(); save();
}
if (report.error || report.replays.some(x => x.exitCode !== 0)) process.exitCode = 1;
