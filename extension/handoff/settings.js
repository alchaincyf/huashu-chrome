// One on/off control per session grant, shared by the side panel and the
// options page. Never reads cookies.
//
// Turning a grant on asks Chrome for the optional `cookies` permission.
// Turning the last enabled grant off gives that permission back, so a profile
// with no grants enabled is back to holding no cookie access at all.
import { GRANTS_KEY, getGrant } from './grants.js';

const LOCK = 'hc-handoff-grants';

const readMap = (stored) => {
  const v = stored?.[GRANTS_KEY];
  return v && typeof v === 'object' && !Array.isArray(v) ? { ...v } : {};
};
const othersOn = (map, id) => Object.entries(map).some(([k, v]) => k !== id && v === true && getGrant(k));

export function mountGrantSettings({
  grantId, chromeApi = chrome, lockManager = globalThis.navigator?.locks,
  toggle, enable, disable, status, message,
}) {
  if (!getGrant(grantId)) throw new Error(`unknown grant ${grantId}`);
  let busy = false;
  let disposed = false;
  let revision = 0;

  function lock() {
    if (toggle) toggle.disabled = true;
    if (enable) enable.disabled = true;
    if (disable) disable.disabled = true;
  }

  async function refresh() {
    if (disposed) return;
    const current = ++revision;
    try {
      const [stored, granted] = await Promise.all([
        chromeApi.storage.local.get(GRANTS_KEY),
        chromeApi.permissions.contains({ permissions: ['cookies'] }),
      ]);
      if (disposed || current !== revision) return;
      const map = readMap(stored);
      const on = map[grantId] === true;
      const active = on && granted;
      if (toggle) { toggle.checked = active; toggle.disabled = busy; }
      if (enable) enable.disabled = busy || active;
      // Something to undo: this grant is on, or a permission is left over with nothing using it.
      if (disable) disable.disabled = busy || !(on || (granted && !othersOn(map, grantId)));
      status.textContent = message(active ? 'active' : 'inactive');
    } catch {
      if (disposed || current !== revision) return;
      lock();
      status.textContent = message('error');
    }
  }

  // Deliberately not async: permissions.request must start inside the user gesture.
  function change(wanted) {
    if (busy || disposed) return;
    busy = true;
    ++revision;
    lock();
    let permissionRequest;
    if (wanted) {
      try {
        // Capture rejection now, even while another view holds the lock.
        permissionRequest = Promise.resolve(chromeApi.permissions.request({ permissions: ['cookies'] }))
          .then((granted) => ({ granted }), () => ({ failed: true }));
      } catch {
        permissionRequest = Promise.resolve({ failed: true });
      }
    }
    const write = async (value) => {
      const map = readMap(await chromeApi.storage.local.get(GRANTS_KEY));
      map[grantId] = value;
      await chromeApi.storage.local.set({ [GRANTS_KEY]: map });
      return map;
    };
    return (async () => {
      let notice;
      let stopped = false;
      try {
        const mutate = async () => {
          try {
            if (wanted) {
              const permission = await permissionRequest;
              if (permission.failed) throw new Error('permission request failed');
              // Another view may have revoked it while this one waited for the lock.
              const granted = permission.granted === true
                && await chromeApi.permissions.contains({ permissions: ['cookies'] });
              await write(granted);
              if (!granted) notice = 'denied';
            } else {
              const map = await write(false);
              stopped = true;
              if (!othersOn(map, grantId)) {
                const removed = await chromeApi.permissions.remove({ permissions: ['cookies'] });
                if (!removed && await chromeApi.permissions.contains({ permissions: ['cookies'] })) notice = 'revokeError';
              }
            }
          } catch {
            notice = stopped ? 'revokeError' : 'error';
            if (wanted) {
              try { await write(false); } catch { /* refresh reports the real state */ }
            }
          }
        };
        // Web Locks are shared by every extension view in this Chrome profile.
        if (lockManager) await lockManager.request(LOCK, mutate);
        else await mutate();
      } catch {
        notice = 'error';
      } finally {
        busy = false;
        await refresh();
        if (!disposed && notice) status.textContent = message(notice);
      }
    })();
  }

  const onToggle = () => change(toggle.checked);
  const onEnable = () => change(true);
  const onDisable = () => change(false);
  const onStorage = (changes, area) => {
    if (!busy && area === 'local' && Object.hasOwn(changes, GRANTS_KEY)) void refresh();
  };
  const onPermission = (permissions) => {
    if (!busy && permissions.permissions?.includes('cookies')) void refresh();
  };
  toggle?.addEventListener('change', onToggle);
  enable?.addEventListener('click', onEnable);
  disable?.addEventListener('click', onDisable);
  chromeApi.storage.onChanged.addListener(onStorage);
  chromeApi.permissions.onAdded.addListener(onPermission);
  chromeApi.permissions.onRemoved.addListener(onPermission);
  lock();
  status.textContent = message('loading');
  void refresh();
  return {
    refresh,
    dispose() {
      disposed = true;
      ++revision;
      toggle?.removeEventListener('change', onToggle);
      enable?.removeEventListener('click', onEnable);
      disable?.removeEventListener('click', onDisable);
      chromeApi.storage.onChanged.removeListener(onStorage);
      chromeApi.permissions.onAdded.removeListener(onPermission);
      chromeApi.permissions.onRemoved.removeListener(onPermission);
    },
  };
}
