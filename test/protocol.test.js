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

// 这条原先断言的是「立刻收到 NO_EXTENSION 而不是干等」。2026-08-26 推翻：
// 「立刻失败」当初防的是 agent 干等 30 秒，但它把两种情况当成了一种——
//
//   a) 扩展被浏览器回收了，一会儿就回来   ← 常态，实测 111 次断开里 103 次 ≤1s 恢复
//   b) 扩展真的没装 / 没启用             ← 例外
//
// MV3 的 SW 本来就随时会被回收（实测连接存活中位数 106s），而桥是本地进程，
// **唤不醒**一个被回收的 SW——能唤醒它的只有 chrome.alarms（30s 一次）、
// tabs.onRemoved、content script 消息，全是「用户在浏览网页」才发生的事。
// 所以用户活跃时秒回、静止时最长等一个 alarm 周期。
//
// 对 a) 判死是错的：agent 拿到的是一个假故障，而正确动作只是等一下。
// 现在改成排队，超过窗口才判死——b) 仍然会失败，只是慢 40 秒，
// 而它本来就需要人去处理，快 40 秒没有任何价值。
test('扩展离线时命令先排队，扩展一连上就送达（不再假判死）', async () => {
  const agent = open();
  agent.on('open', () => agent.send(JSON.stringify({ type: 'hello', role: 'agent', token: TOKEN, client: 'test', v: 1 })));
  await firstMessage(agent);

  const res = nextRes(agent);
  agent.send(JSON.stringify({ type: 'cmd', id: 'q1', cmd: 'snapshot', params: {} }));

  // 命令发出去时扩展还不在。200ms 后它才连上——够久，足以证明桥真的等了
  await new Promise((r) => setTimeout(r, 200));
  const ext = open({ origin: 'chrome-extension://late' });
  ext.on('open', () => ext.send(JSON.stringify({ type: 'hello', role: 'extension', extId: 'late', v: 1 })));
  ext.on('message', (d) => {
    const m = JSON.parse(d.toString());
    if (m.type === 'cmd') ext.send(JSON.stringify({ type: 'res', id: m.id, __k: m.__k, ok: true, data: { queued: true } }));
  });

  const r = await res;
  assert.equal(r.ok, true, '排队的命令没有在扩展连上后送达');
  assert.equal(r.data.queued, true);
  ext.close();
  agent.close();
});

test('扩展一直不来，排队的命令最终仍要失败——且话要说对', async () => {
  const agent = open();
  agent.on('open', () => agent.send(JSON.stringify({ type: 'hello', role: 'agent', token: TOKEN, client: 'test', v: 1 })));
  await firstMessage(agent);

  const res = nextRes(agent);
  // 调用方自己声明只等 300ms —— 排队窗口不能超过它，否则就成了另一种「干等」
  agent.send(JSON.stringify({ type: 'cmd', id: 'q2', cmd: 'snapshot', params: {}, timeout: 300 }));
  const r = await res;
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'NO_EXTENSION');
  // 老话术「确认 Chrome 开着、扩展已启用」会把人骗去点重载，而真实情况多半是
  // 「再等一下它自己就回来了」。新话术必须说出「被浏览器回收」这件事。
  assert.match(r.error.message, /回收|等/, '错误信息没说清扩展是被浏览器回收了');
  agent.close();
});

test('排队期间 agent 自己走了，不能在它关闭的连接上回包', async () => {
  const agent = open();
  agent.on('open', () => agent.send(JSON.stringify({ type: 'hello', role: 'agent', token: TOKEN, client: 'test', v: 1 })));
  await firstMessage(agent);
  agent.send(JSON.stringify({ type: 'cmd', id: 'q3', cmd: 'snapshot', params: {}, timeout: 5000 }));
  await new Promise((r) => setTimeout(r, 50));
  agent.close();

  // 扩展随后连上：队列里那条属于已关闭 agent 的命令必须被丢掉，不能派给扩展
  const ext = open({ origin: 'chrome-extension://after' });
  let got = 0;
  ext.on('open', () => ext.send(JSON.stringify({ type: 'hello', role: 'extension', extId: 'after', v: 1 })));
  ext.on('message', (d) => { if (JSON.parse(d.toString()).type === 'cmd') got++; });
  await firstMessage(ext);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(got, 0, '把命令派给了一个已经走掉的 agent');
  ext.close();
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

test('桥给每条命令盖章 connId：每连接稳定、连接间互异，且不回泄给 agent', async () => {
  const ext = open({ origin: 'chrome-extension://stamp' });
  ext.on('open', () => ext.send(JSON.stringify({ type: 'hello', role: 'extension', extId: 'stamp', v: 1 })));
  await firstMessage(ext);

  const mk = async (name) => {
    const a = open();
    a.on('open', () => a.send(JSON.stringify({ type: 'hello', role: 'agent', token: TOKEN, client: name, v: 1 })));
    await firstMessage(a);
    return a;
  };
  const [a1, a2] = [await mk('stamp-one'), await mk('stamp-two')];

  const seen = [];
  ext.on('message', (d) => {
    const m = JSON.parse(d.toString());
    if (m.type !== 'cmd') return;
    seen.push(m);
    ext.send(JSON.stringify({ type: 'res', id: m.id, __k: m.__k, ok: true, data: { text: 'ok' } }));
  });

  const r1 = nextRes(a1), r2 = nextRes(a2);
  a1.send(JSON.stringify({ type: 'cmd', id: 's1', cmd: 'snapshot', params: {} }));
  a2.send(JSON.stringify({ type: 'cmd', id: 's2', cmd: 'snapshot', params: {} }));
  const [res1, res2] = await Promise.all([r1, r2]);
  assert.equal('connId' in res1, false, 'agent 的 res 里不该有 connId');
  assert.equal('__k' in res2, false, 'agent 的 res 里不该有路由键');

  // 同一个 agent 再发一条，connId 必须和第一次相同
  const r3 = nextRes(a1);
  a1.send(JSON.stringify({ type: 'cmd', id: 's3', cmd: 'snapshot', params: {} }));
  await r3;

  assert.equal(seen.length, 3);
  assert.ok(seen.every((m) => Number.isInteger(m.connId)), '每条命令都带 connId');
  assert.equal(seen.find((m) => m.id === 's1').connId, seen.find((m) => m.id === 's3').connId, '同一连接 connId 必须稳定');
  assert.notEqual(seen.find((m) => m.id === 's1').connId, seen.find((m) => m.id === 's2').connId, '两个 agent 的 connId 必须互异');

  ext.close(); a1.close(); a2.close();
});

test('agent 断开时扩展收到 agent_closed（带 connId），别的 agent 收不到', async () => {
  const ext = open({ origin: 'chrome-extension://gone' });
  ext.on('open', () => ext.send(JSON.stringify({ type: 'hello', role: 'extension', extId: 'gone', v: 1 })));
  await firstMessage(ext);

  const mk = async (name) => {
    const a = open();
    a.on('open', () => a.send(JSON.stringify({ type: 'hello', role: 'agent', token: TOKEN, client: name, v: 1 })));
    await firstMessage(a);
    return a;
  };
  const [leaver, stayer] = [await mk('leaver'), await mk('stayer')];

  const closedEvent = new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), 3000);
    ext.on('message', (d) => {
      const m = JSON.parse(d.toString());
      if (m.type === 'event' && m.event === 'agent_closed') { clearTimeout(t); resolve(m); }
    });
  });
  let leaked = false;
  stayer.on('message', (d) => {
    const m = JSON.parse(d.toString());
    if (m.type === 'event' && m.event === 'agent_closed') leaked = true;
  });

  leaver.close();
  const ev = await closedEvent;
  assert.ok(Number.isInteger(ev.connId), 'agent_closed 必须带 connId 供扩展清槽');
  await new Promise((r) => setTimeout(r, 200));   // 给广播留点时间再查泄漏
  assert.equal(leaked, false, 'agent_closed 不该广播给别的 agent');

  ext.close(); stayer.close();
});

test('扩展发的事件广播给所有 agent（tab_closed 回归）', async () => {
  const ext = open({ origin: 'chrome-extension://bc' });
  ext.on('open', () => ext.send(JSON.stringify({ type: 'hello', role: 'extension', extId: 'bc', v: 1 })));
  await firstMessage(ext);

  const mk = async (name) => {
    const a = open();
    a.on('open', () => a.send(JSON.stringify({ type: 'hello', role: 'agent', token: TOKEN, client: name, v: 1 })));
    await firstMessage(a);
    return a;
  };
  const [a1, a2] = [await mk('bc-one'), await mk('bc-two')];

  const got = (a) => new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), 3000);
    a.on('message', (d) => {
      const m = JSON.parse(d.toString());
      if (m.type === 'event' && m.event === 'tab_closed') { clearTimeout(t); resolve(m); }
    });
  });
  const g1 = got(a1), g2 = got(a2);
  ext.send(JSON.stringify({ type: 'event', event: 'tab_closed', tabId: 9 }));
  await Promise.all([g1, g2]);

  ext.close(); a1.close(); a2.close();
});

// 扩展靠这个字段判断「桥是不是换了一代」，换了就把连接级的 tab 槽全清掉。
// 不清的话会串台：connId 是桥进程内从 1 开始的递增序号，桥一重启就重头数，
// 而槽存在 storage.local 里跨重启活着——新连上的第一个 agent 拿到 connId=1，
// 就捡到了上一代同号会话的受控标签页，并且以为那本来就是自己的。
const helloExt = async (url) => {
  const ws = new WebSocket(url, { origin: 'chrome-extension://epoch' });
  ws.on('open', () => ws.send(JSON.stringify({
    type: 'hello', role: 'extension', extId: 'epoch', version: VERSION, v: 1,
  })));
  return { ws, welcome: await firstMessage(ws) };
};

test('桥在握手时告诉扩展自己是哪一代', async () => {
  const { ws, welcome } = await helloExt(URL);
  assert.equal(welcome.type, 'welcome');
  assert.ok(welcome.epoch, 'welcome 里必须带 epoch，否则扩展无从判断桥换没换代');
  ws.close();
});

test('同一个桥进程，重连拿到的是同一代', async () => {
  // 扩展重载、SW 被回收后复活都会走重连。桥没变，槽就必须原样留着——
  // 那些会话还活着。这一条守的是「别清过头」。
  const a = await helloExt(URL);
  const first = a.welcome.epoch;
  a.ws.close();
  const b = await helloExt(URL);
  assert.equal(b.welcome.epoch, first);
  b.ws.close();
});

test('换一个桥进程就是另一代', async () => {
  const other = startBridge({ port: PORT + 1, token: TOKEN, writeInfo: false });
  await other.ready;
  try {
    const a = await helloExt(URL);
    const b = await helloExt(`ws://127.0.0.1:${PORT + 1}`);
    assert.notEqual(a.welcome.epoch, b.welcome.epoch);
    a.ws.close(); b.ws.close();
  } finally {
    other.close();
  }
});

test('扩展和桥的版本号必须同步', () => {
  // 桥每次握手都拿这两个数比对，对不上就警告「去重载扩展」。
  // 一旦它们因为发版时漏改一处而长期不一致，这条警告就变成了狼来了——
  // 用户学会无视它，而它恰恰是「改了代码没重载」这个高频故障的唯一提示。
  assert.equal(EXT_VERSION, VERSION,
    `extension/manifest.json 是 ${EXT_VERSION}，package.json 是 ${VERSION}，发版时两处要一起改`);
});
