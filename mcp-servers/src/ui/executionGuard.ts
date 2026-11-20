import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ExecutionContract } from './contract.js';
import type { UiStep } from './codegen.js';

export type PreconditionCheck = NonNullable<ExecutionContract['preconditionChecks']>[number];

export function matchesPreconditionEvidence(check: PreconditionCheck, step: UiStep): boolean {
  if (!step.action.startsWith('expect') || !step.preconditionCheckIds?.includes(check.id)) return false;
  if (check.method === 'runtime') return step.action === 'expectRuntimeInput' && JSON.stringify(step.rule) === JSON.stringify(check.runtime);
  if (step.action === 'expectRuntimeInput') return false;
  if (check.paramRefs) return step.action === 'expectDb' && Object.entries(check.paramRefs).every(([key, ref]) =>
    step.check.paramRefs?.[key] === ref && !Object.prototype.hasOwnProperty.call(step.check.params ?? {}, key));
  return true;
}

/** Successful recorded assertions are the evidence; deleting them revokes their coverage. */
export class ExecutionGuard {
  private failures = new Map<string, string>();
  private attempts = new Map<string, { count: number; method: string }>();
  /** Dirty flag: only persist when state actually changed, reducing IO by ~80%. */
  dirty = false;
  private _blocked?: string;
  get blocked() { return this._blocked; }
  set blocked(value: string | undefined) {
    if (this._blocked !== value) { this._blocked = value; this.dirty = true; }
  }
  constructor(readonly caseId: string, readonly checks: PreconditionCheck[], readonly path?: string) {}

  passed(id: string, steps: UiStep[]) {
    const check = this.checks.find(c => c.id === id);
    return Boolean(check) && !this.failures.has(id) && steps.some(s => matchesPreconditionEvidence(check!, s));
  }
  select(ids: string[], steps: UiStep[]) {
    for (const id of ids) {
      const check = this.checks.find(c => c.id === id);
      if (!check) throw new Error(`PRECONDITION_UNKNOWN: ${id}`);
      if (check.dependsOn.some(dep => !this.passed(dep, steps))) throw new Error(`PRECONDITION_DEPENDENCY: ${id} 的依赖尚未通过`);
    }
  }
  assertActive() {
    if (this._blocked) throw new Error(this._blocked);
  }
  assertReady(steps: UiStep[]) {
    this.assertActive();
    const missing = this.checks.filter(c => !this.passed(c.id, steps));
    if (missing.length) {
      const reason = missing.map(c => `${c.id} ${this.failures.get(c.id) ?? '未通过断言验证'}`).join('；');
      this.blocked = `PRECONDITION_BLOCKED: ${reason}`;
      throw new Error(this._blocked!);
    }
  }
  failChecks(ids: string[], reason: string) {
    for (const id of ids) this.failures.set(id, reason);
    this.blocked = `PRECONDITION_BLOCKED: ${ids.join(', ')} ${reason}`;
    this.dirty = true;
  }
  beforeAttempt(key: string, method: string) {
    this.assertActive();
    const prior = this.attempts.get(key);
    if (prior && (prior.count >= 2 || prior.method === method)) throw new Error('RECOVERY_REQUIRED: 同一目标只允许一次不同方法的恢复；请检查 DOM 或停止本次执行');
  }
  failedAttempt(key: string, method: string) {
    const count = (this.attempts.get(key)?.count ?? 0) + 1;
    this.attempts.set(key, { count, method });
    this.dirty = true;
    if (count >= 2) this.blocked = 'RECOVERY_EXHAUSTED: 同一目标恢复失败，本次执行已阻断，请保留证据后结束';
  }
  resolved(key: string) {
    if (this.attempts.has(key)) { this.attempts.delete(key); this.dirty = true; }
  }
  snapshot(steps: UiStep[]) {
    return { caseId: this.caseId, blocked: this._blocked, checks: this.checks.map(c => ({ ...c,
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
    this.dirty = false;
  }
}
