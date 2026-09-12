/** Presentation helpers. Kept apart from calc.js so rounding never leaks into the arithmetic. */

const ZERO_DECIMAL = new Set(['JPY', 'KRW', 'VND', 'CLP', 'ISK']);

export function money(value, ccy, { compact = false } = {}) {
  if (value == null || !Number.isFinite(value)) return '—';
  const digits = ZERO_DECIMAL.has(ccy) ? 0 : 2;
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency', currency: ccy, minimumFractionDigits: compact ? 0 : digits,
      maximumFractionDigits: digits, notation: compact && Math.abs(value) >= 1e6 ? 'compact' : 'standard',
    }).format(value);
  } catch {
    return `${value.toFixed(digits)} ${ccy}`;   // unknown currency code still renders
  }
}

export function units(value, maxDigits = 2) {
  if (value == null || !Number.isFinite(value)) return '—';
  return value.toLocaleString('en-US', { maximumFractionDigits: maxDigits });
}

export function price(value, digits) {
  if (value == null || !Number.isFinite(value)) return '—';
  return value.toFixed(digits);
}

export function pct(value, digits = 1) {
  if (value == null || !Number.isFinite(value)) return '—';
  return `${value.toLocaleString('en-US', { maximumFractionDigits: digits })}%`;
}

/** Set text without ever touching an HTML sink - the CSP blocks those outright. */
export function setText(el, text) { if (el) el.textContent = text; }

export function setAlert(el, message, kind = 'warn') {
  if (!el) return;
  el.hidden = !message;
  if (message) { el.textContent = message; el.className = `alert ${kind}`; }
}
