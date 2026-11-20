// Shared by exploration, debugging and generated scripts. No coercion of absent values.
function decimal(value) {
  if (typeof value !== 'string' && typeof value !== 'number') throw new Error('VALUE_INVALID: expected decimal');
  const text = String(value).trim();
  const match = /^([+-]?)(\d+(?:\.\d*)?|\.\d+)(?:[eE]([+-]?\d+))?$/.exec(text);
  if (!match || text.length > 512) throw new Error('VALUE_INVALID: expected a single decimal without units');
  const exponent = Number(match[3] || 0);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 1000) throw new Error('VALUE_INVALID: exponent out of range');
  const parts = match[2].split('.');
  let scale = (parts[1] || '').length - exponent;
  let coefficient = BigInt((match[1] === '-' ? '-' : '') + (parts[0] || '0') + (parts[1] || ''));
  if (scale < 0) { coefficient *= 10n ** BigInt(-scale); scale = 0; }
  return { coefficient, scale };
}
function numericEqual(actual, expected, tolerance = 0) {
  const a = decimal(actual), e = decimal(expected), t = decimal(tolerance);
  if (t.coefficient < 0n) throw new Error('VALUE_INVALID: negative tolerance');
  const scale = Math.max(a.scale, e.scale, t.scale);
  const aligned = n => n.coefficient * 10n ** BigInt(scale - n.scale);
  const delta = aligned(a) - aligned(e);
  return (delta < 0n ? -delta : delta) <= aligned(t);
}
async function readValue(locator, source = 'text') {
  if (source === 'input') return locator.inputValue();
  if (source === 'checked') {
    return locator.evaluate(el => {
      if (el instanceof HTMLInputElement && ['checkbox', 'radio'].includes(el.type)) return el.checked;
      const value = el.getAttribute('aria-checked');
      if (value !== 'true' && value !== 'false') throw new Error('CONTROL_MISMATCH: checked state unavailable');
      return value === 'true';
    });
  }
  if (source === 'selected') {
    return locator.evaluate(el => {
      if (el instanceof HTMLSelectElement) return [...el.selectedOptions].map(o => o.textContent.trim());
      const root = el.closest('.el-select') || el;
      const labels = [...root.querySelectorAll('.el-select__selected-item:not(.el-select__input-wrapper):not(.is-transparent)')].filter(n => n.getClientRects().length);
      if (!labels.length) throw new Error('CONTROL_MISMATCH: selected display unavailable');
      return labels.map(n => n.textContent.trim());
    });
  }
  if (source === 'texts') return locator.allTextContents();
  return locator.innerText();
}
module.exports = { numericEqual, readValue };
function equalValue(a, b, normalize = 'exact') {
  if (a === undefined || a === null || b === undefined || b === null) throw new Error('VALUE_INVALID: missing observation');
  if (normalize === 'number') return numericEqual(a, b);
  if (normalize === 'trim') {
    if (typeof a !== 'string' || typeof b !== 'string') throw new Error('VALUE_INVALID: text required');
    return a.trim() === b.trim();
  }
  if (normalize === 'set') {
    if (!Array.isArray(a) || !Array.isArray(b) || [...a, ...b].some(v => typeof v !== 'string')) throw new Error('VALUE_INVALID: string collection required');
    return JSON.stringify([...new Set(a)].sort()) === JSON.stringify([...new Set(b)].sort());
  }
  return JSON.stringify(a) === JSON.stringify(b);
}
module.exports.equalValue = equalValue;

function validateCollectionRule(rule) {
  if (!rule || typeof rule.selector !== 'string' || !rule.selector.trim()) throw new Error('VALUE_INVALID: collection CSS selector required');
  for (const key of ['minCount', 'maxCount']) if (rule[key] !== undefined && (!Number.isSafeInteger(rule[key]) || rule[key] < 0)) throw new Error('VALUE_INVALID: invalid count bound');
  if (rule.maxCount !== undefined && rule.maxCount < (rule.minCount ?? 1)) throw new Error('VALUE_INVALID: contradictory count bounds');
  for (const key of ['contains', 'equals']) if (rule[key] !== undefined && (typeof rule[key] !== 'string' || !rule[key].trim())) throw new Error('VALUE_INVALID: nonempty matching value required');
}
async function checkCollection(locator, rule) {
  validateCollectionRule(rule);
  // CSS queries remain within this stable container; result text never selects the rows.
  const values = await locator.evaluate((root, selector) => [...root.querySelectorAll(selector)]
    .filter(el => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden' && getComputedStyle(el).display !== 'none')
    .map(el => el.innerText.trim()), rule.selector);
  return { count: values.length, matched: values.length >= (rule.minCount ?? 1)
    && (rule.maxCount === undefined || values.length <= rule.maxCount)
    && values.every(value => (rule.contains === undefined || value.includes(rule.contains)) && (rule.equals === undefined || value === rule.equals)) };
}
module.exports.validateCollectionRule = validateCollectionRule;
module.exports.checkCollection = checkCollection;

// Created once per case attempt; recordings store field names only.
module.exports.createUiInputs = function createUiInputs() {
  const { randomBytes } = require('node:crypto');
  const id = randomBytes(8).toString('hex');
  return { username: `ui_${id}`, email: `ui_${id}@example.com`,
    password: `Aa1${randomBytes(8).toString('hex')}`, other_password: `Bb2${randomBytes(8).toString('hex')}` };
};

module.exports.assertRuntimeInput = function assertRuntimeInput(inputs, rule) {
  if (rule.minLength === undefined && rule.maxLength === undefined
    && rule.maxUtf8Bytes === undefined && rule.differentFrom === undefined) {
    throw new Error('VALUE_INVALID: runtime requires an explicit constraint');
  }
  const value = inputs[rule.valueRef];
  if (typeof value !== 'string' || !value.length) throw new Error('VALUE_INVALID: unknown runtime input');
  if ((rule.minLength !== undefined && value.length < rule.minLength)
    || (rule.maxLength !== undefined && value.length > rule.maxLength)
    || (rule.maxUtf8Bytes !== undefined && Buffer.byteLength(value, 'utf8') > rule.maxUtf8Bytes)
    || (rule.differentFrom !== undefined && (typeof inputs[rule.differentFrom] !== 'string' || value === inputs[rule.differentFrom]))) {
    throw new Error('ASSERTION_FAILED: runtime input constraints failed');
  }
};

module.exports.resolveInputParams = function resolveInputParams(check, inputs) {
  const { paramRefs, ...literal } = check;
  const params = { ...check.params };
  for (const [key, ref] of Object.entries(paramRefs || {})) {
    if (Object.prototype.hasOwnProperty.call(params, key)) throw new Error('VALUE_INVALID: duplicate literal and runtime parameter');
    if (!Object.prototype.hasOwnProperty.call(inputs, ref)) throw new Error('VALUE_INVALID: unknown runtime input');
    params[key] = inputs[ref];
  }
  return paramRefs ? { ...literal, params } : literal;
};
