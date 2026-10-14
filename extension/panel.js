// 侧栏 —— agent 在这个窗口里做什么、连没连上、开关在哪，全在这一处。
//
// 2026-10-13 起它接替了两样东西：原 popup（连接状态、开关、会话列表）和页内
// 驾驶舱（准备做 / 正在做 / 时间线）。驾驶舱搬出页面是因为它常驻右下角，
// 正好压住聊天类页面的发送键（花叔收到的反馈，豆包实测复现）。
//
// 数据源：background 每条命令后把该 tab 的归属与时间线写进 storage.session
// （panel:<tabId>），这里只订阅、只渲染。所有外部文字（agent 声明的意图、
// 网页标题、client 名）一律 textContent——它们都可能源自被注入的页面。

import { compat, compatNote, cmpVersion } from './compat.js';
import { localizeDocument, t } from './i18n.js';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};
const send = (msg) => chrome.runtime.sendMessage(msg).catch(() => null);
const MINE = chrome.runtime.getManifest().version;
const ACT_MS = 5000;   // 「正在做」只亮 5 秒——停手了还亮着就是在骗人

localizeDocument();

$('ver').textContent = `v${MINE}`;

const relTime = (timestamp) => {
  const s = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (s < 5) return t('panel_rel_just_now');
  if (s < 60) return t(`panel_rel_seconds_${s === 1 ? 'one' : 'many'}`, [s]);
  if (s < 3600) {
    const minutes = Math.floor(s / 60);
    return t(`panel_rel_minutes_${minutes === 1 ? 'one' : 'many'}`, [minutes]);
  }
  const hours = Math.floor(s / 3600);
  return t(`panel_rel_hours_${hours === 1 ? 'one' : 'many'}`, [hours]);
};

let winId = null, tabId = null, actTimer = null;

// ---------- 这一页 ----------

async function renderPage() {
  const box = $('page');
  if (winId == null) winId = (await chrome.windows.getCurrent()).id;
  const [tab] = await chrome.tabs.query({ active: true, windowId: winId });
  tabId = tab?.id ?? null;
  const key = `panel:${tabId}`;
  const got = tabId == null ? {} : await chrome.storage.session.get([key, 'liveSids']);
  const lives = new Set(got.liveSids || []);
  const snap = got[key];
  // 会话结束后快照可能还没来得及摘（页面标记关着时没人去刷新它）——以在线名单为准
  const owners = (snap?.owners || []).filter((o) => lives.has(o.sid));

  box.textContent = '';
  if (!owners.length) {
    box.appendChild(el('div', 'empty', t('panel_page_no_agent')));
    return;
  }

  for (const o of owners) {
    const wrap = el('div');
    wrap.style.setProperty('--c', o.color);
    const head = el('div', 'owner');
    const sw = el('span', 'sw'); sw.style.background = o.color;
    head.append(sw, el('span', 'who', o.label), el('span', 'code', o.code));
    wrap.appendChild(head);

    if (snap.tabLabel) {
      const b = el('div', 'blk');
      b.append(el('div', 'lab', t('panel_label_current_page')), el('div', null, snap.tabLabel));
      wrap.appendChild(b);
    }
    const intent = snap.intents?.[o.sid];
    if (intent?.text) {
      const b = el('div', 'blk');
      const q = el('div', 'intent', intent.text);
      q.appendChild(el('span', 'ago', relTime(intent.t)));
      b.append(el('div', 'lab', t('panel_label_intent')), q);
      wrap.appendChild(b);
    }
    if (snap.plan?.length) {
      const p = snap.plan;
      const b = el('div', 'blk');
      const more = p.length > 4
        ? t(`panel_more_steps_${p.length === 5 ? 'one' : 'many'}`, [p.length - 4])
        : '';
      b.append(el('div', 'lab', t('panel_label_next')),
        el('div', null, p.slice(0, 4).join(' → ') + more));
      wrap.appendChild(b);
    }
    if (snap.act && snap.sid === o.sid && Date.now() - snap.actAt < ACT_MS) {
      const b = el('div', 'blk');
      const n = el('div', 'now');
      const pl = el('span', 'pulse'); pl.style.background = o.color;
      n.append(pl, el('span', null, snap.act));
      b.append(el('div', 'lab', t('panel_label_now')), n);
      wrap.appendChild(b);
      clearTimeout(actTimer);
      actTimer = setTimeout(renderPage, ACT_MS - (Date.now() - snap.actAt) + 50);
    }
    const rows = snap.logs?.[o.sid] || [];
    if (rows.length) {
      const b = el('div', 'blk');
      const tl = el('div', 'tl');
      for (const r of rows) {
        const row = el('div', 'row');
        row.append(el('span', 'ago', relTime(r.t)), el('span', null, r.text));
        tl.appendChild(row);
      }
      b.append(el('div', 'lab', t('panel_label_timeline')), tl);
      wrap.appendChild(b);
    }
    box.appendChild(wrap);
  }
}

// ---------- 所有会话 ----------

async function renderSessions() {
  const r = await send({ __hcPopup: 'sessions' });
  $('mark').checked = r?.enabled !== false;
  const box = $('sess');
  box.textContent = '';
  const rows = r?.sessions || [];
  if (!rows.length) {
    box.appendChild(el('div', 'empty', t('panel_sessions_empty')));
    return rows;
  }
  for (const s of rows) {
    const b = el('button');
    const sw = el('span', 'dot'); sw.style.background = s.color;
    b.append(sw, el('span', 'who', s.label), el('span', 'page', s.title ? t('panel_session_page_title', s.title) : t('panel_session_no_page')));
    if (s.tabId) b.onclick = () => send({ __hcPopup: 'focusTab', tabId: s.tabId });
    else b.disabled = true;
    box.appendChild(b);
  }
  return rows;
}

// ---------- 连接：三盏灯 ----------
//
// 用户以前只看得到一盏灯，分不清是扩展断了、本地端没起、还是根本没有 agent 在跑。
// 每盏红灯旁边直接给能复制的修法。

function light(state, name, sub, cmd) {
  const row = el('div', 'light');
  const d = el('span', `dot ${state}`);
  const txt = el('div');
  txt.appendChild(el('div', 'name', name));
  if (sub) txt.appendChild(el('div', 'sub', sub));
  if (cmd) {
    const c = el('div', 'cmd');
    const code = el('code', null, cmd);
    const btn = el('button', 'btn ghost', t('panel_copy'));
    btn.onclick = async () => {
      try { await navigator.clipboard.writeText(cmd); btn.textContent = t('panel_copied'); } catch { btn.textContent = t('panel_copy_manual'); }
      setTimeout(() => { btn.textContent = t('panel_copy'); }, 1600);
    };
    c.append(code, btn);
    txt.appendChild(c);
  }
  row.append(d, txt);
  return row;
}

async function renderConn(sessionCount) {
  const r = (await send({ __hcPopup: 'status' })) || {};
  const box = $('lights');
  box.textContent = '';
  box.appendChild(light('ok', t('panel_extension_running', [MINE]), t('panel_extension_installed')));

  let pill = ['bad', t('panel_pill_not_connected')];
  if (r.connected) {
    const level = compat({ ext: MINE, cli: r.bridge });
    const note = compatNote(level, { ext: MINE, cli: r.bridge, locale: document.documentElement.lang });
    const needCli = level === 'cli-old' || (level === 'protocol' && cmpVersion(MINE, r.bridge) > 0);
    box.appendChild(light(note ? 'warn' : 'ok', t('panel_cli_name', [r.bridge || '?']), note || t('panel_cli_connected'), needCli ? 'npx -y huashu-chrome@latest install' : null));
    pill = note ? ['warn', t('panel_pill_connected_update')] : ['ok', t('panel_pill_connected')];
  } else {
    const never = !r.lastRx;
    box.appendChild(light('bad', t('panel_cli_disconnected'),
      never ? t('panel_cli_never_used_setup')
        : t('panel_cli_last_heartbeat', [relTime(r.lastRx)]),
      never ? 'npx -y huashu-chrome@latest install' : 'npx huashu-chrome doctor'));
    if (r.offscreenError) box.appendChild(light('warn', t('panel_background_doc_error'), r.offscreenError));
  }
  $('reconnRow').hidden = !!r.connected;

  box.appendChild(sessionCount
    ? light('ok', t(`panel_agents_online_${sessionCount === 1 ? 'one' : 'many'}`, [sessionCount]), t('panel_agents_colors_hint'))
    : light('', t('panel_no_agents'), t('panel_no_agents_hint')));

  $('pilldot').className = `dot ${pill[0]}`;
  $('pilltxt').textContent = pill[1];
}

async function refreshAll() {
  const rows = await renderSessions();
  await renderConn(rows.length);
}

$('reconn').onclick = async () => {
  $('reconn').disabled = true;
  $('reconn').textContent = t('panel_reconnect_connecting');
  await send({ __hcPopup: 'connect' });
  $('reconn').disabled = false;
  $('reconn').textContent = t('panel_reconnect');
  refreshAll();
};

// ---------- 设置 ----------

chrome.storage.local.get('l2Disabled', ({ l2Disabled }) => { $('l2').checked = !l2Disabled; });

$('l2').onchange = async (e) => {
  if (!e.target.checked) {
    // 关之前先把还挂着的调试会话断干净，否则开关关了、黄条还留在标签页上
    await send({ __hcPopup: 'detachAll' });
    await chrome.storage.local.set({ l2Disabled: true });
  } else {
    await chrome.storage.local.set({ l2Disabled: false });
  }
};

$('mark').onchange = async (e) => {
  await chrome.storage.local.set({ markDisabled: !e.target.checked });
  // 先落盘再让 background 去贴/摘——它读的就是这个开关
  await send({ __hcPopup: 'markSync' });
  refreshAll();
};

// ---------- 订阅 ----------

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'session') return;
  const keys = Object.keys(changes);
  if (keys.includes(`panel:${tabId}`) || keys.includes('liveSids')) renderPage();
  if (keys.includes('liveSids') || keys.includes('bridgeConnected') || keys.includes('markedTabs')) refreshAll();
});
chrome.tabs.onActivated.addListener(({ windowId }) => { if (windowId === winId) renderPage(); });
chrome.tabs.onUpdated.addListener((id, info) => { if (info.title) refreshAll(); if (id === tabId && info.status === 'complete') renderPage(); });

renderPage();
refreshAll();
// 相对时间要走字，连接状态要跟上（桥的心跳不写 storage）
setInterval(() => { renderPage(); refreshAll(); }, 15000);
