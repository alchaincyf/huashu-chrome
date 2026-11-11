// One switch row per session grant. Used by the side panel and the options page.
import { listGrants } from './grants.js';
import { mountGrantSettings } from './settings.js';

export function renderGrantRows(container, t, chromeApi = globalThis.chrome) {
  const doc = container.ownerDocument;
  const el = (tag, cls, text) => {
    const e = doc.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };
  return listGrants().map((grant) => {
    const row = el('label', 'sw-row');
    const txt = el('span', 'txt');
    const name = el('span', null, grant.label);
    name.id = `grant-${grant.id}-label`;
    txt.append(name, el('div', 'sub', `--grant ${grant.id} · ${grant.hosts.join(', ')}`));
    const toggle = el('input', 'toggle');
    toggle.type = 'checkbox';
    toggle.disabled = true;
    toggle.setAttribute('aria-labelledby', name.id);
    row.append(txt, toggle);
    const status = el('p', 'setting-status');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    container.append(row, status);
    return mountGrantSettings({ grantId: grant.id, chromeApi, toggle, status, message: (key) => t(`panel_grant_${key}`) });
  });
}
