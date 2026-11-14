import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { BrowserSession } from '../../../mcp-servers/dist/ui/browser.js';
import { fixtureHtml } from './fixture.mjs';

// Adversarial result test: expected text in a different field must not satisfy
// an assertion about the fallback field. This does not call a visual model.
const output = resolve('.release/ui-case-contract/assertion-probe');
mkdirSync(output, { recursive: true });
const steps = JSON.parse(readFileSync('.release/ui-case-contract/flow-control/workspace/scripts/ui/tc_contract_flow.steps.json', 'utf8')).steps;
const original = steps.find(s => s.action === 'expectText' && s.exact && s.text === '阿里云源');
if (!original) throw new Error('先运行连续流程控制实验');
const scoped = { ...original, target: { kind: 'css', value: '.el-select__selection', within: { css: '[role="region"]', hasText: '故障切换配置' } } };
const session = new BrowserSession({ headless: true });
const report = { date: '2026-11-14', mode: 'adversarial-assertion-control', original, proposedScopedAssertion: scoped };
try {
  const page = await session.page();
  await page.setContent(fixtureHtml(0, 'flow').replace(/(<input data-testid="(?:fallback|normal)-select"[^>]*><span class="el-select__selected-item">[^<]*<\/span>)/g, '<div class="el-select__selection">$1</div>'));
  const setValues = async (fallback, normal) => page.evaluate(({ fallback, normal }) => {
    document.querySelector('[data-testid="fallback-wrapper"] .el-select__selected-item').textContent = fallback;
    document.querySelector('[data-testid="normal-wrapper"] .el-select__selected-item').textContent = normal;
  }, { fallback, normal });
  await setValues('阿里云源', '不设置');
  await session.runStep(original, { timeoutMs: 200 });
  await session.runStep(scoped, { timeoutMs: 200 });
  report.positiveControl = 'both passed';
  await setValues('错误渠道', '阿里云源');
  report.actualFallbackValue = '错误渠道';
  report.otherFieldValue = '阿里云源';
  try { await session.runStep(original, { timeoutMs: 200 }); report.originalRejectsWrongField = false; }
  catch { report.originalRejectsWrongField = true; }
  try { await session.runStep(scoped, { timeoutMs: 200 }); report.scopedRejectsWrongField = false; }
  catch { report.scopedRejectsWrongField = true; }
  await page.screenshot({ path: join(output, 'wrong-field.png') });
} finally {
  await session.close();
  writeFileSync(join(output, 'results.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
// Exit nonzero only if the proposed scoped alternative also fails to reject it.
if (!report.scopedRejectsWrongField) process.exitCode = 1;
