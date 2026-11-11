// Extension side of session handoff: grants, handoff_session, handoff_status,
// handoff_resolve_tab. All browser state is a fake; no real cookies anywhere.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { handoffSession, handoffAad } from '../extension/handoff/session.js';
import { handoffStatus, handoffResolveTab } from '../extension/handoff/control.js';
import { GRANTS_KEY, HANDOFF_FORMAT, listGrants, getGrant, grantUrl } from '../extension/handoff/grants.js';

const TAB = 17;
const SC = 'https://sellercentral.amazon.com/fba/shippingqueue';
const IDENTITY = { extensionId: 'ext-id', instanceId: 'inst-id', version: '1.4.0' };
const future = () => Math.floor(Date.now() / 1000) + 3600;

async function recipient() {
  const pair = await webcrypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey']);
  return { pair, publicJwk: await webcrypto.subtle.exportKey('jwk', pair.publicKey) };
}

async function open(envelope, privateKey, grant = 'amazon-sc') {
  const peer = await webcrypto.subtle.importKey('jwk', envelope.ephemeralPublicKey, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const key = await webcrypto.subtle.deriveKey({ name: 'ECDH', public: peer }, privateKey, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  const clear = await webcrypto.subtle.decrypt(
    { name: 'AES-GCM', iv: Buffer.from(envelope.iv, 'base64'), additionalData: new TextEncoder().encode(handoffAad(grant)) },
    key, Buffer.from(envelope.ciphertext, 'base64'),
  );
  return JSON.parse(new TextDecoder().decode(clear));
}

function fakeChrome(o = {}) {
  const calls = { storage: 0, permission: 0, cookieQueries: [], create: [], tabsGet: [] };
  const tabs = new Map((o.tabs ?? [{ id: TAB, windowId: 3, incognito: false, status: 'complete', url: SC }]).map((t) => [t.id, { ...t }]));
  const api = {
    storage: { local: { get: async (key) => {
      calls.storage++;
      assert.equal(key, GRANTS_KEY);
      if (o.storageError) throw new Error('private storage detail');
      return { [GRANTS_KEY]: o.grants ?? { 'amazon-sc': true } };
    } } },
    permissions: { contains: async (q) => {
      calls.permission++;
      assert.deepEqual(q, { permissions: ['cookies'] });
      return o.permission ?? true;
    } },
    tabs: {
      get: async (id) => {
        calls.tabsGet.push(id);
        if (!tabs.has(id)) throw new Error('private: no tab');
        return { ...tabs.get(id) };
      },
      query: async () => [...tabs.values()].map((t) => ({ ...t })),
      create: async (props) => {
        calls.create.push(props);
        const tab = { id: 55, windowId: props.windowId, incognito: false, status: 'complete', url: props.url };
        tabs.set(55, tab);
        return { ...tab };
      },
    },
    windows: { getAll: async () => o.windows ?? [{ id: 7, type: 'normal', incognito: false }] },
    cookies: {
      getAllCookieStores: async () => o.stores ?? [{ id: 'store-1', tabIds: [...tabs.keys(), 55] }],
      getAll: async (q) => {
        calls.cookieQueries.push(q);
        if (o.cookieError) throw new Error('private cookie detail');
        return typeof o.cookies === 'function' ? o.cookies(q) : (o.cookies ?? []);
      },
    },
  };
  if (o.noCookieApi) delete api.cookies;
  return { api, calls, tabs };
}

const code = (c) => (e) => e?.code === c;

// ---------- grants ----------

test('the Amazon preset is the only grant and its URL check is strict', () => {
  assert.deepEqual(listGrants().map((g) => g.id), ['amazon-sc']);
  const g = getGrant('amazon-sc');
  assert.ok(grantUrl(g, SC));
  for (const bad of [
    'http://sellercentral.amazon.com/', 'https://sellercentral.amazon.com:8443/', 'https://user:pw@sellercentral.amazon.com/',
    'https://evil.com/?sellercentral.amazon.com', 'https://sellercentral.amazon.com.evil.com/', 'https://amazon.com/', '',
  ]) assert.equal(grantUrl(g, bad), null, bad);
  assert.equal(getGrant('AMAZON-SC'), null);
  assert.equal(getGrant('../x'), null);
  assert.ok(Object.isFrozen(g));
});

// ---------- handoff_session ----------

test('handoff_session returns only ciphertext, bound to its grant, with the narrow cookie projection', async () => {
  const r = await recipient();
  const { api, calls } = fakeChrome({
    cookies: (q) => (q.url.endsWith('/') ? [
      { name: 'session-id', value: 'secret-1', domain: '.amazon.com', path: '/', secure: true, httpOnly: true, sameSite: 'lax', session: false, expirationDate: future(), hostOnly: false, storeId: 'store-1' },
      { name: 'other', value: 'x', domain: '.example.com', path: '/', secure: true, httpOnly: false, sameSite: 'lax', session: true },
      { name: 'chips', value: 'p', domain: 'sellercentral.amazon.com', path: '/', secure: true, httpOnly: true, sameSite: 'no_restriction', session: true, partitionKey: { topLevelSite: 'https://a.com' } },
    ] : [
      // path=/ cookies come back for every URL; they must not be duplicated
      { name: 'session-id', value: 'secret-1', domain: '.amazon.com', path: '/', secure: true, httpOnly: true, sameSite: 'lax', session: false, expirationDate: future() },
      { name: 'chips', value: 'p', domain: 'sellercentral.amazon.com', path: '/', secure: true, httpOnly: true, sameSite: 'no_restriction', session: true, partitionKey: { topLevelSite: 'https://a.com' } },
      { name: 'queue', value: 'secret-2', domain: 'sellercentral.amazon.com', path: '/fba', secure: true, httpOnly: false, sameSite: 'strict', session: true },
    ]),
  });
  const env = await handoffSession({ grant: 'amazon-sc', recipientPublicKey: r.publicJwk }, TAB, api, webcrypto);
  assert.deepEqual(Object.keys(env).sort(), ['ciphertext', 'ephemeralPublicKey', 'format', 'grant', 'iv']);
  assert.equal(env.format, HANDOFF_FORMAT);
  assert.equal(env.grant, 'amazon-sc');
  assert.doesNotMatch(JSON.stringify(env), /secret-/);
  assert.deepEqual(calls.cookieQueries.map((q) => q.storeId), ['store-1', 'store-1']);

  const payload = await open(env, r.pair.privateKey);
  assert.equal(payload.grant, 'amazon-sc');
  assert.deepEqual(payload.cookies.map((c) => c.name).sort(), ['queue', 'session-id']);
  assert.equal(payload.skipped_partitioned, 1);
  assert.equal('hostOnly' in payload.cookies[0], false);
  assert.equal('storeId' in payload.cookies[0], false);

  // The AAD names the grant: the same ciphertext does not open as another grant
  await assert.rejects(open(env, r.pair.privateKey, 'other-grant'));
});

test('handoff_session needs the grant on, cookie permission, and the cookie API, before reading anything', async () => {
  const r = await recipient();
  const req = { grant: 'amazon-sc', recipientPublicKey: r.publicJwk };
  for (const [opts, c] of [
    [{ grants: {} }, 'HANDOFF_GRANT_DISABLED'],
    [{ grants: { 'amazon-sc': 'yes' } }, 'HANDOFF_GRANT_DISABLED'],
    [{ permission: false }, 'HANDOFF_PERMISSION_REQUIRED'],
    [{ noCookieApi: true }, 'HANDOFF_COOKIE_API_UNAVAILABLE'],
    [{ storageError: true }, 'HANDOFF_STATE_UNAVAILABLE'],
  ]) {
    const { api, calls } = fakeChrome(opts);
    await assert.rejects(handoffSession(req, TAB, api, webcrypto), code(c), c);
    assert.equal(calls.tabsGet.length, 0);
    assert.equal(calls.cookieQueries.length, 0);
  }
  const { api } = fakeChrome();
  await assert.rejects(handoffSession({ grant: 'nope', recipientPublicKey: r.publicJwk }, TAB, api, webcrypto), code('HANDOFF_UNKNOWN_GRANT'));
});

test('handoff_session rejects extra params, bad keys, and the caller naming its own URL or domains', async () => {
  const r = await recipient();
  const { api, calls } = fakeChrome();
  const bad = [
    { grant: 'amazon-sc' },
    { grant: 'amazon-sc', recipientPublicKey: r.publicJwk, url: 'https://mail.google.com/' },
    { grant: 'amazon-sc', recipientPublicKey: r.publicJwk, cookieDomains: ['google.com'] },
    { grant: 'amazon-sc', recipientPublicKey: { ...r.publicJwk, d: 'x'.repeat(43) } },
    { grant: 'amazon-sc', recipientPublicKey: { ...r.publicJwk, crv: 'P-384' } },
    { grant: 'Amazon SC', recipientPublicKey: r.publicJwk },
  ];
  for (const p of bad) await assert.rejects(handoffSession(p, TAB, api, webcrypto), code('HANDOFF_INVALID_REQUEST'), JSON.stringify(Object.keys(p)));
  await assert.rejects(handoffSession({ grant: 'amazon-sc', recipientPublicKey: r.publicJwk }, 0, api, webcrypto), code('HANDOFF_INVALID_REQUEST'));
  const getter = { grant: 'amazon-sc' };
  Object.defineProperty(getter, 'recipientPublicKey', { get: () => r.publicJwk, enumerable: true });
  await assert.rejects(handoffSession(getter, TAB, api, webcrypto), code('HANDOFF_INVALID_REQUEST'));
  assert.equal(calls.storage, 0, 'shape is checked before touching Chrome state');
});

test('handoff_session only reads a tab on the grant host, from that tab\'s single cookie store', async () => {
  const r = await recipient();
  const req = { grant: 'amazon-sc', recipientPublicKey: r.publicJwk };
  const wrongHost = fakeChrome({ tabs: [{ id: TAB, windowId: 1, incognito: false, status: 'complete', url: 'https://mail.google.com/' }] });
  await assert.rejects(handoffSession(req, TAB, wrongHost.api, webcrypto), code('HANDOFF_TAB_INVALID'));
  assert.equal(wrongHost.calls.cookieQueries.length, 0);
  const twoStores = fakeChrome({ stores: [{ id: 'a', tabIds: [TAB] }, { id: 'b', tabIds: [TAB] }] });
  await assert.rejects(handoffSession(req, TAB, twoStores.api, webcrypto), code('HANDOFF_TAB_STORE_UNAVAILABLE'));
  const missing = fakeChrome();
  await assert.rejects(handoffSession(req, 99, missing.api, webcrypto), (e) => e.code === 'HANDOFF_TAB_UNAVAILABLE' && !/private/.test(e.message));
  const readFail = fakeChrome({ cookieError: true });
  await assert.rejects(handoffSession(req, TAB, readFail.api, webcrypto), (e) => e.code === 'HANDOFF_COOKIE_READ_FAILED' && !/private/.test(e.message));
});

// ---------- handoff_status ----------

test('handoff_status reports every grant with tab metadata and never reads cookie values', async () => {
  const { api, calls } = fakeChrome({
    grants: { 'amazon-sc': true, 'not-a-grant': true },
    tabs: [
      { id: TAB, windowId: 3, incognito: false, status: 'complete', url: SC },
      { id: 18, windowId: 3, incognito: false, status: 'complete', url: 'https://example.com/' },
    ],
  });
  const s = await handoffStatus({}, IDENTITY, api);
  assert.equal(s.instanceId, 'inst-id');
  assert.equal(s.cookiePermission, true);
  assert.deepEqual(s.grants.map((g) => [g.id, g.enabled, g.ready, g.tabs.map((t) => t.tabId)]), [['amazon-sc', true, true, [TAB]]]);
  assert.deepEqual(s.grants[0].cookieDomains, ['amazon.com', 'sellercentral.amazon.com']);
  assert.equal(calls.cookieQueries.length, 0);
  await assert.rejects(handoffStatus({ extra: 1 }, IDENTITY, api), code('HANDOFF_INVALID_REQUEST'));
});

test('handoff_status without cookie permission still answers, with no store ids', async () => {
  const { api } = fakeChrome({ permission: false, grants: {} });
  const s = await handoffStatus({}, IDENTITY, api);
  assert.equal(s.cookiePermission, false);
  assert.equal(s.grants[0].enabled, false);
  assert.equal(s.grants[0].ready, false);
  assert.equal(s.grants[0].tabs[0].storeId, null);
});

// ---------- handoff_resolve_tab ----------

test('auto tab choice skips incognito, takes the lowest id in one store, refuses several stores', async () => {
  const tabs = [
    { id: 30, windowId: 1, incognito: true, status: 'complete', url: SC },
    { id: 21, windowId: 1, incognito: false, status: 'complete', url: SC },
    { id: 20, windowId: 1, incognito: false, status: 'complete', url: SC },
  ];
  const one = fakeChrome({ tabs, stores: [{ id: 's', tabIds: [20, 21] }, { id: 'inc', tabIds: [30] }] });
  assert.deepEqual(await handoffResolveTab({ grant: 'amazon-sc' }, one.api), { tabId: 20, created: false, storeId: 's' });
  const two = fakeChrome({ tabs, stores: [{ id: 's', tabIds: [20] }, { id: 't', tabIds: [21] }] });
  await assert.rejects(handoffResolveTab({ grant: 'amazon-sc' }, two.api), code('HANDOFF_TAB_AMBIGUOUS'));
  assert.equal(two.calls.create.length, 0);
  assert.deepEqual(await handoffResolveTab({ grant: 'amazon-sc', storeId: 't' }, two.api), { tabId: 21, created: false, storeId: 't' });
});

test('explicit tab: may be incognito, must be on the grant host, must match a requested store', async () => {
  const tabs = [{ id: 40, windowId: 1, incognito: true, status: 'complete', url: SC }, { id: 41, windowId: 1, incognito: false, status: 'complete', url: 'https://example.com/' }];
  const { api } = fakeChrome({ tabs, stores: [{ id: 'inc', tabIds: [40] }] });
  assert.deepEqual(await handoffResolveTab({ grant: 'amazon-sc', tabId: 40 }, api), { tabId: 40, created: false, storeId: 'inc' });
  await assert.rejects(handoffResolveTab({ grant: 'amazon-sc', tabId: 41 }, api), code('HANDOFF_TAB_INVALID'));
  await assert.rejects(handoffResolveTab({ grant: 'amazon-sc', tabId: 40, storeId: 'other' }, api), code('HANDOFF_TAB_STORE_MISMATCH'));
});

test('no matching tab: opens the grant\'s fixed URL in a normal window, inactive — unless told not to', async () => {
  const { api, calls } = fakeChrome({ tabs: [] });
  const r = await handoffResolveTab({ grant: 'amazon-sc', openIfMissing: true }, api);
  assert.deepEqual(r, { tabId: 55, created: true, storeId: 'store-1' });
  assert.deepEqual(calls.create, [{ windowId: 7, url: 'https://sellercentral.amazon.com/manage/shipments', active: false }]);

  const no = fakeChrome({ tabs: [] });
  await assert.rejects(handoffResolveTab({ grant: 'amazon-sc', openIfMissing: false }, no.api), code('HANDOFF_TAB_NOT_FOUND'));
  await assert.rejects(handoffResolveTab({ grant: 'amazon-sc', storeId: 'x' }, no.api), code('HANDOFF_TAB_NOT_FOUND'));
  const noWindow = fakeChrome({ tabs: [], windows: [{ id: 1, type: 'normal', incognito: true }] });
  await assert.rejects(handoffResolveTab({ grant: 'amazon-sc' }, noWindow.api), code('HANDOFF_NO_NORMAL_WINDOW'));
  assert.equal(no.calls.create.length + noWindow.calls.create.length, 0);
});

test('resolve_tab checks params first and needs the grant on', async () => {
  const { api, calls } = fakeChrome({ grants: {} });
  for (const p of [{}, { grant: 'amazon-sc', tabId: -1 }, { grant: 'amazon-sc', openIfMissing: 'yes' }, { grant: 'amazon-sc', url: 'x' }]) {
    await assert.rejects(handoffResolveTab(p, api), code('HANDOFF_INVALID_REQUEST'), JSON.stringify(p));
  }
  assert.equal(calls.storage, 0);
  await assert.rejects(handoffResolveTab({ grant: 'amazon-sc' }, api), code('HANDOFF_GRANT_DISABLED'));
  assert.equal(calls.create.length, 0);
});
