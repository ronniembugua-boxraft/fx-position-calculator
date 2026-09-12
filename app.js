/**
 * app.js - boot, controls and input binding.
 *
 * Inputs are type="text" with inputmode="decimal" rather than type="number": a numeric input
 * silently discards what the browser considers malformed, which would hide exactly the
 * locale-separator cases parseDecimal exists to catch. Parsed values are echoed back on blur so
 * what the app understood is always visible.
 */
import { parseDecimal, CalcError, FX } from './calc.js';
import { INSTRUMENTS, GROUPS, ACCOUNT_CURRENCIES, findInstrument } from './instruments.js';
import { getRates } from './rates.js';
import { setText } from './format.js';
import { ctx, save, resetAll, instrument, livePrice, currentPrice } from './state.js';
import { renderAll, setRefresh } from './views.js';

const $ = (id) => document.getElementById(id);
const st = () => ctx.state;

const LOT_CHIPS = [0.01, 0.1, 0.5, 1, 2, 5];
const LEV_CHIPS = [30, 100, 200, 400, 500, 1000];
const RISK_CHIPS = [0.5, 1, 2, 3];

/* ------------------------------------------------------------- populating */

function buildInstruments() {
  const sel = $('sym');
  for (const g of GROUPS) {
    const group = document.createElement('optgroup');
    group.label = g.label;
    for (const inst of INSTRUMENTS.filter(g.match)) {
      const o = document.createElement('option');
      o.value = inst.symbol;
      o.textContent = inst.type === FX ? inst.symbol : `${inst.symbol} — ${inst.name}`;
      group.appendChild(o);
    }
    sel.appendChild(group);
  }
  sel.value = st().symbol;
}

function buildCurrencies() {
  const sel = $('a-ccy');
  for (const c of ACCOUNT_CURRENCIES) {
    const o = document.createElement('option');
    o.value = c; o.textContent = c;
    sel.appendChild(o);
  }
  sel.value = st().acctCcy;
}

function buildChips(hostId, values, label, isActive, onPick) {
  const host = $(hostId);
  while (host.firstChild) host.removeChild(host.firstChild);
  for (const v of values) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'pill';
    b.textContent = label(v);
    b.setAttribute('aria-pressed', String(isActive(v)));
    b.addEventListener('click', () => { onPick(v); save(); refresh(); });
    host.appendChild(b);
  }
}

function buildAllChips() {
  buildChips('lot-chips', LOT_CHIPS, (v) => v.toFixed(2), (v) => st().lots === v, (v) => { st().lots = v; });
  buildChips('lev-chips', LEV_CHIPS, (v) => `1:${v}`, (v) => st().leverage === v, (v) => { st().leverage = v; });
  buildChips('risk-chips', RISK_CHIPS, (v) => `${v}%`, (v) => st().riskPct === v, (v) => { st().riskPct = v; });
}

/* ---------------------------------------------------------------- binding */

/** Bind a text field to a numeric state key, refusing rather than guessing at bad input. */
function bindNumber(id, key, { noteId = null, echo = false, transform = (v) => v } = {}) {
  const el = $(id);
  if (!el) return;
  const apply = () => {
    const raw = el.value.trim();
    if (raw === '') {
      el.removeAttribute('aria-invalid');
      if (noteId) setText($(noteId), '');
      st()[key] = null; save(); refresh(); return;
    }
    try {
      const v = parseDecimal(raw);
      if (!Number.isFinite(v)) throw new CalcError('Not a number', 'NOT_FINITE');
      el.removeAttribute('aria-invalid');
      if (noteId) setText($(noteId), '');
      st()[key] = transform(v); save(); refresh();
    } catch (e) {
      // Null the value and re-render. Leaving the previous result on screen would show a plausible
      // figure that does not correspond to what was typed - the worst possible failure mode for a
      // number someone is about to trade on.
      el.setAttribute('aria-invalid', 'true');
      if (noteId) setText($(noteId), e instanceof CalcError ? e.message : 'Not a number');
      st()[key] = null; save(); refresh();
    }
  };
  el.addEventListener('input', apply);
  if (echo) {
    // Show what was actually parsed, so a separator misread can never pass unnoticed.
    el.addEventListener('blur', () => {
      const v = st()[key];
      if (Number.isFinite(v) && el.value.trim() !== '' && !el.hasAttribute('aria-invalid')) {
        el.value = String(v);
      }
    });
  }
}

function bindToggleGroup() {
  for (const b of document.querySelectorAll('[data-dir]')) {
    b.addEventListener('click', () => {
      st().direction = b.dataset.dir; save(); refresh();
    });
  }
  $('price-auto').addEventListener('click', () => {
    st().priceAuto = !st().priceAuto;
    if (!st().priceAuto && st().manualPrice == null) st().manualPrice = currentPrice();
    save(); refresh();
  });
  $('lots-up').addEventListener('click', () => stepLots(1));
  $('lots-down').addEventListener('click', () => stepLots(-1));
}

function stepLots(dir) {
  const inst = instrument();
  const next = Number(((st().lots || 0) + dir * inst.lotStep * 10).toFixed(2));
  st().lots = Math.max(inst.lotStep, next);
  save(); refresh();
}

function bindTabs() {
  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => {
      for (const t of document.querySelectorAll('.tab')) {
        const on = t === tab;
        t.setAttribute('aria-selected', String(on));
        $(`panel-${t.dataset.panel}`).hidden = !on;
      }
      window.scrollTo({ top: 0, behavior: 'instant' });
    });
  }
}

function bindSpecEditor() {
  const modeSel = $('s-margin-mode');
  const sync = () => { $('s-margin-value-wrap').hidden = modeSel.value === ''; };

  const writeOverride = (patch) => {
    const sym = st().symbol;
    st().overrides[sym] = { ...(st().overrides[sym] || {}), ...patch };
    save(); refresh();
  };
  $('s-contract').addEventListener('input', (e) => {
    const v = Number(parseDecimal(e.target.value));
    if (Number.isFinite(v) && v > 0) writeOverride({ contractSize: v });
  });
  $('s-pip').addEventListener('input', (e) => {
    const v = Number(parseDecimal(e.target.value));
    if (Number.isFinite(v) && v > 0) writeOverride({ pipSize: v });
  });
  modeSel.addEventListener('change', () => {
    sync();
    writeOverride({ marginMode: modeSel.value || null, marginValue: modeSel.value ? (modeSel.value === 'percent' ? 1 : 100) : null });
  });
  $('s-margin-value').addEventListener('input', (e) => {
    const v = Number(parseDecimal(e.target.value));
    if (Number.isFinite(v) && v > 0) writeOverride({ marginValue: v });
  });
  $('s-reset').addEventListener('click', () => {
    delete st().overrides[st().symbol];
    save(); refresh();
  });
  sync();
}

function bindActions() {
  $('sym').addEventListener('change', (e) => {
    st().symbol = e.target.value;
    st().manualPrice = null;
    st().priceAuto = true;
    save(); refresh();
  });
  $('a-ccy').addEventListener('change', (e) => { st().acctCcy = e.target.value; save(); refresh(); });

  $('add-pos').addEventListener('click', () => {
    const p = currentPrice();
    if (!p || !st().lots) return;
    st().positions.push({ symbol: st().symbol, lots: st().lots, price: p, direction: st().direction });
    save(); refresh();
    setText($('live'), `Added ${st().lots} lots of ${st().symbol} to open positions.`);
  });

  $('rate-chip').addEventListener('click', () => loadRates(true));
  $('rt-refresh').addEventListener('click', () => loadRates(true));
}

/* --------------------------------------------------------------- syncing */

/** Push state back into the controls, skipping whatever the user is currently typing in. */
function syncInputs() {
  const inst = instrument();
  const active = document.activeElement;
  const put = (id, value) => {
    const el = $(id);
    if (el && el !== active) el.value = value == null ? '' : String(value);
  };

  const p = currentPrice();
  put('price', p == null ? '' : p.toFixed(inst.digits));
  $('price-auto').setAttribute('aria-pressed', String(st().priceAuto));
  $('price-auto').textContent = st().priceAuto ? 'Live' : 'Manual';
  $('price-auto').disabled = inst.type !== FX;
  if (inst.type !== FX && st().priceAuto) { st().priceAuto = false; }
  // Never overwrite a live validation message with the generic hint.
  if (!$('price').hasAttribute('aria-invalid')) setText($('price-note'), inst.type === FX
    ? (st().priceAuto ? 'Mid-market reference rate. Tap Live to type your broker’s price.' : 'Your price. Tap Manual to go back to the live rate.')
    : `${inst.symbol} has no currency-feed price — enter your broker’s quote.`);

  put('lots', st().lots == null ? '' : st().lots.toFixed(2));
  put('a-balance', st().balance);
  put('a-lev', st().leverage);
  put('a-stopout', st().stopOut);
  put('risk-pct', st().riskPct);
  put('stop-pips', st().stopPips);
  put('spread', st().spread);
  put('commission', st().commission);
  put('t-entry', st().entry ?? (p ? p.toFixed(inst.digits) : ''));
  put('t-sl', st().sl);
  put('t-tp', st().tp);
  put('t-lots', st().tradeLots);
  put('s-contract', inst.contractSize);
  put('s-pip', inst.pipSize);
  put('s-margin-value', inst.marginValue);
  if ($('s-margin-mode') !== active) $('s-margin-mode').value = inst.marginMode || '';
  $('s-margin-value-wrap').hidden = !inst.marginMode;
  setText($('spec-for'), `${inst.symbol} — ${inst.name}. ${inst.regulatedCap || ''}`);
  if ($('sym') !== active) $('sym').value = st().symbol;
  if ($('a-ccy') !== active) $('a-ccy').value = st().acctCcy;

  for (const b of document.querySelectorAll('[data-dir]')) {
    b.setAttribute('aria-pressed', String(b.dataset.dir === st().direction));
  }
  buildAllChips();
}

function refresh() { renderAll(); syncInputs(); }

/* ------------------------------------------------------------------ boot */

async function loadRates(force = false) {
  ctx.rateMeta = { ...ctx.rateMeta, status: 'loading' };
  $('rate-chip').disabled = true;
  refresh();
  try {
    const r = await getRates({ forceRefresh: force });
    ctx.rates = r.rates;
    ctx.rateMeta = r;
  } catch {
    ctx.rateMeta = { status: 'none', origin: 'none' };
  } finally {
    $('rate-chip').disabled = false;
    refresh();
  }
}

function boot() {
  buildInstruments();
  buildCurrencies();
  bindTabs();
  bindToggleGroup();
  bindActions();
  bindSpecEditor();

  // Registered before bindNumber's listener so the mode flips before the value is read: typing
  // into the price field is itself the signal that the user wants their own price, and the field
  // stays editable at all times rather than relying on a focus handler to unlock it.
  $('price').addEventListener('input', () => { st().priceAuto = false; }, true);
  bindNumber('price', 'manualPrice', { noteId: 'price-note', echo: true });
  bindNumber('lots', 'lots');
  bindNumber('a-balance', 'balance');
  bindNumber('a-lev', 'leverage');
  bindNumber('a-stopout', 'stopOut');
  bindNumber('risk-pct', 'riskPct');
  bindNumber('stop-pips', 'stopPips');
  bindNumber('spread', 'spread');
  bindNumber('commission', 'commission');
  bindNumber('t-entry', 'entry', { echo: true });
  bindNumber('t-sl', 'sl', { echo: true });
  bindNumber('t-tp', 'tp', { echo: true });
  bindNumber('t-lots', 'tradeLots');

  setRefresh(refresh);
  refresh();
  loadRates(false);

  const secure = location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(location.hostname);
  if ('serviceWorker' in navigator && secure) {
    // Trusted Types is enforced, so a raw string is not an acceptable script URL. The policy
    // below is an allow-list of exactly one file; anything else throws. innerHTML stays blocked
    // because no TrustedHTML policy exists.
    let url = 'sw.js';
    try {
      if (window.trustedTypes && window.trustedTypes.createPolicy) {
        const policy = window.trustedTypes.createPolicy('sw-loader', {
          createScriptURL: (u) => {
            if (u !== 'sw.js') throw new TypeError(`Refused script URL: ${u}`);
            return u;
          },
        });
        url = policy.createScriptURL('sw.js');
      }
      navigator.serviceWorker.register(url).catch(() => { /* offline is a bonus, not a requirement */ });
    } catch { /* no service worker: the app still works, it just will not run offline */ }
  }
}

document.addEventListener('DOMContentLoaded', boot);
export { resetAll, findInstrument, livePrice };   // exposed for tests and console debugging
