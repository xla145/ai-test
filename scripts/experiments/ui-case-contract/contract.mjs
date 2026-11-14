import { z } from 'zod';

const nonempty = z.string().trim().min(1);
const Target = z.object({
  page: nonempty,
  scope: z.array(z.object({
    kind: z.enum(['region', 'dialog', 'row', 'form_item', 'listbox']),
    name: nonempty,
    key: nonempty.optional(),
  }).strict()).min(1),
  control: z.enum(['textbox', 'checkbox', 'combobox', 'button', 'option', 'status']),
  name: nonempty.optional(),
  label: nonempty.optional(),
  placeholder: nonempty.optional(),
  text: nonempty.optional(),
}).strict();
const Assertion = z.object({
  target: nonempty,
  kind: z.enum(['value', 'text', 'checked']),
  expected: z.union([z.string(), z.boolean()]),
  evidence: z.literal('dom'),
}).strict();
const Step = z.object({
  id: nonempty,
  sourceStep: z.number().int().positive(),
  expectedIds: z.array(nonempty).min(1),
  target: nonempty,
  action: z.enum(['fill', 'check', 'click']),
  value: z.union([z.string(), z.boolean()]).optional(),
  assertions: z.array(Assertion).min(1),
}).strict();

/** Experimental minimum contract, not the production TestCase schema. */
export const Contract = z.object({
  version: z.literal('ui-execution/0.1'),
  id: nonempty,
  title: nonempty,
  source: z.object({ caseId: nonempty, stepIndexes: z.array(z.number().int().positive()).min(1), expectedIds: z.array(nonempty).min(1) }).strict(),
  execution: z.object({
    environment: nonempty, role: nonempty, entry: nonempty,
    data: z.array(z.object({ ref: nonempty, key: nonempty }).strict()),
  }).strict(),
  targets: z.record(nonempty, Target),
  steps: z.array(Step).min(1),
  coverage: z.array(z.object({ expectedId: nonempty, stepIds: z.array(nonempty).min(1) }).strict()).min(1),
  unresolved: z.array(nonempty),
  status: z.enum(['draft', 'blocked', 'ready']),
}).strict();

/** Structural/reference checks only. Business semantics still need review. */
export function validateContract(input, manifest) {
  const parsed = Contract.safeParse(input);
  if (!parsed.success) return { ready: false, issues: parsed.error.issues.map(i => `schema:${i.path.join('.')}:${i.code}`) };
  const c = parsed.data;
  const issues = [];
  const fail = (s) => issues.push(s);
  const unique = (xs, label) => { if (new Set(xs).size !== xs.length) fail(`duplicate:${label}`); };
  unique(c.steps.map(s => s.id), 'step');
  unique(c.source.expectedIds, 'expected');
  unique(c.coverage.map(s => s.expectedId), 'coverage');
  if (c.status !== 'ready') fail(`status:${c.status}`);
  if (c.unresolved.length) fail('unresolved');
  if (c.execution.environment !== manifest.environment) fail('environment:unbound');
  if (!manifest.roles.includes(c.execution.role)) fail('role:unbound');
  if (!manifest.entries.includes(c.execution.entry)) fail('entry:unbound');
  for (const d of c.execution.data) {
    if (!manifest.data.some(m => m.ref === d.ref && m.key === d.key)) fail(`data:unbound:${d.ref}`);
  }
  for (const [name, t] of Object.entries(c.targets)) {
    if (![t.name, t.label, t.placeholder, t.text].some(Boolean)) fail(`target:no_identity:${name}`);
    if (t.scope.some(s => s.kind === 'row' && !s.key)) fail(`target:row_key_missing:${name}`);
  }
  const allowed = { fill: ['textbox'], check: ['checkbox'], click: ['button', 'combobox', 'option'] };
  for (const s of c.steps) {
    const t = c.targets[s.target];
    if (!t) fail(`target:unknown:${s.target}`);
    else if (!allowed[s.action].includes(t.control)) fail(`action:control_mismatch:${s.id}`);
    if (s.action === 'fill' && typeof s.value !== 'string') fail(`action:fill_value:${s.id}`);
    if (s.action === 'check' && typeof s.value !== 'boolean') fail(`action:check_state:${s.id}`);
    if (s.action === 'click' && s.value !== undefined) fail(`action:unexpected_value:${s.id}`);
    if (!c.source.stepIndexes.includes(s.sourceStep)) fail(`source:unknown_step:${s.id}`);
    for (const id of s.expectedIds) if (!c.source.expectedIds.includes(id)) fail(`source:unknown_expected:${id}`);
    for (const a of s.assertions) {
      const at = c.targets[a.target];
      if (!at) fail(`assertion:unknown_target:${a.target}`);
      if ((a.kind === 'checked') !== (typeof a.expected === 'boolean')) fail(`assertion:value_type:${s.id}`);
      if (a.kind === 'checked' && at?.control !== 'checkbox') fail(`assertion:control_mismatch:${s.id}`);
      if (a.kind === 'value' && !['textbox', 'combobox'].includes(at?.control)) fail(`assertion:control_mismatch:${s.id}`);
    }
  }
  for (const id of c.source.expectedIds) {
    const mapping = c.coverage.find(x => x.expectedId === id);
    if (!mapping) fail(`coverage:missing:${id}`);
    else for (const stepId of mapping.stepIds) {
      const s = c.steps.find(s => s.id === stepId);
      if (!s || !s.expectedIds.includes(id)) fail(`coverage:invalid_link:${id}:${stepId}`);
    }
  }
  for (const mapping of c.coverage) if (!c.source.expectedIds.includes(mapping.expectedId)) fail(`coverage:unknown_expected:${mapping.expectedId}`);
  for (const s of c.steps) for (const id of s.expectedIds) {
    if (!c.coverage.some(m => m.expectedId === id && m.stepIds.includes(s.id))) fail(`coverage:missing_step_link:${s.id}:${id}`);
  }
  return { ready: !issues.length, issues };
}

const scopeNames = { region: '区域', dialog: '对话框', row: '列表行', form_item: '表单项', listbox: '选项列表' };
const controls = { textbox: '可编辑输入框', checkbox: '复选框开关', combobox: '下拉框', button: '按钮', option: '选项', status: '状态文本' };

export function compileLocate(target, action) {
  const scopes = target.scope.map(s => `${scopeNames[s.kind]}「${s.name}」${s.key ? `（对象「${s.key}」）` : ''}`).join('内的');
  const identity = [
    target.label && `关联标签为「${target.label}」`,
    target.name && `名称为「${target.name}」`,
    target.placeholder && `占位文字为「${target.placeholder}」`,
    target.text && `自身文字为「${target.text}」`,
  ].filter(Boolean).join('，');
  const purpose = action === 'fill' ? '输入内容' : action === 'check' ? '设置勾选状态' : target.control === 'combobox' ? '打开选项' : '点击';
  return {
    prompt: `在「${target.page}」页面的${scopes}内，定位${controls[target.control]}，${identity}，用于${purpose}。目标必须能由这些条件唯一确定。`,
    intent: action,
    ...(target.text || target.placeholder ? { text: target.text || target.placeholder } : {}),
  };
}

export function executableRequest(contract, manifest, stepId) {
  const result = validateContract(contract, manifest);
  if (!result.ready) throw new Error(`用例未就绪：${result.issues.join(',')}`);
  const step = contract.steps.find(s => s.id === stepId);
  if (!step) throw new Error('未知步骤');
  return compileLocate(contract.targets[step.target], step.action);
}

export const jsonSchema = z.toJSONSchema(Contract);
