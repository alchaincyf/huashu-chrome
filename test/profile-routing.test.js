// 多 profile 路由：会话绑定 + tabId 认主。
//
// 同一份扩展被多个 Chrome profile 加载，每个 profile 一个实例。旧路由按 lastRx
// 挑实例，心跳也算——一个会话的命令会随心跳节拍在 profile 之间跳，带着的 tabId
// 还可能在另一个 profile 里恰好存在。这组用例守住：会话不换 profile，
// tabId 只去它真正的主人那里，说不清就拒绝而不是猜。
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { startBridge } from '../src/bridge.js';
import { VERSION } from '../src/lib/version.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TOKEN = 'c'.repeat(64);
let bridge;
let url;
const sockets = new Set();

before(async () => {
  bridge = startBridge({ port: 0, token: TOKEN, writeInfo: false, orphanGraceMs: 200, tickMs: 60000, profileInfoMs: 300 });
  await bridge.ready;
  url = `ws://127.0.0.1:${bridge.wss.address().port}`;
});
after(() => bridge.close());
afterEach(async () => {
  for (const ws of sockets) if (ws.readyState <= 1) ws.terminate();
  sockets.clear();
  await settle(60);
});

const settle = (ms = 120) => new Promise((r) => setTimeout(r, ms));
// 回执尾部可能挂着桥的说明（绑定了哪个 profile 等），身份只看第一行
const first = (r) => String(r.data?.text ?? '').split(/\r?\n/)[0];

function waitFor(list, pred, ms = 2000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + ms;
    const tick = () => {
      const hit = list.find(pred);
      if (hit) return resolve(hit);
      if (Date.now() > deadline) return reject(new Error('timed out'));
      setTimeout(tick, 10);
    };
    tick();
  });
}

// 伪装一个 profile 的扩展实例。reply(fn) 决定怎么回每条命令。
async function profile(instanceId, reply = () => ({ text: instanceId }), { label, headless = false } = {}) {
  const ws = new WebSocket(url, { origin: 'chrome-extension://sameid' });
  sockets.add(ws);
  ws.on('error', () => {});
  const cmds = [];
  const inbox = [];
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    inbox.push(m);
    if (!m.cmd) return;
    cmds.push(m);
    const out = reply(m);
    if (out === undefined) return;
    if (out?.error) ws.send(JSON.stringify({ type: 'res', id: m.id, __k: m.__k, ok: false, error: out.error }));
    else ws.send(JSON.stringify({ type: 'res', id: m.id, __k: m.__k, ok: true, data: out }));
  });
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'hello', role: 'extension', extId: 'sameid', version: VERSION, instanceId, profileLabel: label, headless, v: 1 }));
  await waitFor(inbox, (m) => m.type === 'welcome');
  return {
    ws, cmds, ping: () => ws.send(JSON.stringify({ type: 'ping' })),
    rename: (profileLabel) => ws.send(JSON.stringify({ type: 'meta', profileLabel })),
  };
}

async function agent(sid) {
  const ws = new WebSocket(url);
  sockets.add(ws);
  ws.on('error', () => {});
  const inbox = [];
  ws.on('message', (d) => inbox.push(JSON.parse(d.toString())));
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'hello', role: 'agent', token: TOKEN, client: 'test', sessionId: sid, v: 1 }));
  const welcome = await waitFor(inbox, (m) => m.type === 'welcome');
  let n = 0;
  const call = async (cmd, params = {}, extra = {}) => {
    const id = `${sid}-${++n}`;
    ws.send(JSON.stringify({ type: 'cmd', id, cmd, params, ...extra }));
    return waitFor(inbox, (m) => m.type === 'res' && m.id === id, extra.wait || 2000);
  };
  return { ws, welcome, call };
}

test('会话绑定：心跳把 primary 翻到另一个 profile，已绑定的会话也不跟着跳', async () => {
  const work = await profile('profile-work');
  const s1 = await agent('pin-s1');
  assert.equal(first(await s1.call('status')), 'profile-work');

  const home = await profile('profile-home');
  home.ping();
  await settle();
  assert.ok(s1.welcome.capabilities.includes('session-pinning-v1'));

  for (let i = 0; i < 3; i++) {
    (i % 2 ? work : home).ping();
    await settle(30);
    assert.equal(first(await s1.call('snapshot')), 'profile-work', `第 ${i + 1} 次心跳翻转后仍要留在原 profile`);
  }
  assert.equal(home.cmds.length, 0);

  // 新会话按当时的 primary 绑定，之后同样不动
  home.ping();
  await settle(30);
  const s2 = await agent('pin-s2');
  assert.equal(first(await s2.call('status')), 'profile-home');
  work.ping();
  await settle(30);
  assert.equal(first(await s2.call('snapshot')), 'profile-home');
});

test('tabId 认主：从回执学到的 tab 送回它的 profile，哪怕会话绑定的是另一个', async () => {
  const a = await profile('tab-a', (m) => {
    if (m.cmd === 'tabs' && m.params.action === 'list') return { text: '共 2 个标签页\n[7] * A7 — https://a\n[8]   A8 — https://a' };
    return { text: 'tab-a' };
  });
  const sa = await agent('tab-sa');
  await sa.call('tabs', { action: 'list' });

  const b = await profile('tab-b', (m) => {
    if (m.cmd === 'tabs' && m.params.action === 'new') return { text: 'opened', tabId: 501 };
    return { text: 'tab-b' };
  });
  b.ping();
  await settle();
  const sb = await agent('tab-sb');
  assert.equal((await sb.call('tabs', { action: 'new', url: 'https://b' })).data.tabId, 501);

  // sa 绑定 a，但 501 是 b 的
  assert.equal(first(await sa.call('snapshot', { tabId: 501 }, { tabId: 501 })), 'tab-b');
  // sb 绑定 b，但 7 是 a 的（从 list 学到的）
  assert.equal(first(await sb.call('click', { tabId: 7, ref: 'e1' }, { tabId: 7 })), 'tab-a');
  // 没见过的 tabId 走会话绑定
  assert.equal(first(await sb.call('snapshot', {}, { tabId: 999 })), 'tab-b');
  assert.equal(a.cmds.filter((m) => m.tabId === 501).length, 0, 'a 不该收到 b 的 tab');
});

test('tabs list 是全量：不在 list 里的 tab 除名；NO_TAB 也除名', async () => {
  let listText = '[11] x — https://a\n[12] y — https://a';
  const a = await profile('prune-a', (m) => {
    if (m.cmd === 'tabs' && m.params.action === 'list') return { text: listText };
    if (m.tabId === 12) return { error: { code: 'NO_TAB', message: 'gone' } };
    return { text: 'prune-a' };
  });
  const sa = await agent('prune-sa');
  await sa.call('tabs', { action: 'list' });

  const b = await profile('prune-b');
  b.ping();
  await settle();
  const sb = await agent('prune-sb');
  assert.equal(first(await sb.call('status')), 'prune-b');

  // 12：先去 a（认主），a 回 NO_TAB 后除名，下一次就走 sb 自己的绑定
  assert.equal((await sb.call('snapshot', {}, { tabId: 12 })).error.code, 'NO_TAB');
  assert.equal(first(await sb.call('snapshot', {}, { tabId: 12 })), 'prune-b');

  // 11：a 重新 list 时已经没有它了
  listText = '[13] z — https://a';
  await sa.call('tabs', { action: 'list' });
  assert.equal(first(await sb.call('snapshot', {}, { tabId: 11 })), 'prune-b');
  assert.equal(first(await sb.call('snapshot', {}, { tabId: 13 })), 'prune-a');
  assert.ok(a.cmds.length >= 3);
});

test('同一个 tabId 在两个 profile 都见过：绑定的那个说了算，都不是就拒绝猜', async () => {
  const list = (id) => (m) => (m.cmd === 'tabs' && m.params.action === 'list' ? { text: '[42] t — https://x' } : { text: id });
  await profile('dup-a', list('dup-a'));
  const sa = await agent('dup-sa');
  await sa.call('tabs', { action: 'list' });
  const b = await profile('dup-b', list('dup-b'));
  b.ping();
  await settle();
  const sb = await agent('dup-sb');
  await sb.call('tabs', { action: 'list' });

  assert.equal(first(await sa.call('snapshot', {}, { tabId: 42 })), 'dup-a');
  assert.equal(first(await sb.call('snapshot', {}, { tabId: 42 })), 'dup-b');

  const c = await profile('dup-c');
  c.ping();
  await settle();
  const sc = await agent('dup-sc');
  assert.equal(first(await sc.call('status')), 'dup-c');
  const r = await sc.call('snapshot', {}, { tabId: 42 });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'TAB_AMBIGUOUS');
});

test('绑定的 profile 一去不回：等满窗口后明说 PROFILE_OFFLINE 并解绑，下一条才落到别的 profile', async () => {
  const gone = await profile('off-gone');
  const s = await agent('off-s');
  assert.equal(first(await s.call('status')), 'off-gone');
  const stay = await profile('off-stay');
  gone.ws.close();
  await settle();

  const r = await s.call('snapshot', {}, { timeout: 400, wait: 3000 });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'PROFILE_OFFLINE');
  assert.equal(stay.cmds.length, 0, '等待期间不能偷偷换到另一个 profile');

  assert.equal(first(await s.call('snapshot')), 'off-stay');
});

test('tab 的主人不在线：等它，超时报 TAB_PROFILE_OFFLINE，不送去别的 profile', async () => {
  const owner = await profile('own-a', (m) => (m.cmd === 'tabs' ? { text: 'x', tabId: 77 } : { text: 'own-a' }));
  const sa = await agent('own-sa');
  await sa.call('tabs', { action: 'new' });
  const other = await profile('own-b');
  other.ping();
  await settle();
  const sb = await agent('own-sb');
  assert.equal(first(await sb.call('status')), 'own-b');
  owner.ws.close();
  await settle();

  const r = await sb.call('snapshot', {}, { tabId: 77, timeout: 400, wait: 3000 });
  assert.equal(r.error.code, 'TAB_PROFILE_OFFLINE');
  assert.equal(other.cmds.filter((m) => m.tabId === 77).length, 0);
  // 会话自己的绑定不受影响
  assert.equal(first(await sb.call('snapshot')), 'own-b');
});

test('排队等绑定 profile 时别的 profile 连上，不会续命也不会改道', async () => {
  const a = await profile('q-a');
  const s = await agent('q-s');
  await s.call('status');
  a.ws.close();
  await settle();

  const started = Date.now();
  const pending = s.call('snapshot', {}, { timeout: 600, wait: 3000 });
  await settle(250);
  const b = await profile('q-b');   // 触发一次重新路由
  const r = await pending;
  assert.equal(r.error.code, 'PROFILE_OFFLINE');
  assert.ok(Date.now() - started < 1200, '截止时间不能被别的实例上线续掉');
  assert.equal(b.cmds.length, 0);
});

// ---------- profiles ----------

const info = (extra) => (m) => (m.cmd === 'profile_info' ? extra : { text: m.cmd });

test('profiles 列出每个 profile：名字、页数、主要站点、用户在不在这个 profile、本会话在哪', async () => {
  await profile('pf-work', info({ tabs: 5, focused: true, sites: [{ host: 'mail.google.com', count: 3 }, { host: 'github.com', count: 1 }] }), { label: 'Work' });
  const s = await agent('pf-s');
  await s.call('status');
  const home = await profile('pf-home-0001', info({ tabs: 2, focused: false, sites: [] }));
  home.ping();
  await settle();

  const r = await s.call('profiles');
  assert.equal(r.ok, true);
  const byId = Object.fromEntries(r.data.profiles.map((p) => [p.instanceId, p]));
  assert.equal(byId['pf-work'].name, 'Work');
  assert.equal(byId['pf-work'].current, true);
  assert.equal(byId['pf-work'].tabs, 5);
  assert.equal(byId['pf-work'].focused, true);
  assert.equal(byId['pf-home-0001'].name, null);
  assert.equal(byId['pf-home-0001'].current, false);
  assert.match(r.data.text, /This session works in "Work"/);
  assert.match(r.data.text, /mail\.google\.com ×3/);
  assert.match(r.data.text, /user is here/);
  assert.match(r.data.text, /Unnamed profiles/);
  assert.equal(home.cmds.filter((m) => m.cmd !== 'profile_info').length, 0, 'profiles 只该问概况，不该把会话命令发过去');
});

test('profiles({use}) 按名字、完整 id、id 前缀改绑；之后的命令都去新 profile', async () => {
  await profile('use-a', info({ tabs: 1 }), { label: 'Work' });
  const s = await agent('use-s');
  assert.equal(first(await s.call('status')), 'status');
  const b = await profile('use-b-123456', info({ tabs: 1 }), { label: 'Amazon US' });

  const r = await s.call('profiles', { use: 'amazon us' });
  assert.equal(r.ok, true);
  assert.match(r.data.text, /now works in "Amazon US"/);
  await s.call('snapshot');
  assert.equal(b.cmds.filter((m) => m.cmd === 'snapshot').length, 1);

  assert.equal((await s.call('profiles', { use: 'use-a' })).ok, true);
  await s.call('snapshot');
  assert.equal(b.cmds.filter((m) => m.cmd === 'snapshot').length, 1, '改回 use-a 后 b 不该再收到');

  assert.equal((await s.call('profiles', { use: 'use-b' })).ok, true, 'id 前缀（≥4 位）也能用');
  await s.call('snapshot');
  assert.equal(b.cmds.filter((m) => m.cmd === 'snapshot').length, 2);
});

test('profiles({use}) 找不到或有歧义：报错且不改绑', async () => {
  const a = await profile('bad-a', info({}), { label: 'Same' });
  const s = await agent('bad-s');
  await s.call('status');
  await profile('bad-b', info({}), { label: 'same' });

  const nf = await s.call('profiles', { use: 'Nope' });
  assert.equal(nf.error.code, 'PROFILE_NOT_FOUND');
  assert.match(nf.error.message, /"Same"/);
  const amb = await s.call('profiles', { use: 'same' });
  assert.equal(amb.error.code, 'PROFILE_AMBIGUOUS');
  const short = await s.call('profiles', { use: 'bad' });
  assert.equal(short.error.code, 'PROFILE_NOT_FOUND', '少于 4 位的前缀不认');

  await s.call('snapshot');
  assert.equal(a.cmds.filter((m) => m.cmd === 'snapshot').length, 1, '失败的 use 不能动绑定');
});

test('侧栏改名经 meta 就地生效；名字会清洗', async () => {
  const p = await profile('meta-a', info({}));
  const s = await agent('meta-s');
  p.rename('  Work\u0007  Main  ');
  await settle(60);
  const r = await s.call('profiles');
  assert.equal(r.data.profiles[0].name, 'Work Main');
  p.rename('x'.repeat(80));
  await settle(60);
  assert.equal((await s.call('profiles')).data.profiles[0].name.length, 40);
  const g = await agent('meta-g');
  assert.equal(g.welcome.extensions.find((e) => e.instanceId === 'meta-a').label, 'x'.repeat(40));
});

test('老扩展不回 profile_info：profiles 照样返回，只是缺概况', async () => {
  await profile('old-a', (m) => (m.cmd === 'profile_info' ? undefined : { text: 'old-a' }), { label: 'Old' });
  const s = await agent('old-s');
  const started = Date.now();
  const r = await s.call('profiles');
  assert.equal(r.ok, true);
  assert.equal(r.data.profiles[0].name, 'Old');
  assert.equal(r.data.profiles[0].tabs, null);
  assert.ok(Date.now() - started < 1500);
});

test('第一次绑定且有多个有窗口的 profile：回执尾部说明落在哪个账号；tabs list 注明只列本 profile', async () => {
  await profile('note-a', (m) => (m.cmd === 'tabs' ? { text: '[1] a — https://a' } : { text: 'note-a' }), { label: 'Work' });
  const b = await profile('note-b', info({}), { label: 'Home' });
  b.ping();
  await settle();
  const s = await agent('note-s');
  const r1 = await s.call('profiles', { use: 'Work' });
  assert.equal(r1.ok, true);
  // profiles 的概况查询会刷新两边的 lastRx；让 Home 最后有动静，s2 才确定落在它上面
  b.ping();
  await settle();
  const s2 = await agent('note-s2');
  const r = await s2.call('snapshot');
  assert.match(r.data.text, /2 Chrome profiles .* working in "Home"/);
  const again = await s2.call('snapshot');
  assert.doesNotMatch(again.data.text, /Chrome profiles/, '说明只说一次');

  const list = await s.call('tabs', { action: 'list' });
  assert.match(list.data.text, /Chrome profile "Work" only/);
});

test('只有一个有窗口的 profile 时不加任何说明', async () => {
  await profile('solo-a', info({}), { label: 'Solo' });
  await profile('solo-h', info({}), { headless: true });
  const s = await agent('solo-s');
  const r = await s.call('snapshot');
  assert.equal(r.data.text, 'snapshot');
});

// ---------- 跨文件契约：扩展 ↔ 桥 ----------
// background / offscreen / panel / bridge 互相不能 import，约定只能这样对口径。

test('profile 名字的跨文件契约：同一个存储键，两条腿的握手都带名字，改名走 meta，概况走 profile_info', () => {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
  const bg = read('extension/background.js');
  const panel = read('extension/panel.js');
  const off = read('extension/offscreen.js');
  const br = read('src/bridge.js');
  const key = bg.match(/PROFILE_LABEL_KEY = '([^']+)'/)?.[1];
  assert.ok(key, 'background 里找不到 PROFILE_LABEL_KEY');
  assert.ok(panel.includes(`PROFILE_LABEL_KEY = '${key}'`), '侧栏和 background 必须用同一个存储键');
  assert.match(bg, /instanceId: iid, profileLabel: label/, 'SW 直连那条腿的 hello 要带名字');
  assert.match(bg, /profileLabel: label,\s*\n\s*headless: isHeadless\(\)/, 'identity 应答要带名字（offscreen 那条腿靠它）');
  assert.match(off, /profileLabel: who\.profileLabel/, 'offscreen 的 hello 要带名字');
  assert.match(bg, /type: 'meta', profileLabel/, '改名要发 meta');
  assert.match(br, /msg\.type === 'meta'/, '桥要认 meta');
  assert.match(bg, /msg\.cmd === 'profile_info'/, '扩展要应答 profile_info');
  assert.match(br, /askInstance\(e, 'profile_info'\)/, '桥要用同一个命令名');
  for (const loc of ['en', 'zh_CN']) {
    const msgs = JSON.parse(read(`extension/_locales/${loc}/messages.json`));
    for (const k of ['label', 'placeholder', 'save', 'hint', 'saved', 'cleared', 'error']) {
      assert.ok(msgs[`ui_panel_profile_name_${k}`]?.message, `${loc} 缺 ui_panel_profile_name_${k}`);
    }
  }
});
