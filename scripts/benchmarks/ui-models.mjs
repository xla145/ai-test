#!/usr/bin/env node
/** Read-only visual localization benchmark. Usage: node scripts/benchmarks/ui-models.mjs config.json */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chromium } from 'playwright-core';
import { chooseBrowser } from '../../mcp-servers/dist/ui/chromium.js';
import { midsceneFactory } from '../../mcp-servers/dist/ui/midscene.js';
import { uiReason } from '../../mcp-servers/dist/ui/diagnostics.js';
const [file, child] = process.argv.slice(2);
if (!file) throw new Error('请提供评测配置文件，参考 ui-models.example.json');
const cfg = JSON.parse(readFileSync(resolve(file), 'utf8'));
if (!Array.isArray(cfg.models) || !cfg.models.length || !Array.isArray(cfg.samples) || !cfg.samples.length) throw new Error('需要 models 和 samples');
const repeats = cfg.repeats ?? 5;
if (!Number.isInteger(repeats) || repeats < 5 || repeats > 20) throw new Error('重复次数应为 5–20');
const out = resolve(cfg.output ?? 'reports/model-benchmark'); mkdirSync(out, { recursive: true });
// Model SDK configuration is process-scoped. Isolate models to prevent cached clients/config mixing.
if (child === undefined) {
  for (let i = 0; i < cfg.models.length; i++) {
    const model = cfg.models[i];
    if (!process.env[model.keyEnv]) throw new Error(`缺少模型密钥环境变量：${model.keyEnv}`);
    const result = spawnSync(process.execPath, [process.argv[1], resolve(file), String(i)], {
      stdio: 'inherit', env: { ...process.env, MIDSCENE_MODEL_NAME: model.name, MIDSCENE_MODEL_FAMILY: model.family,
        MIDSCENE_MODEL_BASE_URL: model.baseUrl, MIDSCENE_MODEL_API_KEY: process.env[model.keyEnv], MIDSCENE_RUN_DIR: join(out, `model-${i}`) },
    });
    if (result.status !== 0) throw new Error(`模型 ${model.name} 评测进程未完整完成；保留原始失败记录`);
  }
  const results = cfg.models.map((_, i) => JSON.parse(readFileSync(join(out, `model-${i}.json`), 'utf8')));
  writeFileSync(join(out, 'comparison.json'), JSON.stringify(results, null, 2));
  console.log(`评测完成：${join(out, 'comparison.json')}`);
} else {
  const index = Number(child), model = cfg.models[index];
  const browser = await chromium.launch({ executablePath: chooseBrowser().executablePath });
  const rows = [];
  try {
    for (let iteration = 0; iteration < repeats; iteration++) for (const sample of cfg.samples) {
      const context = await browser.newContext({ viewport: cfg.viewport ?? {width:1280,height:900}, ...(cfg.storageState ? {storageState:resolve(cfg.storageState)} : {}) });
      const page = await context.newPage(); const started = Date.now();
      const row = { sample: sample.id, iteration:iteration+1, status:'error', correct:false, durationMs:0 };
      try {
        await page.goto(sample.url, {waitUntil:'domcontentloaded'});
        const target = page.locator(sample.selector);
        if (await target.count() !== 1) throw new Error('TARGET_AMBIGUOUS: fixture must have one ground-truth target');
        await target.scrollIntoViewIfNeeded();
        const box = await target.boundingBox();
        if (!box) throw new Error('TARGET_MISSING: ground truth not visible');
        const agent = await midsceneFactory(`benchmark-${index}-${iteration}-${sample.id}`)(page);
        const located = await agent.aiLocate(sample.prompt);
        const [x,y] = located.center;
        row.correct = x >= box.x && x <= box.x+box.width && y >= box.y && y <= box.y+box.height;
        row.status = row.correct ? 'passed' : 'wrong_target';
        row.report = agent.reportFile;
      } catch (error) { row.reason = uiReason(String(error.message)); }
      finally {
        row.durationMs = Date.now()-started; rows.push(row);
        await page.screenshot({path:join(out, `model-${index}-${rows.length}.png`)}).catch(()=>{});
        await context.close();
        writeFileSync(join(out, `model-${index}.partial.json`), JSON.stringify(rows,null,2));
      }
    }
  } finally { await browser.close(); }
  const total = rows.length, correct = rows.filter(r=>r.correct).length;
  writeFileSync(join(out, `model-${index}.json`), JSON.stringify({
    model:{name:model.name,family:model.family}, sampleHash:createHash('sha256').update(JSON.stringify(cfg.samples)).digest('hex'),
    viewport:cfg.viewport ?? {width:1280,height:900}, repeats,total,correct,accuracy:correct/total,
    errors:rows.filter(r=>r.status==='error').length, meanDurationMs:rows.reduce((n,r)=>n+r.durationMs,0)/total, rows,
    scope:'read-only localization; does not certify business assertions or replay reliability',
  },null,2));
}
