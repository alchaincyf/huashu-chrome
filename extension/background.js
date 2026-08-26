// Service Worker —— 扩展这一侧的总机
//
// MV3 的 SW 随时会被回收，所以这里没有任何「只在内存里、丢了就完蛋」的状态：
// 受控 tab 记在 chrome.storage.local，WS 断了就重连。
// 保活靠两条腿：WebSocket 活动本身会重置 30s 空闲计时（Chrome 116+），
// 外加 20s 一次的 ping；再加 chrome.alarms 兜底，把被回收后的 SW 唤醒重连。

import * as cdp from './cdp.js';
import { CRED_URL, redactCreds } from './redact.js';

const PORTS = [8899, 8900, 8901, 8902, 8903];
const PING_MS = 20000;

let ws = null;
let pingTimer = null;
let connecting = false;
let retryTimer = null;
let retryDelay = 0;

// 断线后立刻重连，而不是干等 alarm。
// 桥会因为版本升级、用户重启、空闲退出而消失，全都是秒级就能重新连上的场景；
// 只靠 30s 的 alarm 兜底，用户在升级后的第一分钟里看到的是「NO_EXTENSION」，
// 而真实情况只是「还没轮到重连」。退避是为了桥真的没起来时不空转。
function scheduleReconnect() {
  if (retryTimer) return;
  retryDelay = retryDelay ? Math.min(retryDelay * 2, 15000) : 500;
  retryTimer = setTimeout(() => { retryTimer = null; connect(); }, retryDelay);
}

// ---------- 连接 ----------

async function connect() {
  if (connecting || (ws && ws.readyState <= 1)) return;
  connecting = true;
  for (const port of PORTS) {
    try {
      await tryPort(port);
      connecting = false;
      retryDelay = 0;          // 连上了，退避归零
      return;
    } catch {
      /* 换下一个端口 */
    }
  }
  connecting = false;
  setBadge('off');
  scheduleReconnect();
}

function tryPort(port) {
  return new Promise((resolve, reject) => {
    const sock = new WebSocket(`ws://127.0.0.1:${port}`);
    const t = setTimeout(() => { sock.close(); reject(new Error('timeout')); }, 1500);

    sock.onopen = () => {
      sock.send(JSON.stringify({
        type: 'hello',
        role: 'extension',
        extId: chrome.runtime.id,
        version: chrome.runtime.getManifest().version,
        chrome: (navigator.userAgent.match(/Chrome\/([\d.]+)/) || [])[1],
        v: 1,
      }));
    };

    sock.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'welcome') {
        clearTimeout(t);
        ws = sock;
        syncBridgeEpoch(msg.epoch);   // 不 await：清槽和握手互不依赖，别让它拖慢连接
        sock.onmessage = (e) => onMessage(JSON.parse(e.data));
        sock.onclose = () => { ws = null; stopPing(); setBadge('off'); scheduleReconnect(); };
        sock.onerror = () => {};
        startPing();
        setBadge('on');
        return resolve();
      }
      clearTimeout(t);
      sock.close();
      reject(new Error('rejected'));
    };

    sock.onerror = () => { clearTimeout(t); reject(new Error('error')); };
  });
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

function setBadge(state) {
  chrome.action.setBadgeText({ text: state === 'on' ? '' : '·' });
  chrome.action.setBadgeBackgroundColor({ color: state === 'on' ? '#22c55e' : '#94a3b8' });
}

function reply(id, ok, payload, k) {
  if (ws?.readyState === 1) {
    const base = { type: 'res', id, __k: k };
    ws.send(JSON.stringify(ok ? { ...base, ok: true, data: payload } : { ...base, ok: false, error: payload }));
  }
}
function emit(event, extra = {}) {
  if (ws?.readyState === 1) ws.send(JSON.stringify({ type: 'event', event, ...extra }));
}

// ---------- 命令分发 ----------

// 这些命令自己决定用不用受控 tab——tabs 的 new/select/close 各有各的槽语义，
// download 整条链不碰 tab，reload 是扩展级动作
const NO_SLOT_CMDS = new Set(['tabs', 'download', 'reload']);

async function onMessage(msg) {
  // agent_closed：桥通知扩展某条 agent 连接断了，清掉它的槽，
  // 防死槽让「别人在操控」的警告一直误报
  if (msg.type === 'event') {
    if (msg.event === 'agent_closed' && msg.connId !== undefined) {
      await chrome.storage.local.remove(agentTabKey(msg.connId));
    }
    return;
  }
  if (msg.type !== 'cmd') return;
  try {
    const handler = HANDLERS[msg.cmd];
    if (!handler) throw err('INTERNAL', `未知命令 ${msg.cmd}`);
    // 缺省 tabId 在这里统一解析成具体 tabId（连接级槽），handler 拿到的永远是实值。
    // ctx 只在本函数内现场传——SW 里两条命令的 await 会交错，绝不能用模块级变量存「当前消息」
    const ctx = { connId: msg.connId, adopted: false };
    const tabId = NO_SLOT_CMDS.has(msg.cmd) ? msg.tabId : await resolveTab(msg.tabId, msg.connId, ctx);
    const data = await handler(msg.params || {}, tabId, ctx);
    if (ctx.adopted) {
      // 本会话还没定过自己的受控 tab，继承的是全局槽。多 agent 并发时这是最危险的时刻：
      // agent 不知道自己在哪个页面上。只提示一次（SW 重启后可能再来一次，无伤大雅）。
      const head = `⚠️ 本会话还没定过自己的受控标签页，现在沿用的是最近被操控的「${ctx.adoptedTitle || ''}」[${ctx.adoptedTab}]。\n`
        + `   多个会话同时干活时，请用 tabs(action:"select", tabId:…) 定下自己的标签页，别在同一个页面上互相踩。\n`;
      if (typeof data === 'string') return reply(msg.id, true, head + '\n' + data, msg.__k);
      if (data && typeof data.text === 'string') data.text = head + '\n' + data.text;
    }
    reply(msg.id, true, data, msg.__k);
  } catch (e) {
    reply(msg.id, false, { code: e.code || 'INTERNAL', message: e.message || String(e) }, msg.__k);
  }
}

const err = (code, message) => Object.assign(new Error(message), { code });

// ---------- 受控 tab ----------
// 「当前 tab」不取用户正在看的那个——agent 不该在用户眼皮底下乱点他手上的页面。
// 只认自己开过/被显式指定的 tab。
//
// 存 local 而不是 session：session 在扩展重载时会被清空，于是每次升级扩展，
// agent 手上正在操作的标签页就凭空「不存在」了。local 的代价是可能存着一个
// 早已关掉的旧 id——但下面每次读都 chrome.tabs.get 校验一次，对不上就当没有。
// 用「读时校验」换「跨重载不丢」，这笔买卖划算。
//
// 多 agent 并发：每个 agent 连接（桥盖章的 connId）有自己独立的槽 agentTab:<connId>。
// activeTabId 降级为「最近被 new/select 的 tab」——新连接首次缺省调用时继承它，
// 继承时 ctx.adopted 打标，onMessage 在返回里提示 agent 尽早 select。
// 无 connId（旧桥）走纯全局槽，行为与 v0.3 完全一致。

const agentTabKey = (connId) => `agentTab:${connId}`;

// 桥换代了就把连接级的 tab 槽全部清掉。
//
// 起因是个很隐蔽的串台：connId 是桥进程内从 1 开始的递增序号，而这些槽
// 存在 storage.local 里，跨桥重启活着。桥一重启（升级、崩溃、手动重启），
// 新连上的第一个 agent 就拿到 connId=1，捡到上一代同号会话的槽——
// 而且它以为那是自己的，连「你还没定过自己的标签页」那句提示都不会给。
// agent 就这样在一个不属于它的页面上开始干活，正是隔离要防的那件事。
//
// 判据用桥的 epoch，不用「WS 断开」：扩展重载和桥重启撞在一起时
// （开发期天天发生），onclose 根本来不及跑，SW 当场就没了。
// epoch 比对在重连之后照样成立。
//
// 反过来也要成立：扩展自己重载、SW 被回收后复活，桥没变，
// epoch 就没变，槽必须原样留着——那些会话还活着。
async function syncBridgeEpoch(epoch) {
  if (!epoch) return;                    // 旧桥没这个字段，保持原行为
  const { bridgeEpoch } = await chrome.storage.local.get('bridgeEpoch');
  if (bridgeEpoch === epoch) return;
  const all = await chrome.storage.local.get(null);
  const stale = Object.keys(all).filter((k) => k.startsWith('agentTab:'));
  if (stale.length) await chrome.storage.local.remove(stale);
  await chrome.storage.local.set({ bridgeEpoch: epoch });
}

async function getActiveTabId(connId, ctx) {
  if (connId !== undefined) {
    const key = agentTabKey(connId);
    const { [key]: mine } = await chrome.storage.local.get(key);
    if (mine) {
      try { await chrome.tabs.get(mine); return mine; } catch { await chrome.storage.local.remove(key); } // 槽里的 tab 已关，自愈
    }
  }
  const { activeTabId } = await chrome.storage.local.get('activeTabId');
  if (activeTabId) {
    try {
      const tab = await chrome.tabs.get(activeTabId);
      if (connId !== undefined) {
        await chrome.storage.local.set({ [agentTabKey(connId)]: activeTabId });   // 继承 = 写自己的槽
        if (ctx) { ctx.adopted = true; ctx.adoptedTab = activeTabId; ctx.adoptedTitle = tab.title; }
      }
      return activeTabId;
    } catch { /* 已关 */ }
  }
  throw err('NO_TAB', '还没有受控标签页——先 tabs(action:"new", url:…) 开一个');
}
const setActiveTabId = (id) => chrome.storage.local.set({ activeTabId: id });

async function resolveTab(tabId, connId, ctx) {
  if (tabId) {
    try { await chrome.tabs.get(tabId); return tabId; } catch { throw err('NO_TAB', `标签页 ${tabId} 不存在`); }
  }
  return getActiveTabId(connId, ctx);
}

// select/close 时检查这个 tab 是不是别的会话的受控页——不阻止，但必须说清
async function conflictNote(tabId, connId) {
  const mine = connId === undefined ? null : agentTabKey(connId);
  const all = await chrome.storage.local.get(null);
  const clash = Object.entries(all).some(([k, v]) => k.startsWith('agentTab:') && k !== mine && v === tabId);
  return clash ? '⚠️ 这个标签页正被另一个会话操控。\n' : '';
}

// content script 按需注入，注入前先探活，避免重复注入把 refMap 清空
async function pingContent(tabId, frameId = 0) {
  try {
    const r = await chrome.tabs.sendMessage(tabId, { __hc: 'ping' }, { frameId });
    return !!r?.pong;
  } catch {
    return false;
  }
}

async function inject(tabId) {
  try {
    // allFrames：iframe 里的东西不注入就等于不存在。支付、验证码、OAuth、
    // 嵌入式编辑器几乎全在 iframe 里，少了它们，快照看着「正常」却少半张表。
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['content.js'] });
  } catch (e) {
    throw err('NOT_INTERACTABLE', `无法在此页面注入脚本（${e.message}）。chrome:// 和商店页面受浏览器保护，注入不了。`);
  }
}

async function ensureContent(tabId, frameId = 0) {
  if (await pingContent(tabId, frameId)) return;
  await inject(tabId);
  if (await pingContent(tabId, frameId)) return;
  if (frameId !== 0) throw err('NOT_INTERACTABLE', `框架 f${frameId} 无法注入脚本（可能已导航走或被沙箱限制）`);
  // 走到这儿基本只有一种情况：扩展刚重载，页面里留着一个失效的旧 content script，
  // 它的守卫标记还在、监听器却已经死了，新脚本注进去立刻 return。刷一下页面是唯一解。
  await chrome.tabs.reload(tabId);
  await waitForLoad(tabId);
  await sleep(300);
  await inject(tabId);
  if (!(await pingContent(tabId))) throw err('NOT_INTERACTABLE', '页面脚本注入后仍无响应');
}

// ---------- 框架 ----------
//
// 设计上最要紧的一条：**agent 面对的协议一点都不变。**
// 子框架里的元素在快照里写成 e5@f2，桥接层看到 @f2 就把命令路由到那个框架，
// 并把 ref 还原成 e5。content script 完全不知道有框架这回事，
// 于是 click / type / fill / key 这些工具一行都不用改。
//
// 快照 id 也一样：agent 只看到顶层那个 sN，各框架自己的 id 记在这儿。
const frameSnaps = new Map();   // tabId -> { [frameId]: snapshotId }

async function listFrames(tabId) {
  try {
    const res = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => ({ url: location.href, title: document.title }),
    });
    return res
      .filter((r) => r.result?.url && !/^about:/.test(r.result.url))
      .map((r) => ({ frameId: r.frameId, ...r.result }));
  } catch {
    return [{ frameId: 0, url: '', title: '' }];
  }
}

// "e5@f2" → { ref:"e5", frameId:2 }
function splitRef(ref) {
  const m = /^(.*)@f(\d+)$/.exec(String(ref || ''));
  return m ? { ref: m[1], frameId: Number(m[2]) } : { ref, frameId: 0 };
}

// 一条命令带的所有 ref 必须落在同一个框架里——跨框架的一次操作没有意义，
// 与其让它悄悄打到顶层框架去，不如明确拒绝。
function routeOf(p) {
  const refs = [p.ref, p.submitRef, ...(Array.isArray(p.fields) ? p.fields.map((f) => f.ref) : [])]
    .filter(Boolean).map(splitRef);
  const frames = [...new Set(refs.map((r) => r.frameId))];
  if (frames.length > 1) throw err('REF_NOT_FOUND', `一次操作里混了不同框架的 ref（${frames.map((f) => 'f' + f).join('、')}）。分开调用。`);
  const frameId = frames[0] ?? 0;
  const out = { ...p };
  if (p.ref) out.ref = splitRef(p.ref).ref;
  if (p.submitRef) out.submitRef = splitRef(p.submitRef).ref;
  if (Array.isArray(p.fields)) out.fields = p.fields.map((f) => ({ ...f, ref: f.ref ? splitRef(f.ref).ref : f.ref }));
  return { frameId, params: out };
}

async function toContent(tabId, payload, frameId = 0) {
  await ensureContent(tabId, frameId);
  let r;
  try {
    r = await chrome.tabs.sendMessage(tabId, payload, { frameId });
  } catch (e) {
    throw err('TIMEOUT', `页面无响应（${e.message}）`);
  }
  if (!r) throw err('INTERNAL', '页面脚本没有返回');
  if (r.error) throw err(r.error.code, r.error.message);
  return r.data;
}

function waitForLoad(tabId, timeout = 15000) {
  return new Promise((resolve) => {
    const done = () => { chrome.tabs.onUpdated.removeListener(h); clearTimeout(t); resolve(); };
    const t = setTimeout(done, timeout);
    const h = (id, info) => { if (id === tabId && info.status === 'complete') done(); };
    chrome.tabs.onUpdated.addListener(h);
    chrome.tabs.get(tabId).then((tab) => { if (tab.status === 'complete') done(); }).catch(done);
  });
}

// ---------- 数据层：网络 ----------
//
// 这一层的存在理由：DOM 是给人看的，网络是给机器看的。
// 页面上「362223585554365」这种拼在一起的数字，在接口响应里是
// {view_count: 36222, liked_count: 35, ...}——字段语义明确、分页参数可改、
// 不随改版崩。抓数据应该先看这里，DOM 是退路不是首选。
//
// 注入用 world:'MAIN' + 固定函数。CSP 挡的是「字符串变代码」，
// 挡不住 executeScript 注入的编译好的函数——这也是 eval 挂掉而 query 没事的原因。

const NET_SCRIPT_ID = 'hc-net-hook';

// hook 必须赶在页面自己的 JS 之前，否则首屏那批请求全漏掉——而列表数据恰恰在首屏那批里。
// 所以走 registerContentScripts + document_start，事后 executeScript 只能算补救。
async function ensureNetHook() {
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [NET_SCRIPT_ID] }).catch(() => []);
  if (existing.length) return false;
  await chrome.scripting.registerContentScripts([{
    id: NET_SCRIPT_ID,
    matches: ['<all_urls>'],
    js: ['net-hook.js'],
    runAt: 'document_start',
    world: 'MAIN',
    allFrames: false,
  }]);
  return true; // 刚注册，当前这个页面还没被 hook 到，得刷一次
}

// 顶层框架的快照 + 各子框架的快照，拼成一份。子框架的 ref 打上 @fN。
async function snapshotAll(tabId, p = {}) {
  const top = await toContent(tabId, { __hc: 'snapshot', ...p });
  const snaps = { 0: top.snapshotId };

  const frames = (await listFrames(tabId)).filter((f) => f.frameId !== 0);
  const parts = [];
  for (const f of frames.slice(0, 8)) {   // 广告位常有十几个 iframe，全抓会把快照撑爆
    try {
      const sub = await toContent(tabId, { __hc: 'snapshot' }, f.frameId);
      snaps[f.frameId] = sub.snapshotId;
      // 只把 ref 编号加后缀，别的原样保留
      const body = String(sub.text || '').replace(/^\[(e\d+)\]/gm, `[$1@f${f.frameId}]`);
      const rows = (body.match(/^\[e\d+@f\d+\]/gm) || []).length;
      if (rows) parts.push(`\n--- iframe f${f.frameId} · ${f.url} ---\n${body.split('\n--- 正文节选')[0].split('\n').slice(2).join('\n')}`);
    } catch {
      parts.push(`\n--- iframe f${f.frameId} · ${f.url} ---\n  （注入不了，多半是 sandbox 或已跳走）`);
    }
  }
  frameSnaps.set(tabId, snaps);
  return parts.length ? { ...top, text: top.text + '\n' + parts.join('\n') } : top;
}

// 拆框架号、还原 ref、换上那个框架自己的 snapshotId。
function prepare(tabId, p) {
  const { frameId, params } = routeOf(p);
  if (frameId !== 0) {
    const known = frameSnaps.get(tabId)?.[frameId];
    if (!known) throw err('STALE_SNAPSHOT', `没有框架 f${frameId} 的快照，重新 snapshot 一次`);
    params.snapshotId = known;   // agent 只认顶层那个 id，框架内部的 id 由这里补
  }
  return { frameId, params };
}

// 带 ref 的命令统一从这里走。
async function toFrame(tabId, cmd, p) {
  const { frameId, params } = prepare(tabId, p);
  const data = await toContent(tabId, { __hc: cmd, ...params }, frameId);
  // 回执里把框架后缀补回去，否则 agent 传的是 e1@f602、收到的却是「已点击 [e1]」，
  // 看着像操作到了顶层框架的另一个元素上
  if (frameId !== 0 && data?.note) data.note = data.note.replace(/\[(e\d+)\]/g, `[$1@f${frameId}]`);
  return { frameId, data };
}

// ---------- 写操作的统一路径 ----------
//
// L1 执行 → 采效果证据 → 零证据就升级 L2 重试 → 再采一次 → 组装返回。
// 三个 P0 在这里汇合：效果证据是 L2 的触发信号，L2 是效果证据的兜底手段。
//
// 取代了原来每个 handler 里各写一遍的「sleep 固定时长 + 比对 URL + 重拍快照」。

const L2_CMDS = new Set(['click', 'type', 'key']);
const IS_MAC = navigator.userAgent.includes('Mac');
const SETTLE_MS = 1200;

async function execL2(id, cmd, params, loc) {
  const label = params.ref || params.selector || '';
  if (cmd === 'click') {
    await cdp.click(id, loc.x, loc.y);
    return `已点击 [${label}]（真实事件）`;
  }
  if (cmd === 'type') {
    await cdp.click(id, loc.x, loc.y);          // 先真实点击聚焦，和人的顺序一致
    await sleep(80);
    if (params.clear !== false) {
      await cdp.key(id, 'a', { mods: IS_MAC ? ['meta'] : ['ctrl'] });
      await cdp.key(id, 'Delete');
    }
    if (params.text) await cdp.insertText(id, String(params.text));
    if (params.submit) await cdp.key(id, 'Enter');
    return `已在 [${label}] 输入${params.submit ? '并回车' : ''}（真实事件）`;
  }
  if (cmd === 'key') {
    if (loc) { await cdp.click(id, loc.x, loc.y); await sleep(80); }
    const specs = Array.isArray(params.key) ? params.key : [params.key];
    for (const s of specs) await cdp.key(id, s, { mods: params.mods || [], repeat: params.repeat || 1 });
    return `${specs.join(' → ')}（真实事件）`;
  }
  throw err('INTERNAL', `${cmd} 没有 L2 实现`);
}

// 轮询等页面反应。有变化就早停——快页面比原来固定的 400ms 更快，
// 慢页面比它更稳，「更可靠」和「更快」在这里是同一个改动的两面。
async function settle(id, frameId, params, baseline, beforeUrl) {
  const deadline = Date.now() + SETTLE_MS;
  let last = { changed: false, parts: [] };
  while (Date.now() < deadline) {
    await sleep(100);
    const url = (await chrome.tabs.get(id)).url;
    // 跳转是最强的证据，而且此时旧 baseline 已经没有意义，立刻返回
    if (url !== beforeUrl) return { changed: true, navigated: true, parts: [`已跳转到 ${url}`] };
    try {
      last = await toContent(id, { __hc: 'effect', baseline, ref: params.ref, selector: params.selector, find: params.find }, frameId);
    } catch {
      /* 页面正在换页时 content script 会短暂不在，下一轮再问 */
    }
    if (last.changed) return last;
  }
  return last;
}

// ---------- 凭据隐去 ----------
//
// 判定逻辑在 ./redact.js —— 那些是纯函数，抽出去是为了让 `npm test` 能直接跑到，
// 不必开真 Chrome。这里只剩下需要 chrome API 的那一层：拿 URL、组装告诫。

async function guardCreds(tabId, payload) {
  if (!payload || typeof payload.text !== 'string') return payload;
  let url = '';
  try { url = (await chrome.tabs.get(tabId)).url || ''; } catch { /* 标签页没了 */ }

  const { text, count } = redactCreds(payload.text);
  const onCredPage = CRED_URL.test(url);
  if (!count && !onCredPage) return payload;

  const why = [
    count ? `已隐去 ${count} 行疑似凭据` : '',
    onCredPage ? '当前地址看起来是凭据/安全设置页' : '',
  ].filter(Boolean).join('；');

  return {
    ...payload,
    text: `🔒 ${why}。\n`
      + `   这类内容不要转述、不要写进文件、不要发给任何人——需要的话请用户自己看屏幕。\n`
      + `   如果你只是要在这个页面上操作，用 snapshot 拿元素就够了，不必读正文。\n\n`
      + text,
  };
}

// ---------- 受控标签页漂移 ----------
//
// 受控标签页会在 agent 完全不知情的情况下换掉内容：用户自己在用这个浏览器、
// 站点自动跳转、表单提交后重定向。而工具会若无其事地在新页面上继续操作。
//
// 这不是理论风险。开发中真实发生过：agent 以为还在 npm 的 access 页，
// 那个标签页其实已经跳到了 2FA 设置页，一次无差别的 read_text 把用户的
// **2FA 恢复码**整页读进了对话。没有任何环节报错——URL 变了，工具不看。
//
// ref 快照有 STALE_SNAPSHOT 防呆，但 read_text / query / network 这些
// 不带 ref 的读取操作完全没有保护。这里补上：只要 URL 和上次 agent 见到的不一样，
// 就在返回最前面显著说明。不阻断（那会让正常的跳转流程没法走），但绝不静默。
const lastSeen = new Map();   // 「connId:tabId」-> 上次 agent 操作时的 URL；无 connId（旧桥）落 '*' 共享桶

async function driftNote(tabId, connId) {
  const key = `${connId ?? '*'}:${tabId}`;
  let now;
  try { now = (await chrome.tabs.get(tabId)).url; } catch { return ''; }
  const was = lastSeen.get(key);
  lastSeen.set(key, now);
  if (!was || was === now) return '';
  return `⚠️ 这个标签页的地址变了，而且不是本次操作造成的：\n`
    + `   原本：${was}\n   现在：${now}\n`
    + `   可能是用户自己在用这个浏览器，或者页面自动跳转了。下面的内容来自**新页面**——\n`
    + `   如果这不是你预期的页面，先停下来确认，别在陌生页面上继续操作或读取。\n`;
}

// agent 自己导航到的地方不算漂移
const markNavigated = async (tabId, connId) => {
  try { lastSeen.set(`${connId ?? '*'}:${tabId}`, (await chrome.tabs.get(tabId)).url); } catch { /* 标签页没了 */ }
};

// ask 的自动完成判据。轮询而不是 MutationObserver：判据里有 URL 这种
// DOM 观察不到的东西，而 1 秒一次的成本对一个本来就要等几分钟的命令可以忽略。
function watchUntil(tabId, until, timeout) {
  let timer = null;
  const stop = () => { if (timer) clearInterval(timer); timer = null; };
  const promise = new Promise((resolve) => {
    const deadline = Date.now() + timeout;
    timer = setInterval(async () => {
      if (Date.now() > deadline) return stop();
      try {
        const tab = await chrome.tabs.get(tabId);
        if (until.urlContains && tab.url?.includes(until.urlContains)) { stop(); return resolve({ outcome: 'completed' }); }
        if (until.selectorExists || until.textContains) {
          const [{ result } = {}] = await chrome.scripting.executeScript({
            target: { tabId },
            func: (sel, txt) => (sel ? !!document.querySelector(sel) : false)
              || (txt ? (document.body?.innerText || '').includes(txt) : false),
            args: [until.selectorExists || '', until.textContains || ''],
          });
          if (result) { stop(); return resolve({ outcome: 'completed' }); }
        }
      } catch { /* 页面正在跳转 */ }
    }, 1000);
  });
  return { promise, stop };
}

// 执行一个动作并采证据，**不出快照**。
// act 逐步调它，只在最后出一份快照——省掉的那些中间快照正是批处理的全部收益。
// 轮询取浮条的结果，而不是攥着一条长回调等几分钟。
// 长回调那条路会被 back/forward cache 掐断（「The page keeping the extension port
// is moved into back/forward cache」），而用户去解验证码、掏手机付款的过程中
// 页面进 bfcache 恰恰是常态。
function pollPanel(id, timeout) {
  return (async () => {
    const deadline = Date.now() + timeout + 2000;
    while (Date.now() < deadline) {
      await sleep(400);
      try {
        const r = await chrome.tabs.sendMessage(id, { __hcAsk: 'poll' });
        if (r && !r.pending) return r;
      } catch {
        // 页面正在跳转或刚从 bfcache 恢复，下一轮再问。
        // 浮条注入过的页面导航走就没了，这时靠外层超时收尾。
      }
    }
    return { outcome: 'timed_out', note: '' };
  })();
}

// ---------- 支付确认 ----------
//
// 花钱的那一下要人点头。这是整个产品里唯一一处「明知会打扰也要打扰」的地方：
// 别处的设计都在让 agent 别抢用户的焦点，这里反过来——看不见的确认等于没有确认。
// 所以要把标签页切到前台，还要发桌面通知，因为人很可能根本不在浏览器里。
//
// 闸门在扩展里，agent 够不着：没有任何参数能让它跳过这一步。这一点很重要——
// prompt injection 能让 agent 说出任何话，但说不动一个它调不到的开关。
//
// 超时按「不执行」处理。没人应答时放行等于这道闸不存在，
// 而无人值守的机器上恰恰最没有人来阻止一笔支付。
//
// 时长可以被调短（回归测试要用，否则每条用例得等三分钟）。这不是后门：
// 调短只会让支付更容易被拒，没有任何取值能让一笔支付**通过**。
// 真正的开关——「跳过确认」——不存在，agent 那一侧根本没有这个参数。
let payTimeout = 180000;

async function confirmPay(id, pay) {
  const tab = await chrome.tabs.get(id);
  await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
  await chrome.tabs.update(id, { active: true });
  await chrome.scripting.executeScript({ target: { tabId: id }, files: ['ask-overlay.js'] });

  chrome.notifications?.create(`hc-pay-${Date.now()}`, {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: '确认这笔支付？',
    message: `${pay.label}${pay.amount ? ` · ${pay.amount}` : ''}\n${tab.title || ''}`.slice(0, 180),
    priority: 2,
  }, () => void chrome.runtime.lastError);

  await chrome.tabs.sendMessage(id, {
    __hcAsk: 'show',
    danger: true,
    title: '要花钱了，确认一下',
    prompt: 'agent 请求点击这个按钮。确认之后才会真的点下去。',
    facts: [['按钮', pay.label], ['金额', pay.amount], ['页面', tab.title || ''], ['地址', tab.url || '']],
    okText: '确认，点下去',
    noText: '不要',
    wantNote: false,
    timeout: payTimeout,
  });

  const res = await pollPanel(id, payTimeout);
  return res.outcome === 'continued';
}

async function performCore(id, cmd, p, { blockSensitive = false } = {}, ctx) {
  const { frameId, params } = prepare(id, p);
  const before = (await chrome.tabs.get(id)).url;

  // 定位：resolve、滚动、遮挡检测全在 content script 里做（一行没改），
  // 顺带把效果基线采回来。没有 ref 的操作（fill、无 ref 的 key）只采基线。
  const hasTarget = !!(params.ref || params.selector || params.find);
  const loc = await toContent(id,
    // fields 要带过去：fill 没有单一目标，它的效果证据靠逐个字段的状态，
    // 不然填表这条最高频的路上永远报「页面没有反应」
    hasTarget ? { __hc: 'locate', ...params } : { __hc: 'locate', baselineOnly: true, fields: params.fields },
    frameId);

  // iframe 内元素的坐标是相对该框架视口的，而 CDP 打的是顶层视口坐标；
  // 换算要知道 iframe 元素在顶层的位置，跨源时子框架自己也不知道。
  // 所以 v0.3 的 L2 只覆盖顶层框架——iframe 里主要是支付、验证码、OAuth，
  // 而验证码本来就该交给 ask 让用户来。
  // 批处理不代做敏感动作。一串动作里夹一个「提交订单」，一口气跑完的话
  // 中间没有任何人看得见——而 prompt injection 恰恰会这么用。
  // 停在这一步，让 agent 单独去调 click：那样它会看到完整的效果证据，
  // 这一步在审计日志里也独立可查。
  if (blockSensitive && loc?.sensitive) {
    return { blocked: true, why: 'sensitive' };
  }

  // 支付闸门。批处理在上面那一步就已经停住了（支付按钮必然也命中 sensitive），
  // 所以走到这里的一定是 agent 单独发的一次操作——正是该问人的时刻。
  if (loc?.pay) {
    if (!await confirmPay(id, loc.pay)) {
      throw err('PAY_DECLINED',
        `用户没有确认这笔支付（${loc.pay.label}${loc.pay.amount ? ` · ${loc.pay.amount}` : ''}）。`
        + '这是明确的「别做」——不要重试，也不要换个方式绕过去。');
    }
  }

  const l2ok = frameId === 0 && L2_CMDS.has(cmd) && hasTarget && !loc?.outside;
  let layer = (l2ok && (params.real || loc?.prefer === 'L2')) ? 'L2' : 'L1';

  const runL1 = async () => {
    const d = await toContent(id, { __hc: cmd, ...params }, frameId);
    let n = d?.note || d?.text || '';
    if (frameId !== 0 && n) n = n.replace(/\[(e\d+)\]/g, `[$1@f${frameId}]`);
    return n;
  };

  let note = '', usedL2 = layer === 'L2', l2note = '';
  try {
    note = usedL2 ? await execL2(id, cmd, params, loc) : await runL1();
  } catch (e) {
    // L2 不可用不该让整条链路失败——降级回 L1，把原因带在返回里说清楚
    if (usedL2 && (e.code === 'NEEDS_L2' || e.code === 'L2_BUSY')) {
      usedL2 = false;
      l2note = `（本想用真实事件，但${e.message}）`;
      note = await runL1();
    } else throw e;
  }

  let ev = await settle(id, frameId, params, loc?.baseline, before);

  // 零证据 → 自动升级。敏感目标除外：L1 可能其实已经生效只是没留下痕迹，
  // 对「提交/支付/删除」重试一次就是下第二笔单，这个闸门是确定性的，不问模型。
  let upgraded = false;
  if (!ev.changed && !usedL2 && l2ok && !params.real) {
    if (loc?.sensitive) {
      l2note = '（没有自动用真实事件重试：这是提交/支付/删除一类的动作，'
             + '重试可能造成重复执行。确认需要请显式传 real:true）';
    } else {
      try {
        note = await execL2(id, cmd, params, loc);
        usedL2 = true;
        upgraded = true;
        ev = await settle(id, frameId, params, loc?.baseline, before);
      } catch (e) {
        l2note = `（普通事件无效，真实事件也没能用上：${e.message}）`;
      }
    }
  }

  const after = (await chrome.tabs.get(id)).url;
  const navigated = before !== after;
  if (navigated) { await waitForLoad(id); await markNavigated(id, ctx?.connId); }

  return { note, l2note, ev, navigated, upgraded };
}

// 每一步的人话描述。批处理最怕的是「跑了一半，不知道跑到哪了」——
// 回执里必须能一眼看出每一步动了什么。
function describeStep(st) {
  const t = st.find
    ? `${st.find.role ? st.find.role + ' ' : ''}「${st.find.name || st.find.selector || ''}」`
    : st.ref ? `[${st.ref}]`
    : st.selector ? `(${st.selector})`
    : '';
  const extra = st.text !== undefined ? ` ←${String(st.text).length}字`
    : st.value !== undefined ? ` ←"${st.value}"`
    : st.check !== undefined ? (st.check ? ' 勾选' : ' 取消勾选')
    : st.key !== undefined ? ` ${[].concat(st.key).join('+')}`
    : st.url ? ` ${st.url}`
    : st.value === undefined && st.for ? ` ${st.for} ${st.value || ''}`
    : '';
  return `${st.do || '?'} ${t}${extra}`.trim();
}

// 把一次执行的结果写成给 agent 看的那几行
function effectLines({ note, l2note, ev, upgraded }) {
  return [
    note + (upgraded ? '　←　普通事件无效，已自动改用真实事件' : ''),
    l2note,
    ev.changed
      ? `效果：${ev.parts.join('；')}` + (ev.volatile ? '　（注意：这个页面本身也在持续变化）' : '')
      : ev.unattributable
        ? `⚠️ 没有可归因于这次操作的变化。这个页面本身在持续变化（${ev.parts.join('；')}），`
          + `但目标元素的状态没动、也没有新的页面提示——那些变化多半不是这次操作造成的。`
          + `想确认是否生效，看下面快照里目标附近的内容。`
        : `⚠️ 操作已发出，但页面完全没有反应（DOM、正文、焦点、目标状态、页面提示都没变）。`
          + `可能是：① 这个元素只是容器，真正的按钮在它内部或旁边；`
          + `② 操作确实发生了但只有异步副作用（请求已发出、页面稍后才变）；`
          + `③ 站点忽略了这次输入。别原样重试——换个目标，或先 wait 再看。`,
  ].filter(Boolean).join('\n');
}

async function perform(id, cmd, p, ctx) {
  const drift = await driftNote(id, ctx?.connId);
  const r = await performCore(id, cmd, p, {}, ctx);
  const snap = await snapshotAll(id);
  const head = [drift, effectLines(r)].filter(Boolean).join('\n');
  return { ...snap, text: `${head}\n\n${snap.text}`, navigated: r.navigated };
}

const HANDLERS = {
  async snapshot(p, tabId, ctx) {
    const id = await resolveTab(tabId);
    const drift = await driftNote(id, ctx?.connId);
    const snap = await guardCreds(id, await snapshotAll(id, p));
    return drift ? { ...snap, text: drift + '\n' + snap.text } : snap;
  },

  async navigate(p, tabId, ctx) {
    const id = await resolveTab(tabId);
    if (p.url) await chrome.tabs.update(id, { url: p.url });
    else await toContent(id, { __hc: 'history', action: p.action || 'reload' });
    await waitForLoad(id);
    await sleep(300); // 给 SPA 的首屏渲染一点时间，否则快照经常空
    await markNavigated(id, ctx?.connId);
    return snapshotAll(id);
  },

  // 批处理：把「执行 → 观察 → 决定」的循环从模型层下沉到扩展层。
  //
  // 存在理由是回合数。一个「点下一步 → 填手机号 → 勾同意 → 提交」的流程，
  // 逐个调用是 4 次模型推理 + 4 份各 1–2k token 的快照，而中间那 3 份
  // agent 根本不看——它在发出第一个 click 之前就知道后面三步要干什么。
  // act 只在最后回一份快照，省掉的就是中间那些。
  //
  // 最难的是 ref 会在中途作废：第二步开始，页面可能已经重渲染，
  // ref 要么指向别的元素，要么不存在。所以有了 find（语义定位）——
  // 页面变了就用 role + 可访问名现场找回来。规则见下面的 structureChanged。
  async act(p, tabId, ctx) {
    const id = await resolveTab(tabId);
    const steps = Array.isArray(p.steps) ? p.steps : [];
    if (!steps.length) throw err('INTERNAL', 'steps 不能为空');
    if (steps.length > 20) throw err('INTERNAL', `一次最多 20 步，收到 ${steps.length} 步。拆开调用。`);

    const drift = await driftNote(id, ctx?.connId);
    const done = [];
    let stopped = null;
    // 页面结构一旦变过，之前那份快照里的 ref 全部作废——只有 find 还能用
    let structureChanged = false;

    for (let i = 0; i < steps.length; i++) {
      const { do: cmd, ...rest } = steps[i];
      const label = describeStep(steps[i]);

      if (!cmd) { stopped = { i, label, why: `第 ${i + 1} 步没写 do` }; break; }

      if (structureChanged && rest.ref && !rest.find) {
        stopped = {
          i, label,
          why: `页面结构在上一步之后变了，快照里的 ref 已经全部作废。`
            + `这一步用的是 ref="${rest.ref}"，换成 find（按 role + 名字定位）就能继续。`,
        };
        break;
      }

      try {
        if (cmd === 'wait') {
          const r = await toContent(id, { __hc: 'wait', ...rest });
          done.push(`✅ ${label}　${r?.text || ''}`);
          continue;
        }
        if (cmd === 'navigate') {
          await HANDLERS.navigate(rest, id, ctx);
          structureChanged = true;
          done.push(`✅ ${label}`);
          continue;
        }
        if (cmd === 'scroll') {
          const r = await toContent(id, { __hc: 'scroll', ...rest });
          done.push(`✅ ${label}　${(r?.text || '').split('\n')[0]}`);
          continue;
        }

        const r = await performCore(id, cmd, { ...rest, snapshotId: p.snapshotId },
          { blockSensitive: !p.allowSensitive }, ctx);

        if (r.blocked) {
          stopped = {
            i, label,
            why: '这是提交/支付/删除一类的动作，批处理不代做——一串动作里夹一个它，'
              + '跑完了中间没有任何人看得见。单独调用一次 click 把它做掉，'
              + '那样你会看到它自己的效果证据。',
          };
          break;
        }

        if (!r.ev.changed) {
          stopped = {
            i, label,
            why: `这一步没有让页面产生任何可归因的变化，后面的步骤多半建立在错误的前提上，`
              + `所以停在这里。${r.l2note || ''}`,
          };
          break;
        }

        done.push(`✅ ${label}　效果：${r.ev.parts.join('；')}`);
        // 只有「结构性」变化才作废 ref：填个值、勾个框不影响编号，
        // 而连续填表正是批处理最常见的用法，不该逼它们全用 find
        if (r.navigated || r.ev.parts.some((s) => /节点|顶层|跳转|移除/.test(s))) {
          structureChanged = true;
        }
      } catch (e) {
        stopped = { i, label, why: `[${e.code || 'INTERNAL'}] ${e.message}` };
        break;
      }
    }

    const snap = await snapshotAll(id);
    const total = steps.length;
    const head = [
      drift,
      `act ${stopped ? `停在第 ${stopped.i + 1} 步` : '完成'} ${done.length}/${total}：`,
      ...done.map((d) => '  ' + d),
      stopped ? `  ⏸ ${stopped.label}\n     ${stopped.why}` : '',
      stopped && stopped.i + 1 < total
        ? `  还剩 ${total - stopped.i - 1} 步没做：${steps.slice(stopped.i + 1).map(describeStep).join('、')}`
        : '',
    ].filter(Boolean).join('\n');

    return { ...snap, text: `${head}\n\n${snap.text}`, completed: !stopped, doneCount: done.length };
  },

  // 五个写操作走同一条路径：定位 → 执行（L1 或 L2）→ 采效果证据 → 必要时升级重试。
  // select 和 fill 不进 L2：原生 <select> 的下拉是浏览器进程的 UI，CDP 打不到，
  // 点了反而卡住；fill 是多字段批量，逐字段定位的收益等 act 批处理一起做。
  async click(p, tabId, ctx) { return perform(await resolveTab(tabId), 'click', p, ctx); },
  async type(p, tabId, ctx) { return perform(await resolveTab(tabId), 'type', p, ctx); },
  async key(p, tabId, ctx) { return perform(await resolveTab(tabId), 'key', p, ctx); },
  async fill(p, tabId, ctx) { return perform(await resolveTab(tabId), 'fill', p, ctx); },
  async select(p, tabId, ctx) { return perform(await resolveTab(tabId), 'select', p, ctx); },

  async read_text(p, tabId, ctx) {
    const id = await resolveTab(tabId);
    const drift = await driftNote(id, ctx?.connId);
    const r = await guardCreds(id, await toContent(id, { __hc: 'read_text', ...p }));
    return drift ? { ...r, text: drift + '\n' + r.text } : r;
  },

  async wait(p, tabId) {
    const id = await resolveTab(tabId);
    return toContent(id, { __hc: 'wait', ...p });
  },

  async query(p, tabId, ctx) {
    const id = await resolveTab(tabId);
    const drift = await driftNote(id, ctx?.connId);
    const r = await guardCreds(id, await toContent(id, { __hc: 'query', ...p }));
    return drift ? { ...r, text: drift + '\n' + r.text } : r;
  },

  // 让浏览器自己下载。fetch+binary 走的是 base64 over WebSocket，几十 MB 的视频
  // 会在转码和传输上双重爆掉——三个 4K 视频就是这么丢的。
  // 这条路由浏览器原生下载，不进内存、不进 context，还自带断点和大文件支持。
  // saveAs:false 是关键：不弹系统保存对话框（那是扩展够不着的东西）。
  async download(p) {
    const filename = p.filename || `huashu-chrome/${Date.now()}-${(p.url.split('/').pop() || 'file').split('?')[0].slice(0, 60)}`;
    const dlId = await chrome.downloads.download({ url: p.url, filename, conflictAction: 'uniquify', saveAs: false });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        chrome.downloads.onChanged.removeListener(onChanged);
        reject(err('TIMEOUT', `下载超过 ${(p.timeout || 120000) / 1000}s 未完成`));
      }, p.timeout || 120000);
      const onChanged = (d) => {
        if (d.id !== dlId) return;
        if (d.state?.current === 'complete') {
          clearTimeout(timer);
          chrome.downloads.onChanged.removeListener(onChanged);
          chrome.downloads.search({ id: dlId }).then(([item]) =>
            resolve({ text: `已下载 ${Math.round((item?.fileSize || 0) / 1024)}KB → ${item?.filename}`, path: item?.filename, bytes: item?.fileSize }));
        } else if (d.state?.current === 'interrupted') {
          clearTimeout(timer);
          chrome.downloads.onChanged.removeListener(onChanged);
          reject(err('INTERNAL', `下载中断：${d.error?.current || '未知原因'}`));
        }
      };
      chrome.downloads.onChanged.addListener(onChanged);
    });
  },

  async upload(p, tabId) {
    const id = await resolveTab(tabId);
    return (await toFrame(id, 'upload', p)).data;
  },

  async scroll(p, tabId) {
    const id = await resolveTab(tabId);
    return toContent(id, { __hc: 'scroll', ...p });
  },

  // 看这个页面调了哪些接口、返回了什么。抓数据的首选入口。
  async network(p, tabId) {
    const id = await resolveTab(tabId);
    const justRegistered = await ensureNetHook();
    // 当前页面若在注册之前就加载了，补一针（只能抓到此刻之后的请求）
    await chrome.scripting.executeScript({ target: { tabId: id }, world: 'MAIN', files: ['net-hook.js'] }).catch(() => {});

    // 只有在这个页面确实没有记录时才刷新。
    // 曾经这里写的是「刚注册就刷」——而扩展每次重载都会清掉 registerContentScripts，
    // 于是重载扩展后的第一次 network 调用会把页面刷掉，连同已经辛苦滚出来的几百 KB
    // 记录一起销毁。自动修复动作不能先斩后奏地毁掉已有状态。
    let hasData = false;
    try {
      const [probe] = await chrome.scripting.executeScript({
        target: { tabId: id }, world: 'MAIN',
        func: () => (window.__hcNet || []).length,
      });
      hasData = (probe?.result || 0) > 0;
    } catch { /* 注入不了就当没有 */ }

    if (p.reload || !hasData) {
      await chrome.tabs.reload(id);
      await waitForLoad(id);
      await sleep(p.settle || 2000); // 等首屏那批 XHR 落地
    }

    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: id },
      world: 'MAIN',
      func: (match, want, maxBody, index) => {
        const all = window.__hcNet || [];
        const hit = match ? all.filter((r) => (r.url || '').includes(match)) : all;
        if (want) {
          // 翻页时同一个接口会被调多次，URL 只差一个 cursor——光取最后一条会漏掉前面几批。
          // index 从后往前数：0=最后一条，1=倒数第二条。
          const matches = hit.filter((x) => (x.url || '').includes(want));
          const r = matches[matches.length - 1 - (index || 0)];
          return r
            ? { one: true, url: r.url, status: r.status, total: matches.length, body: String(r.body || '').slice(0, maxBody) }
            : { one: true, missing: true, total: matches.length };
        }
        // 默认只给目录，不给正文——响应体动辄几百 KB，一次性倒进 context 是灾难
        return {
          list: hit.map((r) => ({ m: r.method, s: r.status, url: String(r.url).slice(0, 180), kb: Math.round((r.body || '').length / 1024) })),
        };
      },
      args: [p.match || '', p.body || '', p.maxBody || 120000, p.index || 0],
    });

    if (!result) throw err('INTERNAL', '读不到网络记录——页面可能禁止了脚本注入');
    if (result.one) {
      // 不是 REF_NOT_FOUND：那个码的意思是「快照失效了，重新 snapshot」，
      // 而这里跟 DOM 毫无关系，重新快照一百次也变不出这条请求来。
      // 错的错误码会把 agent 引去做无用功。
      if (result.missing) throw err('NO_MATCH', `没有匹配 "${p.body}" 的第 ${p.index || 0} 条请求（共 ${result.total} 条）。先不带 body 参数调一次看看有哪些接口。`);
      return { untrusted: true, meta: `url="${result.url}"`, text: `${result.status} ${result.url}\n\n${result.body}` };
    }
    const rows = result.list;
    if (!rows.length) return { text: '这个页面没有记录到网络请求。加 reload:true 刷新后重试。' };
    return {
      text: `${rows.length} 条请求（带响应体大小）。用 body:"<url片段>" 取某一条的完整响应：\n\n`
        + rows.map((r) => `${String(r.s).padEnd(4)} ${String(r.m).padEnd(5)} ${String(r.kb).padStart(4)}KB  ${r.url}`).join('\n'),
    };
  },

  // 在页面上下文里发请求——自动带用户的 cookie。
  // 拿到接口地址后，翻页/改参数直接在这里做，不用滚动几十次去凑数据。
  //
  // 二进制（图片、文件）走另一条路：从扩展自己发。图片几乎总是在另一个域
  // （公众号正文在 mp.weixin.qq.com，图在 mmbiz.qpic.cn），页面里 fetch 会被 CORS 挡死；
  // 而扩展有 host_permissions，跨域不受限。
  async fetch(p, tabId) {
    if (p.binary && p.via !== 'page') {
      try {
        const res = await fetch(p.url, { credentials: 'include' });
        const bytes = new Uint8Array(await res.arrayBuffer());
        if (bytes.length > 12 * 1024 * 1024) {
          throw err('INTERNAL', `文件 ${Math.round(bytes.length / 1048576)}MB，超过 base64 通道的 12MB 上限。改用 download 工具，它走浏览器原生下载，不限大小。`);
        }
        let s = '';
        for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        return { base64: btoa(s), ct: res.headers.get('content-type') || '', bytes: bytes.length, status: res.status };
      } catch (e) {
        throw err('INTERNAL', `扩展侧下载失败：${e.message}。若是防盗链，改用 via:"page" 从页面上下文请求。`);
      }
    }
    const id = await resolveTab(tabId);
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: id },
      world: 'MAIN',
      func: async (url, init, maxBody, binary) => {
        try {
          const res = await fetch(url, { credentials: 'include', ...(init || {}) });
          if (!binary) return { status: res.status, body: (await res.text()).slice(0, maxBody) };
          // 图片走这里。在页面上下文请求，Referer 自然是本站——防盗链（公众号 mmbiz、
          // 微博、小红书图床）拦的就是缺 Referer 的外部请求。
          // ArrayBuffer 没法跨 world 传，转成 base64 字符串。
          const bytes = new Uint8Array(await res.arrayBuffer());
          let s = '';
          for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
          return { status: res.status, base64: btoa(s), ct: res.headers.get('content-type') || '', bytes: bytes.length };
        } catch (e) {
          return { error: String(e && e.message || e) };
        }
      },
      args: [p.url, p.init || null, p.maxBody || 200000, !!p.binary],
    });
    if (result?.error) throw err('INTERNAL', `请求失败：${result.error}`);
    if (p.binary) return { base64: result.base64, ct: result.ct, bytes: result.bytes, status: result.status };
    return { untrusted: true, meta: `url="${p.url}"`, text: `${result.status}\n\n${result.body}` };
  },

  // 在页面自己的世界里求值。
  //
  // 原来这条路走 content script 的 new Function()，结果是**在任何网站上都必然失败**——
  // MV3 的 content script 跑在隔离世界里，继承的是扩展的 CSP，而扩展 CSP 一律禁
  // unsafe-eval。报错信息里那句 script-src 看着像页面的，其实末尾是
  // chrome-extension://<uuid>，是扩展自己的。一个连本地无 CSP 页面都跑不通的工具，
  // 等于不存在。
  //
  // 换到 MAIN world 之后受页面 CSP 管：没设 CSP 的站点能用了，大站仍然拦——
  // 但那是真实且可解释的边界，不再是「哪儿都不能用」。
  async eval(p, tabId) {
    const id = await resolveTab(tabId);

    // eval 不走 performCore，也就绕开了那里的支付闸门——实测一句
    // `document.getElementById('pay').click()` 就能把确认整个跳过去。
    // 所以求值期间在页面上架一道捕获阶段的拦截，只拦这一段时间。
    // 注入失败（chrome:// 之类）不该拖垮 eval 本身：那些页面上也没有支付按钮。
    let guarded = false;
    try {
      await ensureContent(id);
      await toContent(id, { __hc: 'payGuard', on: true });
      guarded = true;
    } catch { /* 没有 content script 就没有这道防线，eval 照常跑 */ }

    let result;
    try {
      ([{ result } = {}] = await chrome.scripting.executeScript({
        target: { tabId: id },
        world: 'MAIN',
        func: (src, max) => {
          try {
            // eslint-disable-next-line no-eval
            const v = (0, eval)(`"use strict"; (${src})`);
            let s;
            try { s = JSON.stringify(v, null, 2); } catch { s = String(v); }
            if (s === undefined) s = 'undefined';
            return { ok: true, text: s.length > max ? s.slice(0, max) + '\n…（已截断）' : s };
          } catch (e) {
            return { ok: false, message: String((e && e.message) || e) };
          }
        },
        args: [String(p.expr || ''), p.maxLength || 20000],
      }));
    } finally {
      if (guarded) {
        const r = await toContent(id, { __hc: 'payGuard', on: false }).catch(() => null);
        const hit = r?.blocked;
        if (hit) {
          throw err('PAY_DECLINED',
            `这段 eval 试图点击支付按钮（${hit.label}${hit.amount ? ` · ${hit.amount}` : ''}），已被拦下。\n`
            + `花钱的动作要走 click，那条路上有确认弹窗、由人点头。不要用 eval 绕过它。`);
        }
      }
    }

    if (!result) throw err('NOT_INTERACTABLE', '无法在此页面注入脚本');
    if (!result.ok) {
      const csp = /Content Security Policy|unsafe-eval/i.test(result.message);
      // CSP 拦下时升级 L2：调试器的求值通道不受页面 CSP 管。
      // 顺序是「先页面世界、拦了再升级」而不是直接上 L2——小站和本地页面
      // 走页面世界就够，没必要为它们挂一下黄条。
      if (csp) {
        try {
          return { untrusted: true, text: await cdp.evaluate(id, `(${p.expr})`, { maxLength: p.maxLength || 20000 }) };
        } catch (e) {
          throw err(e.code === 'NEEDS_L2' || e.code === 'L2_BUSY' ? e.code : 'INTERNAL',
            e.code === 'NEEDS_L2'
              ? `这个页面的 CSP 禁止 eval。${e.message}`
              : `页面的 CSP 禁止 eval，真实求值通道也没能用上：${e.message}\n`
                + `改用 query（按 selector 提取）或 network（读接口），它们不受 CSP 限制。`);
        }
      }
      throw err('INTERNAL', `表达式执行失败：${result.message}`);
    }
    return { untrusted: true, text: result.text };
  },

  // captureVisibleTab 截的是「那个窗口当前可见的标签页」，不是我们的受控标签页。
  // 用户切走后直接截，截到的就是他自己正在看的页面——把私人内容送进 agent 的上下文。
  // 这件事真实发生过两次，第二次是在传了 focus:true 的情况下（切前台没切成，
  // 保护被绕过），所以下面把「确认切换成功」也做成硬检查。
  //
  // 但真正的解法是根本不走那条路：CDP 的 Page.captureScreenshot 截的是**指定 target**，
  // 后台标签页照样能截，既不打断用户，也不存在截错页面的可能。
  async screenshot(p, tabId) {
    const id = await resolveTab(tabId);
    try {
      return { dataUrl: await cdp.screenshot(id) };
    } catch (e) {
      if (e.code !== 'NEEDS_L2' && e.code !== 'L2_BUSY') throw e;
      // 没有调试器权限时退回老路，前台保护一条不少
      const tab = await chrome.tabs.get(id);
      if (!tab.active) {
        if (!p.focus) {
          throw err('NOT_INTERACTABLE',
            `标签页 ${id} 不在前台。启用「高保真模式」后可以直接截后台标签页；` +
            `在那之前，要截它必须切到前台——传 focus:true 显式同意打断用户，` +
            `或者先用 snapshot / read_text 读内容（不需要前台）。`);
        }
        await chrome.tabs.update(id, { active: true });
        await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
        await sleep(250);
        // 切换可能没成功（窗口最小化、被别的窗口盖住）。不确认就截，
        // 截到的还是用户那一页——这正是第二次事故的成因。
        const now = await chrome.tabs.get(id);
        if (!now.active) {
          throw err('NOT_INTERACTABLE',
            `已请求把标签页 ${id} 切到前台但没有生效（窗口可能被最小化了）。` +
            `拒绝截图——否则截到的是用户当前正在看的其它页面。`);
        }
      }
      return { dataUrl: await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' }) };
    }
  },

  async tabs(p, tabId, ctx) {
    const connId = ctx?.connId;
    if (p.action === 'list') {
      const all = await chrome.tabs.query({});
      // 标的是本会话自己的受控 tab；旧桥（无 connId）退回全局槽
      const { [connId === undefined ? 'activeTabId' : agentTabKey(connId)]: mine } =
        await chrome.storage.local.get(connId === undefined ? 'activeTabId' : agentTabKey(connId));
      const lines = all.map((t) => `[${t.id}]${t.id === mine ? ' *' : '  '} ${t.title || '(无标题)'} — ${t.url}`);
      return { text: `共 ${all.length} 个标签页（* = 受控）\n` + lines.join('\n') };
    }
    // active:false —— agent 在后台干活，不把用户从他正在看的页面上拽走。
    // 需要抢焦点的场合（截图、让用户看着操作）由调用方显式传 focus:true。
    if (p.action === 'new') {
      const tab = await chrome.tabs.create({ url: p.url || 'about:blank', active: !!p.focus });
      await setActiveTabId(tab.id);   // 全局槽照旧更新：它是「最近受控 tab」的继承源
      if (connId !== undefined) await chrome.storage.local.set({ [agentTabKey(connId)]: tab.id });
      if (p.url) { await waitForLoad(tab.id); await sleep(300); }
      return { text: `已在后台打开标签页 ${tab.id}`, tabId: tab.id };
    }
    // 「受控」和「前台」是两件事：这里只改受控目标，不动用户的视线
    if (p.action === 'select') {
      const id = await resolveTab(p.tabId, connId, ctx);
      await setActiveTabId(id);
      if (connId !== undefined) await chrome.storage.local.set({ [agentTabKey(connId)]: id });
      const warn = await conflictNote(id, connId);
      if (p.focus) await chrome.tabs.update(id, { active: true });
      return { text: warn + `受控标签页切到 ${id}` };
    }
    if (p.action === 'close') {
      const id = await resolveTab(p.tabId, connId);
      const warn = await conflictNote(id, connId);
      await chrome.tabs.remove(id);
      return { text: warn + `已关闭标签页 ${id}` };
    }
    throw err('INTERNAL', `未知 tabs 动作 ${p.action}`);
  },

  // 人工介入。产品里第一个「长阻塞 + 等用户动手」的命令。
  //
  // 这是全项目**唯一**一个「抢焦点是对的」的场景：正在请用户帮忙，
  // 他理应看到那个页面。其余所有工具继续守「后台干活不打扰」的硬规则。
  //
  // 我们的路径比 BrowserSkill 短一半：它必须把用户从自己的窗口拽到 Agent Window
  // 去解验证码，我们本来就在用户自己的浏览器里，切个前台就行。
  async ask(p, tabId) {
    // 无人值守场景（定时任务、服务器）没有人可问。立刻返回，让 agent 别干等，
    // 也别把「没人应答」误解成「用户拒绝」。
    if (p.disabled) {
      return { text: 'ask 已被禁用（无人值守模式）。请自行完成或干净地停止，不要重试。', outcome: 'disabled' };
    }

    const id = await resolveTab(tabId);
    const timeout = Math.min(Math.max(Number(p.timeout) || 300000, 5000), 600000);

    // 高亮目标：把用户的视线直接送到该操作的地方。ref 由 content script 解析
    // （只有它认得 refMap），转成临时 selector 交给浮条那一侧去画。
    let selectors = [];
    if (Array.isArray(p.targets) && p.targets.length) {
      try {
        ({ selectors } = await toContent(id, { __hc: 'markTargets', targets: p.targets }));
      } catch { /* 高亮是锦上添花，失败不该拖垮整个请求 */ }
    }

    if (p.focus !== false) {
      const tab = await chrome.tabs.get(id);
      await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
      await chrome.tabs.update(id, { active: true });
    }

    await chrome.scripting.executeScript({ target: { tabId: id }, files: ['ask-overlay.js'] });
    if (selectors.length) {
      await chrome.tabs.sendMessage(id, { __hcAsk: 'flash', selectors }).catch(() => {});
    }

    // 用户很可能根本不在浏览器里——桌面通知是唯一能把他叫回来的东西
    chrome.notifications?.create(`hc-ask-${Date.now()}`, {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: p.title || 'huashu-chrome 需要你搭把手',
      message: String(p.prompt || '').slice(0, 180),
      priority: 2,
    }, () => void chrome.runtime.lastError);

    const started = Date.now();
    await chrome.tabs.sendMessage(id, {
      __hcAsk: 'show', title: p.title, prompt: p.prompt, timeout, wantNote: p.wantNote !== false,
    });
    const panel = pollPanel(id, timeout);

    // until 判据：用户完成后往往不会记得回来点「我完成了」——登录跳转、
    // 验证通过这些都有明确的页面信号，能自动收工就别让他多点一下。
    const auto = p.until ? watchUntil(id, p.until, timeout) : null;
    const res = await (auto ? Promise.race([panel, auto.promise]) : panel);
    auto?.stop();
    if (res.outcome === 'completed') {
      await chrome.tabs.sendMessage(id, { __hcAsk: 'abort' }).catch(() => {});
    }
    await toContent(id, { __hc: 'unmarkTargets' }).catch(() => {});

    const waited = Math.round((Date.now() - started) / 1000);
    const snap = await snapshotAll(id).catch(() => ({ text: '' }));
    const head = {
      continued: `✅ 用户说完成了（等了 ${waited}s）`,
      completed: `✅ 自动判定完成（等了 ${waited}s，命中了你给的 until 条件）`,
      cancelled: `🛑 用户点了取消（等了 ${waited}s）。这是明确的「别做这件事」——停止当前任务，不要换个方式重试。`,
      timed_out: `⏰ ${Math.round(timeout / 1000)}s 内没有人响应。用户可能不在电脑前。`,
    }[res.outcome] || res.outcome;

    return {
      outcome: res.outcome,
      text: `${head}${res.note ? `\n用户留言：${res.note}` : ''}\n\n${snap.text}`,
    };
  },

  // 回归测试用：把支付确认的等待时间调短，否则每条相关用例都要等三分钟。
  // 故意不写进 MCP 工具列表，所以 agent 那一侧看不到、也调不到它。
  // 即使被调到也不危险——超时一律按拒绝处理，调短只会让支付更容易失败。
  async __pay_timeout(p) {
    payTimeout = Math.min(Math.max(Number(p.ms) || 180000, 1000), 600000);
    return { text: `支付确认等待时间设为 ${payTimeout}ms` };
  },

  // 开发期用：改完扩展代码不必再手动去 chrome://extensions 点重载。
  // 先把响应发出去，再重载——重载会当场掐断 WS。
  async reload() {
    setTimeout(() => chrome.runtime.reload(), 150);
    return { text: '扩展重载中，约 2 秒后自动重连' };
  },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 生命周期 ----------

chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(() => {
  connect();
  chrome.alarms.create('hc-keepalive', { periodInMinutes: 0.5 });
});
// SW 上一条命里挂着的调试会话，浏览器还替它留着——连同那条黄带子。
// 每次启动扫一遍，否则用户会看到一条永远摘不掉的「已开始调试此浏览器」。
cdp.reapOrphans();
chrome.alarms?.onAlarm.addListener(() => connect());   // SW 被回收后靠这个复活
chrome.tabs.onRemoved.addListener(async (tabId) => {
  // 全局槽 + 所有连接级槽一次扫清，别留指向死 tab 的槽
  const all = await chrome.storage.local.get(null);
  const dead = Object.keys(all).filter((k) => (k === 'activeTabId' || k.startsWith('agentTab:')) && all[k] === tabId);
  if (dead.length) await chrome.storage.local.remove(dead);
  for (const k of lastSeen.keys()) if (k.endsWith(':' + tabId)) lastSeen.delete(k);
  emit('tab_closed', { tabId });
});

// popup 点「立即连接」时用
chrome.runtime.onMessage.addListener((m, _s, sendResponse) => {
  if (m.__hcPopup === 'status') {
    sendResponse({ connected: ws?.readyState === 1 });
    return true;
  }
  if (m.__hcPopup === 'connect') {
    connect().then(() => sendResponse({ connected: ws?.readyState === 1 }));
    return true;
  }
  // 用户在 popup 里关掉高保真模式时，先把还挂着的调试会话断干净，
  // 否则权限撤销了，黄条却还留在标签页上，而且再也没人能去摘它
  if (m.__hcPopup === 'detachAll') {
    cdp.reapAll().finally(() => sendResponse({ ok: true }));
    return true;
  }
});

connect();
