// Service Worker —— 扩展这一侧的总机
//
// 与桥的那条 WebSocket **不在这里**，在 offscreen.js。理由写在那个文件的头上，
// 一句话版本：SW 空闲 30 秒就被回收，socket 跟着断，而 offscreen 文档不受这条规则管。
// 这边收到的每条命令都是 offscreen 用 runtime 消息递进来的——那条消息本身
// 就会把被回收的 SW 叫醒，所以「SW 睡着了」不再等于「扩展掉线了」。
//
// 于是这里没有任何「只在内存里、丢了就完蛋」的状态：受控 tab 在 storage.local，
// 漂移记录和 iframe 快照在 storage.session，连接状态由 offscreen 维护。

import * as cdp from './cdp.js';
import { matchChallenge, hostOf, hostMatches, L2_ORIGINS_SEED } from './risk.js';
import { CRED_URL, redactCreds } from './redact.js';

// ---------- 连接层 ----------
//
// 两条腿：offscreen 文档（首选，不受 SW 的 30 秒空闲回收管），
// 以及 SW 自己直连（兜底）。
//
// 兜底不是防御性代码洁癖，是踩出来的：offscreen 一旦建不起来（权限没生效、
// 浏览器版本不支持、低内存被收走），SW 这边就再没有任何东西吊着它——
// 没有 socket、而 chrome.runtime.reload() 又**不触发 onInstalled**，
// 连唤醒用的 alarm 都可能没重建。结果是扩展彻底哑掉，一声不响，
// 桥那边永远显示「扩展没连上」。整个产品的连通性不能挂在一个单点上。

let ensuring = null;
let offscreenFailed = null;   // 记下原因，doctor 和 popup 要能说清为什么走了兜底

// createDocument 在文档已存在时会抛错，并发调用也会互相撞上，所以认
// hasDocument + 单飞。alarm 每 30 秒叫一次，顺带做自愈：offscreen 万一
// 被浏览器收走，下一个 alarm 就把它建回来。
// 绝不向外抛——调用方拿到 false 就走兜底，而不是整条链路炸掉。
async function ensureOffscreen() {
  if (ensuring) return ensuring;
  ensuring = (async () => {
    try {
      if (!chrome.offscreen) throw new Error('这个 Chrome 没有 offscreen API');
      if (await chrome.offscreen.hasDocument()) return true;
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['WORKERS'],
        justification: '维持与本机桥（127.0.0.1）的长连接；service worker 会被回收，连接会跟着断。',
      });
      offscreenFailed = null;
      return true;
    } catch (e) {
      // 并发时另一个调用已经建好了，这不算失败
      if (String(e?.message || '').includes('Only a single offscreen')) return true;
      offscreenFailed = String(e?.message || e);
      chrome.storage.session.set({ offscreenError: offscreenFailed }).catch(() => {});
      return false;
    } finally {
      ensuring = null;
    }
  })();
  return ensuring;
}

async function toBridge(msg) {
  if (await ensureOffscreen()) {
    const r = await chrome.runtime.sendMessage({ __hcBridge: 'out', msg }).catch(() => null);
    if (r?.sent) return;
  }
  directSend(msg);   // offscreen 没建起来，或者它手上那条 socket 断了
}

async function connected() {
  if (directWs?.readyState === 1) return true;
  try {
    return !!(await chrome.storage.session.get('bridgeConnected')).bridgeConnected;
  } catch {
    return false;
  }
}

// ---------- 兜底：SW 自己拿着 socket ----------
//
// 就是 offscreen 之前的那套。只在 offscreen 建不起来时才启用，两条腿
// 同时连的话桥会看到两个扩展，而它「同时只认一个」，后来者会把前一个踢掉。

const PORTS = [8899, 8900, 8901, 8902, 8903];
let directWs = null;
let directTimer = null;

function directSend(msg) {
  if (directWs?.readyState === 1) directWs.send(JSON.stringify(msg));
  else directConnect();
}

// 判据是「连上了没有」，不是「offscreen 文档在不在」。
//
// 这两件事以前被当成一件，于是踩了个死局：offscreen 文档建起来了、但它自己
// 连不上桥（它拿不到 chrome.runtime.getManifest()，握手当场 TypeError）。
// SW 一看「文档在」就谦让，offscreen 一看自己连不上就重试——两条腿互相让路，
// 谁都没在干活，而扩展看起来一切正常。
//
// 交接改成显式的：offscreen 一旦真的连上会发 'up'，SW 收到就把自己这条关掉。
async function directConnect() {
  if (directWs && directWs.readyState <= 1) return;
  for (const port of PORTS) {
    try {
      directWs = await new Promise((resolve, reject) => {
        const sock = new WebSocket(`ws://127.0.0.1:${port}`);
        const t = setTimeout(() => { sock.close(); reject(new Error('timeout')); }, 1500);
        sock.onopen = () => sock.send(JSON.stringify({
          type: 'hello', role: 'extension', extId: chrome.runtime.id,
          version: chrome.runtime.getManifest().version,
          chrome: (navigator.userAgent.match(/Chrome\/([\d.]+)/) || [])[1], v: 1,
        }));
        sock.onmessage = (ev) => {
          const m = JSON.parse(ev.data);
          if (m.type !== 'welcome') { clearTimeout(t); sock.close(); return reject(new Error('rejected')); }
          clearTimeout(t);
          sock.onmessage = (e) => { const x = JSON.parse(e.data); if (x.type !== 'pong') onMessage(x); };
          sock.onclose = () => { directWs = null; stopDirectPing(); setBadge(false); };
          sock.onerror = () => {};
          resolve(sock);
        };
        sock.onerror = () => { clearTimeout(t); reject(new Error('error')); };
      });
      startDirectPing();
      setBadge(true);
      return;
    } catch { /* 换下一个端口 */ }
  }
  setBadge(false);
}

function startDirectPing() {
  stopDirectPing();
  directTimer = setInterval(() => {
    if (directWs?.readyState === 1) directWs.send(JSON.stringify({ type: 'ping' }));
    else directConnect();
  }, 15000);
}
function stopDirectPing() {
  if (directTimer) clearInterval(directTimer);
  directTimer = null;
}

function setBadge(on) {
  chrome.action.setBadgeText({ text: on ? '' : '·' });
  chrome.action.setBadgeBackgroundColor({ color: on ? '#22c55e' : '#94a3b8' });
}

const reply = (id, ok, payload, k) => {
  const base = { type: 'res', id, __k: k };
  return toBridge(ok ? { ...base, ok: true, data: payload } : { ...base, ok: false, error: payload });
};
const emit = (event, extra = {}) => toBridge({ type: 'event', event, ...extra });

// ---------- 命令分发 ----------

// 这些命令自己决定用不用受控 tab——tabs 的 new/select/close 各有各的槽语义，
// download 整条链不碰 tab，reload 是扩展级动作
const NO_SLOT_CMDS = new Set(['tabs', 'download', 'reload']);

async function onMessage(msg) {
  if (msg.type !== 'cmd') return;
  try {
    const handler = HANDLERS[msg.cmd];
    if (!handler) throw err('INTERNAL', `未知命令 ${msg.cmd}`);
    // 缺省 tabId 在这里统一解析成具体 tabId（会话级槽），handler 拿到的永远是实值。
    // ctx 只在本函数内现场传——SW 里两条命令的 await 会交错，绝不能用模块级变量存「当前消息」
    const ctx = { sid: msg.sid, live: msg.live, adopted: false };
    const tabId = NO_SLOT_CMDS.has(msg.cmd) ? msg.tabId : await resolveTab(msg.tabId, msg.sid, ctx);
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
// 多 agent 并发：每个会话（桥盖章的 sid）有自己独立的槽 agentTab:<sid>。
// activeTabId 降级为「最近被 new/select 的 tab」，只在**没有活着的会话占着它**时
// 才允许新会话继承——见 getActiveTabId。
//
// sid 由 agent 进程自己生成、跨桥重启稳定（见 src/lib/rpc.js）。这一点是整块
// 逻辑的地基：上一版拿桥的连接序号当身份，而那个序号桥一重启就从 1 重新数，
// 于是每次桥换代都会让所有会话的槽同时失效、集体去继承同一个全局 tab。
// 实测一晚上桥重启 38 次，症状就是「受控标签页莫名其妙换成了别人的页面」。

const agentTabKey = (sid) => `agentTab:${sid}`;
const SLOT_CAP = 32;   // 死会话的槽不主动删（它可能只是断线重连），按 LRU 收口

// 在线会话名单跟着每条命令一起来（见 bridge.js 的 dispatch），不落盘。
// 落盘那版有竞态：新会话连上后立刻发第一条命令，而名单还在路上，
// 第一条命令读到旧名单就判定「没人占」——恰恰漏掉最该拦住的那一条。
const liveOf = (ctx) => new Set(Array.isArray(ctx?.live) ? ctx.live : []);

// 谁占着这个 tab？只算**还连着**的会话——已经结束的会话留下的槽不算数，
// 否则关掉一个 Claude Code 窗口之后，它的标签页就再没人能接手了。
async function liveOwnersOf(tabId, exceptSid, live) {
  const all = await chrome.storage.local.get(null);
  return Object.entries(all)
    .filter(([k, v]) => k.startsWith('agentTab:') && v === tabId)
    .map(([k]) => k.slice('agentTab:'.length))
    .filter((sid) => sid !== exceptSid && live.has(sid));
}

// 记下这个会话的受控 tab，并顺手把最老的槽挤掉
async function claimTab(sid, tabId, ctx) {
  if (!sid) return;
  await chrome.storage.local.set({ [agentTabKey(sid)]: tabId, [`slotTouch:${sid}`]: Date.now() });
  const all = await chrome.storage.local.get(null);
  const slots = Object.keys(all).filter((k) => k.startsWith('agentTab:')).map((k) => k.slice('agentTab:'.length));
  if (slots.length <= SLOT_CAP) return;
  const live = liveOf(ctx);
  const victims = slots
    .filter((s) => !live.has(s))
    .sort((a, b) => (all[`slotTouch:${a}`] || 0) - (all[`slotTouch:${b}`] || 0))
    .slice(0, slots.length - SLOT_CAP);
  if (victims.length) await chrome.storage.local.remove(victims.flatMap((s) => [agentTabKey(s), `slotTouch:${s}`]));
}

async function getActiveTabId(sid, ctx) {
  if (sid !== undefined) {
    const key = agentTabKey(sid);
    const { [key]: mine } = await chrome.storage.local.get(key);
    if (mine) {
      try { await chrome.tabs.get(mine); return mine; } catch { await chrome.storage.local.remove([key, `slotTouch:${sid}`]); } // 槽里的 tab 已关，自愈
    }
  }
  const { activeTabId } = await chrome.storage.local.get('activeTabId');
  if (activeTabId) {
    let tab = null;
    try { tab = await chrome.tabs.get(activeTabId); } catch { /* 已关 */ }
    if (tab) {
      // 这才是「两个 agent 撞进同一个页面」唯一能拦住的地方。
      // 以前这里无条件继承，只在返回里加一句警告——而警告是在操作**已经跑完**
      // 之后才出现的，等于事后通知你刚才踩了别人。现在直接不给。
      const owners = await liveOwnersOf(activeTabId, sid, liveOf(ctx));
      if (owners.length) {
        throw err('NO_TAB',
          `最近受控的标签页 [${activeTabId}]「${tab.title || ''}」正被另一个还在线的会话操控，不替你抢过来。\n`
          + `  要自己开一个：tabs(action:"new", url:…)\n`
          + `  确实要接管同一个页面：tabs(action:"select", tabId:${activeTabId})——那会和对方在同一页面上互相踩，先想清楚。\n`
          + `  想看有哪些页面可选：tabs(action:"list")`);
      }
      if (sid !== undefined) {
        await claimTab(sid, activeTabId, ctx);   // 继承 = 写自己的槽
        if (ctx) { ctx.adopted = true; ctx.adoptedTab = activeTabId; ctx.adoptedTitle = tab.title; }
      }
      return activeTabId;
    }
  }
  throw err('NO_TAB', '还没有受控标签页——先 tabs(action:"new", url:…) 开一个');
}
const setActiveTabId = (id) => chrome.storage.local.set({ activeTabId: id });

async function resolveTab(tabId, sid, ctx) {
  if (tabId) {
    try { await chrome.tabs.get(tabId); return tabId; } catch { throw err('NO_TAB', `标签页 ${tabId} 不存在`); }
  }
  return getActiveTabId(sid, ctx);
}

// select/close 时检查这个 tab 是不是别的会话的受控页——不阻止（显式 select
// 是明确的接管意图），但必须说清
async function conflictNote(tabId, sid, ctx) {
  const owners = await liveOwnersOf(tabId, sid, liveOf(ctx));
  return owners.length ? '⚠️ 这个标签页正被另一个还在线的会话操控，你们会在同一个页面上互相踩。\n' : '';
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
//
// 同样存 storage.session，理由同 driftNote：放内存里的话，SW 一被回收，
// 上一次 snapshot 拿到的 iframe ref 就必然报 STALE_SNAPSHOT——
// 而 agent 明明刚拍完快照什么都没做，这个错误对它毫无道理可讲。
const frameSnapKey = (tabId) => `frames:${tabId}`;
const getFrameSnaps = async (tabId) => (await chrome.storage.session.get(frameSnapKey(tabId)))[frameSnapKey(tabId)] || null;
const setFrameSnaps = (tabId, snaps) => chrome.storage.session.set({ [frameSnapKey(tabId)]: snaps });

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

// 页面里的对话框会把整条链路挂死，而这是唯一一种「扩展完全够不着」的状态：
// alert / confirm / 「离开此页？」一弹出来，那一页的 JS 全停，
// content script 的 onMessage 永远不会跑，下面这个 await 就永久悬着。
// 原先没有超时，最后由桥在 32 秒后回一个 TIMEOUT，而 TIMEOUT 给 agent 的
// 建议是「先 wait 再重试」——wait 同样走这条路，同样挂死，循环到用户自己发现。
//
// 预算按命令算：wait 和 scroll 本来就可能跑很久，用固定值会打断合法的长等待。
// 后台标签页的对话框会被 Chrome 抑制（靶场里有一条测试守着），
// 所以真撞上多半是用户正好切到了这一页，或者 beforeunload 拦下了导航。
const contentBudget = (p) => {
  if (p?.__hc === 'wait') return (Number(p.timeout) || 10000) + 5000;
  if (p?.__hc === 'scroll') return Math.min(Number(p.times) || 1, 50) * (Number(p.wait) || 700) + 10000;
  // ready 不单列：它自己的静默窗口只有 1.5 秒，外层 waitForReady 的 hardCap
  // 是 12 秒，都在默认预算以内——写一条算出来等于 15000 的规则纯属噪音。
  return 15000;
};

async function toContent(tabId, payload, frameId = 0) {
  await ensureContent(tabId, frameId);
  let r;
  try {
    let timer;
    const budget = contentBudget(payload);
    r = await Promise.race([
      chrome.tabs.sendMessage(tabId, payload, { frameId }),
      new Promise((_, rej) => {
        timer = setTimeout(() => rej(err('DIALOG_BLOCKING',
          `页面脚本 ${Math.round(budget / 1000)} 秒没有响应。最常见的原因是这一页上弹了 `
          + `alert / confirm / 「离开此页？」对话框——一弹出来页面的 JS 就全停了，扩展也够不着它。\n`
          + `请让用户到浏览器里手动关掉那个框。别原样重试，wait 走的是同一条路，一样会挂住。\n`
          + `（也可能是页面正在跑一段很重的脚本，那种情况稍后重试是有用的。）`)), budget);
      }),
    ]).finally(() => clearTimeout(timer));
  } catch (e) {
    if (e?.code) throw e;
    throw err('TIMEOUT', `页面无响应（${e.message}）`);
  }
  if (!r) throw err('INTERNAL', '页面脚本没有返回');
  if (r.error) throw err(r.error.code, r.error.message);
  return r.data;
}

// 等 load 事件。**只剩一个用途**：ensureContent 的兜底重载（下面 waitForReady
// 依赖 ensureContent，那条路上再调 waitForReady 会无限递归）。
// 别的地方一律用 waitForReady——理由见它的注释。
function waitForLoad(tabId, timeout = 15000) {
  return new Promise((resolve) => {
    const done = () => { chrome.tabs.onUpdated.removeListener(h); clearTimeout(t); resolve(); };
    const t = setTimeout(done, timeout);
    const h = (id, info) => { if (id === tabId && info.status === 'complete') done(); };
    chrome.tabs.onUpdated.addListener(h);
    chrome.tabs.get(tabId).then((tab) => { if (tab.status === 'complete') done(); }).catch(done);
  });
}

// 浏览器保护的页面：注入不了，等它「就绪」永远等不到。必须在进循环前挡掉，
// 否则 navigate 到 chrome://extensions 会白白空转满 hardCap——
// 而原先的 waitForLoad 在这类页面上是立刻返回的，那会是一次实打实的退步。
// about: 不在这张表里 —— about:blank 是可以注入的，而且新标签页在导航提交前
// 恰恰长这样，误判成「注入不了」会让 tabs(new) 一次都不等。
const UNINJECTABLE = /^(chrome|edge|devtools|view-source|chrome-extension|chrome-search|chrome-untrusted):/i;
const isUninjectable = (url) => UNINJECTABLE.test(url || '') || /^https:\/\/chromewebstore\.google\.com/i.test(url || '');

// 等导航**提交**（新文档上位），不等它加载完。
//
// 少了这一步，waitForReady 会把 content script 注到还没被替换掉的旧文档或
// about:blank 上——那上面 readyState 早就是 complete、DOM 也早就安静了，
// 于是「就绪」当场满足，等于根本没等。
//
// 两个方向都会出错，所以要靠调用方说明意图：
// ① `tabs.update` / `tabs.create` 是**异步**的，调用返回时 status 往往还是
//    上一页的 complete。这时候看 status 就会当场放行，撞的正是上面那个坑。
//    所以明知自己触发了导航的调用方要传 expectNav，让这里只认事件。
// ② 反过来，就地操作（SPA 路由、click 之后导航早已落定）压根没有导航在进行，
//    死等事件只会白白挂满超时——那种情况看 status 才是对的。
function waitForCommit(tabId, { expectNav = false } = {}) {
  return new Promise((resolve) => {
    const done = () => { chrome.tabs.onUpdated.removeListener(h); clearTimeout(t); resolve(); };
    // 等不到也往下走：宁可早一点开始判就绪，也不要挂在这儿——
    // 后面的 ready 循环本来就会重试，那条路比这里的干等有信息量。
    const t = setTimeout(done, expectNav ? 3000 : 6000);
    // 导航提交时 Chrome 会推一条带 url 的 changeInfo
    const h = (id, info) => { if (id === tabId && (info.url || info.status === 'complete')) done(); };
    chrome.tabs.onUpdated.addListener(h);
    if (!expectNav) chrome.tabs.get(tabId).then((tab) => { if (tab.status !== 'loading') done(); }).catch(done);
  });
}

// 等到「这一页能干活了」。
//
// 取代原先的 waitForLoad + sleep(300)。那套等的是 status === 'complete'，
// 也就是 load 事件——连最后一张广告图、最后一个统计脚本都下完。实测：
//   知乎  DOM 可交互 5.1 秒 · load 20.3 秒 → 白等 15.2 秒（那次 tabs 花了 15.4 秒）
//   B 站  DOM 可交互 7.0 秒 · load 13.2 秒 → 白等 6.1 秒（那次花了 13.5 秒）
// 而它同时又太早，接不住 SPA 的首屏渲染，所以后面才要补一句 sleep(300)——
// 日志里 navigate → wait 出现 38 次，就是那 300ms 不够用留下的痕迹。
//
// 这里不需要 webNavigation 权限（给已装扩展加权限会触发 Chrome 重新授权、
// 打断用户，那是这个产品明确不接受的代价）。靠的是一个已经成立的事实：
// content script 是 executeScript 动态注入的，而它默认在 document_idle 执行——
// **注入成功本身就是「DOM 已可交互」的信号**。剩下的交给 content 侧的
// ready 命令去等 DOM 安静下来。
async function waitForReady(tabId, { hardCap = 12000, quiet = 300, expectNav = false } = {}) {
  await waitForCommit(tabId, { expectNav });
  try {
    if (isUninjectable((await chrome.tabs.get(tabId)).url)) return;
  } catch {
    return;   // 标签页没了，交给调用方后面的操作去报错
  }
  const deadline = Date.now() + hardCap;
  while (Date.now() < deadline) {
    try {
      const r = await toContent(tabId, { __hc: 'ready', quiet, budget: deadline - Date.now() });
      if (r?.ready) return;
    } catch {
      // 正在跳转、或 content script 还没起来。下一轮再问。
      // 这里不抛错：调用方后面自己会撞上真正的错误，那个比这儿造一个有信息量。
    }
    await sleep(80);
  }
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
  // 并行拍。串行的时候每个框架都要付一次完整往返，而带广告的页面动辄七八个——
  // 一次快照就变成八次的时间，全花在等，没有一次是必须排在另一次后面的。
  // Promise.all 保序，所以输出跟串行版一模一样。
  const subs = await Promise.all(
    frames.slice(0, 8)   // 广告位常有十几个 iframe，全抓会把快照撑爆
      .map((f) => toContent(tabId, { __hc: 'snapshot' }, f.frameId)
        .then((sub) => ({ f, sub }))
        .catch(() => ({ f, sub: null })))
  );
  for (const { f, sub } of subs) {
    if (!sub) {
      parts.push(`\n--- iframe f${f.frameId} · ${f.url} ---\n  （注入不了，多半是 sandbox 或已跳走）`);
      continue;
    }
    snaps[f.frameId] = sub.snapshotId;
    // 只把 ref 编号加后缀，别的原样保留
    const body = String(sub.text || '').replace(/^\[(e\d+)\]/gm, `[$1@f${f.frameId}]`);
    const rows = (body.match(/^\[e\d+@f\d+\]/gm) || []).length;
    if (rows) parts.push(`\n--- iframe f${f.frameId} · ${f.url} ---\n${body.split('\n--- 正文节选')[0].split('\n').slice(2).join('\n')}`);
  }
  await setFrameSnaps(tabId, snaps);
  return parts.length ? { ...top, text: top.text + '\n' + parts.join('\n') } : top;
}

// 拆框架号、还原 ref、换上那个框架自己的 snapshotId。
async function prepare(tabId, p) {
  const { frameId, params } = routeOf(p);
  if (frameId !== 0) {
    const known = (await getFrameSnaps(tabId))?.[frameId];
    if (!known) throw err('STALE_SNAPSHOT', `没有框架 f${frameId} 的快照，重新 snapshot 一次`);
    params.snapshotId = known;   // agent 只认顶层那个 id，框架内部的 id 由这里补
  }
  return { frameId, params };
}

// 带 ref 的命令统一从这里走。
async function toFrame(tabId, cmd, p) {
  const { frameId, params } = await prepare(tabId, p);
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

// ---------- 风控站点记忆 ----------
//
// 「零证据 → 升级 L2」挡不住风控站点：在那些站上 L1 是**生效的**（消息发出去了、
// DOM 也变了），只是同时被风控记了一笔 isTrusted:false。等攒够分数弹出验证码，
// 这一轮已经废了，而且是人工才能解的废法。
//
// 所以换个信号：一旦某个 origin 弹过验证挑战，就记住它，之后一律从 L2 起步。
// 代价是这些站点上会常驻黄条——但比每隔几条消息就要人来点一次验证码划算得多。
//
// 判定规则在 ./risk.js —— 纯函数，抽出去是为了让 `npm test` 跑得到，不必开真 Chrome。
// 这里只剩需要 chrome API 的那一层：读 URL、存学到的站点。
const L2_ORIGINS_KEY = 'l2Origins';
let l2OriginsCache = null;

async function learnedL2Origins() {
  if (l2OriginsCache) return l2OriginsCache;
  let stored = {};
  try { ({ [L2_ORIGINS_KEY]: stored = {} } = await chrome.storage.local.get(L2_ORIGINS_KEY)); } catch { /* 存储不可用就只用种子 */ }
  l2OriginsCache = stored;
  return stored;
}

async function prefersL2(url) {
  const h = hostOf(url);
  if (!h) return false;
  if (hostMatches(h, L2_ORIGINS_SEED)) return true;
  return hostMatches(h, Object.keys(await learnedL2Origins()));
}

async function rememberL2Origin(url, why) {
  const h = hostOf(url);
  if (!h || hostMatches(h, L2_ORIGINS_SEED)) return false;
  const m = await learnedL2Origins();
  if (m[h]) return false;
  m[h] = { at: Date.now(), why: String(why).slice(0, 60) };
  l2OriginsCache = m;
  try { await chrome.storage.local.set({ [L2_ORIGINS_KEY]: m }); } catch { /* 记不住就下次再记 */ }
  return true;
}

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
//
// 存 storage.session 而不是模块级 Map：MV3 的 SW 随时被回收，实测一条连接的
// 存活中位数只有 106 秒。存在内存里，SW 一没就全清空——而清空之后 `was` 是
// undefined，driftNote 返回空串，**漂移检测静默失效**。这条保护正是防
// 「一次无差别的 read_text 把 2FA 恢复码读进对话」那种事故的，
// 它失效的时候没有任何征兆，这是最坏的一种坏法。
const seenKey = (sid, tabId) => `seen:${sid ?? '*'}:${tabId}`;

async function driftNote(tabId, sid) {
  const key = seenKey(sid, tabId);
  let now;
  try { now = (await chrome.tabs.get(tabId)).url; } catch { return ''; }
  const { [key]: was } = await chrome.storage.session.get(key);
  await chrome.storage.session.set({ [key]: now });
  if (!was || was === now) return '';
  return `⚠️ 这个标签页的地址变了，而且不是本次操作造成的：\n`
    + `   原本：${was}\n   现在：${now}\n`
    + `   可能是用户自己在用这个浏览器，或者页面自动跳转了。下面的内容来自**新页面**——\n`
    + `   如果这不是你预期的页面，先停下来确认，别在陌生页面上继续操作或读取。\n`;
}

// ---------- 点击开出新标签页 ----------
//
// target="_blank" 和 window.open 把新内容开在**另一个标签页**里，而受控槽
// 还钉在原来那个。原页面确实什么都没变，于是工具老老实实报「操作已发出，
// 但页面完全没有反应」——一句完全正确、又完全帮不上忙的话。agent 接着换个
// 元素重试，而它要的东西早就在隔壁开好了。
//
// 记账写 storage.session（SW 随时被回收，而「刚才那次点击开了什么」必须
// 活过回收，否则记账等于没记）。
//
// **每个**新标签页都记，不只记带 openerTabId 的那些——这是踩出来的：
// Chrome 88 起 target="_blank" 隐含 rel=noopener，实测这样开出来的标签页
// 拿不到 opener 关系。只按 openerTabId 记账的话，最常见的那种「点链接开新页」
// 恰恰一个都认不出来，而症状是工具报「页面完全没有反应」——完全正确又完全没用。
//
// 所以判据分两级，并且把用了哪一级写进回执：opener 对得上是确凿的，
// 同窗口内新出现是推断的，agent 该知道这个区别。
const RECENT_TABS = 'recentTabs';
const RECENT_CAP = 20;

chrome.tabs.onCreated.addListener(async (tab) => {
  const { [RECENT_TABS]: list = [] } = await chrome.storage.session.get(RECENT_TABS);
  list.push({ id: tab.id, opener: tab.openerTabId, win: tab.windowId, at: Date.now() });
  await chrome.storage.session.set({ [RECENT_TABS]: list.slice(-RECENT_CAP) });
});

// 这次操作有没有开出新标签页？只认操作开始之后才出现的那个。
async function childOpenedSince(openerId, since) {
  const { [RECENT_TABS]: list = [] } = await chrome.storage.session.get(RECENT_TABS);
  const fresh = list.filter((r) => r.at >= since && r.id !== openerId);
  if (!fresh.length) return null;

  let win = null;
  try { win = (await chrome.tabs.get(openerId)).windowId; } catch { /* 受控页没了 */ }

  const hit = fresh.find((r) => r.opener === openerId)
    || (win !== null ? fresh.find((r) => r.win === win) : null);
  if (!hit) return null;

  // 认领过就从账上划掉，别让下一条命令再报一遍同一个标签页
  await chrome.storage.session.set({ [RECENT_TABS]: list.filter((r) => r.id !== hit.id) });
  try {
    const tab = await chrome.tabs.get(hit.id);
    return { ...tab, how: hit.opener === openerId ? 'opener' : 'window' };
  } catch {
    return null;   // 开完又被关掉了（有些站点用它做中转）
  }
}

// agent 自己导航到的地方不算漂移
const markNavigated = async (tabId, sid) => {
  try { await chrome.storage.session.set({ [seenKey(sid, tabId)]: (await chrome.tabs.get(tabId)).url }); } catch { /* 标签页没了 */ }
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
  const { frameId, params } = await prepare(id, p);
  const before = (await chrome.tabs.get(id)).url;
  const startedAt = Date.now();

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
  // 风控站点从 L2 起步。这里不能等「零证据」再升级——在这类站上 L1 恰恰是有效果的，
  // 那条升级路永远不会触发，而每一次 isTrusted:false 都在给验证码攒分。
  const riskyOrigin = l2ok && await prefersL2(before);
  let layer = (l2ok && (params.real || loc?.prefer === 'L2' || riskyOrigin)) ? 'L2' : 'L1';

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

  // 弹了验证挑战 → 记住这个站点，之后从 L2 起步。
  // 这一轮救不回来了（挑战只能人来解），但要把原因说清楚：
  // 不说的话 agent 会以为是自己点错了，然后换着花样重试，每试一次风控多记一笔。
  const challenge = matchChallenge(ev.challengeEv);
  if (challenge) {
    const learned = await rememberL2Origin(before, challenge);
    l2note = (l2note ? `${l2note} ` : '')
      + `（⚠️ 页面弹出了风控验证：「${challenge}」。这只能由用户手动完成——不要重试，也不要想办法绕。`
      + (usedL2
        ? '本次用的已经是真实事件，说明该站的风控不只看事件可信度，接下来的操作最好交给用户。'
        : learned
          ? `已记住 ${hostOf(before)}，之后在这个站点一律用真实事件操作。`
          : '')
      + '）';
  }

  const after = (await chrome.tabs.get(id)).url;
  const navigated = before !== after;
  if (navigated) { await waitForReady(id); await markNavigated(id, ctx?.sid); }

  // 这次操作把内容开到了另一个标签页里（target=_blank / window.open）。
  // 受控槽跟过去——不跟的话，agent 会一直对着一个「什么都没变」的原页面
  // 换着花样重试，而它要的东西就在隔壁。回执里把两个 id 都写清楚，
  // 想回原页面 tabs(action:"select") 一句话的事。
  const child = await childOpenedSince(id, startedAt);
  if (child) {
    await waitForReady(child.id);
    await setActiveTabId(child.id);
    await claimTab(ctx?.sid, child.id, ctx);
    await markNavigated(child.id, ctx?.sid);
    return { note, l2note, ev, navigated, upgraded, followed: { from: id, to: child.id, url: child.url, how: child.how } };
  }

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
function effectLines({ note, l2note, ev, upgraded, followed }) {
  if (followed) {
    return [
      note + (upgraded ? '　←　普通事件无效，已自动改用真实事件' : ''),
      l2note,
      `↪️ 这次操作开了一个**新标签页**，受控标签页已经跟过去了：\n`
      + `   现在在 [${followed.to}] ${followed.url}\n`
      + `   原来那页是 [${followed.from}]，要回去：tabs(action:"select", tabId:${followed.from})\n`
      + `   下面的快照来自新页面。`
      + (followed.how === 'window'
        ? `\n   （判据是「同一个窗口里刚出现的标签页」，不是确凿的父子关系——`
          + `如果用户正好在这几秒里自己开了一个页面，跟错的可能性存在。不对就 select 回去。）`
        : ''),
    ].filter(Boolean).join('\n');
  }
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
  const drift = await driftNote(id, ctx?.sid);
  const r = await performCore(id, cmd, p, {}, ctx);
  // 跟到新标签页了就拍新的那个——拍老的等于把 agent 留在它已经离开的页面上
  const snap = await snapshotAll(r.followed ? r.followed.to : id);
  const head = [drift, effectLines(r)].filter(Boolean).join('\n');
  return { ...snap, text: `${head}\n\n${snap.text}`, navigated: r.navigated || !!r.followed };
}

const HANDLERS = {
  async snapshot(p, tabId, ctx) {
    const id = await resolveTab(tabId);
    const drift = await driftNote(id, ctx?.sid);
    const snap = await guardCreds(id, await snapshotAll(id, p));
    return drift ? { ...snap, text: drift + '\n' + snap.text } : snap;
  },

  async navigate(p, tabId, ctx) {
    const id = await resolveTab(tabId);
    if (p.url) await chrome.tabs.update(id, { url: p.url });
    else await toContent(id, { __hc: 'history', action: p.action || 'reload' });
    // 「DOM 可交互 + 安静下来」，比 load + sleep(300) 又快又准。
    // expectNav：上面那句 tabs.update / history 刚发出去，导航还没提交
    await waitForReady(id, { expectNav: true });
    await markNavigated(id, ctx?.sid);
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
    let id = await resolveTab(tabId);
    const steps = Array.isArray(p.steps) ? p.steps : [];
    if (!steps.length) throw err('INTERNAL', 'steps 不能为空');
    if (steps.length > 20) throw err('INTERNAL', `一次最多 20 步，收到 ${steps.length} 步。拆开调用。`);

    const drift = await driftNote(id, ctx?.sid);
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

        // 开出新标签页是比「页面有没有变」更强的证据，而且后面几步必须打到
        // 新页面上——不换的话，剩下的步骤会全部落在一个已经被丢在身后的页面里
        if (r.followed) {
          id = r.followed.to;
          structureChanged = true;
          done.push(`✅ ${label}　↪️ 开了新标签页 [${r.followed.to}]，后面几步已改在新页面上执行`);
          continue;
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
    const drift = await driftNote(id, ctx?.sid);
    const r = await guardCreds(id, await toContent(id, { __hc: 'read_text', ...p }));
    return drift ? { ...r, text: drift + '\n' + r.text } : r;
  },

  async wait(p, tabId) {
    const id = await resolveTab(tabId);
    return toContent(id, { __hc: 'wait', ...p });
  },

  async query(p, tabId, ctx) {
    const id = await resolveTab(tabId);
    const drift = await driftNote(id, ctx?.sid);
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
      await waitForReady(id, { expectNav: true });
      await sleep(p.settle || 2000); // 等首屏那批 XHR 落地——DOM 就绪不代表数据回来了
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
    const sid = ctx?.sid;
    if (p.action === 'list') {
      const live = liveOf(ctx);
      const [all, mineSlot] = await Promise.all([
        chrome.tabs.query({}),
        chrome.storage.local.get(sid === undefined ? 'activeTabId' : agentTabKey(sid)),
      ]);
      const mine = mineSlot[sid === undefined ? 'activeTabId' : agentTabKey(sid)];
      // 别的会话占着哪些 tab 也标出来——agent 要挑一个安全的页面接手时，
      // 「哪些不能碰」和「哪个是我的」一样重要
      const slots = await chrome.storage.local.get(null);
      const takenBy = new Map();
      for (const [k, v] of Object.entries(slots)) {
        if (!k.startsWith('agentTab:')) continue;
        const owner = k.slice('agentTab:'.length);
        if (owner !== sid && live.has(owner)) takenBy.set(v, owner);
      }
      const lines = all.map((t) => {
        const mark = t.id === mine ? ' *' : takenBy.has(t.id) ? ' ×' : '  ';
        return `[${t.id}]${mark} ${t.title || '(无标题)'} — ${t.url}`;
      });
      return { text: `共 ${all.length} 个标签页（* = 你的受控页，× = 别的会话占着）\n` + lines.join('\n') };
    }
    // active:false —— agent 在后台干活，不把用户从他正在看的页面上拽走。
    // 需要抢焦点的场合（截图、让用户看着操作）由调用方显式传 focus:true。
    if (p.action === 'new') {
      const tab = await chrome.tabs.create({ url: p.url || 'about:blank', active: !!p.focus });
      await setActiveTabId(tab.id);   // 全局槽照旧更新：它是「最近受控 tab」的继承源
      await claimTab(sid, tab.id, ctx);
      if (p.url) await waitForReady(tab.id, { expectNav: true });
      return { text: `已在后台打开标签页 ${tab.id}`, tabId: tab.id };
    }
    // 「受控」和「前台」是两件事：这里只改受控目标，不动用户的视线
    if (p.action === 'select') {
      const id = await resolveTab(p.tabId, sid, ctx);
      const warn = await conflictNote(id, sid, ctx);
      await setActiveTabId(id);
      await claimTab(sid, id, ctx);
      if (p.focus) await chrome.tabs.update(id, { active: true });
      return { text: warn + `受控标签页切到 ${id}` };
    }
    if (p.action === 'close') {
      const id = await resolveTab(p.tabId, sid, ctx);
      const warn = await conflictNote(id, sid, ctx);
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

// alarm 是 SW 被回收之后唯一能把它叫醒的东西，所以**每次 SW 醒来都重建一遍**，
// 不只在 onInstalled / onStartup 里建。
//
// 这条是踩出来的：`chrome.runtime.reload()` 不触发 onInstalled，扩展更新也会
// 清掉已注册的 alarm。以前那套靠 socket 常驻吊着 SW，看不出问题；socket 一搬走，
// 「没 alarm + 没 socket」就等于扩展永久哑掉，而且一声不响。
// create 同名 alarm 是幂等的（覆盖），重复调用没有代价。
chrome.alarms.create('hc-keepalive', { periodInMinutes: 0.5 });
chrome.runtime.onStartup.addListener(() => chrome.alarms.create('hc-keepalive', { periodInMinutes: 0.5 }));
// SW 上一条命里挂着的调试会话，浏览器还替它留着——连同那条黄带子。
// 每次启动扫一遍，否则用户会看到一条永远摘不掉的「已开始调试此浏览器」。
cdp.reapOrphans();
// SW 被回收后靠 alarm 复活。醒来只认一个判据：**现在连上了没有**。
// 没连上就先把 offscreen 扶起来，还不行就自己顶上——这是「装完就自动连上、
// 永远不需要用户手点」的最后一道保险，所以判据必须是连通性本身。
chrome.alarms?.onAlarm.addListener(async () => {
  await ensureOffscreen();
  if (await connected()) return setBadge(true);
  await directConnect();
  setBadge(await connected());
});
chrome.tabs.onRemoved.addListener(async (tabId) => {
  // 全局槽 + 所有会话级槽一次扫清，别留指向死 tab 的槽
  const all = await chrome.storage.local.get(null);
  const dead = Object.keys(all).filter((k) => (k === 'activeTabId' || k.startsWith('agentTab:')) && all[k] === tabId);
  if (dead.length) await chrome.storage.local.remove(dead);
  const sess = await chrome.storage.session.get(null);
  const gone = Object.keys(sess).filter((k) =>
    (k.startsWith('seen:') && k.endsWith(':' + tabId)) || k === frameSnapKey(tabId) || k === childKey(tabId));
  if (gone.length) await chrome.storage.session.remove(gone);
  emit('tab_closed', { tabId });
});

chrome.runtime.onMessage.addListener((m, _s, sendResponse) => {
  // offscreen 递进来的：桥发来的命令/事件。这条消息同时把被回收的 SW 叫醒——
  // 这正是把 socket 搬出去之后，SW 仍然能及时干活的原因。
  if (m?.__hcBridge === 'in') {
    onMessage(m.msg);
    return false;
  }
  // offscreen 真的连上了，把 SW 自己那条兜底 socket 关掉——
  // 两条同时连着的话，桥「同时只认一个扩展」，会互相踢，命令随机丢
  if (m?.__hcBridge === 'up') {
    setBadge(true);
    if (directWs) { stopDirectPing(); try { directWs.close(); } catch { /* 已经废了 */ } directWs = null; }
    return false;
  }
  // offscreen 拿不到 chrome.runtime.getManifest()，握手身份只能由这边供给
  if (m?.__hcBridge === 'identity') {
    sendResponse({ extId: chrome.runtime.id, version: chrome.runtime.getManifest().version });
    return true;
  }
  // 同理，它也够不着 chrome.storage，连接状态托这边落盘
  if (m?.__hcBridge === 'status') {
    chrome.storage.session.set({ bridgeConnected: !!m.connected }).catch(() => {});
    setBadge(!!m.connected);
    return false;
  }

  if (m.__hcPopup === 'status') {
    connected().then((c) => sendResponse({ connected: c }));
    return true;
  }
  if (m.__hcPopup === 'connect') {
    (async () => {
      if (await ensureOffscreen()) await chrome.runtime.sendMessage({ __hcBridge: 'kick' }).catch(() => {});
      if (!(await connected())) await directConnect();
      const c = await connected();
      setBadge(c);
      sendResponse({ connected: c });
    })();
    return true;
  }
  // 用户在 popup 里关掉高保真模式时，先把还挂着的调试会话断干净，
  // 否则权限撤销了，黄条却还留在标签页上，而且再也没人能去摘它
  if (m.__hcPopup === 'detachAll') {
    cdp.reapAll().finally(() => sendResponse({ ok: true }));
    return true;
  }
});

// SW 每次醒来（安装、浏览器启动、alarm 唤醒、offscreen 递消息）都会跑到这里。
// 给 offscreen 一点时间自己连上，它没连上就自己顶。
(async () => {
  await ensureOffscreen();
  await sleep(2000);
  if (!(await connected())) await directConnect();
})();
