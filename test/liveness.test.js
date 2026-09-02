// 桥的探活：静默先 ping 再杀。
//
// 9-2 上午 bridge.log 里 9 次「静默超时」逐条对上了 pmset 的暗唤醒——桥一醒看到
// lastRx 过期就 terminate，而扩展 1 秒后本来就会回心跳。改成先问一声：
// 会回 pong 的连接活着，不会回的才是真半开。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { startBridge } from '../src/bridge.js';
import { VERSION } from '../src/lib/version.js';

const PORT = 8993;
const URL = `ws://127.0.0.1:${PORT}`;
let bridge;

before(async () => {
  // 全部压到百毫秒级：静默 300ms 就探，探了 300ms 没回音才杀，每 100ms 查一轮
  bridge = startBridge({ port: PORT, token: 'c'.repeat(64), writeInfo: false, silenceMs: 300, probeMs: 300, tickMs: 100 });
  await bridge.ready;
});
after(() => bridge.close());

async function ext(instanceId, { answerPing }) {
  const ws = new WebSocket(URL, { origin: 'chrome-extension://testid' });
  await new Promise((r) => ws.on('open', r));
  const pings = [];
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    if (m.type === 'ping') { pings.push(Date.now()); if (answerPing) ws.send(JSON.stringify({ type: 'pong' })); }
  });
  const closed = new Promise((r) => ws.on('close', (code) => r(code)));
  ws.send(JSON.stringify({ type: 'hello', role: 'extension', extId: 'testid', version: VERSION, instanceId, v: 1 }));
  return { ws, pings, closed, closedYet: () => ws.readyState !== WebSocket.OPEN };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('静默的连接先收到 ping；回 pong 的活着，不回的才被 terminate', async () => {
  const alive = await ext('inst-alive', { answerPing: true });
  const dead = await ext('inst-dead', { answerPing: false });
  await sleep(1500);
  assert.ok(alive.pings.length >= 1, '静默 300ms 后应该收到探活 ping');
  assert.ok(dead.pings.length >= 1, '哑的那条同样先被探');
  assert.equal(alive.closedYet(), false, '会回 pong 的连接不该被杀');
  assert.equal(dead.closedYet(), true, '探了还不回音的才判死');
  alive.ws.close();
  await sleep(100);
});
