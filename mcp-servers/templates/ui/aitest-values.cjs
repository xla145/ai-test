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
