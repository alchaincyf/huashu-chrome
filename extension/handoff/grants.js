// Session grants: which sites a local script may borrow this Chrome profile's
// login for. A grant is the whole trust boundary of the handoff feature:
// a script names a grant id, and everything else (hosts, cookie URLs, cookie
// domains) comes from here, never from the request. A process holding the
// bridge token therefore cannot widen the scope to another site.
//
// Grants are presets defined in code for now. Whether a grant is enabled is a
// per-profile choice the user makes in the side panel or the options page,
// stored under GRANTS_KEY in chrome.storage.local.

export const GRANTS_KEY = 'hcHandoffGrants';
export const HANDOFF_FORMAT = 'huashu-session/v1';

const PRESETS = [
  {
    id: 'amazon-sc',
    label: 'Amazon Seller Central',
    hosts: ['sellercentral.amazon.com'],
    // chrome.cookies.getAll({url}) returns the cookies a request to that URL
    // would carry, so path-scoped cookies need their own URL.
    cookieUrls: [
      'https://sellercentral.amazon.com/',
      'https://sellercentral.amazon.com/fba/shippingqueue/api/v1/shipment/listShipments',
    ],
    cookieDomains: ['amazon.com', 'sellercentral.amazon.com'],
    openUrl: 'https://sellercentral.amazon.com/manage/shipments',
  },
];

const GRANTS = new Map(PRESETS.map((g) => [g.id, Object.freeze({ ...g })]));

export const GRANT_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

export function listGrants() {
  return [...GRANTS.values()];
}

export function getGrant(id) {
  return typeof id === 'string' && GRANT_ID.test(id) ? GRANTS.get(id) || null : null;
}

export function handoffError(code, message) {
  return Object.assign(new Error(message), { code: `HANDOFF_${code}` });
}

/** Read which grants are enabled in this profile. Unknown ids are ignored. */
export async function enabledGrants(chromeApi) {
  if (typeof chromeApi?.storage?.local?.get !== 'function') {
    throw handoffError('UNAVAILABLE', 'Session sharing is unavailable in this browser.');
  }
  let stored;
  try {
    stored = (await chromeApi.storage.local.get(GRANTS_KEY))?.[GRANTS_KEY];
  } catch {
    throw handoffError('STATE_UNAVAILABLE', 'Unable to read session sharing settings.');
  }
  const on = new Set();
  if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
    for (const [id, value] of Object.entries(stored)) if (value === true && GRANTS.has(id)) on.add(id);
  }
  return on;
}

export async function cookiePermission(chromeApi) {
  if (typeof chromeApi?.permissions?.contains !== 'function') return false;
  try {
    return await chromeApi.permissions.contains({ permissions: ['cookies'] }) === true;
  } catch {
    return false;
  }
}

export function cookieApiAvailable(chromeApi) {
  return typeof chromeApi?.cookies?.getAllCookieStores === 'function'
    && typeof chromeApi?.cookies?.getAll === 'function';
}

/**
 * Strictly parse a tab URL against a grant: https, one of the grant's hosts,
 * no port, no credentials. Returns the URL or null.
 */
export function grantUrl(grant, value) {
  if (typeof value !== 'string' || !value) return null;
  try {
    const url = new URL(value);
    const authority = /^[a-z][a-z\d+.-]*:\/\/([^/?#]*)/i.exec(value)?.[1] || '';
    if (url.protocol !== 'https:' || !grant.hosts.includes(url.hostname.toLowerCase())
        || url.port || authority.includes('@') || url.username || url.password) return null;
    return url;
  } catch {
    return null;
  }
}

export function cookieDomainAllowed(grant, domain) {
  if (typeof domain !== 'string') return false;
  return grant.cookieDomains.includes(domain.toLowerCase().replace(/^\./, ''));
}

/** Ensure the grant exists, is enabled here, and cookies can be read. */
export async function requireGrantReady(grantId, chromeApi) {
  const grant = getGrant(grantId);
  if (!grant) throw handoffError('UNKNOWN_GRANT', 'Unknown session grant.');
  const on = await enabledGrants(chromeApi);
  if (!on.has(grant.id)) {
    throw handoffError('GRANT_DISABLED', `Session sharing for "${grant.label}" is off in this Chrome profile.`);
  }
  if (!(await cookiePermission(chromeApi))) {
    throw handoffError('PERMISSION_REQUIRED', 'Chrome cookie permission is not granted.');
  }
  if (!cookieApiAvailable(chromeApi)) {
    throw handoffError('COOKIE_API_UNAVAILABLE', 'Chrome cookie API is unavailable; reload the extension after granting cookie permission.');
  }
  return grant;
}
