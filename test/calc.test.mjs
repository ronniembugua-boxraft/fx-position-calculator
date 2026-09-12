/**
 * Reference values here were derived independently five times over (first-principles,
 * broker back-office, industry-standard-formula, unit-dimension audit, risk-manager lenses)
 * and every figure was unanimous. Treat a failure here as a bug in calc.js, not in the fixture.
 *
 * Rates are USD-anchored (units of CCY per 1 USD) and internally consistent, so every cross
 * triangulates exactly:
 *   EURUSD 1.08500  GBPUSD 1.27000  USDJPY 157.000  USDCAD 1.37000  AUDUSD 0.66000
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FX, INDEX, ENERGY, CalcError, convert, alignRatesToPrice, notional, requiredMargin,
  pipValue, toPips, lotsFromRisk, profitLoss, riskReward, marginLevel, pipsToStopOut, freeMargin,
} from '../calc.js';

const RATES = { USD: 1, EUR: 1 / 1.085, GBP: 1 / 1.27, JPY: 157, CAD: 1.37, AUD: 1 / 0.66 };

const EURUSD = { symbol: 'EURUSD', base: 'EUR', quote: 'USD', type: FX, contractSize: 100000, pipSize: 0.0001, digits: 5 };
const USDJPY = { symbol: 'USDJPY', base: 'USD', quote: 'JPY', type: FX, contractSize: 100000, pipSize: 0.01, digits: 3 };
const GBPJPY = { symbol: 'GBPJPY', base: 'GBP', quote: 'JPY', type: FX, contractSize: 100000, pipSize: 0.01, digits: 3 };
const EURGBP = { symbol: 'EURGBP', base: 'EUR', quote: 'GBP', type: FX, contractSize: 100000, pipSize: 0.0001, digits: 5 };
const AUDCAD = { symbol: 'AUDCAD', base: 'AUD', quote: 'CAD', type: FX, contractSize: 100000, pipSize: 0.0001, digits: 5 };
const US30 = { symbol: 'US30', base: 'USD', quote: 'USD', type: INDEX, contractSize: 1, pipSize: 1, digits: 1 };
const WTI = { symbol: 'XTIUSD', base: 'USD', quote: 'USD', type: ENERGY, contractSize: 1000, pipSize: 0.01, digits: 2 };

const GBPJPY_PRICE = 1.27 * 157;      // 199.39
const EURGBP_PRICE = 1.085 / 1.27;    // 0.85433070866...
const AUDCAD_PRICE = 0.66 * 1.37;     // 0.90420

const close = (actual, expected, tol, label) =>
  assert.ok(Math.abs(actual - expected) <= tol, `${label}: expected ~${expected}, got ${actual}`);
const cents = (a, e, label) => close(a, e, 5e-5, label);

/* ============================== V1-V6: margin, notional, pip value ============================== */

test('V1 EURUSD 1.00 lot @ 1.08500 on a USD account', () => {
  const args = { instrument: EURUSD, lots: 1, price: 1.085, acctCcy: 'USD', rates: RATES };
  cents(notional(args).acct, 108500, 'notional');
  cents(requiredMargin({ ...args, leverage: 400 }).acct, 271.25, 'margin');
  cents(pipValue(args).acct, 10, 'pip value');
});

test('V2 USDJPY margin is rate-independent when the base currency IS the account currency', () => {
  const args = { instrument: USDJPY, lots: 1, price: 157, acctCcy: 'USD', rates: RATES };
  cents(notional(args).acct, 100000, 'notional');
  cents(requiredMargin({ ...args, leverage: 400 }).acct, 250, 'margin');
  cents(pipValue(args).acct, 1000 / 157, 'pip value');

  // The defining property: margin depends only on lots and leverage, never on price.
  for (const price of [90, 157, 250]) {
    cents(requiredMargin({ ...args, price, leverage: 400 }).acct, 250, `margin @ ${price}`);
  }
});

test('V3 GBPJPY 0.50 lot - a cross with neither leg in the account currency', () => {
  const args = { instrument: GBPJPY, lots: 0.5, price: GBPJPY_PRICE, acctCcy: 'USD', rates: RATES };
  cents(notional(args).acct, 63500, 'notional');
  cents(requiredMargin({ ...args, leverage: 400 }).acct, 158.75, 'margin');
  cents(pipValue(args).acct, 500 / 157, 'pip value');
});

test('V4 EURGBP 2.00 lot - triangulation must be exact, not drift', () => {
  const args = { instrument: EURGBP, lots: 2, price: EURGBP_PRICE, acctCcy: 'USD', rates: RATES };
  cents(notional(args).acct, 217000, 'notional');
  cents(requiredMargin({ ...args, leverage: 400 }).acct, 542.5, 'margin');
  cents(pipValue(args).acct, 25.4, 'pip value');

  // Chaining a pre-rounded 7dp cross quote is the classic drift bug; it lands on 216999.9978.
  // Routing through the USD leg keeps it exact even when the caller passes the rounded price.
  cents(notional({ ...args, price: 0.8543307 }).acct, 217000, 'notional from a rounded cross');
});

test('V5 AUDCAD 0.10 lot - both legs foreign, quote inverted against USD', () => {
  const args = { instrument: AUDCAD, lots: 0.1, price: AUDCAD_PRICE, acctCcy: 'USD', rates: RATES };
  cents(notional(args).acct, 6600, 'notional');
  cents(requiredMargin({ ...args, leverage: 400 }).acct, 16.5, 'margin');
  cents(pipValue(args).acct, 1 / 1.37, 'pip value');
});

test('V6 EURUSD on a EUR account - margin becomes price-independent instead', () => {
  const args = { instrument: EURUSD, lots: 1, price: 1.085, acctCcy: 'EUR', rates: RATES };
  cents(notional(args).acct, 100000, 'notional');
  cents(requiredMargin({ ...args, leverage: 400 }).acct, 250, 'margin');
  cents(pipValue(args).acct, 10 / 1.085, 'pip value');
});

/* ==================================== V7: risk-based sizing ==================================== */

test('V7 risk sizing: 1% of 5000 over a 25 pip stop', () => {
  const r = lotsFromRisk({
    instrument: EURUSD, balance: 5000, riskPct: 1, stopPips: 25,
    price: 1.085, acctCcy: 'USD', rates: RATES, lotStep: 0.01,
  });
  cents(r.lots, 0.2, 'lots');
  cents(r.budget, 50, 'budget');
  cents(r.cashAtRisk, 50, 'cash at risk');
  cents(requiredMargin({ instrument: EURUSD, lots: r.lots, price: 1.085, leverage: 400, acctCcy: 'USD', rates: RATES }).acct, 54.25, 'margin');
});

test('V7b sizing rounds DOWN so cash at risk never exceeds the budget', () => {
  // 0.19999... must become 0.19, never 0.20.
  const r = lotsFromRisk({
    instrument: EURUSD, balance: 4999, riskPct: 1, stopPips: 25,
    price: 1.085, acctCcy: 'USD', rates: RATES, lotStep: 0.01,
  });
  cents(r.lots, 0.19, 'lots rounded down');
  assert.ok(r.cashAtRisk <= r.budget, 'cash at risk must not exceed the budget');

  // Sweep the invariant across awkward balances, percentages and stops.
  for (const balance of [100, 317, 1000, 5000, 12345.67]) {
    for (const riskPct of [0.25, 0.5, 1, 2, 3.7]) {
      for (const stopPips of [3, 7.5, 25, 140]) {
        const x = lotsFromRisk({ instrument: EURUSD, balance, riskPct, stopPips, price: 1.085, acctCcy: 'USD', rates: RATES });
        assert.ok(x.cashAtRisk <= x.budget + 1e-9, `over-risked at ${balance}/${riskPct}%/${stopPips}p`);
        assert.ok(Math.abs(x.lots / 0.01 - Math.round(x.lots / 0.01)) < 1e-6, `lots ${x.lots} is off the step grid`);
      }
    }
  }
});

test('V7c an unaffordable stop reports infeasible rather than a nonsense micro-lot', () => {
  const r = lotsFromRisk({
    instrument: EURUSD, balance: 20, riskPct: 1, stopPips: 100,
    price: 1.085, acctCcy: 'USD', rates: RATES, minLot: 0.01,
  });
  assert.equal(r.lots, 0);
  assert.equal(r.feasible, false);
  assert.match(r.reason, /minimum/i);
});

/* ======================================== V8-V9: P/L ======================================== */

test('V8 short EURUSD profits when price falls', () => {
  const r = profitLoss({ instrument: EURUSD, lots: 0.3, entry: 1.085, exit: 1.078, direction: 'sell', acctCcy: 'USD', rates: RATES });
  cents(r.acct, 210, 'P/L');
  cents(r.pips, 70, 'pips');

  // Same move, opposite side, must mirror exactly.
  const long = profitLoss({ instrument: EURUSD, lots: 0.3, entry: 1.085, exit: 1.078, direction: 'buy', acctCcy: 'USD', rates: RATES });
  cents(long.acct, -210, 'mirrored long P/L');
});

test('V9 USDJPY P/L converts at the CLOSING rate, not the entry rate', () => {
  const r = profitLoss({ instrument: USDJPY, lots: 0.2, entry: 157, exit: 158.2, acctCcy: 'USD', rates: RATES });
  cents(r.native, 24000, 'P/L in JPY');
  cents(r.acct, 24000 / 158.2, 'P/L converted at exit');
  close(r.acct, 151.71, 5e-3, 'P/L to the cent');
  assert.ok(Math.abs(r.acct - 24000 / 157) > 1, 'must not have converted at the entry rate');
});

/* ============================ V10: margin level and stop-out distance ============================ */

test('V10 margin level and distance to a 50% stop-out', () => {
  const used = requiredMargin({ instrument: EURUSD, lots: 1, price: 1.085, leverage: 400, acctCcy: 'USD', rates: RATES }).acct;
  cents(used, 271.25, 'used margin');
  close(marginLevel({ equity: 5000, usedMargin: used }), 1843.3179, 1e-3, 'margin level');
  cents(freeMargin({ equity: 5000, usedMargin: used }), 4728.75, 'free margin');

  const s = pipsToStopOut({ equity: 5000, usedMargin: used, stopOutPct: 50, pipValueAcct: 10 });
  cents(s.pips, 486.4375, 'pips to stop-out');
  assert.equal(s.alreadyBreached, false);
});

test('V10b an account already past stop-out is reported, not returned as a negative cushion', () => {
  const s = pipsToStopOut({ equity: 100, usedMargin: 271.25, stopOutPct: 50, pipValueAcct: 10 });
  assert.equal(s.alreadyBreached, true);
});

test('V10c margin level with nothing open is null, never Infinity', () => {
  assert.equal(marginLevel({ equity: 5000, usedMargin: 0 }), null);
  assert.equal(pipsToStopOut({ equity: 5000, usedMargin: 0, stopOutPct: 50, pipValueAcct: 10 }), null);
});

/* ================================== V11-V12: CFD contracts ================================== */

test('V11 US30 index uses the CFD margin path, not the FX one', () => {
  const args = { instrument: US30, lots: 1, price: 38500, acctCcy: 'USD', rates: RATES };
  cents(notional(args).acct, 38500, 'notional');
  cents(requiredMargin({ ...args, leverage: 400 }).acct, 96.25, 'margin');
  cents(pipValue(args).acct, 1, 'value per point');

  // Routing a CFD through the FX formula (contractSize/leverage) would report 0.0025.
  assert.ok(requiredMargin({ ...args, leverage: 400 }).acct > 1, 'CFD margin must scale with price');
});

test('V12 WTI crude, 1000 barrels per lot', () => {
  const args = { instrument: WTI, lots: 1, price: 78.5, acctCcy: 'USD', rates: RATES };
  cents(notional(args).acct, 78500, 'notional');
  cents(requiredMargin({ ...args, leverage: 400 }).acct, 196.25, 'margin');
  cents(pipValue(args).acct, 10, 'value per 0.01 tick');
});

/* ==================================== invariants and guards ==================================== */

test('notional agrees whether routed via the base leg or the quote leg', () => {
  // A wrong conversion direction breaks this identity even when a single value looks plausible.
  for (const [inst, price] of [[EURUSD, 1.085], [USDJPY, 157], [GBPJPY, GBPJPY_PRICE], [EURGBP, EURGBP_PRICE], [AUDCAD, AUDCAD_PRICE]]) {
    const aligned = alignRatesToPrice(inst, price, RATES);
    const viaBase = notional({ instrument: inst, lots: 1, price, acctCcy: 'USD', rates: RATES }).acct;
    const viaQuote = convert(1 * inst.contractSize * price, inst.quote, 'USD', aligned);
    close(viaBase, viaQuote, 1e-6, `${inst.symbol} two-route invariant`);
  }
});

test('pipettes and fractional pips scale linearly', () => {
  close(toPips(EURUSD, 0.00005), 0.5, 1e-12, 'half pip');
  close(toPips(USDJPY, 0.005), 0.5, 1e-12, 'half pip JPY');
});

test('reward-to-risk is direction-agnostic', () => {
  close(riskReward({ entry: 1.085, stopLoss: 1.08, takeProfit: 1.1 }).ratio, 3, 1e-9, 'long 3R');
  close(riskReward({ entry: 1.085, stopLoss: 1.09, takeProfit: 1.07 }).ratio, 3, 1e-9, 'short 3R');
});

test('invalid inputs throw CalcError instead of propagating NaN', () => {
  const base = { instrument: EURUSD, lots: 1, price: 1.085, acctCcy: 'USD', rates: RATES };
  assert.throws(() => requiredMargin({ ...base, leverage: 0 }), CalcError, 'zero leverage');
  assert.throws(() => requiredMargin({ ...base, leverage: -400 }), CalcError, 'negative leverage');
  assert.throws(() => notional({ ...base, lots: 0 }), CalcError, 'zero lots');
  assert.throws(() => notional({ ...base, price: 0 }), CalcError, 'zero price');
  assert.throws(() => notional({ ...base, lots: 'abc' }), CalcError, 'non-numeric lots');
  assert.throws(() => notional({ ...base, lots: Infinity }), CalcError, 'infinite lots');
  assert.throws(() => riskReward({ entry: 1.085, stopLoss: 1.085, takeProfit: 1.1 }), CalcError, 'zero risk');
  assert.throws(() => lotsFromRisk({ ...base, balance: 5000, riskPct: 1, stopPips: 0 }), CalcError, 'zero stop');
  assert.throws(() => notional({ ...base, acctCcy: 'ZWL' }), CalcError, 'unknown account currency');
});

test('numeric input accepts formatted strings from the UI', () => {
  cents(notional({ instrument: EURUSD, lots: '1', price: '1.085', acctCcy: 'USD', rates: RATES }).acct, 108500, 'string inputs');
  cents(notional({ instrument: EURUSD, lots: 1, price: 1.085, acctCcy: 'USD', rates: RATES }).acct, 108500, 'numeric inputs');
});
