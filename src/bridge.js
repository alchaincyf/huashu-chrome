// 桥 Daemon —— 全机单例，坐在 agent 和 Chrome 扩展中间
//
// 职责边界（写死，别扩）：
//   路由 cmd/res、维护扩展连接、站点白名单裁决、审计落盘。
//   它不解析页面、不认识 ref、不知道 snapshot 是什么——那些全在扩展侧。
//
// 安全边界就在 verifyClient：浏览器发起 WS 时强制带 Origin 且不可伪造，
// 网页的 Origin 是自己的域名，扩展的是 chrome-extension://<id>。只放后者进来。
import { WebSocketServer } from 'ws';
import fs from 'node:fs';
import { DEFAULT_PORT, writeBridgeInfo, newToken, tokenEquals, audit, ensureHome, ALLOWLIST_FILE } from './lib/paths.js';
import { VERSION } from './lib/version.js';
// 纯字符串判定、不碰 chrome API，所以桥这边直接复用，不再抄一份
import { scrubProse } from '../extension/redact.js';

export { VERSION };

// 写操作回执的效果分类进审计。以前 res 只有 ok/ms/bytes/error，
// 「回执说没反应、其实已提交」这类误判有多少、修完降了多少，都量不出来。
// 只取类别，不存回执正文。
export function effectOf(data) {
  const t = typeof data === 'string' ? data : data?.text;
  if (typeof t !== 'string') return undefined;
  const head = t.slice(0, 1200);
  if (/^act 停在/m.test(head)) return 'act-stopped';
  if (/^act 完成/m.test(head)) return data?.recipe ? 'act-done+draft' : 'act-done';
  if (/操作已发出，但页面完全没有反应/.test(head)) return 'none';
  if (/没有可归因于这次操作的变化/.test(head)) return 'unattributable';
  if (/发出了请求：/.test(head)) return 'request-only';
  if (/^效果：/m.test(head)) return /^请求：/m.test(head) ? 'changed+request' : 'changed';
  return undefined;
}
import { PROTOCOL, compat, compatNote } from '../extension/compat.js';
const HELLO_TIMEOUT = 5000;
const CMD_TIMEOUT = 30000;
const IDLE_EXIT_MS = 30 * 60 * 1000; // 半小时没人用就自己退，别留僵尸进程
const EXT_SILENCE_MS = 50000;        // 扩展每 15 秒一次心跳，连着三拍没到就先探一下
const EXT_PROBE_MS = 15000;          // 探了还不回，再等这么久才判死
const ORPHAN_GRACE_MS = 15000;       // 扩展断开时在途命令的宽限：一个心跳周期，够它重连并补发回执
const MAX_TARGET_ID_LENGTH = 128;
const PIN_CAP = 1000;                // 会话→实例的绑定上限（按最近使用淘汰）
const TAB_OWNER_CAP = 5000;          // tabId→实例的户口簿上限
const PROFILE_INFO_MS = 2500;        // profiles 向每个实例要概况的等待上限
const RELOAD_WAIT_MS = 15000;        // reload all 等每个实例重连回来的上限
// 本机脚本借登录的命令（huashu-chrome run --grant）。只放行这一个客户端，而且必须点名实例：
// agent（MCP、CLI call）发来一律拒绝。这不是真正的安全边界——本机进程谁都能自称这个名字——
// 真正的边界是扩展里的 grant 开关和加密回执；这一层只保证 agent 不会顺手把它当成普通工具用。
export const HANDOFF_CLIENT = 'huashu-handoff';
const HANDOFF_CMDS = new Set(['handoff_status', 'handoff_resolve_tab', 'handoff_session']);

// profile 名字是用户在侧栏里起的，要进日志、进 agent 的 context：去控制字符、限长
export function cleanProfileLabel(v) {
  if (typeof v !== 'string') return '';
  return v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
}

// writeInfo=false 供测试用：不写 bridge.json，否则测试桥的 token 会盖掉
// 真在跑的那个桥，用户所有 agent 会话当场断连。
export function startBridge({ port = DEFAULT_PORT, token = newToken(), writeInfo = true, orphanGraceMs = ORPHAN_GRACE_MS,
  silenceMs = EXT_SILENCE_MS, probeMs = EXT_PROBE_MS, tickMs = 20000, profileInfoMs = PROFILE_INFO_MS, reloadWaitMs = RELOAD_WAIT_MS } = {}) {
  ensureHome();

  const agents = new Set();      // role=agent 的连接
  // role=extension 的连接。**按实例并存**，不是单槽。
  //
  // 单槽那版的死法（8-29 抓到）：主 Chrome 和 agent 起的 headless 实例
  // 各自加载同一份扩展、各自来连，后来的把前一个踢掉、被踢的立刻重连再踢回去
  // ——每秒一次，命令落在哪一方刚被踢掉的窗口里就报 NO_EXTENSION，
  // 用户看到的是「插件时有时无」。
  //
  // 现在认 instanceId：同一个实例重连才替换，不同实例并存，命令按 primary()
  // 路由到有窗口的那个。顺带把「同一个 Chrome 里装了两份扩展」（比如加 key
  // 之前留下的旧 ID 条目被误启用）也一并接住了——那也只是多一个实例，不再是抢。
  const extensions = new Set();
  // key 是「连接序号:消息id」，不是裸 id——每个 agent 进程的 id 都从 c1 开始数，
  // 只按 id 存会让两个会话的 c1 互相覆盖，响应串到别人的请求上，而且毫无征兆。
  const pending = new Map();
  let connSeq = 0;

  // 扩展缺席时的等待队列。
  //
  // MV3 的 service worker 随时会被 Chrome 回收——实测一条连接的存活中位数只有
  // 106 秒，一晚上断开 111 次。而桥是个本地进程，**唤不醒**被回收的 SW：
  // 能唤醒它的只有 chrome.alarms（30s 一次）、tabs.onRemoved、content script 消息，
  // 全都是「用户在浏览网页」才会发生的事。所以用户活跃时扩展秒回（111 次里 103 次
  // ≤1s），静止时最长要等一个 alarm 周期。
  //
  // 原先这里是「扩展不在就立刻判死」。那当初防的是 agent 干等 30 秒，方向没错，
  // 但它把两件事当成了一件：扩展「一会儿就回来」和扩展「真的没装」。对前者判死，
  // agent 拿到的是个假故障，而正确动作只是等一下。
  //
  // 注意跟「命令执行途中掉线」的区别：那种情况**绝不能**排队重发——点击可能
  // 已经生效，重发等于重复操作。那条路仍然立刻失败，见下面 ws.on('close')。
  const waiting = [];
  const WAIT_CAP = 64;                 // 扩展长期不在时别无限堆积
  const WAIT_MAX = 40000;              // 一个 30s alarm 周期 + 余量
  // 话术和 doctor、mcp-server 的 hint 保持一致：首选动作是扩展弹窗里的「重连」，
  // 不是去 chrome://extensions——插件从来没消失过，去那儿只会把人引向「重装」。
  const NO_EXT_MSG = '扩展没连上桥。桥已经替你等过一轮'
    + `（最多 ${WAIT_MAX / 1000}s），它还没回来。让用户点一下浏览器工具栏的 huashu-chrome 图标 → 「重连」`
    + '（插件没消失，只是这条连接断了）；Chrome 没开就先开；改过扩展代码才需要去 chrome://extensions 重载。';

  let lastActivity = Date.now();

  // 在线会话集合。扩展靠它判断「最近那个受控标签页还有主吗」——有主就不让
  // 新会话继承，没主才放行。这是「两个 agent 撞进同一个页面」唯一能拦住的地方，
  // 而拦截判据只有桥知道（谁还连着）。
  //
  // 跟着**每条命令**一起送，而不是断线/上线时推事件让扩展存着。
  // 推事件那版有个真实的竞态：新会话连上后立刻发第一条命令，而名单还在
  // 桥→offscreen→SW→storage 这一路上，于是第一条命令读到的是旧名单、
  // 判定「没人占」，照样撞进别人的页面——而这恰恰是最该拦住的那一条。
  // 几十字节换掉一整条时序假设，划算。
  const liveSessions = () => [...new Set([...agents].map((a) => a.sid).filter(Boolean))];

  // 命令发给谁。
  //
  // 有窗口的实例优先——headless 那个是 agent 自己起来抓页面的，
  // 没有用户的登录态在用，把「打开淘宝订单页」路由过去等于什么都看不到。
  // 同一档里取最近有动静的那个（心跳也算动静），这样多开几个有头 Chrome 时
  // 命令跟着用户正在用的那个走。
  const liveExtensions = () => [...extensions].filter((e) => e.readyState === 1);
  function primary() {
    const live = liveExtensions();
    if (!live.length) return null;
    const headed = live.filter((e) => !e.headless);
    const pool = headed.length ? headed : live;
    return pool.reduce((a, b) => (a.lastRx >= b.lastRx ? a : b));
  }
  const extLabel = (ws) => `Chrome ${ws.chromeVersion || '?'}${ws.headless ? ' · headless' : ''} · 扩展 ${ws.extVersion}`
    + `${ws.instanceId ? ` · ${String(ws.instanceId).slice(0, 8)}` : ''}${ws.profileLabel ? ` 「${ws.profileLabel}」` : ''}`;
  // 给 agent 看的名字：有名字用名字，没有就用 instanceId 前 8 位
  const profileName = (e) => e.profileLabel || `id ${String(e.instanceId).slice(0, 8)}`;
  const headedCount = () => liveExtensions().filter((e) => !e.headless).length;

  // ---------- 多 profile 路由 ----------
  //
  // 同一份扩展被多个 Chrome profile 加载时，每个 profile 是一个实例。
  // primary() 按 lastRx 挑，而心跳也刷新 lastRx——于是一个会话的命令落在
  // 哪个 profile 取决于心跳节拍，任务做到一半就可能换了账号。更糟的是 tabId：
  // 不同 user-data-dir 的 Chrome 各自从小数字起编号，同一个 tabId 在两边
  // 可能都存在，命令就会在别人的账号里点下去。
  //
  // 两条规则把它钉死：
  // 1) 会话绑定：一个会话第一次落到哪个实例，之后都去那里。实例瞬断就等它回来，
  //    绝不悄悄换到另一个 profile；等满窗口还不回来才解绑并明说。
  // 2) tabId 认主：桥从回执里记下每个 tabId 属于哪个实例，带 tabId 的命令
  //    直接送到它的主人那里——哪怕不是本会话绑定的实例。
  const identityKey = (e) => `${e.extensionId}\u0000${e.instanceId}`;
  const liveByKey = (key) => liveExtensions().find((e) => identityKey(e) === key) || null;
  const sessionPins = new Map();     // sid → identityKey
  const tabOwners = new Map();       // tabId → Set<identityKey>

  function pinSession(sid, key) {
    if (!sid) return;
    sessionPins.delete(sid);
    sessionPins.set(sid, key);
    while (sessionPins.size > PIN_CAP) sessionPins.delete(sessionPins.keys().next().value);
  }
  function noteTab(tabId, key) {
    const owners = tabOwners.get(tabId) || new Set();
    tabOwners.delete(tabId);
    owners.add(key);
    tabOwners.set(tabId, owners);
    while (tabOwners.size > TAB_OWNER_CAP) tabOwners.delete(tabOwners.keys().next().value);
  }
  function forgetTab(tabId, key) {
    const owners = tabOwners.get(tabId);
    if (!owners) return;
    owners.delete(key);
    if (!owners.size) tabOwners.delete(tabId);
  }
  function cmdTabId(msg) {
    const v = msg.tabId ?? msg.params?.tabId;
    return Number.isSafeInteger(v) && v > 0 ? v : null;
  }

  // 未显式指定 target 的命令该去哪个实例。
  // 返回 { key, ext, reason }：ext 为 null 表示该实例此刻不在线（调用方排队等它）。
  function resolveRoute(ws, msg) {
    const pinKey = ws.sid ? sessionPins.get(ws.sid) : undefined;
    const tabId = cmdTabId(msg);
    const owners = tabId != null ? tabOwners.get(tabId) : null;
    if (owners?.size) {
      if (owners.size === 1) {
        const [key] = owners;
        return { key, ext: liveByKey(key), reason: 'tab', tabId };
      }
      // 同一个 tabId 在两个 profile 里都见过：本会话绑定的那个说了算，否则拒绝猜
      if (pinKey && owners.has(pinKey)) return { key: pinKey, ext: liveByKey(pinKey), reason: 'tab', tabId };
      return { error: { code: 'TAB_AMBIGUOUS', message: `Tab ${tabId} exists in more than one connected Chrome profile. `
        + 'Run tabs(action:"list") to re-check, or open a fresh tab with tabs(action:"new").' } };
    }
    if (pinKey) return { key: pinKey, ext: liveByKey(pinKey), reason: 'pin' };
    const ext = primary();
    return ext ? { key: identityKey(ext), ext, reason: 'new' } : { key: null, ext: null, reason: 'none' };
  }

  // 从回执里学 tabId 归属。只信成功的回执，以及 NO_TAB 这种「确定不在这儿」的失败。
  function learnTabs(p, ext, msg) {
    const key = identityKey(ext);
    if (!msg.ok) {
      if (msg.error?.code === 'NO_TAB' && p.tabId != null) forgetTab(p.tabId, key);
      return;
    }
    const closing = p.cmd === 'tabs' && p.action === 'close';
    if (p.tabId != null) (closing ? forgetTab : noteTab)(p.tabId, key);
    const d = msg.data;
    if (!closing && d && Number.isSafeInteger(d.tabId) && d.tabId > 0) noteTab(d.tabId, key);
    if (p.cmd === 'tabs' && p.action === 'list' && typeof d?.text === 'string') {
      // list 是这个实例的全量：在里面的认领，不在里面的除名
      const seen = new Set([...d.text.matchAll(/^\[(\d+)\]/gm)].map((m) => Number(m[1])));
      for (const id of seen) noteTab(id, key);
      for (const [id, owners] of [...tabOwners]) if (owners.has(key) && !seen.has(id)) forgetTab(id, key);
    }
  }
  function extensionIdFromOrigin(origin) {
    if (typeof origin !== 'string') return null;
    try {
      const url = new URL(origin);
      return url.protocol === 'chrome-extension:' && url.hostname ? url.hostname : null;
    } catch {
      return null;
    }
  }

  const wss = new WebSocketServer({
    host: '127.0.0.1',
    port,
    verifyClient: (info, done) => {
      const origin = info.req.headers.origin;
      if (origin === undefined) return done(true);              // Node 侧，进握手后验 token
      if (origin.startsWith('chrome-extension://')) return done(true);
      audit({ ev: 'reject_origin', origin });                   // 网页想连桥——这就是攻击面，堵在这里
      done(false, 403, 'forbidden origin');
    },
  });

  wss.on('connection', (ws, req) => {
    const origin = req.headers.origin;
    ws.extensionId = extensionIdFromOrigin(origin);
    ws.isExtension = !!ws.extensionId;
    ws.helloed = false;
    ws.connId = ++connSeq;
    ws.lastRx = Date.now();

    const helloTimer = setTimeout(() => {
      if (!ws.helloed) ws.close(4008, 'hello timeout');
    }, HELLO_TIMEOUT);

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return send(ws, { type: 'res', ok: false, error: { code: 'INTERNAL', message: '非法 JSON' } });
      }
      lastActivity = Date.now();
      ws.lastRx = lastActivity;

      if (!ws.helloed) {
        clearTimeout(helloTimer);
        return handleHello(ws, msg);
      }
      route(ws, msg);
    });

    ws.on('close', () => {
      clearTimeout(helloTimer);
      if (agents.delete(ws)) {
        // 只把它从在线集合里摘掉，**不删它的受控标签页槽**。
        // 这条连接断开有两种可能：会话真的结束了，或者只是桥在换代/抖了一下
        // 而 agent 马上会带着同一个 sessionId 回来。删槽会把后者也一起毁掉，
        // 那正是「桥一重启就跟丢标签页」的老毛病。槽由扩展侧按 LRU 收口。
        //
        // 它排在队里的命令也一并撤掉，别等扩展回来了再去操作一个没人要结果的动作
        for (let i = waiting.length - 1; i >= 0; i--) {
          if (waiting[i].ws === ws) { clearTimeout(waiting[i].timer); waiting.splice(i, 1); }
        }
        // 名单变了，告诉扩展一声。它平时是搭着每条命令收到 live 的，而一个会话
        // 「结束」的特征恰恰是再也没有命令过来——不推这一条，那个会话留在页面上的
        // 控制标记就摘不掉了。断线重连的情况会在下一条命令里自动补回来。
        // 每个实例都要知道名单：它们各自维护自己那份受控标签页槽
        for (const e of liveExtensions()) {
          send(e, { type: 'event', event: 'sessions', live: liveSessions() });
        }
      }
      if (extensions.delete(ws)) {
        log(`扩展断开（${extLabel(ws)}）`);
        // 这条连接承接的在途命令**不立刻判死**，给一个心跳周期的宽限。
        //
        // 原先是当场回 NO_EXTENSION。可断线多半是瞬断（睡醒后看门狗互杀、
        // 双腿替换、桥换代），扩展 1 秒内就带着同一个 instanceId 回来了，而那条
        // 命令早已在页面上执行完、回执也存在扩展的发件箱里等着补发。当场判死的
        // 后果是最坏的一种：点击已经生效，agent 收到「失败」，按提示重试
        // 就是双击/重复下单——正是这个产品明说要消灭的静默失败。
        // 宽限期里回执按 __k 回来照常配对（routeBack 校验扩展+实例身份）；
        // 宽限用完还没回来，再按原来的话报错。别的实例的命令一概不动。
        for (const [k, p] of pending) {
          if (p.ext !== ws || p.orphanTimer) continue;
          p.orphanTimer = setTimeout(() => {
            if (!pending.has(k)) return;
            clearTimeout(p.timer);
            pending.delete(k);
            send(p.agent, { type: 'res', id: p.id, ok: false, error: { code: 'NO_EXTENSION',
              message: `扩展在命令执行中断开，${orphanGraceMs / 1000} 秒内没回来。这条命令可能已经在页面上生效了——`
                + '重试前先 snapshot 看一眼，别把一次点击做成两次。' } });
          }, orphanGraceMs);
        }
        // 一个都不剩了才算「扩展离线」
        if (!liveExtensions().length) broadcast({ type: 'event', event: 'extension_offline' });
      }
    });

    ws.on('error', () => {});
  });

  function handleHello(ws, msg) {
    if (msg.type !== 'hello') return ws.close(4000, 'expected hello');

    if (msg.role === 'extension') {
      if (!ws.isExtension) return ws.close(4003, 'role/origin mismatch');
      ws.helloed = true;
      ws.extVersion = msg.version || '?';
      ws.extProtocol = msg.v ?? PROTOCOL;
      ws.chromeVersion = msg.chrome || '?';
      ws.headless = !!msg.headless;
      ws.profileLabel = cleanProfileLabel(msg.profileLabel);
      ws.loadedAt = Number.isSafeInteger(msg.loadedAt) && msg.loadedAt > 0 ? msg.loadedAt : null;
      // 老扩展不报 instanceId 时，用实际 Origin 的扩展 id 退回兼容身份。
      // 不采信 hello 里的 extId：它是客户端字段，不能作为连接身份。
      ws.instanceId = typeof msg.instanceId === 'string'
        && msg.instanceId.trim().length > 0
        && msg.instanceId.length <= MAX_TARGET_ID_LENGTH
        ? msg.instanceId
        : `ext:${ws.extensionId}`;

      // 同一个扩展、同一个实例又连了一条：那是断线重连或重载扩展，旧的那条已经是死的，
      // 顶掉它。**只顶同实例的**——顶错了就退回单槽，每秒互踢的老毛病就回来了。
      for (const old of extensions) {
        if (old.extensionId === ws.extensionId && old.instanceId === ws.instanceId && old !== ws) {
          extensions.delete(old);
          if (old.readyState === 1) old.close(4009, 'replaced');
        }
      }
      extensions.add(ws);

      // 改了扩展代码却忘记去 chrome://extensions 重载，是这类产品最高频的故障，
      // 症状还都是些莫名其妙的行为。这里把它变成一句明确的话。
      // 补丁号不同不再报：两边协议没变就是兼容的（判定见 extension/compat.js）
      const level = compat({ ext: ws.extVersion, cli: VERSION, extProtocol: ws.extProtocol });
      if (level !== 'same' && level !== 'patch') log(`⚠️  ${compatNote(level, { ext: ws.extVersion, cli: VERSION })}`);
      log(`扩展已连接（${extLabel(ws)}）`);
      // 多实例不再是故障，但仍然值得说一声：命令只会去其中一个，
      // 而「为什么我的命令跑到另一个 Chrome 里去了」全靠这行日志才查得到。
      const live = liveExtensions();
      if (live.length > 1) {
        log(`⚠️  当前有 ${live.length} 个 Chrome 实例连着（${live.map(extLabel).join(' / ')}），`
          + `命令路由到：${extLabel(primary())}`);
      }
      send(ws, { type: 'welcome', bridge: VERSION, v: PROTOCOL });
      broadcast({ type: 'event', event: 'extension_online' });
      flushWaiting();
      return;
    }

    if (msg.role === 'agent') {
      if (ws.isExtension) return ws.close(4003, 'role/origin mismatch');
      if (!tokenEquals(msg.token || '', token)) {
        audit({ ev: 'reject_token', client: msg.client });
        return ws.close(4001, 'bad token');
      }
      agents.add(ws);
      ws.helloed = true;
      ws.client = msg.client || 'unknown';
      // label 是宿主的显示名（「Codex CLI」），由 MCP server 从握手里认出来；
      // client 仍是审计和 sid 用的 slug。老客户端不带 label，扩展侧退回美化 slug。
      ws.label = typeof msg.label === 'string' && msg.label ? msg.label.slice(0, 40) : undefined;
      // 会话身份由 agent 自己带来，跨桥重启稳定。老客户端不带，退回连接序号——
      // 行为和以前一样（桥一重启就丢槽），但至少不会串到别人的槽上。
      ws.sid = msg.sessionId || `conn:${ws.connId}`;
      log(`agent 已连接：${ws.label || ws.client}（${ws.client}，会话 ${ws.sid}）`);
      const ext = primary();
      send(ws, {
        type: 'welcome', bridge: VERSION, v: PROTOCOL,
        extensionOnline: !!ext,
        extensionVersion: ext?.extVersion,
        // 老 MCP 只认 versionMismatch：只在真需要人处理时置位，补丁号差异不再惊动它
        versionMismatch: !!ext && !['same', 'patch'].includes(compat({ ext: ext.extVersion, cli: VERSION, extProtocol: ext.extProtocol })),
        extensionProtocol: ext?.extProtocol,
        // 多实例是诊断信息，不是故障。doctor 要能说出「有两个 Chrome 连着」，
        // 否则「命令跑到另一个窗口去了」这种事只能靠猜。
        capabilities: ['targeted-routing-v1', 'session-pinning-v1', 'tab-owner-routing-v1', 'profiles-v1', 'session-handoff-v1'],
        extensions: liveExtensions().map((e) => ({
          extensionId: e.extensionId, instanceId: e.instanceId,
          chrome: e.chromeVersion, version: e.extVersion, headless: e.headless, primary: e === ext,
          label: e.profileLabel || undefined, loadedAt: e.loadedAt || undefined,
        })),
      });
      return;
    }

    ws.close(4000, 'unknown role');
  }

  function route(ws, msg) {
    // agent → extension
    if (msg.type === 'cmd') {
      if (!agents.has(ws)) return;
      return dispatch(ws, msg);
    }

    // extension → agent
    return routeBack(ws, msg);
  }

  // 扩展不在时先挂起，等它回来（或等到窗口用完）。
  // 窗口取「调用方自己声明的 timeout」和 WAIT_MAX 里更小的那个——
  // 调用方说只等 300ms，桥就不该替它等 40 秒，那只是换了个姿势干等。
  //
  // deadline：补发时重新解析路由，若要等的实例还没回来会再次入队——
  // 带着原来的截止时间，不然每来一个别的实例，等待窗口就被白白续一次。
  //
  // route 说明在等谁。等的是本会话绑定的 profile、而别的 profile 都在线时，
  // 超时就解绑并明说：悄悄换到另一个账号上接着点，比失败危险得多。
  function enqueue(ws, msg, deadline, route) {
    const fail = (capped = false) => {
      const others = liveExtensions().length > 0;
      if (!capped && others && route?.reason === 'pin' && sessionPins.get(ws.sid) === route.key) {
        sessionPins.delete(ws.sid);
        return send(ws, { type: 'res', id: msg.id, ok: false, error: { code: 'PROFILE_OFFLINE',
          message: 'The Chrome profile this session was working in disconnected and did not come back. '
            + 'Your next command will go to another connected profile — a different account. '
            + 'Run tabs(action:"list") to see where you are before continuing.' } });
      }
      if (!capped && others && route?.reason === 'tab') {
        return send(ws, { type: 'res', id: msg.id, ok: false, error: { code: 'TAB_PROFILE_OFFLINE',
          message: `Tab ${route.tabId} belongs to a Chrome profile that is not connected right now. `
            + 'Ask the user to open that profile, or work in a tab from tabs(action:"list").' } });
      }
      send(ws, { type: 'res', id: msg.id, ok: false, error: { code: 'NO_EXTENSION', message: NO_EXT_MSG } });
    };
    if (waiting.length >= WAIT_CAP) return fail(true);

    const end = deadline ?? Date.now() + Math.min(Number(msg.timeout) || WAIT_MAX, WAIT_MAX);
    const ms = end - Date.now();
    if (ms <= 0) return fail();
    const item = { ws, msg, deadline: end };
    item.timer = setTimeout(() => {
      const i = waiting.indexOf(item);
      if (i >= 0) waiting.splice(i, 1);
      fail();
    }, ms);
    waiting.push(item);
    // 排队本身要留痕：否则「这条命令为什么慢了 8 秒」在审计里是查不出来的。
    // 重新入队（带 deadline）不重复记
    if (deadline == null) {
      audit({ ev: 'queued', id: `${ws.connId}:${msg.id}`, cmd: msg.cmd, client: ws.client, waitMs: ms, wait: route?.reason });
    }
  }

  // 扩展一连上就把队列放出去。丢掉那些 agent 已经走掉的——
  // 往一个关闭的连接上回包不会报错，只会静默地什么都没发生。
  function flushWaiting() {
    const q = waiting.splice(0);
    for (const it of q) {
      clearTimeout(it.timer);
      // Re-run target resolution at drain time. The original message stays intact in
      // the queue, so a targeted command can never silently become an untargeted one.
      if (agents.has(it.ws) && it.ws.readyState === 1) dispatch(it.ws, it.msg, it.deadline);
    }
    if (q.length) log(`扩展回来了，重新路由 ${q.length} 条排队的命令`);
  }

  function targetError(ws, msg, code, message) {
    send(ws, { type: 'res', id: msg.id, ok: false, error: { code, message } });
  }

  function selectTarget(msg) {
    if (!Object.hasOwn(msg, 'target')) return { targeted: false };
    const value = msg.target;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { targeted: true, error: { code: 'TARGET_INVALID', message: 'target must contain extensionId and instanceId strings' } };
    }
    const keys = Object.keys(value);
    const validId = (id) => typeof id === 'string' && id.trim().length > 0 && id.length <= MAX_TARGET_ID_LENGTH;
    if (keys.length !== 2 || !keys.includes('extensionId') || !keys.includes('instanceId')
      || !validId(value.extensionId) || !validId(value.instanceId)) {
      return { targeted: true, error: { code: 'TARGET_INVALID', message: `target must contain only nonempty extensionId and instanceId strings of at most ${MAX_TARGET_ID_LENGTH} characters` } };
    }

    const matches = liveExtensions().filter((e) => e.extensionId === value.extensionId && e.instanceId === value.instanceId);
    if (!matches.length) {
      return { targeted: true, error: { code: 'TARGET_NOT_FOUND', message: 'target instance is not connected' } };
    }
    if (matches.length > 1) {
      return { targeted: true, error: { code: 'TARGET_AMBIGUOUS', message: 'target matches more than one connected instance' } };
    }
    return { targeted: true, extension: matches[0], selector: { extensionId: value.extensionId, instanceId: value.instanceId } };
  }

  // 桥自己向某个实例要一份数据（不经过任何 agent）。回执照常按 __k 配对，
  // 配上后交给 internal 而不是转发。拿不到（超时、老扩展不认）就给 null。
  let internalSeq = 0;
  // extra：要以某个会话的名义发时（reload 会刷标记、记会话），带上 sid/client/label/live
  function askInstance(ext, cmd, params = {}, ms = profileInfoMs, extra = {}) {
    return new Promise((resolve) => {
      const key = `bridge:${++internalSeq}`;
      const timer = setTimeout(() => { pending.delete(key); resolve(null); }, ms);
      pending.set(key, {
        internal: (res) => resolve(res.ok ? res.data ?? null : null),
        ext, extensionId: ext.extensionId, instanceId: ext.instanceId,
        cmd, timer, startedAt: Date.now(), id: key,
      });
      send(ext, { ...extra, type: 'cmd', id: key, cmd, params, __k: key });
    });
  }

  // reload({all:true})：同一个文件夹被多个 profile 加载，改完代码要每个都重载。
  // 逐个发 reload，再等它们各自带着同一个 instanceId 重连回来（新连接 = 新代码）。
  // 回执逐个报：谁回来了、用了多久、谁没回来——没回来的那个多半还在跑旧代码。
  async function handleReloadAll(ws, msg) {
    const targets = liveExtensions();
    if (!targets.length) return enqueue(ws, msg, undefined, { reason: 'none' });
    const as = { sid: ws.sid, client: ws.client, label: ws.label, live: liveSessions() };
    const started = Date.now();
    const acks = await Promise.all(targets.map((e) => askInstance(e, 'reload', {}, profileInfoMs, as)));
    audit({ ev: 'reload_all', client: ws.client, sid: ws.sid, instances: targets.map((e) => String(e.instanceId).slice(0, 8)) });
    const waitMs = Math.min(Math.max(Number(msg.params?.waitMs) || reloadWaitMs, 500), 60000);
    const backAt = new Map();
    while (Date.now() - started < waitMs && backAt.size < targets.length) {
      for (const old of targets) {
        if (backAt.has(old)) continue;
        const fresh = liveExtensions().find((e) => e !== old && identityKey(e) === identityKey(old));
        if (fresh) backAt.set(old, { ext: fresh, ms: Date.now() - started });
      }
      if (backAt.size < targets.length) await new Promise((r) => setTimeout(r, 100));
    }
    const instances = targets.map((old, i) => {
      const back = backAt.get(old);
      return {
        name: old.profileLabel || null, instanceId: old.instanceId,
        acked: !!acks[i], back: !!back, ms: back?.ms ?? null, version: back?.ext.extVersion ?? null,
      };
    });
    const lines = instances.map((r) => `${r.back ? '✓' : '✗'} "${r.name || `id ${String(r.instanceId).slice(0, 8)}`}" `
      + (r.back ? `reloaded, back in ${(r.ms / 1000).toFixed(1)}s (v${r.version})`
        : r.acked ? `reload sent, not back after ${(waitMs / 1000).toFixed(0)}s — it may still be restarting`
          : 'did not answer the reload — reload it from chrome://extensions'));
    const ok = instances.every((r) => r.back);
    log(`reload all：${instances.filter((r) => r.back).length}/${instances.length} 个实例重载完成`);
    send(ws, { type: 'res', id: msg.id, ok: true, data: {
      text: `${ok ? 'Reloaded' : 'Reload incomplete for'} ${instances.length} Chrome profile${instances.length > 1 ? 's' : ''}:\n${lines.join('\n')}`,
      instances, ok,
    } });
  }

  // profiles：列出连着的 Chrome profile（=账号），以及本会话落在哪个上；
  // {use} 把本会话改绑到指定的那个。名字 > 完整 instanceId > instanceId 前缀（≥4 位）。
  async function handleProfiles(ws, msg) {
    const reply = (ok, payload) => send(ws, ok
      ? { type: 'res', id: msg.id, ok: true, data: payload }
      : { type: 'res', id: msg.id, ok: false, error: payload });
    const live = liveExtensions();
    if (!live.length) return enqueue(ws, msg, undefined, { reason: 'none' });

    let switched = null;
    const want = msg.params?.use;
    if (want != null) {
      const q = String(want).trim().toLowerCase();
      const byLabel = live.filter((e) => e.profileLabel && e.profileLabel.toLowerCase() === q);
      const byId = live.filter((e) => String(e.instanceId).toLowerCase() === q);
      const byPrefix = q.length >= 4 ? live.filter((e) => String(e.instanceId).toLowerCase().startsWith(q)) : [];
      const hits = byLabel.length ? byLabel : byId.length ? byId : byPrefix;
      if (hits.length !== 1) {
        const names = live.map((e) => `"${profileName(e)}"`).join(', ');
        return reply(false, hits.length
          ? { code: 'PROFILE_AMBIGUOUS', message: `"${want}" matches ${hits.length} profiles. Use the full instance id. Connected: ${names}.` }
          : { code: 'PROFILE_NOT_FOUND', message: `No connected Chrome profile is named "${want}". Connected: ${names}.` });
      }
      switched = hits[0];
      pinSession(ws.sid, identityKey(switched));
      log(`会话 ${ws.sid} 改绑到 ${extLabel(switched)}`);
    }

    const pinKey = sessionPins.get(ws.sid);
    const current = (pinKey && liveByKey(pinKey)) || null;
    const next = current || primary();
    const infos = await Promise.all(live.map((e) => askInstance(e, 'profile_info')));
    const profiles = live.map((e, i) => {
      const info = infos[i] || {};
      return {
        name: e.profileLabel || null,
        instanceId: e.instanceId,
        headless: !!e.headless,
        current: pinKey && !current ? false : e === next,
        tabs: Number.isInteger(info.tabs) ? info.tabs : null,
        focused: !!info.focused,
        sites: Array.isArray(info.sites) ? info.sites.slice(0, 6) : [],
      };
    });
    const lines = profiles.map((p) => {
      const site = p.sites.map((s) => (s.count > 1 ? `${s.host} ×${s.count}` : s.host)).join(', ');
      return `${p.current ? '→' : ' '} ${p.name ? `"${p.name}"` : '(unnamed)'}  id ${p.instanceId}`
        + `${p.headless ? '  headless' : ''}${p.tabs != null ? `  ${p.tabs} tabs` : ''}${p.focused ? '  [user is here]' : ''}`
        + `${site ? `  — ${site}` : ''}`;
    });
    const head = switched
      ? `This session now works in "${profileName(switched)}".`
      : current ? `This session works in "${profileName(current)}".`
        : pinKey ? 'This session\'s profile is disconnected right now; its commands wait for it to come back.'
          : `This session is not bound yet; its next command goes to "${profileName(next)}".`;
    const text = `${live.length} Chrome profile${live.length > 1 ? 's' : ''} connected (each one is a separate set of logins). ${head}\n`
      + lines.join('\n')
      + '\nSwitch: profiles({use:"<name or id>"}). A tabId you pass always goes to the profile that owns that tab.'
      + (profiles.some((p) => !p.name && !p.headless) ? '\nUnnamed profiles: the user can name them in the huashu-chrome side panel.' : '');
    reply(true, { text, profiles });
  }

  function dispatch(ws, msg, deadline) {
    if (msg.cmd === 'profiles') return void handleProfiles(ws, msg);
    if (msg.cmd === 'reload' && msg.params?.all === true) return void handleReloadAll(ws, msg);
    if (HANDOFF_CMDS.has(msg.cmd)) {
      if (ws.client !== HANDOFF_CLIENT) {
        audit({ ev: 'blocked', cmd: msg.cmd, client: ws.client, reason: 'HANDOFF_FORBIDDEN' });
        return targetError(ws, msg, 'HANDOFF_FORBIDDEN', `${msg.cmd} is only available to huashu-chrome run, not to agents`);
      }
      if (!Object.hasOwn(msg, 'target')) return targetError(ws, msg, 'TARGET_REQUIRED', `${msg.cmd} must name a Chrome profile`);
    }
    let note = '';
    const selection = selectTarget(msg);
    if (selection.error) return targetError(ws, msg, selection.error.code, selection.error.message);
    let target = selection.extension;
    if (!selection.targeted) {
      const route = resolveRoute(ws, msg);
      if (route.error) return targetError(ws, msg, route.error.code, route.error.message);
      target = route.ext;
      if (!target) return enqueue(ws, msg, deadline, route);
      if (route.reason === 'new' && ws.sid) {
        pinSession(ws.sid, route.key);
        if (liveExtensions().length > 1) log(`会话 ${ws.sid} 绑定到 ${extLabel(target)}`);
        // 多个有窗口的 profile 时，绑定是个 agent 必须知道的事实：它落在哪个账号里。
        // 搭在这条回执尾部说一次，不占 STRATEGY 的预算
        if (headedCount() > 1) {
          note = `\n\nℹ️ ${headedCount()} Chrome profiles (accounts) are connected; this session is working in `
            + `"${profileName(target)}". profiles() lists them, profiles({use}) switches.`;
        }
      }
    }
    if (!target) return targetError(ws, msg, 'TARGET_NOT_FOUND', 'target instance is not connected');
    const gate = checkSite(msg);
    if (gate) {
      audit({ ev: 'blocked', cmd: msg.cmd, client: ws.client, reason: gate.code });
      return send(ws, { type: 'res', id: msg.id, ok: false, error: gate });
    }

    // 下载、上传这类命令天然比一次点击慢得多，让调用方自己说要等多久
    const ms = Math.min(Math.max(Number(msg.timeout) || CMD_TIMEOUT, 1000), 600000);
    const key = `${ws.connId}:${msg.id}`;
    const timer = setTimeout(() => {
      clearTimeout(pending.get(key)?.orphanTimer);
      pending.delete(key);
      send(ws, { type: 'res', id: msg.id, ok: false, error: { code: 'TIMEOUT', message: `扩展 ${Math.round(ms / 1000)}s 未响应` } });
    }, ms);

    // 记下**是哪个实例接的**：它断线时只该失败自己承接的这些，别误伤其他实例
    pending.set(key, {
      agent: ws, ext: target, extensionId: target.extensionId, instanceId: target.instanceId,
      target: selection.selector, cmd: msg.cmd, timer, startedAt: Date.now(), id: msg.id,
      tabId: cmdTabId(msg), action: msg.params?.action, note,
    });
    // 审计里的 id 必须全局唯一，否则 cmd 和 res 根本配不上对：
    // msg.id 是每个 agent 进程内自增的（都从 c1 开始数），实测 5381 条 cmd
    // 只有 281 个不同的 id，最多的一个出现了 1088 次。
    // 路由用的一直是 connId:id，审计却记裸 id——「出事能查」这条承诺
    // 在数据结构层面就不成立。
    audit({ ev: 'cmd', id: key, cmd: msg.cmd, client: ws.client, sid: ws.sid, params: redact(msg.params) });
    // sid 盖章：扩展据此维护每个会话自己的受控 tab 槽（多 agent 并发隔离）。
    // live 是此刻还连着的会话，扩展拿它判断某个标签页「还有没有主」。
    // client / label 是给人看的：页面上的控制标记要写出「Codex CLI」而不是一串 sid。
    const command = { ...msg };
    delete command.target;
    send(target, { ...command, __k: key, sid: ws.sid, client: ws.client, label: ws.label, live: liveSessions() });   // __k 原样带回，用于精确路由
  }

  function routeBack(ws, msg) {
    // 扩展的保活心跳。以前这条消息掉进下面的分支里被默默丢掉，桥从不回应——
    // 而 Chrome 是靠 WebSocket 的**收发**活动去续 service worker 的空闲计时的，
    // 单向发等于只续了一半。回一条 pong，让扩展那侧也有「收到」这个事件。
    if (msg.type === 'ping') return send(ws, { type: 'pong' });
    if (msg.type === 'pong') return;   // 桥主动探活的回音，收到本身就是目的（lastRx 已刷新）
    // 用户在侧栏里给 profile 改了名：不必重连，就地更新
    if (msg.type === 'meta') {
      if (extensions.has(ws) && Object.hasOwn(msg, 'profileLabel')) {
        ws.profileLabel = cleanProfileLabel(msg.profileLabel);
        log(`实例改名：${extLabel(ws)}`);
      }
      return;
    }

    // extension → agent
    if (msg.type === 'res') {
      if (!extensions.has(ws)) return;
      const ownsPending = (p) => p && p.extensionId === ws.extensionId && p.instanceId === ws.instanceId;
      let key = msg.__k;
      let p = key ? pending.get(key) : null;
      if (key) {
        // A routing key is authoritative. A replacement socket may deliver a
        // stashed reply during orphan grace only when it proves the same
        // extension+instance identity; another profile cannot guess its way in.
        if (!ownsPending(p)) return;
      } else {
        // 老版本扩展不回传路由键——退回按 id 找，但只能在当前连接承接的
        // 扩展身份承接的请求里找，不能借另一个实例的裸 id 冒充回执。
        for (const [k, v] of pending) if (v.id === msg.id && ownsPending(v)) { key = k; p = v; break; }
      }
      if (!p) return; // 已超时，丢弃
      clearTimeout(p.timer);
      clearTimeout(p.orphanTimer);   // 断线宽限期里补发回来的，正是宽限的意义
      pending.delete(key);
      if (p.internal) return p.internal(msg);
      learnTabs(p, ws, msg);
      if (msg.ok) {
        let tail = p.note || '';
        // 多 profile 时 tabs list 只列本 profile 的页——说清楚，免得 agent 以为另一个账号的页面没了
        if (p.cmd === 'tabs' && p.action === 'list' && headedCount() > 1) {
          tail += `\n(Chrome profile "${profileName(ws)}" only. Other profiles' tabs: profiles({use}) then tabs list.)`;
        }
        if (tail) {
          if (typeof msg.data === 'string') msg.data += tail;
          else if (msg.data && typeof msg.data.text === 'string') msg.data = { ...msg.data, text: msg.data.text + tail };
        }
      }
      // bytes：回执体积。回合空档中位从 5.3s 涨到 9.9s，怀疑是上下文变重，
      // 而审计里没有任何一个字段能证实或证伪——没有量就没法治。
      audit({ ev: 'res', id: key, cmd: p.cmd, ok: msg.ok, ms: Date.now() - p.startedAt, error: msg.error?.code,
        bytes: msg.ok ? JSON.stringify(msg.data ?? '').length : undefined, effect: msg.ok ? effectOf(msg.data) : undefined });
      const { __k, ...clean } = msg;
      send(p.agent, clean);
      return;
    }

    if (msg.type === 'event' && extensions.has(ws)) broadcast(msg);
  }

  // 站点白名单：默认拒绝。裁决在这里做，agent 够不着。
  // allowlist.json 不存在 = 尚未配置 = 全放行（P0 开发期），P1 改为默认拒绝。
  function checkSite(msg) {
    const url = msg.params?.url;
    if (!url) return null;
    let list;
    try {
      list = JSON.parse(fs.readFileSync(ALLOWLIST_FILE, 'utf8'));
    } catch {
      return null;
    }
    if (list.mode !== 'allowlist') return null;
    let host;
    try {
      host = new URL(url).hostname;
    } catch {
      return null;
    }
    const ok = (list.sites || []).some((s) => host === s || host.endsWith('.' + s));
    return ok ? null : { code: 'SITE_NOT_ALLOWED', message: `${host} 不在授权站点列表里，请在扩展弹窗里授权` };
  }

  function send(ws, obj) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
  }
  function broadcast(obj) {
    for (const a of agents) send(a, obj);
  }
  // 后台起的桥，stdout 已被 spawn 重定向到 bridge.log —— 所以无条件写，
  // 不能按 foreground 判断，否则后台模式下日志全丢，doctor 指着一个空文件
  function log(m) {
    console.log(`[${new Date().toLocaleTimeString('zh-CN')}] ${m}`);
  }

  const ready = new Promise((resolve) => {
    wss.on('listening', () => {
      if (writeInfo) writeBridgeInfo({ port, token, pid: process.pid, version: VERSION, startedAt: new Date().toISOString() });
      log(`桥已启动 ws://127.0.0.1:${port}`);
      resolve();
    });
  });

  wss.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      log(`端口 ${port} 已被占用——大概率已有一个桥在跑`);
      process.exit(3);
    }
    throw e;
  });

  // 被换代（版本升级）或被用户 kill 时，先把在途命令回成错误再退。
  // 不做这件事，agent 那边就是一路干等到超时——而超时默认 60s，
  // 用户看到的是「卡住了」，不是「桥重启了」。
  if (writeInfo) {
    for (const sig of ['SIGTERM', 'SIGINT']) {
      process.on(sig, () => {
        log(`收到 ${sig}，正在退出`);
        for (const [, p] of pending) {
          send(p.agent, { type: 'res', id: p.id, ok: false, error: { code: 'NO_EXTENSION', message: '桥正在重启（多半是版本升级），重试一次即可' } });
        }
        for (const c of wss.clients) c.close(1001, 'bridge shutting down');
        wss.close(() => process.exit(0));
        setTimeout(() => process.exit(0), 1000).unref();
      });
    }
  }

  const idleTimer = setInterval(() => {
    // 桥原来只在收到 close 时才知道扩展没了——可半开连接永远不发 close。
    // 扩展那侧 readyState 还停在 1、send 也不报错，两边就这么各自以为
    // 对方还在，而 agent 收到的全是 NO_EXTENSION。主动切断是为了让扩展侧的
    // onclose 真的触发，它那条重连链才跑得起来。
    //
    // 但**先问一声再杀**。静默 50 秒最常见的原因不是半开，是机器睡了一觉：
    // 9-2 上午 bridge.log 里 9 次「静默超时」逐条对上了 pmset 的暗唤醒记录，
    // 每次都是桥先醒、看到 lastRx 过期、当场 terminate，而扩展本来 1 秒后就会
    // 回心跳——白白断一次，在途命令跟着遭殃。发一条 ping，真半开的连接不会回，
    // 再等一拍才判死；只是睡过头的，pong 一到 lastRx 就刷新了。
    const now = Date.now();
    for (const e of liveExtensions()) {
      const silent = now - e.lastRx;
      if (silent <= silenceMs) { e.probedAt = 0; continue; }
      if (!e.probedAt) { e.probedAt = now; send(e, { type: 'ping' }); continue; }
      if (now - e.probedAt >= probeMs) {
        log(`扩展静默超时，探了 ${Math.round((now - e.probedAt) / 1000)}s 也没回音，判定这条连接已死（${extLabel(e)}）`);
        e.terminate();
      }
    }
    if (writeInfo && agents.size === 0 && !liveExtensions().length && Date.now() - lastActivity > IDLE_EXIT_MS) {
      log('空闲超时，桥自行退出');
      process.exit(0);
    }
  }, tickMs);
  idleTimer.unref();

  return { wss, port, token, ready, close: () => { clearInterval(idleTimer); wss.close(); for (const c of wss.clients) c.terminate(); } };
}

// 审计日志里不留敏感明文：输入的文本可能是密码、验证码
// 用户敲进页面的东西一律不进日志。
//
// 这里必须**递归**，而且是踩出来的：上一版按顶层字段逐个点名
//（params.text、params.fields[].text），而 act 把动作放在 params.steps[] 里，
// 于是整条穿过去了——实测审计里躺着 5 条疑似密码、27 个手机号的明文。
// 更糟的是 MCP 的说明文字正在教 agent「登录、多步表单、向导——全都一次说完」，
// 也就是说产品亲手把最敏感的输入引到了唯一没脱敏的那条路上。
//
// 按键名脱敏而不是按路径点名：新增一个带 text 的命令是迟早的事，
// 而下一个人不会记得回来改这里。宁可把「深圳」这种无害的 value 也脱成 <2字>，
// 也不能再漏一条密码——审计要的是「谁在什么时候做了什么」，不是内容本身。
//
// 【第二次，同一个形状】按键名脱敏还漏着一条路：**写在正文里的凭据**。
// `ask` 的 prompt 是 agent 写给人看的一段话，而 `ask` 恰恰是
//「密码我填好了、验证码你来点」这个人工接管场景的专用通道——
// 产品又一次亲手把凭据引到了没脱敏的字段上。键名脱敏对它结构性无效：
// 字段叫 prompt，而 prompt 的全部价值就是那段话，整条脱掉审计就废了。
// 补法见 extension/redact.js 的 scrubProse：按词切，只挖像凭据的词。
const SECRET_KEYS = new Set(['text', 'value', 'password', 'token', 'secret', 'code']);

function scrub(v, depth = 0) {
  if (v == null || depth > 8) return v;
  if (Array.isArray(v)) return v.map((x) => scrub(x, depth + 1));
  // 任何还没被键名接走的字符串都过一遍正文层：不点名 prompt，
  // 是因为下一个带正文的命令叫什么现在还不知道，而下一个人不会记得回来改这里
  if (typeof v !== 'object') return typeof v === 'string' ? scrubProse(v) : v;
  const out = {};
  for (const [k, val] of Object.entries(v)) {
    if (typeof val === 'string' && SECRET_KEYS.has(k)) out[k] = `<${val.length}字>`;
    // upload 的 base64 是整个文件，进日志等于把文件抄一遍
    else if (k === 'base64' && typeof val === 'string') out[k] = `<${Math.round(val.length * 0.75 / 1024)}KB>`;
    else if (k === 'expr' && typeof val === 'string' && val.length > 200) out[k] = val.slice(0, 200) + '…';
    else out[k] = scrub(val, depth + 1);
  }
  return out;
}

// 导出只为让 `npm test` 直接跑到它。这段的失效是静默的——日志照写、
// 命令照跑，只有事后翻日志才会发现密码在里面躺了一个月。
export function redact(params) {
  if (!params || typeof params !== 'object') return params;
  return scrub(params);
}
