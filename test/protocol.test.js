// 协议与安全边界测试 —— 不需要真 Chrome，用 ws 客户端伪装成扩展/网页/agent。
// 重点测的是 verifyClient：网页能不能连上桥，是这个产品最要命的一条边界。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { startBridge } from '../src/bridge.js';
import { VERSION, EXT_VERSION } from '../src/lib/version.js';

const PORT = 8987;
const TOKEN = 'a'.repeat(64);
const URL = `ws://127.0.0.1:${PORT}`;
let bridge;

before(async () => {
  bridge = startBridge({ port: PORT, token: TOKEN, writeInfo: false });
  await bridge.ready;
});
after(() => bridge.close());

function open(opts = {}) {
  return new WebSocket(URL, opts);
}

// 只等 res，跳过穿插进来的 event 广播 —— 真实客户端（rpc.js）也是按 type 分发的
function nextRes(ws) {
  return new Promise((resolve) => {
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      if (m.type === 'res') resolve(m);
    });
  });
}

// 收到第一条消息就 resolve；连接被拒/关闭则 reject
function firstMessage(ws) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), 3000);
    ws.on('message', (d) => { clearTimeout(t); resolve(JSON.parse(d.toString())); });
    ws.on('unexpected-response', (_r, res) => { clearTimeout(t); reject(new Error('HTTP ' + res.statusCode)); });
    ws.on('error', (e) => { clearTimeout(t); reject(e); });
    ws.on('close', (code) => { clearTimeout(t); reject(new Error('closed ' + code)); });
  });
}

test('网页 Origin 被桥拒绝 —— 这是最要紧的一条边界', async () => {
  const ws = open({ origin: 'https://evil.example.com' });
  await assert.rejects(firstMessage(ws), (e) => /403/.test(e.message));
});

test('伪造成 chrome-extension 的网页 Origin：浏览器不可能发出，但仍要能进握手', async () => {
  const ws = open({ origin: 'chrome-extension://fakeid' });
  ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', role: 'extension', extId: 'fakeid', v: 1 })));
  const m = await firstMessage(ws);
  assert.equal(m.type, 'welcome');
  ws.close();
});

test('agent 用错 token 连不上', async () => {
  const ws = open();
  ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', role: 'agent', token: 'wrong', v: 1 })));
  await assert.rejects(firstMessage(ws), (e) => /closed 4001/.test(e.message));
});

test('扩展冒充 agent（有 Origin 却报 role:agent）被拒', async () => {
  const ws = open({ origin: 'chrome-extension://x' });
  ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', role: 'agent', token: TOKEN, v: 1 })));
  await assert.rejects(firstMessage(ws), (e) => /closed 4003/.test(e.message));
});

test('扩展离线时 agent 发命令，立刻收到 NO_EXTENSION 而不是干等', async () => {
  const agent = open();
  agent.on('open', () => agent.send(JSON.stringify({ type: 'hello', role: 'agent', token: TOKEN, client: 'test', v: 1 })));
  await firstMessage(agent);

  const res = await new Promise((resolve) => {
    agent.on('message', (d) => resolve(JSON.parse(d.toString())));
    agent.send(JSON.stringify({ type: 'cmd', id: 'c1', cmd: 'snapshot', params: {} }));
  });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'NO_EXTENSION');
  agent.close();
});

test('端到端：agent 的 cmd 走到扩展，扩展的 res 走回 agent', async () => {
  const ext = open({ origin: 'chrome-extension://real' });
  ext.on('open', () => ext.send(JSON.stringify({ type: 'hello', role: 'extension', extId: 'real', v: 1 })));
  await firstMessage(ext);

  const agent = open();
  agent.on('open', () => agent.send(JSON.stringify({ type: 'hello', role: 'agent', token: TOKEN, client: 'test', v: 1 })));
  const welcome = await firstMessage(agent);
  assert.equal(welcome.extensionOnline, true);

  // 扩展侧：收到 cmd 就回一个假快照
  ext.on('message', (d) => {
    const m = JSON.parse(d.toString());
    if (m.type === 'cmd') {
      ext.send(JSON.stringify({ type: 'res', id: m.id, __k: m.__k, ok: true, data: { text: '[e1] button "确定"' } }));
    }
  });

  const res = await new Promise((resolve) => {
    agent.on('message', (d) => resolve(JSON.parse(d.toString())));
    agent.send(JSON.stringify({ type: 'cmd', id: 'c9', cmd: 'snapshot', params: {} }));
  });
  assert.equal(res.ok, true);
  assert.match(res.data.text, /确定/);

  ext.close();
  agent.close();
});

test('扩展在命令执行途中掉线，在途命令立刻失败', async () => {
  const ext = open({ origin: 'chrome-extension://drop' });
  ext.on('open', () => ext.send(JSON.stringify({ type: 'hello', role: 'extension', extId: 'drop', v: 1 })));
  await firstMessage(ext);

  const agent = open();
  agent.on('open', () => agent.send(JSON.stringify({ type: 'hello', role: 'agent', token: TOKEN, client: 'test', v: 1 })));
  await firstMessage(agent);

  const res = nextRes(agent);
  agent.send(JSON.stringify({ type: 'cmd', id: 'c42', cmd: 'snapshot', params: {} }));
  setTimeout(() => ext.terminate(), 100);   // 扩展突然死掉
  assert.equal((await res).error.code, 'NO_EXTENSION');
  agent.close();
});

test('两个 agent 同时发同一个 id，响应不会串到对方', async () => {
  // 每个 agent 进程的消息 id 都从 c1 开始数，这是必然会撞的
  const ext = open({ origin: 'chrome-extension://dual' });
  ext.on('open', () => ext.send(JSON.stringify({ type: 'hello', role: 'extension', extId: 'dual', v: 1 })));
  await firstMessage(ext);

  const mk = async (name) => {
    const a = open();
    a.on('open', () => a.send(JSON.stringify({ type: 'hello', role: 'agent', token: TOKEN, client: name, v: 1 })));
    await firstMessage(a);
    return a;
  };
  const [a1, a2] = [await mk('agent-one'), await mk('agent-two')];

  // 扩展按路由键原样回，内容里带上它是谁发的
  ext.on('message', (d) => {
    const m = JSON.parse(d.toString());
    if (m.type !== 'cmd') return;
    setTimeout(() => ext.send(JSON.stringify({
      type: 'res', id: m.id, __k: m.__k, ok: true, data: { text: m.params.who },
    })), m.params.who === 'one' ? 200 : 20);   // 故意让先发的后回
  });

  const r1 = nextRes(a1), r2 = nextRes(a2);
  a1.send(JSON.stringify({ type: 'cmd', id: 'c1', cmd: 'snapshot', params: { who: 'one' } }));
  a2.send(JSON.stringify({ type: 'cmd', id: 'c1', cmd: 'snapshot', params: { who: 'two' } }));

  assert.equal((await r1).data.text, 'one', 'agent-one 收到了别人的响应');
  assert.equal((await r2).data.text, 'two', 'agent-two 收到了别人的响应');

  ext.close(); a1.close(); a2.close();
});

test('扩展和桥的版本号必须同步', () => {
  // 桥每次握手都拿这两个数比对，对不上就警告「去重载扩展」。
  // 一旦它们因为发版时漏改一处而长期不一致，这条警告就变成了狼来了——
  // 用户学会无视它，而它恰恰是「改了代码没重载」这个高频故障的唯一提示。
  assert.equal(EXT_VERSION, VERSION,
    `extension/manifest.json 是 ${EXT_VERSION}，package.json 是 ${VERSION}，发版时两处要一起改`);
});
