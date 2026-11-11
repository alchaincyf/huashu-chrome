// Which Chrome profile a grant's session comes from.
//
// Getting this wrong hands a script the wrong account, so the rules are strict:
//   1. --profile <name|id> picks one explicitly, and is remembered for that grant.
//   2. Otherwise the remembered profile is used. If it is not connected, fail —
//      never fall back to whichever other profile happens to be open.
//   3. With nothing remembered, use the one connected profile that has the grant
//      turned on. Zero or several: fail and say which names to pass.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { HOME } from '../lib/paths.js';
import { safeError } from './errors.js';

export const MEMORY_FILE = path.join(HOME, 'handoff.json');
const ID = /^[A-Za-z0-9._:-]{1,128}$/;

export const profileName = (inst) => (inst.label ? `"${inst.label}"` : `id ${String(inst.instanceId).slice(0, 8)}`);

/** Match --profile against connected profiles: label (case-insensitive), full id, then id prefix of 4+. */
export function matchProfile(instances, want) {
  const w = String(want).trim();
  const lower = w.toLowerCase();
  const byLabel = instances.filter((i) => i.label && i.label.toLowerCase() === lower);
  if (byLabel.length === 1) return byLabel[0];
  if (byLabel.length > 1) throw safeError(`Several Chrome profiles are named "${w}"; pass an instance id instead.`, 'PROFILE_AMBIGUOUS');
  const byId = instances.find((i) => i.instanceId === w);
  if (byId) return byId;
  if (w.length >= 4) {
    const byPrefix = instances.filter((i) => i.instanceId.startsWith(w));
    if (byPrefix.length === 1) return byPrefix[0];
    if (byPrefix.length > 1) throw safeError(`"${w}" matches several Chrome profiles; use more of the id.`, 'PROFILE_AMBIGUOUS');
  }
  const names = instances.map(profileName).join(', ') || 'none';
  throw safeError(`No connected Chrome profile matches "${w}". Connected: ${names}.`, 'PROFILE_NOT_FOUND');
}

function cleanEntry(e) {
  if (!e || typeof e !== 'object' || !ID.test(e.extensionId ?? '') || !ID.test(e.instanceId ?? '')) return null;
  return { extensionId: e.extensionId, instanceId: e.instanceId, label: typeof e.label === 'string' ? e.label.slice(0, 80) : '' };
}

export function createMemory(file = MEMORY_FILE) {
  const read = async () => {
    let parsed;
    try { parsed = JSON.parse(await fs.readFile(file, 'utf8')); } catch (e) {
      if (e?.code === 'ENOENT') return {};
      throw safeError(`${file} is unreadable; delete it and pass --profile.`, 'MEMORY_INVALID');
    }
    const out = {};
    for (const [grant, entry] of Object.entries(parsed?.grants || {})) {
      const clean = cleanEntry(entry);
      if (clean) out[grant] = clean;
    }
    return out;
  };
  return {
    file,
    read,
    async get(grant) { return (await read())[grant] || null; },
    async set(grant, inst) {
      const grants = await read();
      grants[grant] = cleanEntry(inst);
      const tmp = path.join(path.dirname(file), `.handoff-${process.pid}-${randomUUID()}.tmp`);
      try {
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(tmp, JSON.stringify({ grants }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
        await fs.rename(tmp, file);
      } catch {
        try { await fs.rm(tmp, { force: true }); } catch { /* ignore */ }
        throw safeError(`Could not save the profile choice to ${file}.`, 'MEMORY_WRITE');
      }
    },
  };
}

/**
 * Decide the target profile. `statusOf(inst)` returns that profile's
 * handoff_status (or throws); it is only called when auto-selecting.
 * Resolves to { instance, source: 'explicit'|'remembered'|'auto', remember: boolean }.
 */
export async function chooseProfile({ instances, grant, profile, memory, statusOf }) {
  const headed = instances.filter((i) => !i.headless);
  if (!headed.length) {
    throw safeError('No Chrome profile is connected to the bridge. Open Chrome with the huashu-chrome extension.', 'NO_EXTENSION');
  }
  if (profile !== undefined) {
    return { instance: matchProfile(headed, profile), source: 'explicit', remember: true };
  }
  const saved = await memory.get(grant);
  if (saved) {
    const live = headed.find((i) => i.extensionId === saved.extensionId && i.instanceId === saved.instanceId);
    if (!live) {
      throw safeError(
        `The Chrome profile used for "${grant}" (${profileName(saved)}) is not connected. Open it, or pass --profile to choose another.`,
        'PROFILE_OFFLINE',
      );
    }
    return { instance: live, source: 'remembered', remember: false };
  }
  const on = [];
  let old = 0;
  for (const inst of headed) {
    try {
      const status = await statusOf(inst);
      if (status.grants.some((g) => g.id === grant && g.enabled)) on.push(inst);
    } catch (e) {
      if (e?.code === 'EXTENSION_OLD') old++;
    }
  }
  if (on.length === 1) return { instance: on[0], source: 'auto', remember: true };
  if (on.length > 1) {
    throw safeError(`"${grant}" sharing is on in several Chrome profiles (${on.map(profileName).join(', ')}); pass --profile.`, 'PROFILE_AMBIGUOUS');
  }
  throw safeError(
    `No connected Chrome profile has "${grant}" sharing turned on. In the profile whose login you want, open the huashu-chrome side panel and turn it on.`
      + (old ? ` (${old} profile(s) run an older extension; reload with \`huashu-chrome dev --once\`.)` : ''),
    'GRANT_DISABLED',
  );
}
