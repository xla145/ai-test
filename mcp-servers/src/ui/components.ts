import { createRequire } from 'node:module';
import type { Locator } from 'playwright-core';
export type ValueSource = 'text' | 'input' | 'checked' | 'selected' | 'texts';
/** A variable reference and a literal are different assertion modes. Never silently prefer one. */
export function validateObservedExpectation(options: { name?: string; expected?: unknown }): void {
  const named = options.name !== undefined;
  const literal = options.expected !== undefined;
  if (named === literal || (named && !options.name?.trim())) {
    throw new Error('VALUE_INVALID: name（来源变量）与 expected（明确预期）必须且只能提供一个；name 不是断言标题。不要先读取当前值再与自身比较');
  }
}
export interface CollectionRule { selector: string; minCount?: number; maxCount?: number; contains?: string; equals?: string }
export type UiInput = "username" | "email" | "password" | "other_password";
export type RuntimeRule = import('zod').infer<typeof import('./contract.js').runtimeRuleSchema>;
export const { assertRuntimeInput, resolveInputParams } = createRequire(import.meta.url)('../../templates/ui/aitest-values.cjs') as {
  assertRuntimeInput(inputs: Record<UiInput, string>, rule: RuntimeRule): void;
  resolveInputParams(check: import('./codegen.js').DbCheck, inputs: Record<UiInput, string>): import('./codegen.js').DbCheck;
};
export const { createUiInputs, numericEqual, readValue, equalValue, validateCollectionRule, checkCollection } = createRequire(import.meta.url)('../../templates/ui/aitest-values.cjs') as {
  createUiInputs(): Record<UiInput, string>;
  validateCollectionRule(rule: CollectionRule): void;
  checkCollection(locator: Locator, rule: CollectionRule): Promise<{ matched: boolean; count: number }>;
  numericEqual(a: unknown, b: string | number, tolerance?: string | number): boolean;
  readValue(locator: Locator, source?: ValueSource): Promise<unknown>;
  equalValue(a: unknown, b: unknown, normalize?: 'exact' | 'trim' | 'number' | 'set'): boolean;
};
