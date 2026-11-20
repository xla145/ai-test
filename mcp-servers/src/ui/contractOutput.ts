import { z } from 'zod';
import { executionContractSchema } from './contract.js';

/** The transport schema is derived from the validator, including optional fields.
 * Strict output requires fixed object keys: optional fields use a singleton envelope and
 * parameter dictionaries travel as entries, then are decoded before validation. */
function strictSchema(value: any): any {
  if (Array.isArray(value)) return value.map(strictSchema);
  if (!value || typeof value !== 'object') return value;
  // Avoid anyOf/type arrays: some compatible providers accept only a single
  // type per schema node. Scalar unions travel as exactly one populated slot.
  if (Array.isArray(value.type)) return { type: 'object', additionalProperties: false,
    properties: Object.fromEntries(value.type.map((type: string) => [type, { type: 'array', maxItems: 1, items: { type } }])),
    required: value.type };
  if (value.type === 'object' && !value.properties && typeof value.additionalProperties === 'object') {
    return { type: 'array', items: { type: 'object', additionalProperties: false,
      properties: { parameter: { type: 'string', minLength: 1 }, valueRef: strictSchema(value.additionalProperties) },
      required: ['parameter', 'valueRef'] } };
  }
  const out = Object.fromEntries(Object.entries(value).filter(([key]) => key !== '$schema' && key !== 'default')
    .map(([key, child]) => [key, strictSchema(child)]));
  if (value.properties) {
    out.properties = Object.fromEntries(Object.entries(value.properties).map(([key, child]) => [key,
      (value.required ?? []).includes(key) ? strictSchema(child) : {
        type: 'object', additionalProperties: false,
        properties: { $optional: { type: 'array', maxItems: 1, items: strictSchema(child) } }, required: ['$optional'],
      }]));
    out.required = Object.keys(value.properties);
    out.additionalProperties = false;
  }
  return out;
}

export const executionContractOutputSchema: Record<string, unknown> = strictSchema(
  z.toJSONSchema(executionContractSchema, { io: 'input', target: 'draft-7' }));

export function decodeContractOutput(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decodeContractOutput);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([, child]) => child !== null).map(([key, child]) => {
    if (child && typeof child === 'object' && !Array.isArray(child) && '$optional' in child) {
      const slots = (child as { $optional: unknown }).$optional;
      if (Object.keys(child).length !== 1 || !Array.isArray(slots) || slots.length > 1) throw new Error('可选字段封装无效');
      if (!slots.length) return [key, undefined];
      return [key, (decodeContractOutput({ [key]: slots[0] }) as Record<string, unknown>)[key]];
    }
    if (key === 'value' && child && typeof child === 'object' && !Array.isArray(child)) {
      const entries = Object.entries(child);
      if (entries.length !== 3 || entries.some(([type, slot]) => !['string', 'boolean', 'number'].includes(type) || !Array.isArray(slot) || slot.length > 1)) throw new Error('value 类型封装无效');
      const populated = entries.filter(([, slot]) => (slot as unknown[]).length === 1);
      if (populated.length !== 1 || typeof (populated[0][1] as unknown[])[0] !== populated[0][0]) throw new Error('value 必须且只能提供一个实际值');
      return [key, (populated[0][1] as unknown[])[0]];
    }
    if (key === 'paramRefs' && Array.isArray(child)) {
      const seen = new Set<string>();
      const pairs = child.map(entry => {
        if (!entry || typeof entry !== 'object' || typeof entry.parameter !== 'string'
          || !entry.parameter || typeof entry.valueRef !== 'string'
          || Object.keys(entry).some(key => !['parameter', 'valueRef'].includes(key)) || seen.has(entry.parameter)) {
          throw new Error('paramRefs 参数条目无效或重复');
        }
        seen.add(entry.parameter);
        return [entry.parameter, entry.valueRef];
      });
      return [key, Object.fromEntries(pairs)];
    }
    return [key, decodeContractOutput(child)];
  }));
}

/** Business validation errors and runtime-rule refinements are never retried. */
export function isContractStructureError(error: unknown): boolean {
  return error instanceof SyntaxError || (error instanceof z.ZodError && error.issues.length > 0
    && error.issues.every(issue => ['invalid_type', 'unrecognized_keys'].includes(issue.code)));
}
