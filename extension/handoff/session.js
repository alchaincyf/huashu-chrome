// handoff_session: read one grant's cookies from one explicit tab's cookie
// store and return them encrypted to the requester's ephemeral key.
// The reply holds only ciphertext, so cookie values never reach the bridge
// log, the audit file, or an agent's context.
import {
  HANDOFF_FORMAT, handoffError, requireGrantReady, grantUrl, cookieDomainAllowed, GRANT_ID,
} from './grants.js';

const COOKIE_FIELDS = ['name', 'value', 'domain', 'path', 'secure', 'httpOnly', 'sameSite', 'session', 'expirationDate'];
const SAME_SITE = ['no_restriction', 'lax', 'strict', 'unspecified'];

const invalidRequest = () => handoffError('INVALID_REQUEST', 'Invalid session handoff request.');

function plainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  // Accessors could run code or change between checks; only data properties.
  return Reflect.ownKeys(value).every((key) => {
    const d = Object.getOwnPropertyDescriptor(value, key);
    return typeof key === 'string' && d && Object.hasOwn(d, 'value');
  });
}

function validateParams(params, tabId) {
  if (!Number.isSafeInteger(tabId) || tabId <= 0) throw invalidRequest();
  if (!plainRecord(params)) throw invalidRequest();
  const keys = Object.keys(params);
  if (keys.length !== 2 || !keys.includes('grant') || !keys.includes('recipientPublicKey')) throw invalidRequest();
  if (typeof params.grant !== 'string' || !GRANT_ID.test(params.grant)) throw invalidRequest();
  validateRecipientJwk(params.recipientPublicKey);
}

function validateRecipientJwk(jwk) {
  if (!plainRecord(jwk)) throw invalidRequest();
  const allowed = new Set(['kty', 'crv', 'x', 'y', 'ext', 'key_ops']);
  if (Object.keys(jwk).some((key) => !allowed.has(key))) throw invalidRequest();
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256') throw invalidRequest();
  if (typeof jwk.x !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(jwk.x)) throw invalidRequest();
  if (typeof jwk.y !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(jwk.y)) throw invalidRequest();
  if (Object.hasOwn(jwk, 'ext') && jwk.ext !== true) throw invalidRequest();
  if (Object.hasOwn(jwk, 'key_ops') && (!Array.isArray(jwk.key_ops) || jwk.key_ops.length !== 0)) throw invalidRequest();
}

function projectCookie(cookie) {
  if (typeof cookie?.name !== 'string' || typeof cookie.value !== 'string'
      || typeof cookie.domain !== 'string' || typeof cookie.path !== 'string') return null;
  const out = {};
  for (const field of COOKIE_FIELDS) {
    if (!Object.hasOwn(cookie, field)) continue;
    const value = cookie[field];
    if (['name', 'value', 'domain', 'path'].includes(field)) out[field] = value;
    else if (field === 'sameSite') { if (SAME_SITE.includes(value)) out[field] = value; }
    else if (field === 'expirationDate') { if (typeof value === 'number' && Number.isFinite(value)) out[field] = value; }
    else if (typeof value === 'boolean') out[field] = value;
  }
  return out;
}

function encodeBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return globalThis.btoa(binary);
}

/** AAD binds the ciphertext to its grant: an envelope for one site cannot be passed off as another. */
export function handoffAad(grantId) {
  return `${HANDOFF_FORMAT}:${grantId}`;
}

async function encryptPayload(payload, recipientJwk, cryptoApi) {
  let recipientKey;
  try {
    recipientKey = await cryptoApi.subtle.importKey(
      'jwk', { kty: 'EC', crv: 'P-256', x: recipientJwk.x, y: recipientJwk.y },
      { name: 'ECDH', namedCurve: 'P-256' }, false, [],
    );
  } catch {
    throw invalidRequest();
  }
  try {
    const ephemeral = await cryptoApi.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveKey']);
    const ephemeralPublicKey = await cryptoApi.subtle.exportKey('jwk', ephemeral.publicKey);
    const aesKey = await cryptoApi.subtle.deriveKey(
      { name: 'ECDH', public: recipientKey }, ephemeral.privateKey,
      { name: 'AES-GCM', length: 256 }, false, ['encrypt'],
    );
    const iv = cryptoApi.getRandomValues(new Uint8Array(12));
    const ciphertext = await cryptoApi.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(handoffAad(payload.grant)) },
      aesKey, new TextEncoder().encode(JSON.stringify(payload)),
    );
    return {
      format: HANDOFF_FORMAT,
      grant: payload.grant,
      ephemeralPublicKey,
      iv: encodeBase64(iv),
      ciphertext: encodeBase64(new Uint8Array(ciphertext)),
    };
  } catch {
    throw handoffError('ENCRYPT_FAILED', 'Could not encrypt the session.');
  }
}

export async function handoffSession(params, tabId, chromeApi = globalThis.chrome, cryptoApi = globalThis.crypto) {
  validateParams(params, tabId);
  if (!cryptoApi?.subtle || typeof cryptoApi.getRandomValues !== 'function') {
    throw handoffError('CRYPTO_UNAVAILABLE', 'Secure cryptography is unavailable.');
  }
  const grant = await requireGrantReady(params.grant, chromeApi);

  let tab;
  try { tab = await chromeApi.tabs.get(tabId); } catch {
    throw handoffError('TAB_UNAVAILABLE', 'The selected tab is unavailable.');
  }
  if (!grantUrl(grant, tab?.url)) {
    throw handoffError('TAB_INVALID', `The selected tab must be an HTTPS ${grant.label} tab.`);
  }

  let storeId;
  try {
    const stores = await chromeApi.cookies.getAllCookieStores();
    const matching = Array.isArray(stores)
      ? stores.filter((s) => Array.isArray(s?.tabIds) && s.tabIds.includes(tabId)) : [];
    if (matching.length !== 1 || typeof matching[0]?.id !== 'string' || !matching[0].id) throw new Error('no unique store');
    storeId = matching[0].id;
  } catch {
    throw handoffError('TAB_STORE_UNAVAILABLE', 'Could not identify the selected tab cookie store.');
  }

  const seen = new Set();
  const cookies = [];
  let skippedPartitioned = 0;
  for (const url of grant.cookieUrls) {
    let batch;
    try { batch = await chromeApi.cookies.getAll({ url, storeId }); } catch { batch = null; }
    if (!Array.isArray(batch)) throw handoffError('COOKIE_READ_FAILED', `Unable to read ${grant.label} cookies.`);
    for (const cookie of batch) {
      if (!cookieDomainAllowed(grant, cookie?.domain)) continue;
      // Several cookie URLs overlap (path=/ cookies come back for each).
      const partitioned = cookie.partitionKey !== undefined;
      const key = `${cookie.name}\u0000${cookie.domain}\u0000${cookie.path}\u0000${partitioned}`;
      if (seen.has(key)) continue;
      seen.add(key);
      // Partitioned (CHIPS) cookies belong to one top-level site; replaying
      // them elsewhere is wrong, so they are counted and left behind.
      if (partitioned) { skippedPartitioned++; continue; }
      const projected = projectCookie(cookie);
      if (projected) cookies.push(projected);
    }
  }

  const payload = {
    grant: grant.id,
    captured_at: new Date().toISOString(),
    cookies,
    skipped_partitioned: skippedPartitioned,
  };
  if (typeof globalThis.navigator?.userAgent === 'string') payload.userAgent = globalThis.navigator.userAgent;
  return encryptPayload(payload, params.recipientPublicKey, cryptoApi);
}
