/**
 * calc.js - pure calculation core for the FX position calculator.
 *
 * Dependency-free ES module. Imported unchanged by the browser (<script type="module">)
 * and by `node --test`, so the shipped math and the tested math are the same code.
 *
 * Reference values for every exported function are pinned in test/calc.test.mjs and were
 * cross-verified by five independent derivations before a line of this file was written.
 *
 * CURRENCY MODEL
 *   `rates` is a USD-anchored table: rates[CCY] = units of CCY per 1 USD, with rates.USD === 1.
 *   That is the native shape of open.er-api.com. Every conversion triangulates through USD at
 *   full precision (never through a pre-rounded cross quote), so EURGBP 2 lots lands on exactly
 *   217000 rather than 216999.9978.
 *
 * TWO MARGIN MODELS - the distinction most calculators get wrong
 *   FX:  the contract is denominated in the BASE currency. margin = lots*contractSize/leverage,
 *        denominated in BASE, then converted to the account currency. This is why USDJPY on a
 *        USD account needs exactly $250 at 1:400 no matter where the price is.
 *   CFD: indices and energies have no base-currency leg - they are priced directly in their
 *        settlement currency. margin = lots*contractSize*price/leverage, denominated in the
 *        QUOTE currency. Routing a CFD through the FX path would report $0.0025 for US30.
 */

export const FX = 'fx';
export const INDEX = 'index';
export const ENERGY = 'energy';

/** CFD-style instruments carry no base-currency leg. */
export function isCfd(instrument) {
  return instrument.type === INDEX || instrument.type === ENERGY;
}

/* ------------------------------------------------------------------ guards */

export class CalcError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'CalcError';
    this.code = code;
  }
}

/**
 * Parse and validate a numeric input. Rejects NaN/Infinity and out-of-range values up front so
 * a bad field can never silently poison a result with NaN three functions downstream.
 */
export function num(value, name, { min = -Infinity, max = Infinity, positive = false } = {}) {
  const n = typeof value === 'string' ? Number(value.replace(/[\s,_]/g, '')) : Number(value);
  if (!Number.isFinite(n)) throw new CalcError(`${name} must be a finite number`, 'NOT_FINITE');
  if (positive && n <= 0) throw new CalcError(`${name} must be greater than zero`, 'NOT_POSITIVE');
  if (n < min || n > max) throw new CalcError(`${name} must be between ${min} and ${max}`, 'OUT_OF_RANGE');
  return n;
}

function rateFor(ccy, rates) {
  if (ccy === 'USD') return 1;
  const r = rates && rates[ccy];
  if (!Number.isFinite(r) || r <= 0) {
    throw new CalcError(`No usable exchange rate for ${ccy}`, 'MISSING_RATE');
  }
  return r;
}

/* -------------------------------------------------------------- conversion */

/** Convert `amount` from one currency to another through the USD anchor. */
export function convert(amount, from, to, rates) {
  const a = num(amount, 'amount');
  if (from === to) return a;
  return (a * rateFor(to, rates)) / rateFor(from, rates);
}

/**
 * Return a rates table made consistent with a traded price.
 *
 * The instrument's own price IS an exchange rate, and it is fresher and broker-exact compared
 * with the cached table. Pinning the table to it is what implements "P/L converts at the closing
 * rate": pass the exit price and the conversion happens at exit.
 *
 * Whichever leg is not USD gets overridden, so rates.USD always stays exactly 1.
 */
export function alignRatesToPrice(instrument, price, rates) {
  if (isCfd(instrument)) return rates;
  const p = num(price, 'price', { positive: true });
  const { base, quote } = instrument;
  if (quote === 'USD') return { ...rates, [base]: 1 / p };
  if (base === 'USD') return { ...rates, [quote]: p };
  // Cross pair: anchor the base leg to the USD table and pin the cross ratio to the traded price.
  return { ...rates, [quote]: p * rateFor(base, rates) };
}

/* ------------------------------------------------------------- core sizing */

/** Notional (full contract) value of a position, in its native currency and the account currency. */
export function notional({ instrument, lots, price, acctCcy, rates }) {
  const l = num(lots, 'lots', { positive: true });
  const p = num(price, 'price', { positive: true });
  const cs = num(instrument.contractSize, 'contract size', { positive: true });
  const aligned = alignRatesToPrice(instrument, p, rates);

  const nativeCcy = isCfd(instrument) ? instrument.quote : instrument.base;
  const native = isCfd(instrument) ? l * cs * p : l * cs;
  return { native, nativeCcy, acct: convert(native, nativeCcy, acctCcy, aligned) };
}

/**
 * Margin a broker locks to hold the position.
 * Uses the OPEN price: mainstream retail platforms lock margin at the opening rate rather than
 * revaluing it tick by tick, so this figure is a constant for the life of the trade.
 */
export function requiredMargin({ instrument, lots, price, leverage, acctCcy, rates }) {
  const lev = num(leverage, 'leverage', { positive: true, max: 5000 });
  const n = notional({ instrument, lots, price, acctCcy, rates });
  return { native: n.native / lev, nativeCcy: n.nativeCcy, acct: n.acct / lev };
}

/**
 * Value of one pip (FX) or one point/tick (CFD) of price movement.
 * Always accrues in the QUOTE currency, then converts.
 */
export function pipValue({ instrument, lots, price, acctCcy, rates }) {
  const l = num(lots, 'lots', { positive: true });
  const p = num(price, 'price', { positive: true });
  const cs = num(instrument.contractSize, 'contract size', { positive: true });
  const pip = num(instrument.pipSize, 'pip size', { positive: true });
  const aligned = alignRatesToPrice(instrument, p, rates);
  const quoteValue = pip * cs * l;
  return {
    native: quoteValue,
    nativeCcy: instrument.quote,
    acct: convert(quoteValue, instrument.quote, acctCcy, aligned),
  };
}

/** Price difference expressed in pips/points. */
export function toPips(instrument, priceDelta) {
  return num(priceDelta, 'price delta') / num(instrument.pipSize, 'pip size', { positive: true });
}

/* ------------------------------------------------------------ risk sizing */

/**
 * Largest position whose loss at the stop is still within the risk budget.
 * Always rounds DOWN to the lot step - rounding up would exceed the stated risk, which is the
 * one direction a risk tool must never err in. Callers get `cashAtRisk <= budget` as an invariant.
 */
export function lotsFromRisk({ instrument, balance, riskPct, stopPips, price, acctCcy, rates, lotStep = 0.01, minLot = 0.01, maxLot = 100 }) {
  const bal = num(balance, 'balance', { positive: true });
  const pct = num(riskPct, 'risk %', { positive: true, max: 100 });
  const pips = num(stopPips, 'stop distance', { positive: true });
  const step = num(lotStep, 'lot step', { positive: true });

  const budget = (bal * pct) / 100;
  const perLot = pipValue({ instrument, lots: 1, price, acctCcy, rates }).acct;
  if (perLot <= 0) throw new CalcError('Pip value resolved to zero', 'ZERO_PIP_VALUE');

  const raw = budget / (pips * perLot);
  // Round down on the step grid. The epsilon absorbs binary-float dust so an exact multiple
  // such as 0.2 / 0.01 = 19.999999999999996 does not silently drop a whole step.
  let lots = Math.floor(raw / step + 1e-9) * step;
  lots = Number(lots.toFixed(8));

  const capped = lots > maxLot ? num(maxLot, 'max lot') : lots;
  const feasible = capped >= minLot;
  const finalLots = feasible ? capped : 0;

  return {
    lots: finalLots,
    rawLots: raw,
    budget,
    pipValuePerLot: perLot,
    cashAtRisk: finalLots * pips * perLot,
    feasible,
    cappedByMaxLot: lots > maxLot,
    reason: feasible ? null : `Risk budget is too small for the minimum ${minLot} lot size`,
  };
}

/* ---------------------------------------------------------------- outcomes */

/**
 * Realised/unrealised P/L. Accrues in the quote currency and converts at the EXIT rate, matching
 * MT4/MT5. Converting at the entry rate instead shifts a 0.20-lot USDJPY trade by over a dollar.
 */
export function profitLoss({ instrument, lots, entry, exit, direction = 'buy', acctCcy, rates }) {
  const l = num(lots, 'lots', { positive: true });
  const e = num(entry, 'entry price', { positive: true });
  const x = num(exit, 'exit price', { positive: true });
  const cs = num(instrument.contractSize, 'contract size', { positive: true });
  const sign = direction === 'sell' ? -1 : 1;

  const quotePl = (x - e) * cs * l * sign;
  const aligned = alignRatesToPrice(instrument, x, rates);
  return {
    native: quotePl,
    nativeCcy: instrument.quote,
    acct: convert(quotePl, instrument.quote, acctCcy, aligned),
    pips: toPips(instrument, (x - e) * sign),
  };
}

/** Reward-to-risk ratio from raw prices; direction-agnostic because it uses absolute distances. */
export function riskReward({ entry, stopLoss, takeProfit }) {
  const e = num(entry, 'entry price', { positive: true });
  const sl = num(stopLoss, 'stop loss', { positive: true });
  const tp = num(takeProfit, 'take profit', { positive: true });
  const risk = Math.abs(e - sl);
  const reward = Math.abs(tp - e);
  if (risk === 0) throw new CalcError('Stop loss cannot equal the entry price', 'ZERO_RISK');
  return { risk, reward, ratio: reward / risk };
}

/* ----------------------------------------------------------- account state */

/** Margin level %. With nothing open there is no ratio to report, so this returns null, not Infinity. */
export function marginLevel({ equity, usedMargin }) {
  const eq = num(equity, 'equity');
  const used = num(usedMargin, 'used margin', { min: 0 });
  if (used === 0) return null;
  return (eq / used) * 100;
}

/**
 * How far price can move against the position before the broker force-closes it.
 * Assumes used margin stays locked at the open rate (mainstream retail behaviour).
 */
export function pipsToStopOut({ equity, usedMargin, stopOutPct, pipValueAcct }) {
  const eq = num(equity, 'equity');
  const used = num(usedMargin, 'used margin', { min: 0 });
  const pct = num(stopOutPct, 'stop-out %', { min: 0, max: 100 });
  const pv = num(pipValueAcct, 'pip value', { positive: true });
  if (used === 0) return null;
  const equityAtStopOut = (pct / 100) * used;
  const lossRoom = eq - equityAtStopOut;
  return { pips: lossRoom / pv, lossRoom, equityAtStopOut, alreadyBreached: lossRoom <= 0 };
}

/** Free margin available for new positions. */
export function freeMargin({ equity, usedMargin }) {
  return num(equity, 'equity') - num(usedMargin, 'used margin', { min: 0 });
}
