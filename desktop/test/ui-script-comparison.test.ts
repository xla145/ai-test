import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { ScriptSteps } from '../src/renderer/components/ScriptSteps';
import type { UiScriptDetail } from '../src/shared/ipc';

const source = { steps: ['打开设置'], expected: ['显示当前值', '保存值一致'], preconditions: ['已登录'] };
const detail: UiScriptDetail = {
  path: 'scripts/ui/tc_a.spec.ts', code: '// generated', synced: true, source,
  steps: [
    { id:'S1', action:'goto', description:'打开设置页', caseStep:1 },
    { id:'S2', action:'expectVisible', description:'确认账号入口', preconditionIndices:[1], role:'管理员' },
    { id:'S3', action:'expectObserved', description:'比较字段与 3', expectedIndices:[2] },
  ],
};
it('compares all expectations independently of step count, with explicit unmapped and role labels', () => {
  const html = renderToStaticMarkup(createElement(ScriptSteps, {caseSteps:source.steps, expected:source.expected, preconditions:source.preconditions, detail, states:{}}));
  expect(html).toContain('保存值一致');
  expect(html).toContain('没有能证明此项的关联断言');
  expect(html).toContain('管理员');
  expect(html).toContain('比较字段与 3');
  expect(html).toContain('不等于验证正确或执行通过');
  expect(html).not.toContain('用例已变化');
});
it('warns when current case contents differ from the recorded source', () => {
  const html = renderToStaticMarkup(createElement(ScriptSteps, {caseSteps:source.steps, expected:['新预期'], preconditions:source.preconditions, detail, states:{}}));
  expect(html).toContain('用例已变化');
});
it('removes duplicated document numbering in display without changing decimals or source data', () => {
  const steps = ['【1】 1. 打开设置', '1.5 倍比例'];
  const expected = ['【1】 1. 显示配置'];
  const html = renderToStaticMarkup(createElement(ScriptSteps, {caseSteps:steps, expected, detail:{...detail,source:{steps,expected,preconditions:[]}}, states:{}}));
  expect(html).not.toContain('【1】');
  expect(html).not.toContain('1. 打开设置');
  expect(html).toContain('1.5 倍比例');
  expect(steps[0]).toBe('【1】 1. 打开设置');
});
