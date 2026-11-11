// handoff_status / handoff_resolve_tab: what a local script needs to know
// before asking for a session. Neither command reads cookie values.
import {
  listGrants, enabledGrants, cookiePermission, cookieApiAvailable,
  grantUrl, requireGrantReady, handoffError, GRANT_ID, onSignInPage, signedOut,
} from './grants.js';

// Seller Central often takes more than 10s on a cold start. The command itself has 30s.
const LOAD_TIMEOUT_MS = 20000;
const LOAD_POLL_MS = 100;
// Finished loading somewhere else (a sign-in host) and stayed there this long: signed out, not slow.
const OFF_SITE_SETTLE_MS = 1500;

const invalidRequest = () => handoffError('INVALID_REQUEST', 'Invalid session handoff request.');
const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const validTabId = (v) => Number.isSafeInteger(v) && v > 0;
const validStoreId = (v) => typeof v === 'string' && v.length > 0 && v.length <= 256 && !/[\u0000-\u001f\u007f]/.test(v);

function validateKeys(params, allowed) {
  if (!isRecord(params) || Object.keys(params).some((k) => !allowed.includes(k))) throw invalidRequest();
}

// A pending URL counts only while Chrome is actually navigating. It is
// checked as strictly as a committed URL and never returned.
function tabMatches(grant, tab, { allowPending = true } = {}) {
  if (grantUrl(grant, tab?.url)) return true;
  if (!allowPending || (tab?.url && tab.status !== 'loading')) return false;
  return !!grantUrl(grant, tab?.pendingUrl);
}

function makeStoreMap(stores) {
  const map = new Map();
  if (!Array.isArray(stores)) return map;
  for (const store of stores) {
    if (!validStoreId(store?.id) || !Array.isArray(store?.tabIds)) continue;
    for (const tabId of store.tabIds) {
      if (!validTabId(tabId)) continue;
      if (!map.has(tabId)) map.set(tabId, new Set());
      map.get(tabId).add(store.id);
    }
  }
  return map;
}

function storeIdForTab(storeMap, tabId) {
  const ids = storeMap.get(tabId);
  return ids?.size === 1 ? [...ids][0] : null;
}

async function readCookieStores(chromeApi) {
  try {
    return makeStoreMap(await chromeApi.cookies.getAllCookieStores());
  } catch {
    throw handoffError('TAB_STORE_UNAVAILABLE', 'Could not identify the selected tab cookie store.');
  }
}

async function queryTabs(chromeApi) {
  if (typeof chromeApi?.tabs?.query !== 'function') throw handoffError('UNAVAILABLE', 'Session sharing is unavailable in this browser.');
  try {
    const tabs = await chromeApi.tabs.query({});
    return Array.isArray(tabs) ? tabs : [];
  } catch {
    throw handoffError('TAB_QUERY_FAILED', 'Unable to inspect tabs.');
  }
}

/** Readiness of every grant in this profile, with sanitized tab metadata. */
export async function handoffStatus(params, identity, chromeApi = globalThis.chrome) {
  validateKeys(params, []);
  const on = await enabledGrants(chromeApi);
  const permission = await cookiePermission(chromeApi);
  const cookieApi = cookieApiAvailable(chromeApi);
  const storeMap = permission && cookieApi ? await readCookieStores(chromeApi) : new Map();
  const tabs = await queryTabs(chromeApi);
  return {
    extensionId: identity?.extensionId,
    instanceId: identity?.instanceId,
    version: identity?.version,
    cookiePermission: permission,
    cookieApiAvailable: cookieApi,
    grants: listGrants().map((grant) => ({
      id: grant.id,
      label: grant.label,
      hosts: [...grant.hosts],
      cookieDomains: [...grant.cookieDomains],
      enabled: on.has(grant.id),
      ready: on.has(grant.id) && permission && cookieApi,
      tabs: tabs
        .filter((tab) => validTabId(tab?.id) && Number.isSafeInteger(tab?.windowId) && tabMatches(grant, tab))
        .map((tab) => ({
          tabId: tab.id, windowId: tab.windowId, incognito: tab.incognito === true, storeId: storeIdForTab(storeMap, tab.id),
        })),
    })),
  };
}

function chooseTab(entries, requestedStoreId) {
  if (requestedStoreId !== undefined) {
    return entries.filter((e) => e.storeId === requestedStoreId).sort((a, b) => a.tab.id - b.tab.id)[0] || null;
  }
  const stores = new Set(entries.filter((e) => e.storeId !== null).map((e) => e.storeId));
  if (stores.size > 1) {
    throw handoffError('TAB_AMBIGUOUS', 'Tabs in several cookie stores match; pass --tab-id or --store-id.');
  }
  if (entries.some((e) => e.storeId === null)) {
    throw handoffError('TAB_STORE_UNAVAILABLE', 'Could not identify the selected tab cookie store.');
  }
  return entries.slice().sort((a, b) => a.tab.id - b.tab.id)[0] || null;
}

async function normalWindowId(chromeApi) {
  let windows;
  try { windows = await chromeApi.windows.getAll({ windowTypes: ['normal'] }); } catch { windows = null; }
  const normal = (Array.isArray(windows) ? windows : [])
    .filter((w) => w?.type === 'normal' && w.incognito === false && Number.isSafeInteger(w.id))
    .sort((a, b) => a.id - b.id);
  if (!normal.length) throw handoffError('NO_NORMAL_WINDOW', 'Could not find a normal Chrome window to open the site in.');
  return normal[0].id;
}

async function openGrantTab(grant, chromeApi) {
  const windowId = await normalWindowId(chromeApi);
  let created;
  try { created = await chromeApi.tabs.create({ windowId, url: grant.openUrl, active: false }); } catch { created = null; }
  if (!validTabId(created?.id)) throw handoffError('TAB_CREATE_FAILED', `Could not open a ${grant.label} tab.`);
  const deadline = Date.now() + LOAD_TIMEOUT_MS;
  let offSince = null;
  while (Date.now() <= deadline) {
    let tab;
    try { tab = await chromeApi.tabs.get(created.id); } catch { break; }
    if (tab?.status === 'complete' && onSignInPage(grant, tab.url)) throw signedOut(grant);
    if (tab?.incognito !== true && tab.status === 'complete' && grantUrl(grant, tab.url)) return created.id;
    if (tab?.status === 'complete' && tab.url && !grantUrl(grant, tab.url)) {
      offSince ??= Date.now();
      if (Date.now() - offSince >= OFF_SITE_SETTLE_MS) throw signedOut(grant);
    } else offSince = null;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise((r) => setTimeout(r, Math.min(LOAD_POLL_MS, remaining)));
  }
  throw handoffError('TAB_LOAD_TIMEOUT', `${grant.label} did not finish loading in time (signed out?).`);
}

/** Pick the tab whose cookie store a session will come from, opening one if needed. */
export async function handoffResolveTab(params, chromeApi = globalThis.chrome) {
  validateKeys(params, ['grant', 'tabId', 'openIfMissing', 'storeId']);
  if (typeof params.grant !== 'string' || !GRANT_ID.test(params.grant)) throw invalidRequest();
  if (Object.hasOwn(params, 'tabId') && !validTabId(params.tabId)) throw invalidRequest();
  if (Object.hasOwn(params, 'openIfMissing') && typeof params.openIfMissing !== 'boolean') throw invalidRequest();
  if (Object.hasOwn(params, 'storeId') && !validStoreId(params.storeId)) throw invalidRequest();
  const grant = await requireGrantReady(params.grant, chromeApi);
  const storeMap = await readCookieStores(chromeApi);

  if (params.tabId !== undefined) {
    let tab;
    try { tab = await chromeApi.tabs.get(params.tabId); } catch {
      throw handoffError('TAB_UNAVAILABLE', 'The selected tab is unavailable.');
    }
    if (!tabMatches(grant, tab)) throw handoffError('TAB_INVALID', `The selected tab must be an HTTPS ${grant.label} tab.`);
    if (onSignInPage(grant, tab.url)) throw signedOut(grant);
    const storeId = storeIdForTab(storeMap, params.tabId);
    if (params.storeId !== undefined && storeId !== params.storeId) {
      throw handoffError('TAB_STORE_MISMATCH', 'The selected tab is not in the requested cookie store.');
    }
    return { tabId: params.tabId, created: false, storeId };
  }

  // Automatic choice never picks incognito: that is a different login.
  const entries = (await queryTabs(chromeApi))
    .filter((tab) => validTabId(tab?.id) && tab.incognito === false && tabMatches(grant, tab) && !onSignInPage(grant, tab.url))
    .map((tab) => ({ tab, storeId: storeIdForTab(storeMap, tab.id) }));
  const selected = chooseTab(entries, params.storeId);
  if (selected) return { tabId: selected.tab.id, created: false, storeId: selected.storeId };

  // An explicit store is an explicit login choice, and Chrome cannot open a
  // tab into an arbitrary store, so never open into a different one.
  if (params.storeId !== undefined || params.openIfMissing === false) {
    throw handoffError('TAB_NOT_FOUND', `No ${grant.label} tab is open.`);
  }
  const tabId = await openGrantTab(grant, chromeApi);
  return { tabId, created: true, storeId: storeIdForTab(await readCookieStores(chromeApi), tabId) };
}
