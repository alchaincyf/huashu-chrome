// Exact extension+profile routing for authenticated Node agents. These use a
// loopback-only mock bridge and extension clients; they never touch bridge.json.
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { startBridge } from '../src/bridge.js';
import { VERSION } from '../src/lib/version.js';

const TOKEN = 'target-routing-test-token';
let bridge;
let url;
const clients = new Set();

before(async () => {
  bridge = startBridge({ port: 0, token: TOKEN, writeInfo: false, orphanGraceMs: 600, tickMs: 60000 });
  await bridge.ready;
  url = `ws://127.0.0.1:${bridge.wss.address().port}`;
});

after(async () => bridge.close());

afterEach(async () => {
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.terminate();
  }
  clients.clear();
  await new Promise((resolve) => setTimeout(resolve, 40));
});

function channel(ws) {
  const history = [];
  const queued = [];
  const waiters = [];
  ws.on('message', (raw) => {
    const message = JSON.parse(raw.toString());
    history.push(message);
    const index = waiters.findIndex((waiter) => waiter.predicate(message));
    if (index >= 0) {
      const [waiter] = waiters.splice(index, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    } else queued.push(message);
  });
  return {
    history,
    next(predicate, ms = 2000) {
      const index = queued.findIndex(predicate);
      if (index >= 0) return Promise.resolve(queued.splice(index, 1)[0]);
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve };
        waiter.timer = setTimeout(() => {
          const i = waiters.indexOf(waiter);
          if (i >= 0) waiters.splice(i, 1);
          reject(new Error(`timed out waiting for WebSocket message after ${ms}ms`));
        }, ms);
        waiters.push(waiter);
      });
    },
  };
}

function open(ws) {
  return new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
}

async function connectExtension({ originId, callerExtId = 'claimed-id', instanceId, headless = false }) {
  const ws = new WebSocket(url, { origin: `chrome-extension://${originId}` });
  clients.add(ws);
  ws.on('error', () => {});
  const messages = channel(ws);
  await open(ws);
  const welcome = messages.next((m) => m.type === 'welcome');
  ws.send(JSON.stringify({
    type: 'hello', role: 'extension', extId: callerExtId,
    version: VERSION, v: 1, instanceId, headless,
  }));
  await welcome;
  return { ws, messages };
}

async function connectAgent(sessionId = 'target-routing-session') {
  const ws = new WebSocket(url);
  clients.add(ws);
  ws.on('error', () => {});
  const messages = channel(ws);
  await open(ws);
  const welcome = messages.next((m) => m.type === 'welcome');
  ws.send(JSON.stringify({ type: 'hello', role: 'agent', token: TOKEN, client: 'node-test', sessionId, v: 1 }));
  return { ws, messages, welcome: await welcome };
}

const settle = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));
const byType = (type) => (message) => message.type === type;
const hasCommand = (messages, id) => messages.history.some((m) => m.type === 'cmd' && m.id === id);

test('welcome advertises targeted routing and pinning ignores primary flips', async () => {
  const first = await connectExtension({ originId: 'actual-extension-id', callerExtId: 'forged-extension-id', instanceId: 'profile-first' });
  await settle(20);
  const second = await connectExtension({ originId: 'actual-extension-id', instanceId: 'profile-second' });

  const firstAgent = await connectAgent('primary-check-first');
  assert.ok(firstAgent.welcome.capabilities.includes('targeted-routing-v1'));
  assert.equal(firstAgent.welcome.extensions.find((e) => e.primary).instanceId, 'profile-second');
  assert.deepEqual(firstAgent.welcome.extensions.map(({ extensionId, instanceId }) => ({ extensionId, instanceId })), [
    { extensionId: 'actual-extension-id', instanceId: 'profile-first' },
    { extensionId: 'actual-extension-id', instanceId: 'profile-second' },
  ]);

  // Bring the first instance to primary, then flip primary back to the second.
  first.ws.send(JSON.stringify({ type: 'ping' }));
  await first.messages.next(byType('pong'));
  await settle(20);
  const flippedFirst = await connectAgent('primary-check-flipped-first');
  assert.equal(flippedFirst.welcome.extensions.find((e) => e.primary).instanceId, 'profile-first');
  second.ws.send(JSON.stringify({ type: 'ping' }));
  await second.messages.next(byType('pong'));
  await settle(20);
  const flippedSecond = await connectAgent('primary-check-flipped-second');
  assert.equal(flippedSecond.welcome.extensions.find((e) => e.primary).instanceId, 'profile-second');

  const response = flippedSecond.messages.next((m) => m.type === 'res' && m.id === 'pinned-first');
  const delivered = first.messages.next((m) => m.type === 'cmd' && m.id === 'pinned-first');
  flippedSecond.ws.send(JSON.stringify({
    type: 'cmd', id: 'pinned-first', cmd: 'status', params: {},
    target: { extensionId: 'actual-extension-id', instanceId: 'profile-first' },
  }));
  const command = await delivered;
  assert.equal(command.target, undefined, 'bridge routing metadata should not be forwarded to the extension');
  assert.equal(hasCommand(second.messages, 'pinned-first'), false, 'primary received a command pinned to another profile');
  first.ws.send(JSON.stringify({ type: 'res', id: command.id, __k: command.__k, ok: true, data: { instance: 'first' } }));
  assert.equal((await response).data.instance, 'first');
});

test('invalid target shapes fail with TARGET_INVALID without dispatch', async () => {
  const ext = await connectExtension({ originId: 'invalid-shape-extension', instanceId: 'profile' });
  const agent = await connectAgent('invalid-shapes');
  const targets = [
    null,
    [],
    { extensionId: 'id' },
    { extensionId: 'id', instanceId: 'profile', extra: true },
    { extensionId: '', instanceId: 'profile' },
    { extensionId: 'id', instanceId: '   ' },
    { extensionId: 'x'.repeat(129), instanceId: 'profile' },
    { extensionId: 'id', instanceId: 12 },
  ];

  for (let i = 0; i < targets.length; i++) {
    const id = `invalid-${i}`;
    const result = agent.messages.next((m) => m.type === 'res' && m.id === id, 500);
    agent.ws.send(JSON.stringify({ type: 'cmd', id, cmd: 'status', params: {}, target: targets[i] }));
    assert.equal((await result).error.code, 'TARGET_INVALID');
  }
  assert.equal(hasCommand(ext.messages, 'invalid-0'), false);
  assert.equal(ext.messages.history.filter((m) => m.type === 'cmd').length, 0);
});

test('missing target fails immediately and never falls back or queues for a later match', async () => {
  const primary = await connectExtension({ originId: 'shared-extension', instanceId: 'primary-profile' });
  const agent = await connectAgent('missing-target');

  const result = agent.messages.next((m) => m.type === 'res' && m.id === 'missing-target', 350);
  agent.ws.send(JSON.stringify({
    type: 'cmd', id: 'missing-target', cmd: 'status', params: {}, timeout: 20000,
    target: { extensionId: 'shared-extension', instanceId: 'not-connected-yet' },
  }));
  assert.equal((await result).error.code, 'TARGET_NOT_FOUND');

  const laterMatch = await connectExtension({ originId: 'shared-extension', instanceId: 'not-connected-yet' });
  await settle(100);
  assert.equal(primary.messages.history.filter((m) => m.type === 'cmd').length, 0, 'existing primary received an untargeted fallback');
  assert.equal(laterMatch.messages.history.filter((m) => m.type === 'cmd').length, 0, 'failed target was left in the wait queue');
});

test('extension identity comes from Origin and replacement includes extensionId', async () => {
  const actual = await connectExtension({ originId: 'origin-extension-a', callerExtId: 'caller-claimed-extension', instanceId: 'same-profile-id' });
  const other = await connectExtension({ originId: 'origin-extension-b', callerExtId: 'origin-extension-a', instanceId: 'same-profile-id' });
  assert.equal(actual.ws.readyState, WebSocket.OPEN, 'same instanceId under another extension id must not replace the first socket');

  const agent = await connectAgent('origin-identity');
  assert.deepEqual(agent.welcome.extensions.map(({ extensionId, instanceId }) => ({ extensionId, instanceId })), [
    { extensionId: 'origin-extension-a', instanceId: 'same-profile-id' },
    { extensionId: 'origin-extension-b', instanceId: 'same-profile-id' },
  ]);

  const command = actual.messages.next((m) => m.type === 'cmd' && m.id === 'origin-pinned');
  const response = agent.messages.next((m) => m.type === 'res' && m.id === 'origin-pinned');
  agent.ws.send(JSON.stringify({
    type: 'cmd', id: 'origin-pinned', cmd: 'status', params: {},
    target: { extensionId: 'origin-extension-a', instanceId: 'same-profile-id' },
  }));
  const received = await command;
  actual.ws.send(JSON.stringify({ type: 'res', id: received.id, __k: received.__k, ok: true, data: { origin: 'a' } }));
  assert.equal((await response).data.origin, 'a');
  assert.equal(hasCommand(other.messages, 'origin-pinned'), false);
});

test('a different extension cannot spoof keyed or fallback-id responses', async () => {
  const owner = await connectExtension({ originId: 'response-owner', instanceId: 'profile' });
  const other = await connectExtension({ originId: 'response-other', instanceId: 'profile' });
  const agent = await connectAgent('response-origin');

  const keyedCommand = owner.messages.next((m) => m.type === 'cmd' && m.id === 'same-id');
  const keyedResponse = agent.messages.next((m) => m.type === 'res' && m.id === 'same-id');
  agent.ws.send(JSON.stringify({
    type: 'cmd', id: 'same-id', cmd: 'status', params: {},
    target: { extensionId: 'response-owner', instanceId: 'profile' },
  }));
  const keyed = await keyedCommand;
  other.ws.send(JSON.stringify({ type: 'res', id: 'same-id', __k: keyed.__k, ok: true, data: { source: 'other-keyed' } }));
  owner.ws.send(JSON.stringify({ type: 'res', id: 'same-id', __k: keyed.__k, ok: true, data: { source: 'owner-keyed' } }));
  assert.equal((await keyedResponse).data.source, 'owner-keyed');

  const legacyCommand = owner.messages.next((m) => m.type === 'cmd' && m.id === 'legacy-id');
  const legacyResponse = agent.messages.next((m) => m.type === 'res' && m.id === 'legacy-id');
  agent.ws.send(JSON.stringify({
    type: 'cmd', id: 'legacy-id', cmd: 'status', params: {},
    target: { extensionId: 'response-owner', instanceId: 'profile' },
  }));
  await legacyCommand;
  other.ws.send(JSON.stringify({ type: 'res', id: 'legacy-id', ok: true, data: { source: 'other-fallback' } }));
  owner.ws.send(JSON.stringify({ type: 'res', id: 'legacy-id', ok: true, data: { source: 'owner-fallback' } }));
  assert.equal((await legacyResponse).data.source, 'owner-fallback');
});

test('targeted pending reply survives same-identity reconnect without failing over to another profile', async () => {
  const original = await connectExtension({ originId: 'reconnect-extension', instanceId: 'profile-target' });
  const other = await connectExtension({ originId: 'reconnect-extension', instanceId: 'profile-other' });
  const agent = await connectAgent('target-reconnect');

  const commandPromise = original.messages.next((m) => m.type === 'cmd' && m.id === 'reconnect-target');
  const result = agent.messages.next((m) => m.type === 'res' && m.id === 'reconnect-target');
  agent.ws.send(JSON.stringify({
    type: 'cmd', id: 'reconnect-target', cmd: 'status', params: {},
    target: { extensionId: 'reconnect-extension', instanceId: 'profile-target' },
  }));
  const command = await commandPromise;

  const originalClosed = new Promise((resolve) => original.ws.once('close', resolve));
  original.ws.close();
  await originalClosed;
  const replacement = await connectExtension({ originId: 'reconnect-extension', instanceId: 'profile-target' });

  other.ws.send(JSON.stringify({ type: 'res', id: command.id, __k: command.__k, ok: true, data: { source: 'other-profile' } }));
  replacement.ws.send(JSON.stringify({ type: 'res', id: command.id, __k: command.__k, ok: true, data: { source: 'reconnected-target' } }));
  assert.equal((await result).data.source, 'reconnected-target');
  assert.equal(hasCommand(other.messages, 'reconnect-target'), false, 'disconnect must not fail over to a different profile');
});
