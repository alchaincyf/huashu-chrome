// The bridge's part in session handoff: only `huashu-chrome run` may send
// handoff_* commands, they must name a profile, and the whole path works over
// a real bridge with the real extension code on the far end.
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { webcrypto } from 'node:crypto';
import WebSocket from 'ws';
import { startBridge } from '../src/bridge.js';
import { VERSION } from '../src/lib/version.js';
import { handoffSession } from '../extension/handoff/session.js';
import { handoffStatus } from '../extension/handoff/control.js';
import { GRANTS_KEY } from '../extension/handoff/grants.js';
import { getSession } from '../src/handoff/index.js';
import { createMemory } from '../src/handoff/profile.js';
import { HOME } from '../src/lib/paths.js';

const TOKEN = 'e'.repeat(64);
const SECRET = 'bridge-test-cookie-value';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let bridge;
let port;
const sockets = new Set();

before(async () => {
  bridge = startBridge({ port: 0, token: TOKEN, writeInfo: false, tickMs: 60000 });
  await bridge.ready;
  port = bridge.wss.address().port;
});
after(() => bridge.close());
afterEach(async () => {
  for (const ws of sockets) if (ws.readyState <= 1) ws.terminate();
  sockets.clear();
  await new Promise((r) => setTimeout(r, 60));
});

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

// A Chrome profile whose extension answers handoff_* with the real code.
async function profile(instanceId, label) {
  const seen = [];
  const chromeApi = {
    storage: { local: { get: async () => ({ [GRANTS_KEY]: { 'amazon-sc': true } }) } },
    permissions: { contains: async () => true },
    tabs: {
      get: async () => ({ id: 42, url: 'https://sellercentral.amazon.com/home' }),
      query: async () => [{ id: 42, windowId: 1, incognito: false, status: 'complete', url: 'https://sellercentral.amazon.com/home' }],
    },
    cookies: {
      getAllCookieStores: async () => [{ id: '0', tabIds: [42] }],
      getAll: async () => [{ name: 'sid', value: SECRET, domain: '.amazon.com', path: '/', secure: true, httpOnly: true, sameSite: 'lax', session: true }],
    },
  };
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, { origin: 'chrome-extension://sameid' });
  sockets.add(ws);
  ws.on('error', () => {});
  const inbox = [];
  ws.on('message', async (d) => {
    const m = JSON.parse(d.toString());
    inbox.push(m);
    if (!m.cmd) return;
    seen.push(m);
    const reply = (ok, payload) => ws.send(JSON.stringify({ type: 'res', id: m.id, __k: m.__k, ok, ...(ok ? { data: payload } : { error: payload }) }));
    try {
      if (m.cmd === 'handoff_status') return reply(true, await handoffStatus(m.params, { extensionId: 'sameid', instanceId, version: VERSION }, chromeApi));
      if (m.cmd === 'handoff_resolve_tab') return reply(true, { tabId: 42, created: false, storeId: '0' });
      if (m.cmd === 'handoff_session') return reply(true, await handoffSession(m.params, m.tabId, chromeApi, webcrypto));
      return reply(true, { text: 'ok' });
    } catch (e) {
      return reply(false, { code: e.code || 'INTERNAL', message: e.message });
    }
  });
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'hello', role: 'extension', extId: 'sameid', version: VERSION, instanceId, profileLabel: label, headless: false, v: 1 }));
  await waitFor(inbox, (m) => m.type === 'welcome');
  return { seen };
}

async function agent(client) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  sockets.add(ws);
  ws.on('error', () => {});
  const inbox = [];
  ws.on('message', (d) => inbox.push(JSON.parse(d.toString())));
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'hello', role: 'agent', token: TOKEN, client, sessionId: `${client}:t`, v: 1 }));
  const welcome = await waitFor(inbox, (m) => m.type === 'welcome');
  let n = 0;
  const call = (cmd, params, extra = {}) => {
    const id = `c${++n}`;
    ws.send(JSON.stringify({ type: 'cmd', id, cmd, params, ...extra }));
    return waitFor(inbox, (m) => m.type === 'res' && m.id === id);
  };
  return { welcome, call };
}

test('agents (MCP, CLI call) are refused handoff_* even when they name a profile', async () => {
  const p = await profile('hb-a', 'Work');
  for (const client of ['claude-code', 'cli', 'codex']) {
    const a = await agent(client);
    for (const cmd of ['handoff_status', 'handoff_resolve_tab', 'handoff_session']) {
      const r = await a.call(cmd, {}, { target: { extensionId: 'sameid', instanceId: 'hb-a' } });
      assert.equal(r.ok, false);
      assert.equal(r.error.code, 'HANDOFF_FORBIDDEN', `${client} ${cmd}`);
    }
  }
  assert.equal(p.seen.length, 0, 'the extension never saw them');
});

test('huashu-handoff must name the profile: no default routing, no session pinning', async () => {
  const p = await profile('hb-b', 'Work');
  const a = await agent('huashu-handoff');
  assert.ok(a.welcome.capabilities.includes('session-handoff-v1'));
  const r = await a.call('handoff_status', {});
  assert.equal(r.error.code, 'TARGET_REQUIRED');
  assert.equal(p.seen.length, 0);
  const ok = await a.call('handoff_status', {}, { target: { extensionId: 'sameid', instanceId: 'hb-b' } });
  assert.equal(ok.ok, true);
  assert.equal(ok.data.instanceId, 'hb-b');
});

test('end to end over the real bridge: run picks the named profile and decrypts; the bridge only ever carried ciphertext', async () => {
  await profile('hb-work', 'Work');
  const home = await profile('hb-home', 'Home');
  const dir = fs.mkdtempSync(path.join(HOME, 'handoff-e2e-'));
  const session = await getSession({
    grant: 'amazon-sc', profile: 'home',
    memory: createMemory(path.join(dir, 'handoff.json')),
    readBridgeInfo: async () => ({ port, token: TOKEN }),
  });
  assert.equal(session.profile.name, 'Home');
  assert.equal(session.cookies[0].value, SECRET);
  const sent = home.seen.find((m) => m.cmd === 'handoff_session');
  assert.equal(sent.tabId, 42);
  assert.equal(sent.client, 'huashu-handoff');
  // what the bridge relayed back is in its audit; the value must not be there
  const auditFile = path.join(HOME, 'audit.jsonl');
  if (fs.existsSync(auditFile)) assert.ok(!fs.readFileSync(auditFile, 'utf8').includes(SECRET));
});

test('contract: background answers handoff_* before session slots, marks and coaching; manifest stays huashu-chrome', () => {
  const bg = fs.readFileSync(path.join(ROOT, 'extension/background.js'), 'utf8');
  const early = bg.indexOf('const handoff = HANDOFF_HANDLERS[msg.cmd];');
  assert.ok(early > 0 && early < bg.indexOf('await noteSession(msg.sid'), 'handoff dispatch must come before noteSession/resolveTab');
  assert.doesNotMatch(bg.slice(bg.indexOf('const HANDLERS = {')), /handoff_session/, 'not reachable through the ordinary HANDLERS table');
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'extension/manifest.json'), 'utf8'));
  assert.equal(manifest.name, 'huashu-chrome');
  assert.deepEqual(manifest.optional_permissions, ['cookies']);
  assert.ok(!(manifest.permissions || []).includes('cookies'), 'cookie access is opt-in per profile, never install-time');
  assert.equal(manifest.options_ui.page, 'options.html');
});
