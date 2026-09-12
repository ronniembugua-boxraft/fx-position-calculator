/**
 * Vectors that a plausible-but-wrong engine still passes on the primary suite.
 *
 * The twelve headline vectors share a structural blind spot: every conversion in them is either an
 * identity, a multiply-by-XXXUSD, or a divide-by-USDYYY. None multiplies by USDYYY, none takes two
 * hops, and no instrument settles in a non-USD currency. An engine hardcoding
 * `if (pair.startsWith('USD')) rate = 1/quote` passes all twelve and is wrong by 24,686x here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FX, INDEX, CalcError, parseDecimal, num, notional, requiredMargin, pipValue,
  lotsFromRisk, profitLoss, conversionLegs, marginDivisor,
} from '../calc.js';

const RATES = { USD: 1, EUR: 1 / 1.085, GBP: 1 / 1.27, JPY: 157, CAD: 1.37, AUD: 1 / 0.66 };
const EURUSD = { symbol: 'EURUSD', base: 'EUR', quote: 'USD', type: FX, contractSize: 100000, pipSize: 0.0001 };
const USDJPY = { symbol: 'USDJPY', base: 'USD', quote: 'JPY', type: FX, contractSize: 100000, pipSize: 0.01 };
const AUDCAD = { symbol: 'AUDCAD', base: 'AUD', quote: 'CAD', type: FX, contractSize: 100000, pipSize: 0.0001 };
const GER40 = { symbol: 'GER40', base: 'GER40', quote: 'EUR', type: INDEX, contractSize: 1, pipSize: 1 };

const close = (a, e, tol, label) => assert.ok(Math.abs(a - e) <= tol, `${label}: expected ~${e}, got ${a}`);
const cents = (a, e, label) => close(a, e, 5e-5, label);

/* ===================== conversion shapes the headline vectors never exercise ===================== */

test('V13 account currency IS the quote currency - must multiply by USDJPY, not divide', () => {
  const args = { instrument: USDJPY, lots: 1, price: 157, acctCcy: 'JPY', rates: RATES };
  cents(notional(args).acct, 15700000, 'notional');
  cents(requiredMargin({ ...args, leverage: 400 }).acct, 39250, 'margin');
  cents(pipValue(args).acct, 1000, 'pip value needs no conversion at all');
  // An inverted conversion returns 1.59 here instead of 39250 - a 24,686x error.
  assert.ok(requiredMargin({ ...args, leverage: 400 }).acct > 1000, 'conversion direction inverted');
});

test('V14 account currency is neither leg - two hops, multiply then multiply', () => {
  const args = { instrument: EURUSD, lots: 1, price: 1.085, acctCcy: 'JPY', rates: RATES };
  cents(notional(args).acct, 17034500, 'notional');
  cents(requiredMargin({ ...args, leverage: 400 }).acct, 42586.25, 'margin');
  cents(pipValue(args).acct, 1570, 'pip value');
});

test('V15 two hops, divide then divide - and no intermediate rounding', () => {
  const args = { instrument: AUDCAD, lots: 0.1, price: 0.9042, acctCcy: 'GBP', rates: RATES };
  cents(notional(args).acct, 5196.8504, 'notional');
  cents(requiredMargin({ ...args, leverage: 400 }).acct, 12.9921, 'margin');
  // CAD -> USD (/1.37) -> GBP (/1.27). Rounding the intermediate to 2dp yields 0.5748.
  close(pipValue(args).acct, 0.5747, 5e-5, 'pip value must carry full precision');
});

test('V16 P/L at the closing rate, on a losing short - discriminates from the entry rate', () => {
  const r = profitLoss({ instrument: USDJPY, lots: 1, entry: 157, exit: 157.5, direction: 'sell', acctCcy: 'USD', rates: RATES });
  cents(r.native, -50000, 'loss in JPY');
  close(r.acct, -317.4603, 1e-3, 'converted at the closing rate');
  assert.ok(Math.abs(r.acct - (-318.4713)) > 1, 'must not have used the entry rate');
});

test('V18 non-USD-settled index on a percentage margin - separates the CFD path from the FX one', () => {
  const args = { instrument: GER40, lots: 1, price: 18000, acctCcy: 'USD', rates: RATES };
  cents(notional(args).acct, 19530, 'notional in USD from a EUR-settled index');
  cents(requiredMargin({ ...args, marginPercent: 5 }).acct, 976.5, 'margin at 5%');
  cents(pipValue(args).acct, 1.085, 'one index point is worth one EUR');
  // US30/WTI pass with either formula because quote == account == USD. This one does not.
  cents(requiredMargin({ ...args, leverage: 20 }).acct, 976.5, '5% and 1:20 are the same thing');
});

test('margin percent and leverage are reciprocal', () => {
  cents(marginDivisor({ leverage: 400 }), 400, 'leverage passthrough');
  cents(marginDivisor({ marginPercent: 5 }), 20, '5% -> 1:20');
  cents(marginDivisor({ marginPercent: 0.25 }), 400, '0.25% -> 1:400');
  assert.throws(() => marginDivisor({ marginPercent: 0 }), CalcError, 'zero percent');
  assert.throws(() => marginDivisor({}), CalcError, 'neither supplied');
});

/* ======================= locale parsing: a silent 1000x error if unhandled ======================= */

test('decimal separators are parsed, not guessed', () => {
  cents(parseDecimal('1.085'), 1.085, 'plain dot decimal');
  cents(parseDecimal('38500'), 38500, 'no separator');
  cents(parseDecimal('1 085,50'), 1085.5, 'space grouping, comma decimal (fr)');
  cents(parseDecimal('1.234,56'), 1234.56, 'dot grouping, comma decimal (de)');
  cents(parseDecimal('1,234.56'), 1234.56, 'comma grouping, dot decimal (en)');
  cents(parseDecimal('1.085.000'), 1085000, 'repeated dot can only be grouping');
  cents(parseDecimal('1,085,000'), 1085000, 'repeated comma can only be grouping');
  cents(parseDecimal('-0.5'), -0.5, 'negative');
  assert.ok(Number.isNaN(parseDecimal('abc')), 'letters are not a number');
  assert.ok(Number.isNaN(parseDecimal('')), 'empty is not a number');
});

test('genuinely ambiguous input is refused rather than guessed', () => {
  // "1,085" is 1.085 to a German and 1085 to an American. Guessing is a 1000x error either way.
  assert.throws(() => parseDecimal('1,085'), (e) => e.code === 'AMBIGUOUS_DECIMAL');
  assert.throws(() => parseDecimal('38,500'), (e) => e.code === 'AMBIGUOUS_DECIMAL');
  assert.throws(() => num('1,085', 'price'), CalcError, 'num() propagates the refusal');
});

test('regression: a comma price can never silently inflate the notional', () => {
  // Before the locale fix this returned 108,500,000 instead of 108,500.
  assert.throws(
    () => notional({ instrument: EURUSD, lots: 1, price: '1,085', acctCcy: 'USD', rates: RATES }),
    CalcError,
  );
  cents(notional({ instrument: EURUSD, lots: 1, price: '1.085', acctCcy: 'USD', rates: RATES }).acct, 108500, 'dot form still works');
});

/* ===================== risk sizing: the costs that turn 1% into 1.3% ===================== */

test('the float-quantization trap: 0.29 must not collapse to 0.28', () => {
  // 0.29 / 0.01 === 28.999999999999996 in IEEE-754, so a naive floor loses a whole step.
  const r = lotsFromRisk({ instrument: EURUSD, balance: 5800, riskPct: 1.5, stopPips: 30, price: 1.085, acctCcy: 'USD', rates: RATES });
  cents(r.lots, 0.29, 'lots');
  assert.equal(Math.floor((87 / 300) / 0.01) * 0.01, 0.28, 'the naive formula really does fail here');
});

test('spread and commission are part of the risk, not an afterthought', () => {
  const base = { instrument: EURUSD, balance: 5000, riskPct: 1, stopPips: 10, price: 1.085, acctCcy: 'USD', rates: RATES };
  const naive = lotsFromRisk(base);
  cents(naive.lots, 0.5, 'mid-price-only sizing');

  const real = lotsFromRisk({ ...base, spreadPips: 1.2, commissionPerLot: 7 });
  cents(real.lots, 0.42, 'sizing that accounts for spread and commission');
  assert.ok(real.cashAtRisk <= real.budget, 'still inside the budget');

  // What the naive answer actually costs: 0.5 lots x ((10+1.2) x 10 + 7) = 59.50 = 1.19%, not 1%.
  const trueCostOfNaive = naive.lots * ((10 + 1.2) * 10 + 7);
  close(trueCostOfNaive, 59.5, 1e-9, 'the naive size over-risks by 19%');
  assert.ok(trueCostOfNaive > naive.budget, 'confirms the over-risk');
});

test('a position the account cannot fund is capped, not cheerfully recommended', () => {
  const r = lotsFromRisk({
    instrument: EURUSD, balance: 50000, riskPct: 1, stopPips: 25, price: 1.085,
    acctCcy: 'USD', rates: RATES, freeMarginAvail: 100, leverage: 400,
  });
  cents(r.lots, 0.36, 'capped to what 100 USD of free margin can hold');
  assert.equal(r.cappedByMargin, true);
  assert.ok(r.marginNeeded <= 100, 'must fit inside free margin');

  // Without the free-margin input it would have recommended 2.00 lots needing 542.50.
  const unconstrained = lotsFromRisk({ instrument: EURUSD, balance: 50000, riskPct: 1, stopPips: 25, price: 1.085, acctCcy: 'USD', rates: RATES });
  cents(unconstrained.lots, 2, 'risk alone would allow 2 lots');
});

/* ============================== rate legs the UI must disclose ============================== */

test('every conversion names the rate legs it depends on', () => {
  assert.deepEqual(conversionLegs('USD', 'USD'), []);
  assert.deepEqual(conversionLegs('EUR', 'USD'), ['USD/EUR']);
  assert.deepEqual(conversionLegs('USD', 'JPY'), ['USD/JPY']);
  // GBP account trading AUDCAD offline needs two legs beyond the traded price.
  assert.deepEqual(conversionLegs('CAD', 'GBP'), ['USD/CAD', 'USD/GBP']);
});
