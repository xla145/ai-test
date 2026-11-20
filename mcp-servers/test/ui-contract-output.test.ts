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
  it('retries only syntax and structural validation errors', () => {
    expect(isContractStructureError(new SyntaxError('json'))).toBe(true);
    expect(isContractStructureError(executionContractSchema.safeParse({ version: 1, status: 'ready', issues: [], preconditions: [], steps: 'wrong' }).error)).toBe(true);
    expect(isContractStructureError(new Error('业务事实缺失'))).toBe(false);
    expect(isContractStructureError(executionContractSchema.safeParse({ version: 2 }).error)).toBe(false);
  });
});
