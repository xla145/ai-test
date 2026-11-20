import { describe, expect, it } from 'vitest';
import { decodeContractOutput, executionContractOutputSchema, isContractStructureError } from '../src/ui/contractOutput.js';
import { executionContractSchema } from '../src/ui/contract.js';

describe('contract output transport', () => {
  it('requires every fixed key and forbids extra properties recursively', () => {
    const visit = (node: any) => {
      if (!node || typeof node !== 'object') return;
      if (node.properties) {
        expect(node.required).toEqual(Object.keys(node.properties));
        expect(node.additionalProperties).toBe(false);
      }
      for (const child of Object.values(node)) {
        if (Array.isArray(child)) child.forEach(visit); else visit(child);
      }
    };
    visit(executionContractOutputSchema);
    const serialized = JSON.stringify(executionContractOutputSchema);
    expect(serialized).not.toContain('anyOf');
    expect(serialized).not.toContain('"type":["');
  });
  it('decodes optional nulls and parameter entries without losing false or zero', () => {
    expect(decodeContractOutput({ target: null, value: false, n: 0, paramRefs: [{ parameter: 'user', valueRef: 'username' }] }))
      .toEqual({ value: false, n: 0, paramRefs: { user: 'username' } });
    expect(() => decodeContractOutput({ paramRefs: [{ parameter: 'x', valueRef: 'email' }, { parameter: 'x', valueRef: 'password' }] })).toThrow('重复');
  });
  it('decodes provider-compatible envelopes and validates scalar slots', () => {
    expect(decodeContractOutput({ target: { $optional: [] }, value: { $optional: [{ string: [], boolean: [false], number: [] }] }, paramRefs: { $optional: [[{ parameter: 'u', valueRef: 'username' }]] } }))
      .toEqual({ target: undefined, value: false, paramRefs: { u: 'username' } });
    expect(() => decodeContractOutput({ value: { string: ['a'], boolean: [false], number: [] } })).toThrow('只能');
    expect(() => decodeContractOutput({ value: { string: [false], boolean: [], number: [] } })).toThrow('只能');
    expect(() => decodeContractOutput({ target: { $optional: [1, 2] } })).toThrow('无效');
  });
  it('roundtrips a complete transport plan through the canonical validator', () => {
    const plan = { version: 1, status: 'ready', issues: [], preconditions: [], dataRefs: { $optional: [] }, preconditionChecks: { $optional: [] },
      steps: [{ index: 1, source: '填写邮箱', expected: ['填写成功'], actions: [{ action: 'fill', instruction: '填写邮箱',
        target: { $optional: [] }, targetHint: { $optional: ['邮箱输入框'] }, role: { $optional: [] },
        value: { $optional: [{ string: ['test@example.com'], boolean: [], number: [] }] }, valueRef: { $optional: [] }, paramRefs: { $optional: [] } }] }] };
    const decoded = executionContractSchema.parse(decodeContractOutput(plan));
    expect(decoded.steps[0].actions[0]).toMatchObject({ value: 'test@example.com', targetHint: '邮箱输入框' });
    expect(decoded.dataRefs).toBeUndefined();
  });
  it('retries only syntax and structural validation errors', () => {
    expect(isContractStructureError(new SyntaxError('json'))).toBe(true);
    expect(isContractStructureError(executionContractSchema.safeParse({ version: 1, status: 'ready', issues: [], preconditions: [], steps: 'wrong' }).error)).toBe(true);
    expect(isContractStructureError(new Error('业务事实缺失'))).toBe(false);
    expect(isContractStructureError(executionContractSchema.safeParse({ version: 2 }).error)).toBe(false);
  });
});
