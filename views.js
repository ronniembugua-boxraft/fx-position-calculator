/**
 * views.js - rendering. Every value reaches the DOM through textContent; the page's CSP sets
 * `require-trusted-types-for 'script'`, so an innerHTML assignment throws rather than quietly
 * becoming an XSS sink, and CI greps for the same thing.
 */
import {
  notional, requiredMargin, pipValue, lotsFromRisk, profitLoss, riskReward,
  marginLevel, pipsToStopOut, freeMargin, conversionLegs, CalcError, FX,
} from './calc.js';
import { findInstrument, describeLot } from './instruments.js';
import { freshness } from './rates.js';
import { money, units, price as fmtPrice, pct, setText, setAlert } from './format.js';
import { ctx, save, instrument, marginArgs, currentPrice, usedMargin } from './state.js';

const $ = (id) => document.getElementById(id);

/** app.js installs the re-render hook so a row delete can refresh everything. */
let refresh = () => {};
export function setRefresh(fn) { refresh = fn; }

/* -------------------------------------------------------------- rendering */

export function renderSize() {
  const inst = instrument();
  const p = currentPrice();
  const err = $('size-err');
  setText($('lev-cap'), inst.regulatedCap || '');

  if (!p) {
    for (const id of ['r-margin', 'r-notional', 'r-pip', 'r-free', 'r-level']) setText($(id), '—');
    setText($('r-derivation'), '');
    err.hidden = false;
    err.textContent = $('price').hasAttribute('aria-invalid')
      ? 'The price above could not be read, so nothing is being calculated.'
      : inst.type === FX
        ? 'No rate available yet — enter the price manually.'
        : `Enter the current ${inst.symbol} price. Index and energy prices are not available from a currency rate feed.`;
    return;
  }
  err.hidden = true;

  try {
    const args = { instrument: inst, lots: ctx.state.lots, price: p, acctCcy: ctx.state.acctCcy, rates: ctx.rates };
    const n = notional(args);
    const m = requiredMargin({ ...args, ...marginArgs(inst) });
    const pv = pipValue(args);
    const used = usedMargin();
    const equity = ctx.state.balance;
    const freeBefore = freeMargin({ equity, usedMargin: used });
    const freeAfter = freeBefore - m.acct;
    const levelAfter = marginLevel({ equity, usedMargin: used + m.acct });

    setText($('r-margin'), money(m.acct, ctx.state.acctCcy));
    setText($('r-notional'), money(n.acct, ctx.state.acctCcy, { compact: true }));
    setText($('r-pip'), money(pv.acct, ctx.state.acctCcy));
    setText($('r-pip-label'), inst.type === FX ? 'Value per pip' : 'Value per point');
    setText($('r-free'), money(freeAfter, ctx.state.acctCcy));
    setText($('r-level'), levelAfter == null ? '—' : pct(levelAfter, 0));
    $('r-free').className = `v ${freeAfter < 0 ? 'neg' : ''}`;
    $('r-level').className = `v ${levelAfter != null && levelAfter < ctx.state.stopOut * 2 ? 'warn' : ''}`;

    // Spelled out so a wrong contract size is visible rather than buried.
    const legs = conversionLegs(inst.type === FX ? inst.base : inst.quote, ctx.state.acctCcy);
    setText($('r-derivation'),
      `${describeLot(inst, ctx.state.lots)} = ${money(n.acct, ctx.state.acctCcy)} notional · ` +
      `1 ${inst.type === FX ? 'pip' : 'point'} = ${inst.pipSize} = ${money(pv.acct, ctx.state.acctCcy)} · ` +
      `margin ${units(100 / (m.effectiveLeverage), 3)}% (1:${units(m.effectiveLeverage)})` +
      (legs.length ? ` · via ${legs.join(', ')}` : ''));

    // Segments carry a min-width so a thin sliver stays visible; hide empty ones outright so
    // "nothing is open" does not render as a stray mark in the used-margin colour.
    const total = Math.max(equity, used + m.acct);
    const seg = (id, value) => {
      const el = $(id), frac = total > 0 ? value / total : 0;
      el.style.width = `${Math.max(0, frac) * 100}%`;
      el.style.display = frac > 0.0001 ? '' : 'none';
    };
    seg('bar-used', used);
    seg('bar-new', m.acct);
    seg('bar-free', equity - used - m.acct);
    setText($('lg-used'), money(used, ctx.state.acctCcy));
    setText($('lg-new'), money(m.acct, ctx.state.acctCcy));
    setText($('lg-free'), money(Math.max(0, freeAfter), ctx.state.acctCcy));

    setAlert($('size-alert'),
      freeAfter < 0 ? `This position needs ${money(m.acct, ctx.state.acctCcy)} but only ${money(freeBefore, ctx.state.acctCcy)} is free. Your broker would reject it.`
        : levelAfter != null && levelAfter < ctx.state.stopOut * 2 ? `Margin level would fall to ${pct(levelAfter, 0)}, close to the ${pct(ctx.state.stopOut, 0)} stop-out.`
        : '', freeAfter < 0 ? 'bad' : 'warn');
  } catch (e) {
    err.hidden = false;
    err.textContent = e instanceof CalcError ? e.message : 'Check the values above.';
  }
}

export function renderRisk() {
  const inst = instrument();
  const p = currentPrice();
  const err = $('risk-err');
  if (!p || !ctx.rates) { err.hidden = false; err.textContent = 'A price is needed before a size can be worked out.'; return; }
  try {
    const used = usedMargin();
    const r = lotsFromRisk({
      instrument: inst, balance: ctx.state.balance, riskPct: ctx.state.riskPct, stopPips: ctx.state.stopPips,
      price: p, acctCcy: ctx.state.acctCcy, rates: ctx.rates, lotStep: inst.lotStep, minLot: inst.minLot, maxLot: inst.maxLot,
      spreadPips: ctx.state.spread, commissionPerLot: ctx.state.commission,
      freeMarginAvail: freeMargin({ equity: ctx.state.balance, usedMargin: used }), ...marginArgs(inst),
    });
    err.hidden = true;
    setText($('k-lots'), r.feasible ? `${r.lots.toFixed(2)} lots` : 'Too small');
    $('k-lots').className = `value ${r.feasible ? '' : 'muted'}`;
    setText($('k-risk'), money(r.cashAtRisk, ctx.state.acctCcy));
    setText($('k-budget'), money(r.budget, ctx.state.acctCcy));
    setText($('k-margin'), r.marginNeeded == null ? '—' : money(r.marginNeeded, ctx.state.acctCcy));
    setText($('k-costs'), money(r.spreadCost + r.commissionCost, ctx.state.acctCcy));
    setText($('k-derivation'),
      `${money(r.budget, ctx.state.acctCcy)} budget ÷ (${units(ctx.state.stopPips)} + ${units(ctx.state.spread)} pips × ` +
      `${money(r.pipValuePerLot, ctx.state.acctCcy)}/pip + ${money(ctx.state.commission, ctx.state.acctCcy)} commission) ` +
      `= ${units(r.rawLots, 4)} lots, rounded down to ${r.lots.toFixed(2)}`);
    setAlert($('risk-alert'),
      !r.feasible ? r.reason
        : r.cappedByMargin ? `Capped by free margin: your risk budget allowed more, but the account can only fund ${r.lots.toFixed(2)} lots.`
        : r.cappedByMaxLot ? `Capped at the ${inst.maxLot} lot maximum.`
        : ctx.state.spread === 0 && ctx.state.commission === 0 ? 'Spread and commission are set to zero, so this is a best-case figure. Add them for your real risk.'
        : '', !r.feasible || r.cappedByMargin ? 'bad' : 'warn');
  } catch (e) {
    err.hidden = false;
    err.textContent = e instanceof CalcError ? e.message : 'Check the values above.';
  }
}

export function renderTrade() {
  const inst = instrument();
  const err = $('trade-err');
  const { entry, sl, tp, tradeLots } = ctx.state;
  if (!ctx.rates || !entry || !sl || !tp) {
    for (const id of ['t-rr', 't-tp-pl', 't-sl-pl', 't-tp-pips', 't-sl-pips']) setText($(id), '—');
    setText($('t-derivation'), '');
    err.hidden = false; err.textContent = 'Enter an entry, a stop loss and a take profit.';
    return;
  }
  try {
    const dir = ctx.state.direction;
    const common = { instrument: inst, lots: tradeLots, entry, acctCcy: ctx.state.acctCcy, rates: ctx.rates, direction: dir };
    const atTp = profitLoss({ ...common, exit: tp });
    const atSl = profitLoss({ ...common, exit: sl });
    const rr = riskReward({ entry, stopLoss: sl, takeProfit: tp });
    err.hidden = true;

    setText($('t-rr'), `${rr.ratio.toFixed(2)} : 1`);
    $('t-rr').className = `value ${rr.ratio >= 2 ? 'pos' : rr.ratio < 1 ? 'neg' : ''}`;
    setText($('t-tp-pl'), money(atTp.acct, ctx.state.acctCcy));
    setText($('t-sl-pl'), money(atSl.acct, ctx.state.acctCcy));
    setText($('t-tp-pips'), `${units(Math.abs(atTp.pips), 1)} pips`);
    setText($('t-sl-pips'), `${units(Math.abs(atSl.pips), 1)} pips`);

    const m = requiredMargin({ instrument: inst, lots: tradeLots, price: entry, acctCcy: ctx.state.acctCcy, rates: ctx.rates, ...marginArgs(inst) });
    const levelAtSl = marginLevel({ equity: ctx.state.balance + atSl.acct, usedMargin: usedMargin() + m.acct });
    setText($('t-derivation'),
      `${dir === 'sell' ? 'Short' : 'Long'} ${tradeLots} lot from ${fmtPrice(entry, inst.digits)} · ` +
      `P/L converts at the closing rate · margin level if the stop is hit: ${levelAtSl == null ? '—' : pct(levelAtSl, 0)}`);

    const wrongSide = dir === 'buy' ? (sl > entry || tp < entry) : (sl < entry || tp > entry);
    setAlert($('trade-alert'),
      wrongSide ? `For a ${dir}, the stop and target are on the wrong sides of the entry.`
        : atSl.acct > 0 ? 'Your "stop loss" is in profit — check the direction.'
        : levelAtSl != null && levelAtSl < ctx.state.stopOut ? `If this stop is hit the account drops below the ${pct(ctx.state.stopOut, 0)} stop-out level.`
        : rr.ratio < 1 ? `Risking ${money(Math.abs(atSl.acct), ctx.state.acctCcy)} to make ${money(atTp.acct, ctx.state.acctCcy)}.`
        : '', wrongSide || (levelAtSl != null && levelAtSl < ctx.state.stopOut) ? 'bad' : 'warn');
  } catch (e) {
    err.hidden = false;
    err.textContent = e instanceof CalcError ? e.message : 'Check the values above.';
  }
}

export function renderAccount() {
  const used = usedMargin();
  const equity = ctx.state.balance;
  const free = freeMargin({ equity, usedMargin: used });
  const level = marginLevel({ equity, usedMargin: used });
  setText($('a-used'), money(used, ctx.state.acctCcy));
  setText($('a-free'), money(free, ctx.state.acctCcy));
  setText($('a-level'), level == null ? 'No positions' : pct(level, 0));
  $('a-level').className = `v ${level != null && level < ctx.state.stopOut * 2 ? 'warn' : ''}`;

  let dist = '—';
  const first = ctx.state.positions[0];
  if (first && ctx.rates) {
    try {
      const inst = findInstrument(first.symbol, ctx.state.overrides);
      const pv = pipValue({ instrument: inst, lots: first.lots, price: first.price, acctCcy: ctx.state.acctCcy, rates: ctx.rates }).acct;
      const s = pipsToStopOut({ equity, usedMargin: used, stopOutPct: ctx.state.stopOut, pipValueAcct: pv });
      dist = s == null ? '—' : s.alreadyBreached ? 'Breached' : `${units(s.pips, 0)} pips`;
    } catch { dist = '—'; }
  }
  setText($('a-stopdist'), dist);
  setAlert($('acct-alert'),
    free < 0 ? 'Open positions need more margin than the account holds.'
      : level != null && level < ctx.state.stopOut ? 'The account is below its stop-out level.' : '', 'bad');
  renderPositions();
  setText($('acct-summary'), `${ctx.state.acctCcy} account · 1:${units(ctx.state.leverage)}`);
}

export function renderPositions() {
  const host = $('pos-rows');
  while (host.firstChild) host.removeChild(host.firstChild);
  if (!ctx.state.positions.length) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = 'Nothing open. Add a position to see its effect on free margin.';
    host.appendChild(p);
    return;
  }
  ctx.state.positions.forEach((pos, i) => {
    const inst = findInstrument(pos.symbol, ctx.state.overrides);
    let marginText = '—';
    if (inst && ctx.rates) {
      try {
        marginText = money(requiredMargin({ instrument: inst, lots: pos.lots, price: pos.price, acctCcy: ctx.state.acctCcy, rates: ctx.rates, ...marginArgs(inst) }).acct, ctx.state.acctCcy);
      } catch { /* leave as em dash */ }
    }
    const row = document.createElement('div');
    row.className = 'row';
    const grow = document.createElement('div');
    grow.className = 'grow';
    const sym = document.createElement('div');
    sym.className = 'sym';
    sym.textContent = `${pos.direction === 'sell' ? 'Sell' : 'Buy'} ${pos.lots} ${pos.symbol}`;
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = `at ${fmtPrice(pos.price, inst ? inst.digits : 5)}`;
    grow.append(sym, meta);
    const amt = document.createElement('div');
    amt.className = 'amt';
    amt.textContent = marginText;
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'icon-btn';
    del.setAttribute('aria-label', `Remove ${pos.symbol} position`);
    del.textContent = '×';
    del.addEventListener('click', () => { ctx.state.positions.splice(i, 1); save(); refresh(); });
    row.append(grow, amt, del);
    host.appendChild(row);
  });
}

export function renderRateChip() {
  const f = freshness(ctx.rateMeta.updatedAt);
  $('rate-dot').className = `dot ${f.status}`;
  setText($('rate-label'), ctx.rateMeta.status === 'loading' ? 'Loading…' : f.label);
  setText($('rt-source'), ctx.rateMeta.attribution || 'No source yet');
  setText($('rt-updated'), ctx.rateMeta.origin === 'none' ? 'Never fetched — enter prices manually' : `${f.label}${ctx.rateMeta.degraded ? ' · offline, using cache' : ''}`);
  setText($('attribution'), ctx.rateMeta.attribution || '');
  const inst = instrument();
  const legs = conversionLegs(inst.type === FX ? inst.base : inst.quote, ctx.state.acctCcy);
  setText($('rt-legs'), legs.length
    ? `${ctx.state.symbol} on a ${ctx.state.acctCcy} account converts through ${legs.join(' and ')}.`
    : `${ctx.state.symbol} settles in ${ctx.state.acctCcy}, so no conversion is needed.`);
}

export function renderAll() {
  renderRateChip(); renderSize(); renderRisk(); renderTrade(); renderAccount();
}
