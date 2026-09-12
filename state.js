/**
 * state.js - persisted settings and the derived model every view reads from.
 *
 * `ctx` is the single mutable holder: views import it rather than receiving props, which keeps
 * the render functions free of plumbing. Rates live here too so a refresh reaches every tab.
 */
import { requiredMargin, freeMargin, FX } from './calc.js';
import { findInstrument } from './instruments.js';

const STATE_KEY = 'fxcalc.state.v1';

export const DEFAULTS = {
  symbol: 'EURUSD', direction: 'buy', lots: 1, manualPrice: null, priceAuto: true, leverage: 400,
  balance: 5000, acctCcy: 'USD', stopOut: 50,
  riskPct: 1, stopPips: 25, spread: 0, commission: 0,
  entry: null, sl: null, tp: null, tradeLots: 1,
  positions: [], overrides: {},
};

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(STATE_KEY) || '{}');
    // Spread onto a fresh object literal so a crafted cache cannot reach Object.prototype.
    return { ...DEFAULTS, ...saved, overrides: { ...saved.overrides }, positions: Array.isArray(saved.positions) ? saved.positions : [] };
  } catch { return { ...DEFAULTS }; }
}

export const ctx = { state: load(), rates: null, rateMeta: { status: 'none' } };

export function save() {
  try { localStorage.setItem(STATE_KEY, JSON.stringify(ctx.state)); } catch { /* private mode */ }
}

export function resetAll() {
  try { localStorage.removeItem(STATE_KEY); } catch { /* ignore */ }
  ctx.state = { ...DEFAULTS };
}

export const instrument = () =>
  findInstrument(ctx.state.symbol, ctx.state.overrides) || findInstrument('EURUSD');

/** Margin basis for an instrument: its own override if set, otherwise the account default. */
export function marginArgs(inst) {
  if (inst.marginMode === 'percent') return { marginPercent: inst.marginValue };
  if (inst.marginMode === 'leverage') return { leverage: inst.marginValue };
  return { leverage: ctx.state.leverage };
}

/** A live price is only derivable for FX: the feed carries currency ratios, not index quotes. */
export function livePrice(inst) {
  if (!ctx.rates || inst.type !== FX) return null;
  const q = ctx.rates[inst.quote], b = ctx.rates[inst.base];
  if (!Number.isFinite(q) || !Number.isFinite(b) || b <= 0) return null;
  // Snap to the instrument's quoted precision. Carrying twelve digits of a reference-rate ratio
  // is false precision, and it makes the on-screen derivation fail to reconcile: a price shown as
  // 1.16007 against a notional of 116,006.72 reads as a 28-cent bug rather than as rounding.
  return Number((q / b).toFixed(inst.digits));
}

export function currentPrice() {
  const inst = instrument();
  if (ctx.state.priceAuto) { const p = livePrice(inst); if (p) return p; }
  return ctx.state.manualPrice;
}

/** Margin committed by open positions, each valued at its own opening price. */
export function usedMargin() {
  let total = 0;
  for (const p of ctx.state.positions) {
    const inst = findInstrument(p.symbol, ctx.state.overrides);
    if (!inst || !ctx.rates) continue;
    try {
      total += requiredMargin({
        instrument: inst, lots: p.lots, price: p.price,
        acctCcy: ctx.state.acctCcy, rates: ctx.rates, ...marginArgs(inst),
      }).acct;
    } catch { /* a position in a currency we lack a rate for is skipped, not fatal */ }
  }
  return total;
}

export const equityFree = () => freeMargin({ equity: ctx.state.balance, usedMargin: usedMargin() });
