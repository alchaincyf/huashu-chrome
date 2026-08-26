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

let ws = null;
let pingTimer = null;
let retryTimer = null;
let retryDelay = 0;
let connecting = false;

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
    const deliver = (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (msg.type === 'pong') return;              // 心跳回执，收到本身就是目的
      post({ __hcBridge: 'in', msg });              // 其余全部丢给 SW，它才认识命令
    };
    ws.onmessage = (e) => deliver(e.data);
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

function startPing() {
  stopPing();
  pingTimer = setInterval(() => {
    if (ws?.readyState === 1) ws.send(JSON.stringify({ type: 'ping' }));
    else connect();
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
  if (m?.__hcBridge === 'status') {
    sendResponse({ connected: ws?.readyState === 1 });
    return true;
  }
  if (m?.__hcBridge === 'kick') {                   // popup 点了「立即连接」
    connect().then(() => sendResponse({ connected: ws?.readyState === 1 }));
    return true;
  }
  return false;
});

connect();
