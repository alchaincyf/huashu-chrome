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
import { identityOf, stripMarkPrefix } from './identity.js';
import { validateScript, condText, repeatMax, EXEC_BUDGET } from './script.js';

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
      // 加超时：createDocument 万一挂住不 resolve，`ensuring` 永远非空，
      // 每条回执、每次 alarm 自愈都卡在它上面——整个扩展静默瘫痪。
      // 8 秒建不起来就当失败走兜底，下一个 alarm 再试。
      await Promise.race([
        chrome.offscreen.createDocument({
          url: 'offscreen.html',
          reasons: ['WORKERS'],
          justification: '维持与本机桥（127.0.0.1）的长连接；service worker 会被回收，连接会跟着断。',
        }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('createDocument 8 秒没返回')), 8000)),
      ]);
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
  if (directSend(msg)) return;   // offscreen 没建起来，或者它手上那条 socket 断了
  await stash(msg);              // 两条腿都不通：先存着，连上再补发
}

// ---------- 发件箱 ----------
//
// 命令在途时连接断了（睡醒后看门狗互杀、双腿替换、桥换代），回执以前就地丢掉：
// 点击已经在页面上生效，agent 收到的却是 NO_EXTENSION，按提示重试就是双击。
// 现在两条腿都发不出去的回执先写 storage.session（SW 随时被回收，内存不算数），
// 任何一条腿连上就按原样补发；桥那侧对断线的在途命令留了宽限，按 __k 照常配对。
// 只留 60 秒：过了这个时限桥早已把命令判死，补发也没人收。
const OUTBOX = 'outbox';
async function stash(msg) {
  if (msg?.type !== 'res') return;   // 事件丢了无妨，回执不能丢
  try {
    const { [OUTBOX]: list = [] } = await chrome.storage.session.get(OUTBOX);
    list.push({ t: Date.now(), msg });
    await chrome.storage.session.set({ [OUTBOX]: list.slice(-50) });
  } catch { /* 存不下就只能丢 */ }
}
async function flushOutbox(sendFn) {
  let list = [];
  try { ({ [OUTBOX]: list = [] } = await chrome.storage.session.get(OUTBOX)); } catch { return; }
  if (!list.length) return;
  await chrome.storage.session.remove(OUTBOX).catch(() => {});
  const fresh = list.filter((it) => Date.now() - it.t < 60000);
  for (const it of fresh) await sendFn(it.msg);
}

// 判据是**现场问**，不是读缓存。
//
// 上一版读的是 storage.session 里的 bridgeConnected，而那个标志只在 offscreen
// 主动上报时才更新——它被浏览器冻结或回收时根本没机会上报 false，标志就永久
// 卡在 true。于是下面那个每 30 秒的自愈 alarm 每次醒来都判「连着呢」直接返回，
// 一次重连都不发起。8-31 15:46 断开、17:25 用户手动重载扩展才恢复，中间 99
// 分钟就是这么来的：扩展这侧以为自己在线，桥那侧早就把它判死了。
//
// 缓存留着，但只喂 badge 和 popup 的显示，绝不参与「要不要重连」这个判断。
async function connected() {
  return (await connState()).connected;
}

// 给 popup 看的完整状态：连没连、上次收到桥的消息是几点、桥版本几、
// offscreen 建不起来的原因。以前只有一盏灯，用户分不清是扩展断了、桥没起、
// 还是终端根本没在跑。
async function connState() {
  if (directWs?.readyState === 1 && Date.now() - directLastRx <= DIRECT_DEAD_MS) {
    return { connected: true, lastRx: directLastRx, bridge: directBridgeVersion, leg: 'direct' };
  }
  const r = await chrome.runtime.sendMessage({ __hcBridge: 'status' }).catch(() => null);
  return { connected: !!r?.connected, lastRx: r?.lastRx || directLastRx || 0, bridge: r?.bridge || '', leg: 'offscreen', offscreenError: offscreenFailed };
}

// 桥版本对不上时亮角标。npx 原地刷新了扩展文件、Chrome 跑的却还是旧 SW，
// 这种错位以前只有 bridge.log 知道（22 条记录，没人看）。
function noteBridgeVersion(v) {
  if (!v) return;
  const mine = chrome.runtime.getManifest().version;
  bridgeMismatch = v === mine ? '' : v;
  chrome.action.setTitle({ title: bridgeMismatch
    ? `huashu-chrome：扩展 v${mine} 和桥 v${v} 版本不一致，去 chrome://extensions 重载一次`
    : 'huashu-chrome' });
  setBadge(true);
}

// ---------- 兜底：SW 自己拿着 socket ----------
//
// 就是 offscreen 之前的那套。只在 offscreen 建不起来时才启用，两条腿
// 同时连的话桥会看到两个扩展，而它「同时只认一个」，后来者会把前一个踢掉。

const PORTS = [8899, 8900, 8901, 8902, 8903];
const DIRECT_DEAD_MS = 45000;   // 和 offscreen 那条腿同一个判据：三拍没回音就是死了
let directWs = null;
let directTimer = null;
let directLastRx = 0;
let directLastTick = 0;
let directBridgeVersion = '';

// 这个 Chrome 实例的身份证。
//
// 桥靠它区分两件以前分不开的事：「同一个扩展断线重连」该替换掉旧连接，
// 「另一个 Chrome 也装了这份扩展」该并存。分不开的时候桥只能留一个槽，
// 于是主窗口和 agent 起的 headless 实例每秒互相踢一次（8-29 抓到的现场）。
//
// 存在 storage.local：同一个 profile 重启、重载扩展之后都不变，
// 而另起一个 --user-data-dir 的实例必然拿到一个新的。
// 扩展 ID 不能拿来当它用——同一份代码在两个 Chrome 里 ID 是一样的。
let iidCache = null;
async function instanceId() {
  if (iidCache) return iidCache;
  try {
    const { hcInstanceId } = await chrome.storage.local.get('hcInstanceId');
    if (hcInstanceId) return (iidCache = hcInstanceId);
    const fresh = crypto.randomUUID();
    await chrome.storage.local.set({ hcInstanceId: fresh });
    return (iidCache = fresh);
  } catch {
    return null;   // 拿不到就退回桥那侧的老行为（按扩展 id 替换），不阻断连接
  }
}

// headless 实例是 agent 起来抓页面的，没有窗口也没有用户的登录态在用，
// 桥路由命令时要让着有窗口的那个——UA 是唯一稳定的判据。
const isHeadless = () => /HeadlessChrome/.test(navigator.userAgent);

// 发出去了回 true；没连着回 false 并顺手发起重连——调用方据此决定要不要存发件箱
function directSend(msg) {
  if (directWs?.readyState === 1) { directWs.send(JSON.stringify(msg)); return true; }
  directConnect();
  return false;
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
  // 两条腿必须报同一个 instanceId：桥认的是实例不是连接，报岔了
  // 就会被当成两个 Chrome 并存，谁也不替换谁。
  const iid = await instanceId();
  for (const port of PORTS) {
    try {
      directWs = await new Promise((resolve, reject) => {
        const sock = new WebSocket(`ws://127.0.0.1:${port}`);
        const t = setTimeout(() => { sock.close(); reject(new Error('timeout')); }, 1500);
        sock.onopen = () => sock.send(JSON.stringify({
          type: 'hello', role: 'extension', extId: chrome.runtime.id,
          version: chrome.runtime.getManifest().version,
          instanceId: iid, headless: isHeadless(),
          chrome: (navigator.userAgent.match(/Chrome\/([\d.]+)/) || [])[1], v: 1,
        }));
        sock.onmessage = (ev) => {
          const m = JSON.parse(ev.data);
          if (m.type !== 'welcome') { clearTimeout(t); sock.close(); return reject(new Error('rejected')); }
          clearTimeout(t);
          directLastRx = Date.now();
          directBridgeVersion = String(m.bridge || '');
          sock.onmessage = (e) => {
            directLastRx = Date.now();
            const x = JSON.parse(e.data);
            if (x.type === 'pong') return;
            if (x.type === 'ping') { if (sock.readyState === 1) sock.send(JSON.stringify({ type: 'pong' })); return; }
            onMessage(x);
          };
          sock.onclose = () => { directWs = null; stopDirectPing(); setBadge(false); };
          sock.onerror = () => {};
          resolve(sock);
        };
        sock.onerror = () => { clearTimeout(t); reject(new Error('error')); };
      });
      startDirectPing();
      setBadge(true);
      noteBridgeVersion(directBridgeVersion);
      void flushOutbox(async (m) => { if (directWs?.readyState === 1) directWs.send(JSON.stringify(m)); });
      return;
    } catch { /* 换下一个端口 */ }
  }
  setBadge(false);
}

// 兜底腿也要验回音，理由和 offscreen 那条腿完全一样：半开时 readyState
// 照样是 1、send 照样不报错，只发不验的心跳一辈子发现不了。而这条腿是
// 「offscreen 建不起来」时的唯一通路，它哑掉就真的没人在连了。
function startDirectPing() {
  stopDirectPing();
  directLastTick = Date.now();
  directTimer = setInterval(() => {
    const now = Date.now();
    const slept = now - directLastTick > 30000;   // 两拍没跑到 = 机器睡过，墙钟差不作数（同 offscreen）
    directLastTick = now;
    if (directWs?.readyState !== 1) return directConnect();
    if (slept) { directLastRx = now; directWs.send(JSON.stringify({ type: 'ping' })); return; }
    if (now - directLastRx > DIRECT_DEAD_MS) {
      try { directWs.close(); } catch { /* 已经废了 */ }
      directWs = null;
      stopDirectPing();
      setBadge(false);
      return directConnect();
    }
    directWs.send(JSON.stringify({ type: 'ping' }));
  }, 15000);
}
function stopDirectPing() {
  if (directTimer) clearInterval(directTimer);
  directTimer = null;
}

let bridgeMismatch = '';   // 桥版本和扩展对不上时记下桥的版本；角标据此亮「!」

function setBadge(on) {
  if (on && bridgeMismatch) {
    chrome.action.setBadgeText({ text: '!' });
    chrome.action.setBadgeBackgroundColor({ color: '#f59e0b' });
    return;
  }
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
// download 整条链不碰 tab，reload 是扩展级动作，status 是会话级声明
// （它常在第一个 tab 存在之前就被调，走槽解析会平白抛 NO_TAB）
const NO_SLOT_CMDS = new Set(['tabs', 'download', 'reload', 'status']);

async function onMessage(msg) {
  if (msg.type === 'event') return onBridgeEvent(msg);
  if (msg.type !== 'cmd') return;
  try {
    const handler = HANDLERS[msg.cmd];
    if (!handler) throw err('INTERNAL', `未知命令 ${msg.cmd}`);
    // await 而不是 void：标记那一侧只信 storage 里的名单（见 syncMark 上的说明），
    // 这里必须保证「本命令携带的名单已落盘」先于命令完成后的刷新，否则新会话的
    // 第一条命令刷标记时会读到没有自己的旧名单——正是当年那个落盘竞态
    await noteSession(msg.sid, msg.client, msg.live);
    // 缺省 tabId 在这里统一解析成具体 tabId（会话级槽），handler 拿到的永远是实值。
    // ctx 只在本函数内现场传——SW 里两条命令的 await 会交错，绝不能用模块级变量存「当前消息」
    const ctx = { sid: msg.sid, live: msg.live, adopted: false };
    const tabId = NO_SLOT_CMDS.has(msg.cmd) ? msg.tabId : await resolveTab(msg.tabId, msg.sid, ctx);
    // 显式 tabId 也进户口簿——await 而不是 void：命令完成后的 syncMark 从
    // 户口簿反推归属，登记必须先落盘，否则第一条命令刷不出标记（又一个落盘竞态）
    if (tabId && msg.sid && !NO_SLOT_CMDS.has(msg.cmd)) await registerTab(msg.sid, tabId);
    let data = await handler(msg.params || {}, tabId, ctx);
    // 命令跑完才刷标记，不是跑之前：导航会把页面里的 mark.js 冲掉，
    // 提前贴的那一次多半活不到用户看见。act 顺路带上，一次消息两件事。
    // 这里**不带 msg.live**：它是命令出发时的快照。命令在途时用户关掉终端，
    // 桥的 sessions 事件已经摘了标记，快照却还写着「他活着」——用它刷新会把
    // 死会话的标记贴回去，而且再没有任何事件来摘（sessions 只在名单变化时推，
    // 变化已经发生过了）。storage 里的名单永远是最新写入，信它。
    const marked = tabId || data?.tabId;
    if (marked) void syncMark(marked, { sid: msg.sid, act: actText(msg.cmd, msg.params) });
    // 教练搭在回执尾部。await 的代价是一次 storage 读写（约 1ms），
    // 相比它要省下的 6 秒模型回合可以忽略
    const tip = (await coachNote(msg.sid, msg.cmd)) + (await multiLineNote(msg.sid, msg.tabId, msg.cmd, tabId));
    if (tip) {
      if (typeof data === 'string') data += tip;
      else if (data && typeof data.text === 'string') data.text += tip;
    }
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

// ---------- 教练 ----------
//
// 审计实测：一个 219 条命令的真实会话 0 次用 act，98% 的墙钟耗在命令之间的
// 模型回合（中位 5.8s），浏览器执行只占 2%（click 中位 0.2s）。批处理工具
// 一直都在，但 agent 不用——在回执里当面提醒，比任何文档都有效。
// 只提醒、不阻塞、不改变任何结果；agent 用了一次 act 就闭嘴重数。
// 两档：第 3 条提 act；act 提示被无视、单发滚到第 8 条，升级提双脑（能起
// subagent 的宿主才用得上，起不了的忽略——回执是唯一不被 instructions
// 截断的通道，见 test/mcp.test.js 的 STRATEGY 预算注释）。之后归零重数。
const BATCHABLE = new Set(['click', 'type', 'select', 'fill', 'key', 'navigate']);

async function coachNote(sid, cmd) {
  if (!sid) return '';
  const key = `coach:${sid}`;
  try {
    if (cmd === 'act') { await chrome.storage.session.remove(key); return ''; }
    if (!BATCHABLE.has(cmd)) return '';   // 读页面不算——观察和行动的节奏不同
    const { [key]: n = 0 } = await chrome.storage.session.get(key);
    await chrome.storage.session.set({ [key]: n + 1 });
    if (n + 1 === 3) {
      return '\n\n💡 已连续 3 条单发操作。下一步若已可预判，用 act(steps:[…]) 一次跑完：'
        + '每合并一步省一个完整模型回合（实测回合中位约 6 秒，浏览器执行仅 0.2 秒）。'
        + '翻页循环用 repeat、可选弹窗用 if、状态检查用 assert。';
    }
    if (n + 1 === 8) {
      await chrome.storage.session.remove(key);   // 归零重数，别每条都唠叨
      return '\n\n💡 已连续 8 条单发操作。若你的宿主能起 subagent：把这段循环交给一个'
        + '快模型驱动手（带上任务目标和本站 learnings），你只审计划和结果——支付/敏感'
        + '提交、ask 结果、计划变更必须回你裁决。起不了 subagent 就忽略这条。';
    }
  } catch { /* 教练缺席不影响干活 */ }
  return '';
}

// 多线检测：本会话的户口簿上已有 ≥2 个还开着的标签页，这条命令却没带 tabId。
// 缺省槽是**每会话一个**，而 Claude Code 的主 agent 和它派的 subagent 共用同一个
// MCP 连接——扩展眼里是同一个会话，槽也是同一个。任何一方 tabs/navigate 都会
// 把槽改写，另一方下一条缺省命令就落进别人的页面（VFS 那晚的事故路径）。
// 这在扩展侧无解（工具调用不携带 caller 身份），唯一的防线是让 agent 切到
// 显式 tabId——在回执里当面说，比任何文档都有效（同 coachNote 的教训）。
// 10 分钟冷却：多线是持续状态，每条命令都唠叨的提醒很快会被当背景噪音。
async function multiLineNote(sid, explicitTab, cmd, resolved) {
  if (!sid || explicitTab || NO_SLOT_CMDS.has(cmd)) return '';
  try {
    const { [regKey(sid)]: mine = [] } = await chrome.storage.local.get(regKey(sid));
    if (mine.length < 2) return '';
    const key = `multiWarn:${sid}`;
    const { [key]: last = 0 } = await chrome.storage.session.get(key);
    if (Date.now() - last < 600000) return '';
    const open = (await Promise.all(mine.map((t) => chrome.tabs.get(t).catch(() => null)))).filter(Boolean);
    if (open.length < 2) return '';
    await chrome.storage.session.set({ [key]: Date.now() });
    return `\n\n⚠️ 本会话正在 ${open.length} 个标签页上干活，这条命令却没带 tabId——它落在了缺省槽`
      + `当前指向的 [${resolved}]。缺省槽整个会话（含你派的 subagent）共用一个，任何一方`
      + ` tabs/navigate 都会改写它。多线并行时每条命令显式带 tabId；tabs(action:"list") 看各页归属。`;
  } catch { return ''; }
}

// 桥主动推过来的事件。目前只有一件：会话名单变了。
//
// 它必须由桥来推，扩展自己推不出来——`live` 平时是搭着每条命令过来的，
// 而一个会话「结束」的特征恰恰是**再也没有命令过来**。没有这条推送，
// 用户关掉终端窗口之后，那个页面上的标记会一直挂着，直到下一个会话碰巧
// 操作同一个标签页。
function onBridgeEvent(msg) {
  if (msg.event !== 'sessions') return;
  // 先落盘再重算：resyncMarks 里的 ownersOfTab 读的就是 storage 名单
  return noteSession(null, null, msg.live).then(() => resyncMarks());
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

const SLOT_PREFIX = 'agentTab:';
const agentTabKey = (sid) => `${SLOT_PREFIX}${sid}`;
const SLOT_CAP = 32;   // 死会话的槽不主动删（它可能只是断线重连），按 LRU 收口

// 在线会话名单跟着每条命令一起来（见 bridge.js 的 dispatch），不落盘。
// 落盘那版有竞态：新会话连上后立刻发第一条命令，而名单还在路上，
// 第一条命令读到旧名单就判定「没人占」——恰恰漏掉最该拦住的那一条。
const liveOf = (ctx) => new Set(Array.isArray(ctx?.live) ? ctx.live : []);

// 谁占着这个 tab？只算**还连着**的会话——已经结束的会话留下的槽不算数，
// 否则关掉一个 Claude Code 窗口之后，它的标签页就再没人能接手了。
async function liveOwnersOf(tabId, exceptSid, live) {
  const all = await chrome.storage.local.get(null);
  return sidsOnTab(all, tabId).filter((sid) => sid !== exceptSid && live.has(sid));
}

// 记下这个会话的受控 tab，并顺手把最老的槽挤掉
async function claimTab(sid, tabId, ctx) {
  if (!sid) return;
  const key = agentTabKey(sid);
  const { [key]: prev } = await chrome.storage.local.get(key);
  await chrome.storage.local.set({ [key]: tabId, [`slotTouch:${sid}`]: Date.now() });
  await registerTab(sid, tabId);   // 槽页也进户口簿：标记和冲突检测只从户口簿+槽反推
  // 认领的同时就在页面上留痕。不 await：贴标记是给人看的辅助信息，
  // 不该挤进命令的关键路径，慢一拍也没人受损。
  void syncMark(tabId);
  // 换页了就把旧页上的标记摘掉。少了这一句，那个标记会变成**孤儿**：
  // 槽已经指向新页，而「哪些页面上有标记」是靠槽反推的，于是再没有任何
  // 代码路径会找到它——用户看着一个早就没人管的页面，上面挂着别人的名字。
  // 实测就是这么发现的：一个会话换了两次受控页，前两个页面的标记永久留着。
  if (prev && prev !== tabId) void syncMark(prev);
  const all = await chrome.storage.local.get(null);
  const slots = Object.keys(all).filter((k) => k.startsWith('agentTab:')).map((k) => k.slice('agentTab:'.length));
  if (slots.length <= SLOT_CAP) return;
  const live = liveOf(ctx);
  const victims = slots
    .filter((s) => !live.has(s))
    .sort((a, b) => (all[`slotTouch:${a}`] || 0) - (all[`slotTouch:${b}`] || 0))
    .slice(0, slots.length - SLOT_CAP);
  if (victims.length) await chrome.storage.local.remove(victims.flatMap((s) => [agentTabKey(s), `slotTouch:${s}`, `agentGroup:${s}`, regKey(s)]));
}

// ---------- 户口簿 ----------
//
// 槽只回答「缺省 tabId 落到哪」，回答不了「这个会话都在哪些页面上」。
// 多线并行（一个会话开几个页、或父子 agent 显式分页干活）时，显式 tabId
// 驱动的页面从不进槽——而标记、冲突检测以前都从槽反推，于是这些页面全部
// 裸奔：没有光标、没有驾驶舱、没有标签组，别的会话还能把它们「继承」走。
// VFS 那晚的两个症状（subagent 抢槽、显式分页后标记消失）就是这么来的。
//
// 户口簿按会话记「它操作过的所有标签页」。存 local，理由同槽：跨扩展重载
// 不丢，读时靠 live 名单 + onRemoved 清理兜住陈旧条目。
//
// 前缀不能叫 agentTabs:——'agentTabs:x'.startsWith('agentTab:') 为真，
// 会混进所有按 SLOT_PREFIX 扫描的地方。
const REG_PREFIX = 'ownTabs:';
const regKey = (sid) => `${REG_PREFIX}${sid}`;
const REG_CAP = 16;

async function registerTab(sid, tabId) {
  if (!sid || !tabId) return;
  const key = regKey(sid);
  const { [key]: list = [] } = await chrome.storage.local.get(key);
  if (list.includes(tabId)) return;
  await chrome.storage.local.set({ [key]: [...list, tabId].slice(-REG_CAP), [`slotTouch:${sid}`]: Date.now() });
}

// 槽 + 户口簿，站在这个 tab 上的所有会话。调用方自己拿 live 名单过滤。
function sidsOnTab(all, tabId) {
  const out = new Set();
  for (const [k, v] of Object.entries(all)) {
    if (k.startsWith(SLOT_PREFIX) && v === tabId) out.add(k.slice(SLOT_PREFIX.length));
    else if (k.startsWith(REG_PREFIX) && Array.isArray(v) && v.includes(tabId)) out.add(k.slice(REG_PREFIX.length));
  }
  return [...out];
}

// 标签页的 label——agent 开页时声明的「这页是哪条线」（如「陈云飞-签证表」）。
// 按 tab 记不按会话记：页面的用途属于页面，谁来看都该是同一个答案。
// 它同时是 agent 的工作记忆兜底：上下文被压缩后，tabs(action:"list") 一眼重建。
const labelKey = (tabId) => `tabLabel:${tabId}`;
const getLabel = async (tabId) => (await chrome.storage.local.get(labelKey(tabId)))[labelKey(tabId)] || '';

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

// ---------- 控制标记 ----------
//
// 上面那一整套隔离（谁占着哪个 tab、谁不许抢）只对 agent 说话，从来没对人说过。
// 用户面前是一片安静的浏览器：页面上没痕迹、标签栏没痕迹，他随手一点就和
// 某个正在后台干活的会话撞上了。这一节把那份已经算清楚的归属关系画到屏幕上。
//
// 外观是 sid 的纯函数（identity.js），所以它继承了 sid 的稳定性：桥重启、
// 会话断线重连，颜色和 emoji 都不变——用户不会看见一个页面的标记莫名换了色。
//
// 全节唯一的硬规矩：**绝不能让贴标记这件事把命令本身搞失败。**
// 它是辅助信息，页面注不进去、标签页已经关掉、用户把开关关了，
// 都只意味着「这次没画上」，不意味着这条命令出了问题。

const LIVE_SIDS = 'liveSids';                     // storage.session：此刻还连着的会话
const MARKED_TABS = 'markedTabs';                 // storage.session：此刻贴着标记的页
const sidClientKey = (sid) => `sidClient:${sid}`; // storage.session：sid → client 名

const markEnabled = async () => !(await chrome.storage.local.get('markDisabled')).markDisabled;

// 每条命令都带着 sid / client / live 过来，顺手记下来。
// popup 要显示「谁在控哪一页」，而它自己够不着桥。
async function noteSession(sid, client, live) {
  const patch = {};
  if (sid && client) patch[sidClientKey(sid)] = client;
  if (Array.isArray(live)) patch[LIVE_SIDS] = live;
  if (Object.keys(patch).length) await chrome.storage.session.set(patch).catch(() => {});
}

const liveList = async () => (await chrome.storage.session.get(LIVE_SIDS))[LIVE_SIDS] || [];

// 这个标签页此刻的主人们。只算**还连着**的会话——判据和 liveOwnersOf 一致：
// 已结束的会话留下的槽不算数，否则关掉一个终端窗口之后，它的标记会永远挂在那儿。
//
// 名单**只读 storage**，不收调用方传的快照。onMessage 在跑 handler 之前就把
// 本命令携带的名单 await 落盘了，所以 storage 永远不比任何快照旧；反过来，
// 快照可能比 storage 旧——命令在途时用户关终端，sessions 事件已把新名单写进
// storage 并摘了标记，命令完成后的刷新若信快照，会把死会话的标记贴回去，
// 而且再没有任何事件来摘。质控实测抓到的就是这条路。
async function ownersOfTab(tabId) {
  const lives = new Set(await liveList());
  if (!lives.size) return [];
  const all = await chrome.storage.local.get(null);
  const sids = sidsOnTab(all, tabId).filter((sid) => lives.has(sid));
  if (!sids.length) return [];
  const clients = await chrome.storage.session.get(sids.map(sidClientKey));
  return sids.map((sid) => identityOf(sid, clients[sidClientKey(sid)]));
}

// 判据必须是「收到了 mark.js 的回执」，不能是「sendMessage 没报错」：
// 页面里通常已经有 content.js，它对 __hcMark 消息不作应答——这种情况下
// sendMessage 是 resolve(undefined) 而不是 reject 的。按「没报错就算送到」
// 来判，标记会在每一个已注入 content.js 的页面上永远贴不上，且一声不响。
const postMark = (tabId, msg) => chrome.tabs.sendMessage(tabId, msg).then((r) => !!r?.ok).catch(() => false);

// 把某个标签页的标记刷成「现在这个样子」。owners 为空就是摘掉。
//
// 先发后注：稳态下页面里的 mark.js 还在，一次消息往返（约 1ms）就完事；
// 只有导航过、脚本被冲掉时才付一次 executeScript。反过来先探活再发是两次往返，
// 而这个函数跟在每一条命令后面跑。
async function syncMark(tabId, { act, sid, plan } = {}) {
  if (!tabId) return;
  try {
    if (!(await markEnabled())) return;
    const owners = await ownersOfTab(tabId);
    // 标签组跟着同一份归属关系走，但不挤在这条 await 链上：
    // 组画不上（用户正在拖标签页、旧 Chrome 没有 API）不该拖累页内标记。
    void syncGroup(tabId, owners);
    if (act && sid) await pushActLog(sid, act);
    // plan 不落盘、每次 set 都覆盖：批处理一结束它就该消失，
    // 「接下来」栏里挂着永远不会跑的步骤是在骗用户
    const msg = { __hcMark: 'set', owners, act: act || null, sid, plan: plan || null, tabLabel: await getLabel(tabId), ...(await panelData(owners)) };
    await noteMarked(tabId, owners.length > 0);
    if (await postMark(tabId, msg)) return;
    // 没人接消息 = 页面里没有 mark.js。既然这页也没有主，就别为了摘一个
    // 不存在的标记去注入脚本——那是纯粹的浪费，而且会打在每一个普通网页上。
    if (!owners.length) return;
    await chrome.scripting.executeScript({ target: { tabId }, files: ['mark.js'] });
    await postMark(tabId, msg);
  } catch { /* chrome:// 注不进、标签页已关、开关关了——都不是命令的错 */ }
}

// 驾驶舱时间线的原料。存这边而不是页面内存：导航会把页面里的一切冲掉，
// 而「刚刚发生过什么」恰恰要跨导航活着。20 条封顶。内容是 actText 的输出——
// 只有动词和目标，**绝不含用户输入的内容**（这些字会显示在可能正被录屏的页面上）。
const actLogKey = (sid) => `actLog:${sid}`;
const intentKey = (sid) => `intent:${sid}`;

async function pushActLog(sid, text) {
  const key = actLogKey(sid);
  const { [key]: list = [] } = await chrome.storage.session.get(key);
  list.unshift({ t: Date.now(), text: String(text).slice(0, 60) });
  await chrome.storage.session.set({ [key]: list.slice(0, 20) });
}

// 驾驶舱要展示的两样：各会话的时间线，和 agent 用 status 声明的意图。
// 都按 sid 键控——同一页有两个主时，各自的账各自记。
async function panelData(owners) {
  const logs = {}, intents = {};
  if (owners.length) {
    const got = await chrome.storage.session.get(owners.flatMap((o) => [actLogKey(o.sid), intentKey(o.sid)]));
    for (const o of owners) {
      if (got[actLogKey(o.sid)]) logs[o.sid] = got[actLogKey(o.sid)];
      if (got[intentKey(o.sid)]) intents[o.sid] = got[intentKey(o.sid)];
    }
  }
  return { logs, intents };
}

// 「此刻哪些页面上贴着标记」得自己记一笔账，不能靠槽反推。
// 槽会被覆盖：一个会话换了受控页，槽指向新页，旧页上那块标记就再没有任何
// 代码路径找得到它——用户看着一个早就没人管的页面，上面挂着别人的名字。
// 实测撞到过，两个页面的标记永久留在那里。
async function noteMarked(tabId, on) {
  const { [MARKED_TABS]: list = [] } = await chrome.storage.session.get(MARKED_TABS);
  const has = list.includes(tabId);
  if (on === has) return;
  await chrome.storage.session.set({
    [MARKED_TABS]: on ? [...list, tabId].slice(-64) : list.filter((t) => t !== tabId),
  });
}

// ---------- 标签组 ----------
//
// 标签栏是后台干活时用户唯一一直看得见的地方，而标题前缀有个盲区：
// 标签页一多，Chrome 把标题压缩到只剩 favicon，前缀就没了——恰恰是
// 开一堆标签页的重度用户最需要这个信号。标签组的彩色胶囊不受压缩影响，
// 组色与页内标记同源（identity.js），两处信号互相印证。
//
// 两条铁律，都朝「宁可不画，绝不误伤」那一侧偏：
// 1. **绝不碰用户自己的组。** tab 已经在组里而那个组不是我们建的，就当没看见。
// 2. **只动确认还是我们的组。** groupId 记在 storage.local（跨扩展重载不丢），
//    代价是浏览器重启后这个 id 可能被发给别的组。所以动手前先验指纹：
//    组标题必须还是我们写上去的那个 emoji。用户改过组名？那它已经是
//    用户的组了，按铁律 1 处理。指纹会放过「用户恰好建了个同 emoji 的组」，
//    但那种碰撞的后果只是多染一个组，比拆错用户的组轻得多。
const groupKey = (sid) => `agentGroup:${sid}`;

// 组名是品牌字不是彩色圆点 emoji（花叔定的：色块图标丑）。它同时是「这个组
// 是我们建的」的指纹。旧版组名用过身份 emoji，验指纹时兼容一阵子——
// 不兼容的话，升级前建的组会因为指纹对不上而永远摘不掉。
const GROUP_TITLE = '花叔';
const groupTitleOk = (title, sid) => title === GROUP_TITLE || title === identityOf(sid).emoji;

async function syncGroup(tabId, owners) {
  try {
    if (!chrome.tabGroups) return;   // 旧 Chrome 没有这个 API
    const tab = await chrome.tabs.get(tabId);
    const all = await chrome.storage.local.get(null);
    const ours = new Map(Object.entries(all)
      .filter(([k]) => k.startsWith('agentGroup:'))
      .map(([k, v]) => [k.slice('agentGroup:'.length), v]));

    // 这一页没有主：还挂在我们的组里就摘出来。组空了 Chrome 会自己解散它。
    if (!owners.length) {
      if (tab.groupId === -1) return;
      for (const [sid, gid] of ours) {
        if (gid !== tab.groupId) continue;
        const g = await chrome.tabGroups.get(gid).catch(() => null);
        if (g && groupTitleOk(g.title, sid)) await chrome.tabs.ungroup(tabId);
        return;
      }
      return;
    }

    // 多主时跟第一个——组只有一个，双色条纹画不进标签栏；页内边框负责说清「有两个主」
    const o = owners[0];
    const stored = ours.get(o.sid);
    if (tab.groupId !== -1) {
      if (tab.groupId === stored) return;                         // 已经在对的组里
      if (![...ours.values()].includes(tab.groupId)) return;      // 用户的组，不碰
    }
    // 旧组还在、还像我们的、且在同一个窗口 → 归队；否则新建。
    // 跨窗口不归队：group({groupId}) 会把标签页搬进另一个窗口，比不显著更糟。
    let gid = null;
    if (stored !== undefined) {
      const g = await chrome.tabGroups.get(stored).catch(() => null);
      if (g && g.windowId === tab.windowId && groupTitleOk(g.title, o.sid)) gid = stored;
    }
    if (gid !== null) {
      await chrome.tabs.group({ tabIds: tabId, groupId: gid });
    } else {
      gid = await chrome.tabs.group({ tabIds: tabId });
      await chrome.tabGroups.update(gid, { title: GROUP_TITLE, color: o.group });
      await chrome.storage.local.set({ [groupKey(o.sid)]: gid });
    }
  } catch { /* 标签页正被拖动/已关、API 不可用——都不是命令的错 */ }
}

// 会话名单变了（有人下线），所有可能带着标记的标签页都得重算一遍。
// 不能只看「还活着的会话占的页」——恰恰是**刚死掉那个**占的页需要被摘。
// 两个来源取并集：槽（可能指向还没来得及贴标记的新页）和记账（可能有孤儿）。
async function resyncMarks() {
  try {
    const [all, sess] = await Promise.all([
      chrome.storage.local.get(null),
      chrome.storage.session.get(MARKED_TABS),
    ]);
    const tabs = new Set(Object.entries(all).filter(([k]) => k.startsWith(SLOT_PREFIX)).map(([, v]) => v));
    for (const [k, v] of Object.entries(all)) {
      if (k.startsWith(REG_PREFIX) && Array.isArray(v)) for (const t of v) tabs.add(t);
    }
    for (const t of sess[MARKED_TABS] || []) tabs.add(t);
    for (const tabId of tabs) await syncMark(tabId);
  } catch { /* 同上 */ }
}

// 胶囊上打出「它刚刚做了什么」。常驻的淡边框回答「有没有主」，这一行回答
// 「此刻在动」——两个问题都要有答案，否则用户看着一个静止的页面无从判断。
//
// 只说动词和目标 ref，**绝不带用户输入的内容**：type / fill 的值可能是密码或
// 私信正文，而这行字会显示在一个用户可能正在录屏或投屏的页面上。
function actText(cmd, p = {}) {
  const ref = p.ref || p.selector || '';
  switch (cmd) {
    case 'navigate': return `打开 ${hostOf(p.url) || '页面'}`;
    case 'click': return `点击 ${ref}`;
    case 'type': return `输入 ${ref}`;
    case 'fill': return '填写表单';
    case 'select': return `选择 ${ref}`;
    case 'key': return `按键 ${p.key || ''}`;
    case 'scroll': return '滚动';
    case 'snapshot': return '读取页面';
    case 'read_text': return '读取正文';
    case 'query': return '查询元素';
    case 'screenshot': return '截图';
    case 'network': return '看网络请求';
    case 'fetch': return '调接口';
    case 'download': return '下载';
    case 'upload': return '上传文件';
    case 'eval': return '执行脚本';
    case 'wait': return '等待';
    case 'ask': return '请用户搭把手';
    // act 的每一步在批处理循环里单独同步过了（带「第 i/n 步」），
    // 批量结束后再记一条汇总只是时间线上的噪音
    case 'act': return '';
    default: return cmd;
  }
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
//
// 有证据之后**不在第一拍就走**。框架的 hover/active/ripple class 常常先于异步
// 请求落地——第一拍拍到「目标 class 变了」就返回，回来的快照是旧页面，agent
// 只能再拍一次或写 eval 去核实（审计里 click→eval 109 次、snapshot→snapshot
// 588 次，相当一部分是这么来的）。所以等证据集合连续两拍不再变化再返回：
// 快页面多付 100ms，慢页面拿到的是落定后的样子。上限仍是 SETTLE_MS。
//
// 带 expect 时判据换成「期望满足了没有」：满足立刻返回（最强的证据），
// 到点没满足就把现场写进 expectUnmet——「变没变」和「变成我要的样子没有」
// 终于是两个问题了。
async function settle(id, frameId, params, baseline, beforeUrl) {
  const deadline = Date.now() + SETTLE_MS;
  let last = { changed: false, parts: [] };
  let prevKey = null;
  const expect = params.expect && typeof params.expect === 'object' ? params.expect : null;
  let verdict = null;
  while (Date.now() < deadline) {
    await sleep(100);
    const url = (await chrome.tabs.get(id)).url;
    // 跳转是最强的证据，而且此时旧 baseline 已经没有意义，立刻返回
    if (url !== beforeUrl) return { changed: true, navigated: true, parts: [`已跳转到 ${url}`] };
    try {
      last = await toContent(id, { __hc: 'effect', baseline, ref: params.ref, selector: params.selector, find: params.find }, frameId);
      if (expect) {
        verdict = await toContent(id, { __hc: 'expect', expect, ref: params.ref, selector: params.selector, find: params.find }, frameId);
        if (verdict?.ok) return { ...last, changed: true, parts: [...(last.parts || []), `期望已满足：${verdict.text}`] };
        continue;   // 有期望就等期望，不按「证据稳定」早停
      }
    } catch {
      /* 页面正在换页时 content script 会短暂不在，下一轮再问 */
      continue;
    }
    if (!last.changed) continue;
    // 只有「目标 class 变了」这一条时再多等一会儿（到 500ms）：它几乎总是
    // 动画/激活态，真正的结果多半还在路上。别的强证据两拍稳定就走。
    const classOnly = last.parts.length === 1 && last.parts[0] === '目标 class 变了';
    if (classOnly && Date.now() < deadline - SETTLE_MS + 500) { prevKey = null; continue; }
    const key = last.parts.join('|');
    if (key === prevKey) return last;
    prevKey = key;
  }
  if (expect) last = { ...last, expectUnmet: verdict?.text || condOf(expect) };
  return last;
}

const condOf = (e) => Object.entries(e || {}).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ');

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

// act 剧本的单发条件判定。词汇和 watchUntil / ask 的 until 完全一致
// （urlContains / selectorExists / textContains，多字段取或），外加 not 取反。
// 页面正在跳转时按「未命中」处理——repeat 的下一轮会再问一次。
async function evalCond(tabId, cond) {
  if (!cond || typeof cond !== 'object') return true;
  let hit = false;
  try {
    // 单元素判据 {ref|selector, checked|value|text}：走 content 的 expect，那边认得 refMap
    if ((cond.ref || cond.selector) && ('checked' in cond || 'value' in cond || 'text' in cond)) {
      const { ref, selector, not, ...expect } = cond;
      const v = await toContent(tabId, { __hc: 'expect', expect, ref, selector }).catch(() => null);
      hit = !!v?.ok;
      return cond.not ? !hit : hit;
    }
    if (cond.urlContains) hit = ((await chrome.tabs.get(tabId)).url || '').includes(cond.urlContains);
    if (!hit && (cond.selectorExists || cond.textContains)) {
      const [{ result } = {}] = await chrome.scripting.executeScript({
        target: { tabId },
        func: (sel, txt) => (sel ? !!document.querySelector(sel) : false)
          || (txt ? (document.body?.innerText || '').includes(txt) : false),
        args: [cond.selectorExists || '', cond.textContains || ''],
      });
      hit = !!result;
    }
  } catch { hit = false; }
  return cond.not ? !hit : hit;
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
  await chrome.scripting.executeScript({ target: { tabId: id }, files: ['mark.js'] });

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

  // 坐标点击 / 拖拽：canvas、地图、游戏这类站快照里什么都没有，agent 只能靠截图看，
  // 而看到了也没有任何一条路能点到那个位置（审计里 287 次截图集中在这类站）。
  // 走真实事件，不做元素定位，效果证据只有全局那几样；支付闸门在这里管不着——
  // 坐标点不到「按钮文案」，这条路的安全边界是它本来就要求显式给坐标。
  if (cmd === 'click' && !hasTarget && Number.isFinite(params.x) && Number.isFinite(params.y)) {
    const base = await toContent(id, { __hc: 'locate', baselineOnly: true }, frameId).catch(() => null);
    const x = Number(params.x), y = Number(params.y);
    let note;
    if (params.dragTo && Number.isFinite(params.dragTo.x) && Number.isFinite(params.dragTo.y)) {
      await cdp.drag(id, x, y, Number(params.dragTo.x), Number(params.dragTo.y));
      note = `已从 (${x}, ${y}) 拖到 (${params.dragTo.x}, ${params.dragTo.y})（真实事件）`;
    } else {
      await cdp.click(id, x, y);
      note = `已点击坐标 (${x}, ${y})（真实事件）`;
    }
    const ev = await settle(id, frameId, { ...params, ref: undefined }, base?.baseline, before);
    const after = (await chrome.tabs.get(id)).url;
    return { note, l2note: '', ev, navigated: before !== after, upgraded: false };
  }
  const loc = await toContent(id,
    // fields 要带过去：fill 没有单一目标，它的效果证据靠逐个字段的状态，
    // 不然填表这条最高频的路上永远报「页面没有反应」。
    // forCmd 给虚拟光标定动画（点击是涟漪、输入是脉动），不参与定位本身
    hasTarget ? { __hc: 'locate', forCmd: cmd, ...params } : { __hc: 'locate', baselineOnly: true, fields: params.fields },
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
  if (st.do === 'repeat') return `repeat ×≤${repeatMax(st)}${st.until ? ` until ${condText(st.until)}` : ''}（${(st.steps || []).length} 子步）`;
  if (st.do === 'if') return `if ${condText(st.cond)}`;
  if (st.do === 'assert') return `assert ${condText(st.cond)}`;
  const t = st.find
    ? `${st.find.role ? st.find.role + ' ' : ''}「${st.find.name || st.find.selector || ''}」`
    : st.ref ? `[${st.ref}]`
    : st.selector ? `(${st.selector})`
    : st.contains ? `含「${String(st.contains).slice(0, 30)}」`
    : '';
  const extra = st.do === 'read' ? (st.attr ? ` @${st.attr}` : '')
    : st.text !== undefined ? ` ←${String(st.text).length}字`
    : st.value !== undefined ? ` ←"${st.value}"`
    : st.check !== undefined ? (st.check ? ' 勾选' : ' 取消勾选')
    : st.key !== undefined ? ` ${[].concat(st.key).join('+')}`
    : st.url ? ` ${st.url}`
    : st.value === undefined && st.for ? ` ${st.for} ${st.value || ''}`
    : '';
  return `${st.do || '?'} ${t}${extra}`.trim();
}

// describeStep 的驾驶舱版本：只说动词和目标。value 原文换成「选项」、URL 只留
// 域名——这些字会显示在页面上并进时间线，而页面可能正被录屏或投屏。
// describeStep 本身不动：agent 的回执要的就是完整细节。
function panelStep(st) {
  // 控制块在驾驶舱上只报类型，不报条件细节——condText 可能引用页面文本
  if (st.do === 'repeat') return `循环（≤${repeatMax(st)} 轮）`;
  if (st.do === 'if') return '条件分支';
  if (st.do === 'assert') return '检查页面状态';
  if (st.do === 'read') return '读取页面';
  const t = st.find
    ? `「${st.find.name || st.find.selector || ''}」`
    : st.ref ? `[${st.ref}]`
    : st.selector ? `(${st.selector})`
    : '';
  const extra = st.text !== undefined ? ` ←${String(st.text).length}字`
    : st.value !== undefined ? ' ←选项'
    : st.check !== undefined ? (st.check ? ' 勾选' : ' 取消勾选')
    : st.key !== undefined ? ` ${[].concat(st.key).join('+')}`
    : st.url ? ` ${hostOf(st.url) || ''}`
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
    ev.expectUnmet ? `⚠️ 期望未满足（等了 ${SETTLE_MS / 1000}s）：${ev.expectUnmet}。别按「成功」往下走。` : '',
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
    // 先等页面安静一小会儿再拍。以前直接拍，骨架屏/loading 态照拍不误，
    // agent 拿到一份「什么都还没有」的快照只能再拍一次当轮询用
    //（审计里同一 tab 连拍两次 588 回）。150ms 的静默窗口换掉那一整个回合。
    await toContent(id, { __hc: 'ready', quiet: 150, budget: 800 }).catch(() => {});
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
    // 剧本静态校验：嵌套控制块、repeat 里用 ref 这类注定失败的形状，
    // 在动第一根手指之前拦下来——错误落在真实页面上的调试成本高得多
    const bad = validateScript(steps);
    if (bad) throw err('INTERNAL', bad);

    const drift = await driftNote(id, ctx?.sid);
    const done = [];
    let stopped = null;       // { label, why, i? } 一旦置上，整个剧本停机
    // 页面结构一旦变过，之前那份快照里的 ref 全部作废——只有 find 还能用
    let structureChanged = false;
    let executed = 0;         // 实际执行的原子步数。repeat 展开后可能远超 20，
                              // EXEC_BUDGET 是防失控循环的硬闸

    // 执行一个原子步。结果全走闭包：done/out 收回执、stopped 收停机原因、
    // id 跟着新开的标签页走、structureChanged 决定 ref 还能不能信。
    // progress 是驾驶舱「正在做」的前缀，plan 是「接下来」（panelStep 版，
    // 不带用户输入内容——可能正被录屏）。
    const execStep = async (st, progress, plan, out = done) => {
      const { do: cmd, ...rest } = st;
      const label = describeStep(st);
      if (!cmd) { stopped = { label, why: '这一步没写 do' }; return; }
      if (++executed > EXEC_BUDGET) {
        stopped = { label, why: `超出单次 act 的 ${EXEC_BUDGET} 步执行预算（repeat 展开后）。拆成多次调用。` };
        return;
      }
      // 不 await：呈现是给人看的辅助信息，绝不挤进步与步之间的关键路径
      void syncMark(id, { sid: ctx?.sid, act: `${progress} · ${panelStep(st)}`, plan });
      if (structureChanged && rest.ref && !rest.find) {
        stopped = {
          label,
          why: `页面结构在上一步之后变了，快照里的 ref 已经全部作废。`
            + `这一步用的是 ref="${rest.ref}"，换成 find（按 role + 名字定位）就能继续。`,
        };
        return;
      }
      try {
        if (cmd === 'wait') {
          const r = await toContent(id, { __hc: 'wait', ...rest });
          out.push(`✅ ${label}　${r?.text || ''}`);
          return;
        }
        if (cmd === 'navigate') {
          await HANDLERS.navigate(rest, id, ctx);
          structureChanged = true;
          out.push(`✅ ${label}`);
          return;
        }
        if (cmd === 'scroll') {
          const r = await toContent(id, { __hc: 'scroll', ...rest });
          out.push(`✅ ${label}　${(r?.text || '').split('\n')[0]}`);
          return;
        }
        // 观察步：批处理以前只能「做」不能「看」，中途想读一眼就得回模型一趟，
        // 而那正是 act 要省掉的东西。读到的内容原样进回执。
        if (cmd === 'read') {
          const r = await toContent(id, { __hc: 'read', ...rest });
          out.push(`📖 ${label}\n     ${String(r?.text || '').split('\n').join('\n     ')}`);
          return;
        }

        const r = await performCore(id, cmd, { ...rest, snapshotId: p.snapshotId },
          { blockSensitive: !p.allowSensitive }, ctx);

        if (r.blocked) {
          stopped = {
            label,
            why: '这是提交/支付/删除一类的动作，批处理不代做——一串动作里夹一个它，'
              + '跑完了中间没有任何人看得见。单独调用一次 click 把它做掉，'
              + '那样你会看到它自己的效果证据。',
          };
          return;
        }
        // 开出新标签页是比「页面有没有变」更强的证据，而且后面几步必须打到
        // 新页面上——不换的话，剩下的步骤会全部落在一个已经被丢在身后的页面里
        if (r.followed) {
          id = r.followed.to;
          structureChanged = true;
          out.push(`✅ ${label}　↪️ 开了新标签页 [${r.followed.to}]，后面几步已改在新页面上执行`);
          return;
        }
        if (r.ev.expectUnmet) {
          stopped = { label, why: `期望未满足：${r.ev.expectUnmet}。页面没变成这一步预期的样子，后面的步骤不该跑。` };
          return;
        }
        if (!r.ev.changed) {
          stopped = {
            label,
            why: `这一步没有让页面产生任何可归因的变化，后面的步骤多半建立在错误的前提上，`
              + `所以停在这里。${r.l2note || ''}`,
          };
          return;
        }
        out.push(`✅ ${label}　效果：${r.ev.parts.join('；')}`);
        // 只有「结构性」变化才作废 ref：填个值、勾个框不影响编号，
        // 而连续填表正是批处理最常见的用法，不该逼它们全用 find。
        // 区块里多了三五个节点也不算——那是 ripple、下拉箭头、校验图标这类
        // 小动静，以前一律当结构变化，一次点击动画就让整份 ref 剧本半途报废，
        // agent 只好退回逐条调用。ref 本身有 resolve 的名字比对兜底，
        // 真被换掉的元素照样会被拦住。
        if (r.navigated || r.ev.parts.some((s) => /顶层|跳转|移除/.test(s) || (/区块 DOM [+-](\d+)/.exec(s)?.[1] | 0) >= 10)) {
          structureChanged = true;
        }
      } catch (e) {
        stopped = { label, why: `[${e.code || 'INTERNAL'}] ${e.message}` };
      }
    };

    const runLinear = async (list, progress, plan, out) => {
      for (const st of list) {
        if (stopped) return;
        await execStep(st, progress, plan, out);
      }
    };

    let doneTop = 0;   // 顶层完成到第几步，给「还剩 N 步」和 doneCount 用
    for (let i = 0; i < steps.length && !stopped; i++) {
      const st = steps[i] || {};
      const progress = `第${i + 1}/${steps.length}步`;
      const remaining = steps.slice(i + 1).map(panelStep);

      if (st.do === 'assert') {
        // 中途护栏：页面不在剧本预期的状态上，就不该在错误前提上继续跑
        if (await evalCond(id, st.cond)) done.push(`✅ 断言成立：${condText(st.cond)}`);
        else stopped = { label: describeStep(st), why: `断言不成立：${condText(st.cond)}。页面不在这个剧本预期的状态上，后面的步骤不该跑。` };
      } else if (st.do === 'if') {
        const hit = await evalCond(id, st.cond);
        const branch = hit ? st.then : (st.else || []);
        done.push(hit
          ? `↳ 条件成立（${condText(st.cond)}），走 then ${st.then.length} 步`
          : `↷ 条件不成立（${condText(st.cond)}），${st.else?.length ? `走 else ${st.else.length} 步` : '跳过'}`);
        await runLinear(branch, progress, remaining, done);
      } else if (st.do === 'repeat') {
        const max = repeatMax(st);
        let hit = false, k = 0;
        while (k < max && !stopped) {
          k++;
          const round = [];
          await runLinear(st.steps, `${progress}·第${k}轮`, remaining, round);
          // 第一轮完整展开（agent 要看到模式跑通了），后面每轮压成一行——
          // 25 轮 × 3 步全展开是 75 行回执，会把真正重要的信息淹掉。
          // 中途停机的那一轮也完整展开：停在哪一步、前几步做了什么都要可见。
          if (k === 1 || stopped) done.push(...round.map((l) => `　${k}轮 ${l}`));
          else done.push(`　🔁 第${k}轮 ✅${round.length}步`);
          if (stopped) break;
          if (st.until) { hit = await evalCond(id, st.until); if (hit) break; }
        }
        if (!stopped) {
          // until 声明的是「循环应该达到的状态」。跑满 max 仍未达到 = 剧本的
          // 预期和页面不符，按停机处理——这和「零效果就停」是同一个哲学
          if (st.until && !hit) stopped = { label: describeStep(st), why: `repeat 跑满 ${max} 轮，until 条件（${condText(st.until)}）仍未命中。剧本的预期和页面不符，停在这里。` };
          else done.push(st.until ? `🔁 循环结束：第 ${k} 轮后命中 ${condText(st.until)}` : `🔁 已按 max 跑满 ${max} 轮`);
        }
      } else {
        await execStep(st, progress, remaining);
      }
      if (!stopped) doneTop = i + 1;
      else if (stopped.i === undefined) stopped.i = i;
    }

    const snap = await snapshotAll(id);
    const total = steps.length;
    const head = [
      drift,
      `act ${stopped ? `停在第 ${stopped.i + 1} 步` : '完成'}（顶层 ${doneTop}/${total}，实际执行 ${executed} 个动作）：`,
      ...done.map((d) => '  ' + d),
      stopped ? `  ⏸ ${stopped.label}\n     ${stopped.why}` : '',
      stopped && stopped.i + 1 < total
        ? `  还剩 ${total - stopped.i - 1} 步没做：${steps.slice(stopped.i + 1).map(describeStep).join('、')}`
        : '',
    ].filter(Boolean).join('\n');

    return { ...snap, text: `${head}\n\n${snap.text}`, completed: !stopped, doneCount: doneTop };
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

  // 滚完顺手拍一份：视口一动，快照收的元素集合就变了，agent 下一步几乎必然
  // 要重拍——省它一个回合
  async scroll(p, tabId) {
    const id = await resolveTab(tabId);
    const r = await toContent(id, { __hc: 'scroll', ...p });
    const snap = await snapshotAll(id).catch(() => null);
    return snap ? { ...snap, text: `${r?.text || ''}\n\n${snap.text}` } : r;
  },

  // 读一个元素的状态/文本，或按文本找元素。给 act 的 read 步用；也可单独调
  async read(p, tabId) {
    const id = await resolveTab(tabId);
    return (await toFrame(id, 'read', p)).data;
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
    // 幕帘：先把我们画的一切（光标、边框、驾驶舱、ask）藏起来再拍。
    // 不藏的话 agent 会在自己的截图里看到一个页面上并不存在的发光箭头，
    // 把它当页面元素去理解甚至去点。应答回来时样式已生效：两条截图路径
    // 都在 ack 之后才合成新帧。页面里没有 mark.js 时 veil 返回 false——
    // 幕帘失败绝不能弄失败截图本身。
    const veiled = await veilMarks(id, true);
    try {
      return await cdp.screenshot(id, { full: !!p.full });
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
      // 等一帧再抓：captureVisibleTab 拿的是合成器当前帧，幕帘的 visibility
      // 刚设完可能还没画上去。60ms > 一个 60Hz 帧周期，页面进程的 rAF 这边够不着，
      // 用固定等待兜住（tab 不在前台的分支上面已经 sleep(250)，这里覆盖的是
      // 「本来就在前台」那条最短路径）。
      if (veiled) await sleep(60);
      // 这条老路缩不了尺寸，至少换成 JPEG 省一截
      return p.full
        ? { dataUrl: await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' }), scale: 1 }
        : { dataUrl: await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 80 }), scale: 1 };
    } finally {
      if (veiled) void veilMarks(id, false);
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
      const taken = new Set();       // 别的在线会话（槽或户口簿）站着的页
      const mineToo = new Set();     // 本会话户口簿里的页（缺省槽之外的工作线）
      for (const t of all) {
        for (const owner of sidsOnTab(slots, t.id)) {
          if (owner === sid) mineToo.add(t.id);
          else if (live.has(owner)) taken.add(t.id);
        }
      }
      const lines = all.map((t) => {
        const mark = t.id === mine ? ' *' : taken.has(t.id) ? ' ×' : mineToo.has(t.id) ? ' +' : '  ';
        const lb = slots[labelKey(t.id)];
        return `[${t.id}]${mark}${lb ? `「${lb}」` : ''} ${t.title || '(无标题)'} — ${t.url}`;
      });
      return { text: `共 ${all.length} 个标签页（* = 你的缺省槽，+ = 你的另一条工作线，× = 别的会话在用；「」= 开页时声明的 label）\n` + lines.join('\n') };
    }
    // active:false —— agent 在后台干活，不把用户从他正在看的页面上拽走。
    // 需要抢焦点的场合（截图、让用户看着操作）由调用方显式传 focus:true。
    if (p.action === 'new') {
      const tab = await chrome.tabs.create({ url: p.url || 'about:blank', active: !!p.focus });
      const label = String(p.label || '').slice(0, 40);
      if (label) await chrome.storage.local.set({ [labelKey(tab.id)]: label });
      await setActiveTabId(tab.id);   // 全局槽照旧更新：它是「最近受控 tab」的继承源
      await claimTab(sid, tab.id, ctx);
      if (p.url) await waitForReady(tab.id, { expectNav: true });
      // 出生证：tabId 必须被 agent 转述进对话才能活过上下文压缩，
      // 回执里把「该记什么、怎么找回」一次说全
      return {
        text: `已在后台打开标签页 [${tab.id}]${label ? `「${label}」` : ''}。多线并行（含 subagent）时，`
          + `后续命令显式带 tabId:${tab.id}`
          + (label ? '' : '；建议开页时带 label:"这页是哪条线"，忘了哪页是哪线时 tabs(action:"list") 能找回')
          + '。',
        tabId: tab.id,
      };
    }
    // 「受控」和「前台」是两件事：这里只改受控目标，不动用户的视线
    if (p.action === 'select') {
      const id = await resolveTab(p.tabId, sid, ctx);
      const warn = await conflictNote(id, sid, ctx);
      const label = String(p.label || '').slice(0, 40);
      if (label) await chrome.storage.local.set({ [labelKey(id)]: label });
      await setActiveTabId(id);
      await claimTab(sid, id, ctx);
      if (p.focus) await chrome.tabs.update(id, { active: true });
      return { text: warn + `受控标签页切到 [${id}]${label ? `「${label}」` : ''}` };
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

    // ask 的浮条并进了 mark.js（统一呈现层），协议没变，只是换了宿主文件
    await chrome.scripting.executeScript({ target: { tabId: id }, files: ['mark.js'] });
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

  // agent 的一句话意图声明，进驾驶舱的「准备做」一栏。fire-and-forget：
  // 立刻回 ok，呈现走 syncMark 的旁路——这个工具的全部成本必须接近零，
  // 否则 agent 会因为「多一次往返」而干脆不用它。
  //
  // 文案是 agent 写的（可能源自被注入的页面）。这里只截长度，页面那侧
  // 一律 textContent 呈现且和扩展观察到的事实分区——见 mark.js 的 intent 区。
  async status(p, _tabId, ctx) {
    const text = String(p.text || '').trim().slice(0, 80);
    const sid = ctx?.sid;
    if (sid && text) {
      await chrome.storage.session.set({ [intentKey(sid)]: { text, t: Date.now() } });
      const { [agentTabKey(sid)]: tab } = await chrome.storage.local.get(agentTabKey(sid));
      if (tab) void syncMark(tab, { sid });
    }
    return { text: 'ok' };
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

// 截图幕帘的开合。判据和 postMark 一样认回执——sendMessage 对没有监听者的
// 页面 resolve(undefined) 而不是 reject，「没报错」不等于「藏好了」。
const veilMarks = (tabId, on) =>
  chrome.tabs.sendMessage(tabId, { __hcMark: 'stealth', on }).then((r) => !!r?.ok).catch(() => false);

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
  // 先让 offscreen 那条腿尽力——kick 会等它把五个端口探完再回话。
  // 不等就直接自己顶上的话，两条腿会同时往桥上连，而桥只认一个、后来者
  // 把前一个踢掉、被踢的立刻重连再踢回去，就是 8-29 抓到的每秒互相挤兑。
  // 但也只让它这一次：「文档建起来了却连不上」是踩过的死局，
  // 判据永远是连上了没有，不是文档在不在。
  const kicked = await chrome.runtime.sendMessage({ __hcBridge: 'kick' }).catch(() => null);
  if (kicked?.connected) return setBadge(true);
  await directConnect();
  setBadge(await connected());
});
chrome.tabs.onRemoved.addListener(async (tabId) => {
  // 全局槽 + 所有会话级槽一次扫清，别留指向死 tab 的槽
  const all = await chrome.storage.local.get(null);
  const dead = Object.keys(all).filter((k) => (k === 'activeTabId' || k.startsWith('agentTab:')) && all[k] === tabId);
  if (all[labelKey(tabId)] !== undefined) dead.push(labelKey(tabId));
  if (dead.length) await chrome.storage.local.remove(dead);
  // 户口簿是数组，摘条目而不是删键
  const shrunk = {};
  for (const [k, v] of Object.entries(all)) {
    if (k.startsWith(REG_PREFIX) && Array.isArray(v) && v.includes(tabId)) shrunk[k] = v.filter((t) => t !== tabId);
  }
  if (Object.keys(shrunk).length) await chrome.storage.local.set(shrunk);
  const sess = await chrome.storage.session.get(null);
  const gone = Object.keys(sess).filter((k) =>
    (k.startsWith('seen:') && k.endsWith(':' + tabId)) || k === frameSnapKey(tabId) || k === childKey(tabId));
  if (gone.length) await chrome.storage.session.remove(gone);
  await noteMarked(tabId, false);
  emit('tab_closed', { tabId });
});

// 页面自己跳走了（agent 点了个链接、站点自动重定向），页面里的 mark.js
// 跟着没了。只靠命令后那次刷新的话，标记会在「跳转完成」到「下一条命令」
// 之间消失——而那段空窗恰好是用户最可能切过来看一眼的时候。
//
// 这个监听器对浏览器里每一个标签页的每一次加载都会响，所以 syncMark 的
// 第一件事是查 liveSids：没有会话在线时它一次 storage.get 就返回了。
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'complete') void syncMark(tabId);
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
    noteBridgeVersion(m.bridge);
    if (directWs) { stopDirectPing(); try { directWs.close(); } catch { /* 已经废了 */ } directWs = null; }
    // 断线期间攒下的回执，连上就补发——桥那侧留着宽限等它们
    void flushOutbox((msg) => chrome.runtime.sendMessage({ __hcBridge: 'out', msg }).catch(() => null));
    return false;
  }
  // offscreen 拿不到 chrome.runtime.getManifest()，握手身份只能由这边供给
  if (m?.__hcBridge === 'identity') {
    instanceId().then((iid) => sendResponse({
      extId: chrome.runtime.id,
      version: chrome.runtime.getManifest().version,
      instanceId: iid,
      headless: isHeadless(),
    }));
    return true;   // 异步回答，通道要留着
  }
  // 同理，它也够不着 chrome.storage，连接状态托这边落盘
  if (m?.__hcBridge === 'status') {
    chrome.storage.session.set({ bridgeConnected: !!m.connected }).catch(() => {});
    setBadge(!!m.connected);
    return false;
  }

  if (m.__hcPopup === 'status') {
    connState().then(sendResponse);
    return true;
  }
  if (m.__hcPopup === 'connect') {
    (async () => {
      if (await ensureOffscreen()) await chrome.runtime.sendMessage({ __hcBridge: 'kick' }).catch(() => {});
      if (!(await connected())) await directConnect();
      const s = await connState();
      setBadge(s.connected);
      sendResponse(s);
    })();
    return true;
  }
  // 用户在 popup 里关掉高保真模式时，先把还挂着的调试会话断干净，
  // 否则权限撤销了，黄条却还留在标签页上，而且再也没人能去摘它
  if (m.__hcPopup === 'detachAll') {
    cdp.reapAll().finally(() => sendResponse({ ok: true }));
    return true;
  }
  // popup 的会话列表：谁、在控哪一页。数据全在扩展这一侧（槽 + live 名单），
  // popup 够不着桥，所以由这儿组装。
  if (m.__hcPopup === 'sessions') {
    (async () => {
      try {
        const [all, lives] = await Promise.all([chrome.storage.local.get(null), liveList()]);
        const clients = await chrome.storage.session.get(lives.map(sidClientKey));
        const rows = [];
        for (const sid of lives) {
          const tabId = all[agentTabKey(sid)];
          let title = '';
          // 标题里的 emoji 前缀是我们自己加的，这一行左边已经有色点了，
          // 再带一次只是噪音
          if (tabId) title = await chrome.tabs.get(tabId).then((t) => stripMarkPrefix(t.title) || t.url || '').catch(() => '');
          rows.push({ ...identityOf(sid, clients[sidClientKey(sid)]), tabId: title ? tabId : null, title });
        }
        sendResponse({ sessions: rows, enabled: await markEnabled() });
      } catch {
        sendResponse({ sessions: [], enabled: true });
      }
    })();
    return true;
  }
  // 开关拨过之后要立刻见效：关掉时把已经贴出去的标记全摘干净，
  // 否则用户会看到一个「已关闭」的开关配着满屏还在的标记。
  if (m.__hcPopup === 'markSync') {
    (async () => {
      if (await markEnabled()) await resyncMarks();
      else {
        const { [MARKED_TABS]: list = [] } = await chrome.storage.session.get(MARKED_TABS);
        // 组和页内标记同开同关：开关拨到关，两种痕迹都得立刻消失
        for (const tabId of list) { await postMark(tabId, { __hcMark: 'clear' }); await syncGroup(tabId, []); }
        await chrome.storage.session.set({ [MARKED_TABS]: [] });
      }
      sendResponse({ ok: true });
    })();
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
