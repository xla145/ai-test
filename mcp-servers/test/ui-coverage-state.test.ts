import { expect, it } from 'vitest';
import { coverageIssues } from '../src/ui/coverage.js';
import type { UiStep } from '../src/ui/codegen.js';
const target = { kind: 'testid' as const, value: 'key-field' };
const source = { steps: ['查看删除按钮'], expected: ['仅剩一条时删除按钮不可用或点击后提示至少保留一条'], preconditions: ['仅保留一条 Key 输入框'] };
it('rejects visible-only assertions for disabled controls and exact key count', () => {
  const steps: UiStep[] = [{ action: 'goto', url: '/' }, { action: 'expectVisible', target, preconditionIndices: [1] }, { action: 'expectVisible', target, caseStep: 1, expectedIndices: [1] }];
  expect(coverageIssues(steps, source)).toHaveLength(2);
  steps[1] = { action: 'expectCollection', target, rule: { selector: 'input', minCount: 1, maxCount: 1 }, preconditionIndices: [1] };
  steps[2] = { action: 'expectEnabled', target, enabled: false, caseStep: 1, expectedIndices: [1] };
  expect(coverageIssues(steps, source)).toEqual([]);
  steps[2].enabled = true;
  expect(coverageIssues(steps, source).join()).toContain('禁用状态');
});
it('preserves the alternative message branch and unrelated visibility checks', () => {
  const steps: UiStep[] = [{ action: 'goto', url: '/' }, { action: 'expectCollection', target, rule: { selector: 'input', minCount: 1, maxCount: 1 }, preconditionIndices: [1] }, { action: 'expectText', target, text: '至少保留一条', caseStep: 1, expectedIndices: [1] }];
  expect(coverageIssues(steps, source)).toEqual([]);
  expect(coverageIssues([{ action: 'goto', url: '/', caseStep: 1 }, { action: 'expectVisible', target, expectedIndices: [1] }], { steps: ['打开'], expected: ['显示详情'] })).toEqual([]);
});
