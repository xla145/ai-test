import type { UiStep } from './codegen.js';
import { matchesPreconditionEvidence } from './executionGuard.js';
export interface CoverageSource { steps?: string[]; expected?: string[]; preconditions?: string[]; preconditionChecks?: import('./executionGuard.js').PreconditionCheck[] }
/** Explicit coverage is required. Assertion counts cannot prove that expectations are covered. */
export function coverageIssues(steps: UiStep[], source: CoverageSource): string[] {
  const assertion = (s: UiStep) => s.action.startsWith('expect') || s.action === 'visualCheck';
  const issues: string[] = [];
  const check = (values: string[], field: 'caseStep' | 'expectedIndices' | 'preconditionIndices', mustAssert: boolean) => {
    values.forEach((_, i) => {
      if (!steps.some(s => (!mustAssert || assertion(s)) && (field === 'caseStep' ? s.caseStep === i + 1 : (s[field] ?? []).includes(i + 1)))) issues.push(`${field === 'caseStep' ? '步骤' : field === 'expectedIndices' ? '预期' : '前置条件'} ${i + 1} 未映射到${mustAssert ? '断言' : '执行步骤'}`);
    });
    for (const step of steps) {
      const indices = field === 'caseStep' ? (step.caseStep === undefined ? [] : [step.caseStep]) : step[field] ?? [];
      if (indices.some(i => !Number.isInteger(i) || i < 1 || i > values.length)) issues.push(`步骤 ${step.id ?? step.action} 的覆盖索引越界`);
      if (mustAssert && indices.length && !assertion(step)) issues.push(`步骤 ${step.id ?? step.action} 不是断言，不能证明预期或前置条件`);
    }
  };
  check(source.steps ?? [], 'caseStep', false);
  check(source.expected ?? [], 'expectedIndices', true);
  check(source.preconditions ?? [], 'preconditionIndices', true);
  // These are deliberately narrow checks for explicit, machine-verifiable
  // requirements. Coverage indices alone are not evidence of state or count.
  const semantic = (values: string[], field: 'expectedIndices' | 'preconditionIndices') => {
    values.forEach((value, i) => {
      const mapped = steps.filter(s => s[field]?.includes(i + 1));
      const label = `${field === 'expectedIndices' ? '预期' : '前置条件'} ${i + 1}`;
      const alternativeMessage = value.split(/或.*?提示/)[1]?.trim().replace(/[。；;]$/, '');
      if (/(?:按钮|控件).{0,12}(?:不可用|禁用|不可点击)/.test(value)
        && !mapped.some(s => s.action === 'expectEnabled' && !s.enabled)
        && !mapped.some(s => s.action === 'visualCheck')
        && !(alternativeMessage && mapped.some(s => s.action === 'expectText' && s.text.includes(alternativeMessage)))) {
        issues.push(`${label} 要求禁用状态，不能以可见断言代替，请使用 expect_enabled`);
      }
      if (/(?:仅保留|仅有|仅剩|恰好)(?:一|1)(?:条|个|项|行)(?!时)/.test(value)
        && !mapped.some(s => s.action === 'expectCollection' && s.rule.minCount === 1 && s.rule.maxCount === 1)) {
        issues.push(`${label} 要求精确数量，请使用数量上下界均为 1 的集合断言`);
      }
    });
  };
  semantic(source.expected ?? [], 'expectedIndices');
  semantic(source.preconditions ?? [], 'preconditionIndices');
  if (source.preconditionChecks) {
    const bodyStart = steps.findIndex(s => s.caseStep !== undefined);
    for (const check of source.preconditionChecks) {
      const mapped = steps.filter(s => s.preconditionCheckIds?.includes(check.id));
      if (check.paramRefs && mapped.some(s => !matchesPreconditionEvidence(check, s))) {
        issues.push(`原子前置检查 ${check.id} 的数据库参数引用与计划不匹配`);
      }
      if (mapped.some(s => (s.action === 'expectRuntimeInput') !== (check.method === 'runtime')
        || (s.action === 'expectRuntimeInput' && JSON.stringify(s.rule) !== JSON.stringify(check.runtime)))) {
        issues.push(`原子前置检查 ${check.id} 的运行时证据与计划不匹配`);
      }
      const evidence = steps.findIndex(s => matchesPreconditionEvidence(check, s));
      if (evidence < 0 || (bodyStart >= 0 && evidence >= bodyStart)) issues.push(`原子前置检查 ${check.id} 未在正文前验证`);
      for (const dep of check.dependsOn) {
        const prior = steps.findIndex(s => s.action.startsWith('expect') && s.preconditionCheckIds?.includes(dep));
        if (prior < 0 || prior >= evidence) issues.push(`原子前置检查 ${check.id} 的依赖 ${dep} 未先验证`);
      }
    }
    for (const step of steps) for (const id of step.preconditionCheckIds ?? []) {
      if (!source.preconditionChecks.some(c => c.id === id) || !step.action.startsWith('expect')) issues.push(`无效原子检查映射 ${id}`);
    }
  }
  if (!source.expected?.length) issues.push('用例没有预期结果');
  const seen = new Set<string>();
  for (const step of steps.filter(s => !["expectDb", "expectRuntimeInput"].includes(s.action))) { const role = step.role ?? 'default'; if (!seen.has(role) && step.action !== 'goto') issues.push(`角色「${role}」缺少独立回放入口，请先录制导航`); seen.add(role); }
  return [...new Set(issues)];
}
