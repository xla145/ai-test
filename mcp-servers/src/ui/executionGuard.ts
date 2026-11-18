import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ExecutionContract } from './contract.js';
import type { UiStep } from './codegen.js';

export type PreconditionCheck = NonNullable<ExecutionContract['preconditionChecks']>[number];

/** Successful recorded assertions are the evidence; deleting them revokes their coverage. */
export class ExecutionGuard {
  private failures = new Map<string, string>();
  private attempts = new Map<string, { count: number; method: string }>();
  blocked?: string;
  constructor(readonly caseId: string, readonly checks: PreconditionCheck[], readonly path?: string) {}

  passed(id: string, steps: UiStep[]) {
    return !this.failures.has(id) && steps.some(s => s.action.startsWith('expect') && s.preconditionCheckIds?.includes(id));
  }
  select(ids: string[], steps: UiStep[]) {
    for (const id of ids) {
      const check = this.checks.find(c => c.id === id);
      if (!check) throw new Error(`PRECONDITION_UNKNOWN: ${id}`);
      if (check.dependsOn.some(dep => !this.passed(dep, steps))) throw new Error(`PRECONDITION_DEPENDENCY: ${id} 的依赖尚未通过`);
    }
  }
  assertActive() {
    if (this.blocked) throw new Error(this.blocked);
  }
  assertReady(steps: UiStep[]) {
    this.assertActive();
    const missing = this.checks.filter(c => !this.passed(c.id, steps));
    if (missing.length) throw new Error(`PRECONDITION_BLOCKED: ${missing.map(c => `${c.id} ${this.failures.get(c.id) ?? '未通过断言验证'}`).join('；')}`);
  }
  failChecks(ids: string[], reason: string) {
    for (const id of ids) this.failures.set(id, reason);
    this.blocked = `PRECONDITION_BLOCKED: ${ids.join(', ')} ${reason}`;
  }
  beforeAttempt(key: string, method: string) {
    this.assertActive();
    const prior = this.attempts.get(key);
    if (prior && (prior.count >= 2 || prior.method === method)) throw new Error('RECOVERY_REQUIRED: 同一目标只允许一次不同方法的恢复；请检查 DOM 或停止本次执行');
  }
  failedAttempt(key: string, method: string) {
    const count = (this.attempts.get(key)?.count ?? 0) + 1;
    this.attempts.set(key, { count, method });
    if (count >= 2) this.blocked = 'RECOVERY_EXHAUSTED: 同一目标恢复失败，本次执行已阻断，请保留证据后结束';
  }
  resolved(key: string) { this.attempts.delete(key); }
  snapshot(steps: UiStep[]) {
    return { caseId: this.caseId, blocked: this.blocked, checks: this.checks.map(c => ({ ...c,
      status: this.failures.has(c.id) ? 'blocked' : this.passed(c.id, steps) ? 'passed' : 'pending',
      reason: this.failures.get(c.id),
      evidenceSteps: steps.flatMap((s, i) => s.action.startsWith('expect') && s.preconditionCheckIds?.includes(c.id) ? [i + 1] : []),
    })) };
  }
  persist(steps: UiStep[]) {
    if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify({ ...this.snapshot(steps), updatedAt: new Date().toISOString(), steps }, null, 2), { mode: 0o600 });
    renameSync(tmp, this.path);
  }
}
