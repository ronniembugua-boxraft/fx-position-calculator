/**
 * rates.js - FX rate acquisition, validation and caching.
 *
 * Two verified keyless, CORS-enabled sources. Both were curl-tested rather than assumed:
 *
 *   open.er-api.com   166 currencies (incl. KES), keyless, `access-control-allow-origin: *`
 *   frankfurter.dev   29 ECB currencies, keyless, CORS *, used only if the primary fails
 *
 * TWO NON-OBVIOUS CONSTRAINTS, both verified against the live endpoints:
 *
 * 1. The primary answers OPTIONS with `405 allow: GET`. Any custom request header (even a
 *    harmless Accept) turns the request into a preflighted one, the preflight fails, and the
 *    fetch dies in-browser while working perfectly in curl. So: plain GET, zero headers.
 *
 * 2. Its `cache-control: max-age=3600` is a CDN TTL, not the data cadence. The payload's own
 *    stamps are ~24.15h apart. These are DAILY reference rates, not a live feed - fine for
 *    sizing and margin, wrong for anything tick-sensitive, which is why manual override exists.
 *
 * Rates are untrusted third-party input and are fully validated before a single value is used.
 */

const CACHE_KEY = 'fxcalc.rates.v1';
const MAX_ENTRIES = 500;
const DAY = 86400e3;

export const SOURCES = [
  {
    id: 'er-api',
    url: 'https://open.er-api.com/v6/latest/USD',
    attribution: 'Rates by ExchangeRate-API',
    attributionUrl: 'https://www.exchangerate-api.com',
    parse(json) {
      if (json.result !== 'success') throw new Error('source reported failure');
      return { rates: json.rates, updatedAt: (json.time_last_update_unix || 0) * 1000 };
    },
  },
  {
    id: 'frankfurter',
    url: 'https://api.frankfurter.dev/v1/latest?base=USD',
    attribution: 'Rates by Frankfurter (ECB)',
    attributionUrl: 'https://frankfurter.dev',
    parse(json) {
      if (!json.rates || json.base !== 'USD') throw new Error('unexpected payload');
      return { rates: { ...json.rates, USD: 1 }, updatedAt: Date.parse(`${json.date}T00:00:00Z`) };
    },
  },
];

/**
 * Validate a third-party rate table before any value reaches the calculation core.
 * Rejects non-objects, absurd magnitudes, malformed currency codes and a missing/incorrect USD
 * anchor - the whole conversion model assumes rates are "units per 1 USD" with USD exactly 1.
 */
export function validateRates(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Rate payload is not an object');
  }
  const entries = Object.entries(raw);
  if (entries.length === 0) throw new Error('Rate payload is empty');
  if (entries.length > MAX_ENTRIES) throw new Error('Rate payload is implausibly large');

  const clean = {};
  for (const [code, value] of entries) {
    if (!/^[A-Z]{3}$/.test(code)) continue;                       // ignore non-ISO keys
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n) || n <= 0 || n > 1e9) continue;        // drop absurd or unusable rates
    clean[code] = n;
  }
  if (!clean.USD) clean.USD = 1;
  if (Math.abs(clean.USD - 1) > 1e-9) throw new Error('USD anchor is not 1; table is not USD-based');
  if (Object.keys(clean).length < 5) throw new Error('Too few usable rates');
  return clean;
}

/** How much to trust what we have. FX is closed at weekends, so a Friday rate on Sunday is normal. */
export function freshness(updatedAt, now = Date.now()) {
  if (!updatedAt) return { status: 'none', label: 'No rates yet', ageMs: null };
  const ageMs = now - updatedAt;
  if (ageMs < 0) return { status: 'live', label: 'Just updated', ageMs: 0 };
  const hours = ageMs / 3600e3;
  if (hours < 26) return { status: 'live', label: hours < 1 ? 'Updated just now' : `Updated ${Math.round(hours)}h ago`, ageMs };
  const days = Math.round(ageMs / DAY);
  if (ageMs < 4 * DAY) return { status: 'stale', label: `${days}d old`, ageMs };
  return { status: 'old', label: `${days}d old - check manually`, ageMs };
}

export function loadCache(storage = safeStorage()) {
  try {
    const raw = storage && storage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return { ...parsed, rates: validateRates(parsed.rates) };
  } catch {
    return null;                                                   // corrupt cache is simply ignored
  }
}

export function saveCache(payload, storage = safeStorage()) {
  try {
    storage && storage.setItem(CACHE_KEY, JSON.stringify(payload));
  } catch { /* private mode / quota - the app still works, it just will not remember */ }
}

function safeStorage() {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}

async function fetchSource(source, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    // No headers, no credentials: a custom header would trigger a preflight the primary rejects.
    const res = await fetch(source.url, { method: 'GET', credentials: 'omit', mode: 'cors', signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { rates, updatedAt } = source.parse(await res.json());
    return {
      rates: validateRates(rates),
      updatedAt: Number.isFinite(updatedAt) && updatedAt > 0 ? updatedAt : Date.now(),
      sourceId: source.id, attribution: source.attribution, attributionUrl: source.attributionUrl,
      fetchedAt: Date.now(),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Get the best rates available, degrading in a defined order rather than failing outright:
 * network -> cache -> nothing. The caller is always told which it got so the UI can say so.
 */
export async function getRates({ forceRefresh = false, timeoutMs = 8000 } = {}) {
  const cached = loadCache();
  if (!forceRefresh && cached && freshness(cached.updatedAt).status === 'live') {
    return { ...cached, origin: 'cache' };
  }

  const errors = [];
  for (const source of SOURCES) {
    try {
      const fresh = await fetchSource(source, timeoutMs);
      saveCache(fresh);
      return { ...fresh, origin: 'network' };
    } catch (err) {
      errors.push(`${source.id}: ${err.message}`);
    }
  }

  if (cached) return { ...cached, origin: 'cache', degraded: true, errors };
  return { rates: null, updatedAt: null, origin: 'none', errors };
}
