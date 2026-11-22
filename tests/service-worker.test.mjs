// The service worker run in a stand-in browser (review 2026-11-22, 34~36). Run: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../dist/sw.js', import.meta.url), 'utf8');

/** sw.js loaded at `scope` with a fake Cache Storage and network; returns its event handlers and the caches. */
function worker(scope = 'https://example.invalid/roadname_pwa/', network = async url => new Response(`net ${url}`), online = true) {
  const stores = new Map();
  const open = name => {
    if (!stores.has(name)) stores.set(name, new Map());
    const m = stores.get(name), key = r => new URL(typeof r === 'string' ? r : r.url, scope).href;
    return {
      put: async (r, res) => { m.set(key(r), await res.clone().text()); },
      match: async r => (m.has(key(r)) ? new Response(m.get(key(r))) : undefined),
      keys: async () => [...m.keys()].map(url => ({url})),
      addAll: async list => { for (const r of list) m.set(key(r), 'shell'); },
    };
  };
  const handlers = {};
  const self = {
    location: new URL('sw.js', scope), navigator: {onLine: online},
    addEventListener: (type, fn) => { handlers[type] = fn; },
    skipWaiting: () => {}, clients: {claim: async () => {}},
  };
  const caches = {open: async name => open(name), keys: async () => [...stores.keys()], delete: async name => stores.delete(name)};
  vm.runInNewContext(source, {self, caches, fetch: async r => network(typeof r === 'string' ? r : r.url), Request: class { constructor(u, o = {}) { this.url = new URL(typeof u === 'string' ? u : u.url, scope).href; this.mode = o.mode || u.mode || 'cors'; this.method = 'GET'; } },
    Response, URL, setTimeout, Promise, Error, String, console});
  const fire = async (type, extra = {}) => { let done; handlers[type]({...extra, waitUntil: p => { done = p; }, respondWith: p => { done = p; }}); return done; };
  return {stores, fire, scope};
}

test('sw 34: opening another page of the site does not become the offline start page', async () => {
  const w = worker();
  await w.fire('install');
  const name = [...w.stores.keys()].find(k => k.startsWith('roadname-assets-'));
  const request = {url: `${w.scope}licenses.txt`, mode: 'navigate', method: 'GET'};
  const page = await (await w.fire('fetch', {request}));
  assert.ok((await page.text()).includes('licenses'), 'the page itself is shown');
  assert.ok(!w.stores.get(name).get(`${w.scope}index.html`).includes('licenses'), 'index.html kept');
});

test('sw 36: the beta beside the site keeps the site\'s caches', async () => {
  const site = worker('https://example.invalid/roadname_pwa/');
  await site.fire('install'); await site.fire('activate');
  // The site is a version behind the beta.
  for (const k of [...site.stores.keys()]) { site.stores.set(k.replace(/-v\d+/, '-v1'), site.stores.get(k)); site.stores.delete(k); }
  const siteCaches = [...site.stores.keys()];
  // The beta's worker shares the origin, so the same Cache Storage.
  const beta = worker('https://example.invalid/roadname_pwa/beta/');
  for (const [k, v] of site.stores) beta.stores.set(k, v);
  await beta.fire('install'); await beta.fire('activate');
  for (const k of siteCaches) assert.ok(beta.stores.has(k), `${k} still there`);
});

test('sw 35: on a slow but working network the app code is not mixed with an older cached copy', async () => {
  let release;
  const slow = new Promise(r => { release = r; });
  let installed = false;
  const w = worker('https://example.invalid/roadname_pwa/', async url => { if (installed) await slow; return new Response(`new ${url}`); });
  await w.fire('install');
  installed = true;
  const name = [...w.stores.keys()].find(k => k.startsWith('roadname-assets-'));
  w.stores.get(name).set(`${w.scope}address-core.mjs`, 'old');
  const answer = w.fire('fetch', {request: {url: `${w.scope}address-core.mjs`, mode: 'cors', method: 'GET'}});
  setTimeout(release, 3500);
  const res = await (await answer);
  assert.ok((await res.text()).startsWith('new'));
});
