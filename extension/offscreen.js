// 与桥的长连接住在这里，不在 service worker 里。
//
// 为什么要搬：MV3 的 SW 空闲 30 秒就被回收，实测一条连接的存活中位数只有
// 106 秒、一晚上断开 111 次。每断一次，桥那侧看到的是「扩展没了」，
// 接下来最长 30 秒（一个 alarm 周期）所有命令都回 NO_EXTENSION——
// 而真实情况只是「还没轮到重连」。桥侧的排队缓冲能盖住大部分，
// 盖不住的那部分就是用户看到的「经常断联」。
//
// offscreen 文档不受那条 30 秒空闲规则管，socket 一直挂着，桥基本上
// 再也看不到扩展掉线。SW 该被回收还是被回收——收到命令时，
// 这边一条 runtime 消息就能把它叫醒，这是 MV3 明确支持的唤醒路径。
//
// 分工写死：这个文件不认识任何一条命令，只管连接、心跳、转发。
// 页面解析、tab 槽、CDP 全都在 SW 那边，一行都不搬过来。
//
// ⚠️ offscreen 文档拿不到扩展 API —— 只有 chrome.runtime 的消息通道能用。
// chrome.storage、chrome.runtime.getManifest() 在这里全是 undefined，
// 按 service worker 的习惯写会当场 TypeError，而且这个文件一炸就等于
// 整个扩展失联（踩过：`chrome.runtime.getManifest is not a function`）。
// 所以握手要用的身份（扩展 id、版本号）一律问 SW 要，连接状态也回报给 SW 去存。

const PORTS = [8899, 8900, 8901, 8902, 8903];
const PING_MS = 15000;          // 留足余量：30 秒空闲线，20 秒太贴边
const PROBE_MS = 1500;
const MAX_BACKOFF = 15000;
const DEAD_MS = 45000;          // 三个心跳周期一声不吭 = 这条连接已经死了

let ws = null;
let pingTimer = null;
let retryTimer = null;
let retryDelay = 0;
let connecting = false;
let lastRx = 0;                 // 最近一次从桥收到**任何**东西的时刻（含 pong）
let lastTick = 0;               // 心跳定时器上一次跑到的时刻——判「机器睡过一觉」用
let bridgeVersion = '';         // welcome 里桥报的版本，popup 要显示、SW 要比对

const post = (m) => chrome.runtime.sendMessage(m).catch(() => { /* SW 正在起来，下一条会到 */ });

function scheduleReconnect() {
  if (retryTimer) return;
  retryDelay = retryDelay ? Math.min(retryDelay * 2, MAX_BACKOFF) : 400;
  retryTimer = setTimeout(() => { retryTimer = null; connect(); }, retryDelay);
}

// 五个端口**并行**探，不是挨个等。串行时每个端口 1.5 秒，全试一遍最坏 7.5 秒，
// 而这 7.5 秒里 agent 只能干等——桥其实往往就在第二个端口上。
function probe(port, hello) {
  return new Promise((resolve, reject) => {
    const sock = new WebSocket(`ws://127.0.0.1:${port}`);
    const t = setTimeout(() => { try { sock.close(); } catch { /* 已经废了 */ } reject(new Error('timeout')); }, PROBE_MS);
    const die = () => { clearTimeout(t); try { sock.close(); } catch { /* 已经废了 */ } reject(new Error('rejected')); };

    sock.onopen = () => sock.send(JSON.stringify(hello));
    sock.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return die(); }
      if (msg.type !== 'welcome') return die();
      clearTimeout(t);
      // 握上手就把探测期的处理器换掉。留着 die 的话，从这里到 connect() 装上
      // 正式 onclose 之间若断了，走的是 die（它只 reject 一个已 resolve 的
      // promise，等于什么都没做），正式的重连逻辑不会触发——socket 悄悄死掉，
      // 要等下一次 15 秒心跳才发现。
      //
      // 缓存这段窗口里到达的消息，别直接扔：桥在 welcome 之后**紧接着**就推
      // 在线会话名单，而扩展要靠那份名单判断标签页归属。扔了的话，名单是空的，
      // 所有 tab 看着都「没人占」——多会话隔离当场失效，且毫无征兆。
      const buffered = [];
      sock.onmessage = (e) => buffered.push(e.data);
      sock.onerror = null;
      sock.onclose = null;
      resolve({ sock, welcome: msg, buffered });
    };
    sock.onerror = die;
    sock.onclose = die;
  });
}

// 握手要用的身份只有 SW 拿得到，问它要。要不到就不连——顶着一个假身份连上去，
// 桥会记下一个错的扩展版本，而版本比对正是「改了代码忘记重载」的唯一探针。
async function askIdentity() {
  const r = await chrome.runtime.sendMessage({ __hcBridge: 'identity' }).catch(() => null);
  return r?.extId ? r : null;
}

async function connect() {
  if (connecting || ws?.readyState <= 1) return;
  connecting = true;
  try {
    const who = await askIdentity();
    if (!who) { setStatus(false); return scheduleReconnect(); }
    const hello = {
      type: 'hello',
      role: 'extension',
      extId: who.extId,
      version: who.version,
      // 桥按实例区分连接，靠这两个字段：同 instanceId = 同一个 Chrome 断线重连，
      // 该顶掉旧连接；不同 = 另一个 Chrome，该并存。headless 的那个不抢主。
      instanceId: who.instanceId,
      headless: !!who.headless,
      chrome: (navigator.userAgent.match(/Chrome\/([\d.]+)/) || [])[1],
      v: 1,
    };

    let winner = null;
    const races = PORTS.map((p) => probe(p, hello).then((r) => {
      // 只留第一个握上手的，其余当场关掉——不关的话桥那边会看到
      // 四条多余的扩展连接，而桥「同时只认一个扩展」，后来者会把前一个踢掉
      if (winner) { try { r.sock.close(); } catch { /* 已经废了 */ } return null; }
      winner = r;
      return r;
    }));
    const results = await Promise.allSettled(races);
    const hit = results.map((r) => r.value).find(Boolean);
    if (!hit) { setStatus(false); return scheduleReconnect(); }
    if (hit.sock.readyState !== 1) { setStatus(false); return scheduleReconnect(); }

    ws = hit.sock;
    retryDelay = 0;
    lastRx = Date.now();      // 看门狗的起点：刚握完手，算收到过
    bridgeVersion = String(hit.welcome?.bridge || '');
    const deliver = (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (msg.type === 'pong') return;              // 心跳回执，收到本身就是目的
      // 桥主动探活（静默 50 秒后它会先问一声再杀）——回一声就行，不必吵醒 SW
      if (msg.type === 'ping') { if (ws?.readyState === 1) ws.send(JSON.stringify({ type: 'pong' })); return; }
      post({ __hcBridge: 'in', msg });              // 其余全部丢给 SW，它才认识命令
    };
    ws.onmessage = (e) => { lastRx = Date.now(); deliver(e.data); };
    ws.onclose = () => { ws = null; stopPing(); setStatus(false); scheduleReconnect(); };
    ws.onerror = () => { /* onclose 会跟着来，在那儿统一处理 */ };
    startPing();
    setStatus(true);
    post({ __hcBridge: 'up', bridge: hit.welcome.bridge });
    for (const raw of hit.buffered) deliver(raw);   // 补上握手窗口里到达的那几条
  } finally {
    connecting = false;
  }
}

// 心跳必须**验回音**，只发不验等于没发。
//
// 踩出来的：8-31 15:46 桥记下「扩展断开」，直到 17:25 用户手动重载扩展才恢复，
// 中间 99 分钟一次重连都没发生。死法是半开——offscreen 被浏览器冻结、或系统
// 睡醒后本地网络栈换了代，桥那侧的 socket 已经关了，这侧的 readyState 却
// 还停在 1，`ws.send()` 也不报错。于是 onclose 永远不来，scheduleReconnect
// 永远不触发，而 connect() 开头那句 `if (ws?.readyState <= 1) return`
// 把所有重连尝试原地挡掉。扩展看着一切正常，桥那边已经判它死了。
//
// 所以判据不能是 readyState（它只反映本地对 socket 的记忆），只能是
// 「最近还收到过对面的东西吗」。桥收到 ping 一定回 pong，45 秒里三次
// 都没回音，这条连接就当死的处理：主动 close 掉，让重连链跑起来。
//
// 但看门狗认的是**墙钟差**，而墙钟差在机器睡过一觉之后是假的：9-2 上午 bridge.log
// 里 9 次「静默超时」逐条对上了 pmset 的暗唤醒记录——定时器在睡眠里根本没跑，
// 醒来第一拍 Date.now() - lastRx 必然超过 45 秒，于是连接被自己判死、断一次、
// 再重连一次，桥那侧同时也在杀。判据加一条：这一拍离上一拍超过两个周期，说明
// 中间睡过，那就先把 lastRx 当成现在、立刻发一条 ping 去验，别急着杀。
function startPing() {
  stopPing();
  lastTick = Date.now();
  pingTimer = setInterval(() => {
    const now = Date.now();
    const slept = now - lastTick > PING_MS * 2;
    lastTick = now;
    if (ws?.readyState !== 1) return connect();
    if (slept) {
      lastRx = now;                                  // 睡过：重新起算，下一拍再看回音
      ws.send(JSON.stringify({ type: 'ping' }));
      return;
    }
    if (now - lastRx > DEAD_MS) {
      try { ws.close(); } catch { /* 已经废了 */ }
      ws = null;
      stopPing();
      setStatus(false);
      return scheduleReconnect();
    }
    ws.send(JSON.stringify({ type: 'ping' }));
  }, PING_MS);
}
function stopPing() {
  if (pingTimer) clearInterval(pingTimer);
  pingTimer = null;
}

// SW 随时会被回收，所以连接状态不能只活在这个文件的内存里——它醒来
// 第一件事就是问「现在连上了吗」，而那时它自己什么都不记得。
// 但 chrome.storage 在 offscreen 里够不着，只能回报给 SW，由它去落盘。
const setStatus = (connected) => post({ __hcBridge: 'status', connected });

chrome.runtime.onMessage.addListener((m, _s, sendResponse) => {
  if (m?.__hcBridge === 'out') {                    // SW 要往桥上发一条（res / event）
    if (ws?.readyState === 1) ws.send(JSON.stringify(m.msg));
    sendResponse({ sent: ws?.readyState === 1 });
    return true;
  }
  // 同上：readyState 只是本地对 socket 的记忆，半开时它照样是 1。
  // 把新鲜度一起算进去，SW 才不用等看门狗那 45 秒就能识破。
  // kick 的回话**也**得算新鲜度：以前它裸看 readyState，半开时回「连着呢」，
  // SW 的自愈 alarm 信了它就再也不走兜底——那是一条无限期的死路。
  const fresh = () => ws?.readyState === 1 && Date.now() - lastRx <= DEAD_MS;
  const state = () => ({ connected: fresh(), lastRx, bridge: bridgeVersion });
  if (m?.__hcBridge === 'status') {
    sendResponse(state());
    return true;
  }
  if (m?.__hcBridge === 'kick') {                   // popup 点了「重连」，或 alarm 自愈
    connect().then(() => sendResponse(state()));
    return true;
  }
  return false;
});

connect();
