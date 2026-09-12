/**
 * Guards on the service worker's cache policy. A stale shell is invisible in normal testing -
 * everything looks fine until a deploy silently fails to reach anybody - so the properties that
 * prevent it are asserted against the source directly.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const sw = readFileSync(new URL('../sw.js', import.meta.url), 'utf8');

test('revalidation bypasses the HTTP cache', () => {
  // Without this, a host sending max-age re-serves the bytes already held and the loop never converges.
  assert.match(sw, /fetch\(request,\s*\{\s*cache:\s*'no-cache'\s*\}\)/, 'asset revalidation must use cache: no-cache');
  assert.match(sw, /new Request\(u,\s*\{\s*cache:\s*'no-cache'\s*\}\)/, 'precache must use cache: no-cache');
});

test('navigations are network-first so the document is never a version behind', () => {
  assert.match(sw, /request\.mode === 'navigate'/, 'navigations need their own branch');
  const nav = sw.slice(sw.indexOf("request.mode === 'navigate'"));
  assert.ok(nav.indexOf('fetch(request)') < nav.indexOf('caches.match'), 'navigation must try the network first');
});

test('the cache is versioned and old versions are swept', () => {
  const m = sw.match(/const CACHE = '([^']+)'/);
  assert.ok(m, 'cache name must be a versioned constant');
  assert.match(m[1], /-v\d+$/, `cache name ${m[1]} must carry a version suffix`);
  assert.match(sw, /keys\.filter\(\(k\) => k !== CACHE\)\.map\(\(k\) => caches\.delete\(k\)\)/, 'activate must purge other caches');
});

test('cross-origin and non-GET requests are never intercepted', () => {
  assert.match(sw, /request\.method !== 'GET'/, 'non-GET must bail out');
  assert.match(sw, /origin !== self\.location\.origin/, 'cross-origin must bail out');
});

test('only genuine same-origin 200s are stored', () => {
  assert.match(sw, /response\.status === 200 && response\.type === 'basic'/, 'opaque responses must never be cached');
});

test('every module the page loads is precached', () => {
  for (const f of ['./index.html', './app.js', './state.js', './views.js', './calc.js', './instruments.js', './rates.js', './format.js', './styles.css']) {
    assert.ok(sw.includes(`'${f}'`), `${f} is missing from the precache list`);
  }
});
