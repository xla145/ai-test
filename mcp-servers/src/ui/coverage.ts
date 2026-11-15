import type { UiStep } from './codegen.js';
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
  if (source.preconditionChecks) {
    const bodyStart = steps.findIndex(s => s.caseStep !== undefined);
    for (const check of source.preconditionChecks) {
      const evidence = steps.findIndex(s => s.action.startsWith('expect') && s.preconditionCheckIds?.includes(check.id));
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
  for (const step of steps) { const role = step.role ?? 'default'; if (!seen.has(role) && step.action !== 'goto') issues.push(`角色「${role}」缺少独立回放入口，请先录制导航`); seen.add(role); }
  return [...new Set(issues)];
}
