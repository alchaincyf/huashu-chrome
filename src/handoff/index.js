// Borrow a Chrome profile's login for a local script.
//
//   getSession({ grant, profile?, tabId?, storeId? })  → decrypted session (in memory only)
//   getStatus({ profile? })                            → every profile × grant, no cookies read
import { connect, HANDOFF_CAPABILITY, CLIENT_TIMEOUT_MS } from './client.js';
import { newKeyPair, decryptEnvelope } from './envelope.js';
import { chooseProfile, createMemory, matchProfile, profileName } from './profile.js';
import { safeError, sanitize } from './errors.js';

export const GRANT_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const str = (v, max) => typeof v === 'string' && v.length <= max && !CONTROL.test(v);
const storeOk = (v) => v === null || str(v, 512);

const badStatus = () => safeError('The Chrome extension sent an invalid status.', 'BAD_RESPONSE');

export function validateStatus(data, inst) {
  if (!data || typeof data !== 'object' || data.extensionId !== inst.extensionId || data.instanceId !== inst.instanceId
      || typeof data.cookiePermission !== 'boolean' || typeof data.cookieApiAvailable !== 'boolean'
      || !Array.isArray(data.grants) || data.grants.length > 64) throw badStatus();
  const grants = data.grants.map((g) => {
    if (!g || typeof g !== 'object' || typeof g.id !== 'string' || !GRANT_ID.test(g.id) || !str(g.label, 80)
        || typeof g.enabled !== 'boolean' || typeof g.ready !== 'boolean'
        || !Array.isArray(g.hosts) || !g.hosts.every((h) => str(h, 253))
        || !Array.isArray(g.cookieDomains) || !g.cookieDomains.length || !g.cookieDomains.every((d) => str(d, 253))
        || !Array.isArray(g.tabs) || g.tabs.length > 2_000) throw badStatus();
    const tabs = g.tabs.map((t) => {
      if (!t || !Number.isSafeInteger(t.tabId) || t.tabId <= 0 || !Number.isSafeInteger(t.windowId)
          || typeof t.incognito !== 'boolean' || !storeOk(t.storeId)) throw badStatus();
      return { tabId: t.tabId, windowId: t.windowId, incognito: t.incognito, storeId: t.storeId };
    });
    return {
      id: g.id, label: g.label, hosts: [...g.hosts], cookieDomains: g.cookieDomains.map((d) => d.toLowerCase().replace(/^\./, '')),
      enabled: g.enabled, ready: g.ready, tabs,
    };
  });
  return { cookiePermission: data.cookiePermission, cookieApiAvailable: data.cookieApiAvailable, grants };
}

function notReady(status, grant, inst) {
  const g = status.grants.find((x) => x.id === grant);
  const where = `Chrome profile ${profileName(inst)}`;
  if (!g) return safeError(`The extension in ${where} has no "${grant}" grant. Update or reload it: \`huashu-chrome dev --once\`.`, 'UNKNOWN_GRANT');
  if (!g.enabled) return safeError(`"${g.label}" sharing is off in ${where}. Turn it on in that profile's huashu-chrome side panel.`, 'GRANT_DISABLED');
  if (!status.cookiePermission) return safeError(`Chrome has not granted cookie permission in ${where}. Turn "${g.label}" off and on again in the side panel.`, 'PERMISSION_REQUIRED');
  if (!status.cookieApiAvailable) return safeError(`Reload the extension in ${where} after granting cookie permission: \`huashu-chrome dev --once\`.`, 'COOKIE_API_UNAVAILABLE');
  return null;
}

function requireHandoff(welcome) {
  if (!welcome.capabilities.includes(HANDOFF_CAPABILITY)) {
    throw safeError('The running bridge is older than this command. Restart it: close agent sessions, then run `huashu-chrome doctor`.', 'BRIDGE_OLD');
  }
}

const targetOf = (inst) => ({ extensionId: inst.extensionId, instanceId: inst.instanceId });

// Right after a bridge (re)start the extensions take a few seconds to dial back
// in, and the welcome lists only who is connected at that instant. Reconnect
// until at least one Chrome profile is there, or give up after waitMs.
export const EXTENSION_WAIT_MS = 8000;
async function connectWithExtensions(options, { waitMs = EXTENSION_WAIT_MS, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const end = Date.now() + waitMs;
  for (;;) {
    const client = await connect(options);
    if (client.welcome.instances.some((i) => !i.headless) || Date.now() >= end) return client;
    client.close();
    await sleep(500);
  }
}

function validateOptions({ grant, profile, tabId, storeId, timeoutMs }) {
  if (typeof grant !== 'string' || !GRANT_ID.test(grant)) throw safeError('--grant needs a grant id such as amazon-sc. `huashu-chrome grants` lists them.', 'USAGE');
  if (profile !== undefined && (!str(profile, 128) || !profile.trim())) throw safeError('--profile needs a profile name or id.', 'USAGE');
  if (tabId !== undefined && (!Number.isSafeInteger(tabId) || tabId <= 0)) throw safeError('--tab-id must be a positive integer.', 'USAGE');
  if (storeId !== undefined && (!str(storeId, 512) || !storeId)) throw safeError('--store-id needs a cookie store id.', 'USAGE');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > CLIENT_TIMEOUT_MS) throw safeError('Invalid timeout.', 'USAGE');
}

export async function getSession(options = {}) {
  const {
    grant, profile, tabId, storeId,
    memory = createMemory(), timeoutMs = CLIENT_TIMEOUT_MS, crypto, now = Date.now, extensionWaitMs,
    ...connectOptions
  } = options;
  validateOptions({ grant, profile, tabId, storeId, timeoutMs });
  const keys = await newKeyPair(crypto);
  const client = await connectWithExtensions({ ...connectOptions, timeoutMs }, { waitMs: extensionWaitMs });
  try {
    requireHandoff(client.welcome);
    const statuses = new Map();
    const statusOf = async (inst) => {
      if (!statuses.has(inst.instanceId)) {
        statuses.set(inst.instanceId, validateStatus(await client.request('handoff_status', {}, targetOf(inst)), inst));
      }
      return statuses.get(inst.instanceId);
    };
    const chosen = await chooseProfile({ instances: client.welcome.instances, grant, profile, memory, statusOf });
    const inst = chosen.instance;
    const status = await statusOf(inst);
    const problem = notReady(status, grant, inst);
    if (problem) throw problem;
    const grantInfo = status.grants.find((g) => g.id === grant);

    const resolveParams = { grant, openIfMissing: true };
    if (tabId !== undefined) resolveParams.tabId = tabId;
    if (storeId !== undefined) resolveParams.storeId = storeId;
    const resolved = await client.request('handoff_resolve_tab', resolveParams, targetOf(inst));
    if (!Number.isSafeInteger(resolved?.tabId) || resolved.tabId <= 0 || (tabId !== undefined && resolved.tabId !== tabId)
        || !storeOk(resolved.storeId ?? null) || (storeId !== undefined && resolved.storeId !== storeId)) {
      throw safeError('The Chrome extension picked an unexpected tab.', 'BAD_RESPONSE');
    }

    const envelope = await client.request(
      'handoff_session', { grant, recipientPublicKey: keys.publicJwk }, targetOf(inst), { tabId: resolved.tabId },
    );
    const payload = await decryptEnvelope(envelope, keys.privateKey, grantInfo, { crypto, now: now() });
    // Remember only after a session actually came back from that profile.
    if (chosen.remember) await memory.set(grant, inst);
    return {
      grant,
      profile: { name: inst.label || null, instanceId: inst.instanceId, source: chosen.source },
      tabId: resolved.tabId,
      captured_at: payload.captured_at,
      ...(payload.userAgent ? { userAgent: payload.userAgent } : {}),
      cookies: payload.cookies,
      skipped_partitioned: payload.skipped_partitioned,
    };
  } catch (error) {
    throw sanitize(error);
  } finally {
    client.close();
  }
}

export async function getStatus(options = {}) {
  const { profile, memory = createMemory(), timeoutMs = CLIENT_TIMEOUT_MS, extensionWaitMs, ...connectOptions } = options;
  if (profile !== undefined && (!str(profile, 128) || !profile.trim())) throw safeError('--profile needs a profile name or id.', 'USAGE');
  const client = await connectWithExtensions({ ...connectOptions, timeoutMs }, { waitMs: extensionWaitMs });
  try {
    requireHandoff(client.welcome);
    const headed = client.welcome.instances.filter((i) => !i.headless);
    const picked = profile !== undefined ? [matchProfile(headed, profile)] : headed;
    const remembered = await memory.read().catch(() => ({}));
    const profiles = [];
    for (const inst of picked) {
      let status = null;
      let error = null;
      try { status = validateStatus(await client.request('handoff_status', {}, targetOf(inst)), inst); } catch (e) {
        error = sanitize(e).message;
      }
      profiles.push({
        name: inst.label || null,
        instanceId: inst.instanceId,
        version: inst.version,
        error,
        cookiePermission: status?.cookiePermission ?? null,
        grants: (status?.grants || []).map((g) => ({
          id: g.id, label: g.label, enabled: g.enabled, ready: g.ready, tabs: g.tabs.length,
          remembered: remembered[g.id]?.instanceId === inst.instanceId,
        })),
      });
    }
    return { ok: true, bridge: client.welcome.version, profiles };
  } catch (error) {
    throw sanitize(error);
  } finally {
    client.close();
  }
}
