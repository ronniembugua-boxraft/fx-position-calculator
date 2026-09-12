/** Rate payloads are untrusted third-party input; these pin the validation boundary. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateRates, freshness, loadCache, saveCache, SOURCES } from '../rates.js';

test('a well-formed payload passes through intact', () => {
  const r = validateRates({ USD: 1, EUR: 0.862, GBP: 0.7395, JPY: 153.76, KES: 129.44 });
  assert.equal(r.EUR, 0.862);
  assert.equal(r.USD, 1);
  assert.equal(Object.keys(r).length, 5);
});

test('hostile and malformed payloads are rejected, not partially trusted', () => {
  assert.throws(() => validateRates(null), /not an object/);
  assert.throws(() => validateRates([1, 2, 3]), /not an object/);
  assert.throws(() => validateRates('EUR=0.86'), /not an object/);
  assert.throws(() => validateRates({}), /empty/);
  assert.throws(() => validateRates({ USD: 2, EUR: 0.86, GBP: 1, JPY: 1, CHF: 1 }), /not USD-based/);
  assert.throws(() => validateRates({ USD: 1, EUR: 0.86 }), /Too few/);

  const huge = { USD: 1 };
  for (let i = 0; i < 600; i++) huge[`C${String(i).padStart(2, '0')}`] = 1;
  assert.throws(() => validateRates(huge), /implausibly large/);
});

test('individual bad entries are dropped rather than poisoning the table', () => {
  const r = validateRates({
    USD: 1, EUR: 0.862, GBP: 0.7395, JPY: 153.76, CHF: 0.81,
    BAD: -5,            // negative
    ZER: 0,             // zero would divide-by-zero downstream
    INF: Infinity,
    NAN: NaN,
    HUGE: 1e12,         // absurd magnitude
    TEXT: 'not a rate',
    lowercase: 1.5,     // malformed code
    TOOLONG: 1.5,
    __proto__gag: 1,
  });
  for (const k of ['BAD', 'ZER', 'INF', 'NAN', 'HUGE', 'TEXT', 'lowercase', 'TOOLONG']) {
    assert.ok(!(k in r), `${k} should have been dropped`);
  }
  assert.deepEqual(Object.keys(r).sort(), ['CHF', 'EUR', 'GBP', 'JPY', 'USD']);
});

test('a numeric string rate is coerced, since some sources quote them', () => {
  const r = validateRates({ USD: 1, EUR: '0.862', GBP: 0.7395, JPY: 153.76, CHF: 0.81 });
  assert.equal(r.EUR, 0.862);
});

test('a missing USD anchor is supplied rather than rejected', () => {
  const r = validateRates({ EUR: 0.862, GBP: 0.7395, JPY: 153.76, CHF: 0.81, AUD: 1.39 });
  assert.equal(r.USD, 1);
});

test('freshness buckets reflect a DAILY feed, not an hourly one', () => {
  const now = Date.parse('2026-09-12T12:00:00Z');
  const h = (n) => now - n * 3600e3;
  assert.equal(freshness(h(0.5), now).status, 'live');
  assert.equal(freshness(h(20), now).status, 'live');    // yesterday's publish is still current
  assert.equal(freshness(h(30), now).status, 'stale');
  assert.equal(freshness(h(24 * 5), now).status, 'old');
  assert.equal(freshness(null, now).status, 'none');
  assert.equal(freshness(now + 5000, now).status, 'live'); // clock skew must not read as ancient
});

test('a corrupt cache is ignored rather than crashing startup', () => {
  const store = new Map();
  const fake = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };

  store.set('fxcalc.rates.v1', '{ not json');
  assert.equal(loadCache(fake), null);

  store.set('fxcalc.rates.v1', JSON.stringify({ rates: { USD: 7 }, updatedAt: 1 }));
  assert.equal(loadCache(fake), null, 'a cache failing validation must not be served');

  saveCache({ rates: { USD: 1, EUR: 0.86, GBP: 0.74, JPY: 153, CHF: 0.81 }, updatedAt: 123 }, fake);
  assert.equal(loadCache(fake).rates.EUR, 0.86);
});

test('storage that throws (private mode) degrades quietly', () => {
  const hostile = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  assert.equal(loadCache(hostile), null);
  assert.doesNotThrow(() => saveCache({ rates: {} }, hostile));
});

test('both sources are keyless and carry attribution', () => {
  for (const s of SOURCES) {
    assert.ok(s.url.startsWith('https://'), `${s.id} must be HTTPS`);
    assert.ok(!/key|token|secret/i.test(s.url), `${s.id} must not carry a credential`);
    assert.ok(s.attribution && s.attributionUrl, `${s.id} must carry attribution`);
  }
});

test('source parsers handle their real payload shapes', () => {
  const er = SOURCES[0].parse({ result: 'success', rates: { USD: 1, EUR: 0.862 }, time_last_update_unix: 1789171351 });
  assert.equal(er.updatedAt, 1789171351000);
  assert.throws(() => SOURCES[0].parse({ result: 'error' }), /failure/);

  const fr = SOURCES[1].parse({ amount: 1, base: 'USD', date: '2026-09-11', rates: { EUR: 0.86266 } });
  assert.equal(fr.rates.USD, 1, 'frankfurter omits USD from its own table');
  assert.equal(fr.updatedAt, Date.parse('2026-09-11T00:00:00Z'));
  assert.throws(() => SOURCES[1].parse({ base: 'EUR', rates: {} }), /unexpected/);
});
