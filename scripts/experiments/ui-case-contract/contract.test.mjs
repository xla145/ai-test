import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Contract, validateContract, executableRequest, jsonSchema } from './contract.mjs';
import { tasks, contractFor, manifest } from './fixture.mjs';

test('all six concrete fixture contracts are ready and compile to supported tool inputs', () => {
  for (const t of tasks) {
    const c = contractFor(t);
    assert.deepEqual(validateContract(c, manifest), { ready: true, issues: [] });
    const req = executableRequest(c, manifest, 's1');
    assert.deepEqual(Object.keys(req).sort(), ['intent', 'prompt', ...(t.target.text || t.target.placeholder ? ['text'] : [])].sort());
    assert.ok(req.prompt.includes(t.target.scope[0].name));
    assert.equal(req.intent, t.action);
  }
  assert.equal(jsonSchema.type, 'object');
});

const negatives = [
  ['unknown target', c => c.steps[0].target = 'missing'],
  ['action type mismatch', c => c.steps[0].action = 'check'],
  ['missing fill value', c => delete c.steps[0].value],
  ['missing assertion', c => c.steps[0].assertions = []],
  ['unknown assertion target', c => c.steps[0].assertions[0].target = 'missing'],
  ['expected type mismatch', c => c.steps[0].assertions[0].expected = true],
  ['missing coverage', c => c.coverage = []],
  ['extra source expected not covered', c => c.source.expectedIds.push('e2')],
  ['coverage points to nonexistent step', c => c.coverage[0].stepIds = ['s2']],
  ['unknown source expectation', c => c.steps[0].expectedIds = ['e2']],
  ['unknown source step', c => c.steps[0].sourceStep = 2],
  ['duplicate step ids', c => c.steps.push(structuredClone(c.steps[0]))],
  ['unresolved information declared ready', c => c.unresolved.push('缺少模型身份')],
  ['unknown role is not substituted', c => c.execution.role = '超级管理员'],
  ['wrong environment', c => c.execution.environment = 'dev'],
  ['unknown page entry', c => c.execution.entry = '/unknown'],
  ['missing bound data', c => c.execution.data[0].key = 'qwen-plus-chat'],
  ['row without key', c => c.targets.target.scope = [{ kind: 'row', name: '模型记录' }]],
  ['unidentified target', c => delete c.targets.target.placeholder],
  ['draft cannot execute', c => c.status = 'draft'],
  ['unsupported scope_ref rejected', c => c.targets.target.scope_ref = 'e1'],
];
for (const [name, mutate] of negatives) test(name, () => {
  const c = structuredClone(contractFor(tasks[0]));
  mutate(c);
  assert.equal(validateContract(c, manifest).ready, false);
  assert.throws(() => executableRequest(c, manifest, 's1'), /未就绪/);
});

test('a label is not automatically passed as the target own text', () => {
  const req = executableRequest(contractFor(tasks[1]), manifest, 's1');
  assert.equal(req.text, undefined);
  assert.ok(req.prompt.includes('启用故障切换'));
});

test('semantic checks do not pretend to prove business correctness', () => {
  const c = contractFor(tasks[0]);
  c.steps[0].assertions[0].expected = 'a business reviewer must validate this value';
  assert.equal(Contract.safeParse(c).success, true);
  assert.equal(validateContract(c, manifest).ready, true);
});
