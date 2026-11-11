// reload({all:true}) 与「哪个 profile 在跑旧代码」。
//
// 同一个 unpacked 文件夹被几个 Chrome profile 加载：改一次代码要每个都重载，
// 漏掉一个，它就带着同样的版本号继续跑旧代码——症状是「修好的 bug 时有时无」。
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { startBridge } from '../src/bridge.js';
import { VERSION } from '../src/lib/version.js';
import { isNoiseFile, newestFile, staleInstances } from '../src/lib/ext-files.js';

const TOKEN = 'd'.repeat(64);
let bridge;
let url;
const sockets = new Set();

before(async () => {
  bridge = startBridge({ port: 0, token: TOKEN, writeInfo: false, tickMs: 60000, profileInfoMs: 300, reloadWaitMs: 900 });
  await bridge.ready;
  url = `ws://127.0.0.1:${bridge.wss.address().port}`;
});
after(() => bridge.close());
afterEach(async () => {
  for (const ws of sockets) if (ws.readyState <= 1) ws.terminate();
  sockets.clear();
  await settle(60);
});

const settle = (ms = 100) => new Promise((r) => setTimeout(r, ms));
function waitFor(list, pred, ms = 3000) {
  return new Promise((resolve, reject) => {
    const end = Date.now() + ms;
    const tick = () => {
      const hit = list.find(pred);
      if (hit) return resolve(hit);
      if (Date.now() > end) return reject(new Error('timed out'));
      setTimeout(tick, 10);
    };
    tick();
  });
}

// 一个 profile 的扩展实例。onReload：'restart' = 回执后断开并在 100ms 后带同一个 instanceId
// 重连（像 chrome.runtime.reload）；'vanish' = 回执后断开不再回来；'mute' = 根本不回。
async function profile(instanceId, { label, onReload = 'restart', loadedAt = 1000 } = {}) {
  const state = { cmds: [], reloads: 0, ws: null, loadedAt };
  const connect = async () => {
    const ws = new WebSocket(url, { origin: 'chrome-extension://sameid' });
    sockets.add(ws);
    ws.on('error', () => {});
    const inbox = [];
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      inbox.push(m);
      if (!m.cmd) return;
      state.cmds.push(m);
      if (m.cmd === 'reload') {
        state.reloads++;
        if (onReload === 'mute') return;
        ws.send(JSON.stringify({ type: 'res', id: m.id, __k: m.__k, ok: true, data: { text: 'reloading' } }));
        setTimeout(() => {
          ws.close();
          if (onReload === 'restart') setTimeout(() => { state.loadedAt += 1; void connect(); }, 100);
        }, 20);
        return;
      }
      ws.send(JSON.stringify({ type: 'res', id: m.id, __k: m.__k, ok: true, data: { text: instanceId } }));
    });
    await new Promise((r) => ws.on('open', r));
    ws.send(JSON.stringify({ type: 'hello', role: 'extension', extId: 'sameid', version: VERSION, instanceId, profileLabel: label, loadedAt: state.loadedAt, headless: false, v: 1 }));
    await waitFor(inbox, (m) => m.type === 'welcome');
    state.ws = ws;
  };
  await connect();
  return state;
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
  const call = async (cmd, params = {}) => {
    const id = `${sid}-${++n}`;
    ws.send(JSON.stringify({ type: 'cmd', id, cmd, params }));
    return waitFor(inbox, (m) => m.type === 'res' && m.id === id, 5000);
  };
  return { welcome, call };
}

test('reload({all:true}) 重载每个 profile，等它们带着同一个 instanceId 回来，逐个报告', async () => {
  const work = await profile('ra-work', { label: 'Work' });
  const home = await profile('ra-home', { label: 'Home' });
  const s = await agent('ra-s');
  const r = await s.call('reload', { all: true });
  assert.equal(r.ok, true);
  assert.equal(work.reloads, 1);
  assert.equal(home.reloads, 1);
  assert.equal(r.data.ok, true);
  assert.deepEqual(r.data.instances.map((i) => [i.name, i.back]).sort(), [['Home', true], ['Work', true]]);
  assert.match(r.data.text, /Reloaded 2 Chrome profiles/);
  assert.match(r.data.text, /✓ "Work" reloaded, back in/);

  // 回来之后照常干活，会话绑定也还在原来的 profile 上
  const g = await agent('ra-g');
  assert.equal(g.welcome.extensions.length, 2);
});

test('有的 profile 没回来、有的根本不回：明说是哪个，不报成功', async () => {
  await profile('rb-ok', { label: 'OK' });
  await profile('rb-gone', { label: 'Gone', onReload: 'vanish' });
  await profile('rb-mute', { label: 'Mute', onReload: 'mute' });
  const s = await agent('rb-s');
  const started = Date.now();
  const r = await s.call('reload', { all: true });
  assert.equal(r.data.ok, false);
  assert.match(r.data.text, /Reload incomplete/);
  assert.match(r.data.text, /✓ "OK" reloaded/);
  assert.match(r.data.text, /✗ "Gone" reload sent, not back/);
  assert.match(r.data.text, /✗ "Mute" did not answer/);
  assert.ok(Date.now() - started < 3000, '等待有上限');
});

test('不带 all 的 reload 只发给本会话绑定的 profile', async () => {
  const a = await profile('rc-a', { label: 'A' });
  const b = await profile('rc-b', { label: 'B' });
  const s = await agent('rc-s');
  await s.call('profiles', { use: 'A' });
  await s.call('reload');
  assert.equal(a.reloads, 1);
  assert.equal(b.reloads, 0);
});

test('welcome 报出每个实例的装载时刻（doctor 拿它判断旧代码）', async () => {
  await profile('rd-a', { loadedAt: 1234567 });
  const g = await agent('rd-g');
  assert.equal(g.welcome.extensions.find((e) => e.instanceId === 'rd-a').loadedAt, 1234567);
});

// ---------- ext-files ----------

test('isNoiseFile：编辑器临时文件、隐藏文件不触发重载', () => {
  for (const f of ['.background.js.swp', 'background.js~', 'x.tmp', '.git/HEAD', 'sub/.DS_Store', 'a.crdownload']) {
    assert.equal(isNoiseFile(f), true, f);
  }
  for (const f of ['background.js', '_locales/en/messages.json', 'icons/icon16.png']) {
    assert.equal(isNoiseFile(f), false, f);
  }
});

test('newestFile + staleInstances：装载之后文件夹被改过的 profile 判为旧代码', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-ext-'));
  try {
    fs.mkdirSync(path.join(dir, 'sub'));
    fs.writeFileSync(path.join(dir, 'a.js'), '1');
    fs.writeFileSync(path.join(dir, 'sub', 'b.js'), '2');
    fs.writeFileSync(path.join(dir, '.hidden.tmp'), '3');
    const t0 = Date.now() / 1000 - 100;
    fs.utimesSync(path.join(dir, 'a.js'), t0, t0);
    fs.utimesSync(path.join(dir, 'sub', 'b.js'), t0 + 50, t0 + 50);
    fs.utimesSync(path.join(dir, '.hidden.tmp'), t0 + 90, t0 + 90);
    const newest = newestFile(dir);
    assert.equal(newest.file.replace(/\\/g, '/'), 'sub/b.js', '隐藏/临时文件不算');

    const at = newest.mtimeMs;
    const exts = [
      { instanceId: 'old', loadedAt: at - 60000 },
      { instanceId: 'fresh', loadedAt: at + 5000 },
      { instanceId: 'same-second', loadedAt: at - 500 },
      { instanceId: 'unknown', loadedAt: null },
      { instanceId: 'headless', loadedAt: at - 60000, headless: true },
    ];
    assert.deepEqual(staleInstances(exts, newest).map((e) => e.instanceId), ['old']);
    assert.deepEqual(staleInstances(exts, null), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('装载时刻的跨文件契约：两条腿的握手都带 loadedAt', () => {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
  const bg = read('extension/background.js');
  assert.match(bg, /chrome\.storage\.session\.get\('hcLoadedAt'\)/, '装载时刻要存在 storage.session（重载即清空）');
  assert.match(bg, /loadedAt: at, headless: isHeadless\(\)/, 'SW 直连的 hello 要带 loadedAt');
  assert.match(bg, /loadedAt: at,\s*\n\s*headless: isHeadless\(\)/, 'identity 应答要带 loadedAt');
  assert.match(read('extension/offscreen.js'), /loadedAt: who\.loadedAt/, 'offscreen 的 hello 要带 loadedAt');
});
