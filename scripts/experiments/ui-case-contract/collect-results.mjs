import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

const output = resolve(process.argv[2] || 'docs/evidence/ui-case-contract/2026-11-14');
mkdirSync(output, { recursive: true });
const groups = ['control', 'live', 'qwen3-vl', 'flow-control', 'flow'];
const summaries = {};
for (const group of groups) {
  const dir = resolve('.release/ui-case-contract', group);
  const source = join(dir, 'results.json');
  if (!existsSync(source)) continue;
  const r = JSON.parse(readFileSync(source, 'utf8'));
  if (!r.finishedAt) throw new Error(`${group} 尚未结束，不能收集为最终证据`);
  copyFileSync(source, join(output, `${group}-results.json`));
  if (r.mode.startsWith('sequential')) {
    summaries[group] = { mode: r.mode, model: r.model, family: r.family, completed: r.observations.length, correct: r.observations.filter(x => x.correct).length, error: r.error ?? null };
  } else {
    summaries[group] = {
      mode: r.mode, model: r.model, family: r.family, sdk: r.sdk,
      summary: Object.fromEntries(Object.entries(r.summary).map(([arm, summary]) => [arm, {
        ...summary,
        wrongAction: r.observations.filter(x => x.arm === arm && x.actionCompleted && !x.correctOutcome).length,
        correctedHit: r.observations.filter(x => x.arm === arm && !x.rawHit && x.mappedHit).length,
      }])),
      perTask: Object.fromEntries([...new Set(r.observations.map(x => x.task))].map(task => [task,
        Object.fromEntries(['brief', 'structured'].map(arm => {
          const xs = r.observations.filter(x => x.task === task && x.arm === arm);
          return [arm, { total: xs.length, raw: xs.filter(x => x.rawHit).length, correct: xs.filter(x => x.correctOutcome).length }];
        })),
      ])),
    };
  }
  summaries[group].replay = {
    rounds: r.replays.length,
    total: r.replays.flatMap(x => x.results).length,
    passed: r.replays.flatMap(x => x.results).filter(x => x.status === 'passed').length,
    errors: r.replays.flatMap(x => x.errors),
  };
}
writeFileSync(join(output, 'summary.json'), JSON.stringify(summaries, null, 2));
console.log(JSON.stringify(summaries, null, 2));
