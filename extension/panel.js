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

$('ver').textContent = `v${MINE}`;

const relTime = (t) => {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 5) return '刚刚';
  if (s < 60) return `${s}秒前`;
  if (s < 3600) return `${Math.floor(s / 60)}分前`;
  return `${Math.floor(s / 3600)}时前`;
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
    box.appendChild(el('div', 'empty', '这一页没有 agent 在操作。下面列着它们各自在哪一页，点一下就能切过去。'));
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
      b.append(el('div', 'lab', '本页'), el('div', null, snap.tabLabel));
      wrap.appendChild(b);
    }
    const intent = snap.intents?.[o.sid];
    if (intent?.text) {
      const b = el('div', 'blk');
      const q = el('div', 'intent', intent.text);
      q.appendChild(el('span', 'ago', relTime(intent.t)));
      b.append(el('div', 'lab', '准备做'), q);
      wrap.appendChild(b);
    }
    if (snap.plan?.length) {
      const p = snap.plan;
      const b = el('div', 'blk');
      b.append(el('div', 'lab', '接下来'),
        el('div', null, p.slice(0, 4).join(' → ') + (p.length > 4 ? ` →（还有 ${p.length - 4} 步）` : '')));
      wrap.appendChild(b);
    }
    if (snap.act && snap.sid === o.sid && Date.now() - snap.actAt < ACT_MS) {
      const b = el('div', 'blk');
      const n = el('div', 'now');
      const pl = el('span', 'pulse'); pl.style.background = o.color;
      n.append(pl, el('span', null, snap.act));
      b.append(el('div', 'lab', '正在做'), n);
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
      b.append(el('div', 'lab', '时间线'), tl);
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
    box.appendChild(el('div', 'empty', '还没有 agent 在线。在 Claude Code、Codex 这类工具里让它用 lingee-chrome 做件事，这里就会出现。'));
    return rows;
  }
  for (const s of rows) {
    const b = el('button');
    const sw = el('span', 'dot'); sw.style.background = s.color;
    b.append(sw, el('span', 'who', s.label), el('span', 'page', s.title ? `· ${s.title}` : '· 还没打开页面'));
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
    const btn = el('button', 'btn ghost', '复制');
    btn.onclick = async () => {
      try { await navigator.clipboard.writeText(cmd); btn.textContent = '已复制'; } catch { btn.textContent = '请手动复制'; }
      setTimeout(() => { btn.textContent = '复制'; }, 1600);
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
  box.appendChild(light('ok', `浏览器扩展 v${MINE}`, '已装好，正在运行'));

  let pill = ['bad', '未连接'];
  if (r.connected) {
    const level = compat({ ext: MINE, cli: r.bridge });
    const note = compatNote(level, { ext: MINE, cli: r.bridge });
    const needCli = level === 'cli-old' || (level === 'protocol' && cmpVersion(MINE, r.bridge) > 0);
    box.appendChild(light(note ? 'warn' : 'ok', `本地端 v${r.bridge || '?'}`, note || '已连接', needCli ? 'npx -y lingee-chrome@latest install' : null));
    pill = note ? ['warn', '已连接（有更新）'] : ['ok', '已连接'];
  } else {
    const never = !r.lastRx;
    box.appendChild(light('bad', '本地端未连接',
      never ? '还没装本地端，或者装了但还没有 agent 用过它（本地端由 agent 第一次调用时拉起）。在终端里跑这一行，它会自动配好你电脑上的 agent：'
        : `上次收到心跳是 ${relTime(r.lastRx)}。先点下面的「重连」；不行再在终端跑：`,
      never ? 'npx -y lingee-chrome@latest install' : 'npx lingee-chrome doctor'));
    if (r.offscreenError) box.appendChild(light('warn', '后台文档建不起来', r.offscreenError));
  }
  $('reconnRow').hidden = !!r.connected;

  box.appendChild(sessionCount
    ? light('ok', `${sessionCount} 个 agent 在线`, '每个 agent 用自己的颜色，页面描边和标签组同色')
    : light('', '暂无 agent 在线', '在你的 agent 里说一句「用 lingee-chrome 打开……」就会出现在这里'));

  $('pilldot').className = `dot ${pill[0]}`;
  $('pilltxt').textContent = pill[1];
}

async function refreshAll() {
  const rows = await renderSessions();
  await renderConn(rows.length);
}

$('reconn').onclick = async () => {
  $('reconn').disabled = true;
  $('reconn').textContent = '连接中…';
  await send({ __hcPopup: 'connect' });
  $('reconn').disabled = false;
  $('reconn').textContent = '重连';
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
