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

const TOKEN = 'c'.repeat(64);
let bridge;
let url;
const sockets = new Set();

before(async () => {
  bridge = startBridge({ port: 0, token: TOKEN, writeInfo: false, orphanGraceMs: 200, tickMs: 60000 });
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
async function profile(instanceId, reply = () => ({ text: instanceId })) {
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
  ws.send(JSON.stringify({ type: 'hello', role: 'extension', extId: 'sameid', version: VERSION, instanceId, headless: false, v: 1 }));
  await waitFor(inbox, (m) => m.type === 'welcome');
  return { ws, cmds, ping: () => ws.send(JSON.stringify({ type: 'ping' })) };
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
  assert.equal((await s1.call('status')).data.text, 'profile-work');

  const home = await profile('profile-home');
  home.ping();
  await settle();
  assert.ok(s1.welcome.capabilities.includes('session-pinning-v1'));

  for (let i = 0; i < 3; i++) {
    (i % 2 ? work : home).ping();
    await settle(30);
    assert.equal((await s1.call('snapshot')).data.text, 'profile-work', `第 ${i + 1} 次心跳翻转后仍要留在原 profile`);
  }
  assert.equal(home.cmds.length, 0);

  // 新会话按当时的 primary 绑定，之后同样不动
  home.ping();
  await settle(30);
  const s2 = await agent('pin-s2');
  assert.equal((await s2.call('status')).data.text, 'profile-home');
  work.ping();
  await settle(30);
  assert.equal((await s2.call('snapshot')).data.text, 'profile-home');
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
  assert.equal((await sa.call('snapshot', { tabId: 501 }, { tabId: 501 })).data.text, 'tab-b');
  // sb 绑定 b，但 7 是 a 的（从 list 学到的）
  assert.equal((await sb.call('click', { tabId: 7, ref: 'e1' }, { tabId: 7 })).data.text, 'tab-a');
  // 没见过的 tabId 走会话绑定
  assert.equal((await sb.call('snapshot', {}, { tabId: 999 })).data.text, 'tab-b');
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
  assert.equal((await sb.call('status')).data.text, 'prune-b');

  // 12：先去 a（认主），a 回 NO_TAB 后除名，下一次就走 sb 自己的绑定
  assert.equal((await sb.call('snapshot', {}, { tabId: 12 })).error.code, 'NO_TAB');
  assert.equal((await sb.call('snapshot', {}, { tabId: 12 })).data.text, 'prune-b');

  // 11：a 重新 list 时已经没有它了
  listText = '[13] z — https://a';
  await sa.call('tabs', { action: 'list' });
  assert.equal((await sb.call('snapshot', {}, { tabId: 11 })).data.text, 'prune-b');
  assert.equal((await sb.call('snapshot', {}, { tabId: 13 })).data.text, 'prune-a');
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

  assert.equal((await sa.call('snapshot', {}, { tabId: 42 })).data.text, 'dup-a');
  assert.equal((await sb.call('snapshot', {}, { tabId: 42 })).data.text, 'dup-b');

  const c = await profile('dup-c');
  c.ping();
  await settle();
  const sc = await agent('dup-sc');
  assert.equal((await sc.call('status')).data.text, 'dup-c');
  const r = await sc.call('snapshot', {}, { tabId: 42 });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'TAB_AMBIGUOUS');
});

test('绑定的 profile 一去不回：等满窗口后明说 PROFILE_OFFLINE 并解绑，下一条才落到别的 profile', async () => {
  const gone = await profile('off-gone');
  const s = await agent('off-s');
  assert.equal((await s.call('status')).data.text, 'off-gone');
  const stay = await profile('off-stay');
  gone.ws.close();
  await settle();

  const r = await s.call('snapshot', {}, { timeout: 400, wait: 3000 });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'PROFILE_OFFLINE');
  assert.equal(stay.cmds.length, 0, '等待期间不能偷偷换到另一个 profile');

  assert.equal((await s.call('snapshot')).data.text, 'off-stay');
});

test('tab 的主人不在线：等它，超时报 TAB_PROFILE_OFFLINE，不送去别的 profile', async () => {
  const owner = await profile('own-a', (m) => (m.cmd === 'tabs' ? { text: 'x', tabId: 77 } : { text: 'own-a' }));
  const sa = await agent('own-sa');
  await sa.call('tabs', { action: 'new' });
  const other = await profile('own-b');
  other.ping();
  await settle();
  const sb = await agent('own-sb');
  assert.equal((await sb.call('status')).data.text, 'own-b');
  owner.ws.close();
  await settle();

  const r = await sb.call('snapshot', {}, { tabId: 77, timeout: 400, wait: 3000 });
  assert.equal(r.error.code, 'TAB_PROFILE_OFFLINE');
  assert.equal(other.cmds.filter((m) => m.tabId === 77).length, 0);
  // 会话自己的绑定不受影响
  assert.equal((await sb.call('snapshot')).data.text, 'own-b');
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
