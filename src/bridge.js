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
const PROTOCOL = 1;
const HELLO_TIMEOUT = 5000;
const CMD_TIMEOUT = 30000;
const IDLE_EXIT_MS = 30 * 60 * 1000; // 半小时没人用就自己退，别留僵尸进程
const EXT_SILENCE_MS = 50000;        // 扩展每 15 秒一次心跳，连着三拍没到就是死了

// writeInfo=false 供测试用：不写 bridge.json，否则测试桥的 token 会盖掉
// 真在跑的那个桥，用户所有 agent 会话当场断连。
export function startBridge({ port = DEFAULT_PORT, token = newToken(), writeInfo = true } = {}) {
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
  const NO_EXT_MSG = '扩展没连上。Chrome 会回收扩展的后台进程，通常几秒内自己回来，'
    + `所以桥已经替你等过一轮（最多 ${WAIT_MAX / 1000}s）。仍然没回来的话，多半是 Chrome 没开、`
    + '扩展被停用，或者改过扩展代码后忘了去 chrome://extensions 点重载。';

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
  const extLabel = (ws) => `Chrome ${ws.chromeVersion || '?'}${ws.headless ? ' · headless' : ''} · 扩展 ${ws.extVersion}`;

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
    ws.isExtension = typeof origin === 'string' && origin.startsWith('chrome-extension://');
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
        // 只失败**这条连接**承接的在途命令。别的实例还在正常干活，
        // 一起清掉就是误伤——单槽时代不存在这个区分，多实例下必须有。
        for (const [k, p] of pending) {
          if (p.ext !== ws) continue;
          clearTimeout(p.timer);
          pending.delete(k);
          send(p.agent, { type: 'res', id: p.id, ok: false, error: { code: 'NO_EXTENSION', message: '扩展在命令执行中断开' } });
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
      ws.chromeVersion = msg.chrome || '?';
      ws.headless = !!msg.headless;
      // 老扩展不报 instanceId。退回按扩展 id 认——行为和单槽那版一样
      // （同一份代码的两个实例仍会互相替换），但至少不会跟新扩展混着算。
      ws.instanceId = msg.instanceId || `ext:${msg.extId || '?'}`;

      // 同一个实例又连了一条：那是断线重连或重载扩展，旧的那条已经是死的，
      // 顶掉它。**只顶同实例的**——顶错了就退回单槽，每秒互踢的老毛病就回来了。
      for (const old of extensions) {
        if (old.instanceId === ws.instanceId && old !== ws) {
          extensions.delete(old);
          if (old.readyState === 1) old.close(4009, 'replaced');
        }
      }
      extensions.add(ws);

      // 改了扩展代码却忘记去 chrome://extensions 重载，是这类产品最高频的故障，
      // 症状还都是些莫名其妙的行为。这里把它变成一句明确的话。
      if (ws.extVersion !== VERSION) {
        log(`⚠️  版本不一致：扩展 ${ws.extVersion} vs 桥 ${VERSION} —— 去 chrome://extensions 重载扩展`);
      }
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
      // 会话身份由 agent 自己带来，跨桥重启稳定。老客户端不带，退回连接序号——
      // 行为和以前一样（桥一重启就丢槽），但至少不会串到别人的槽上。
      ws.sid = msg.sessionId || `conn:${ws.connId}`;
      log(`agent 已连接：${ws.client}（会话 ${ws.sid}）`);
      const ext = primary();
      send(ws, {
        type: 'welcome', bridge: VERSION, v: PROTOCOL,
        extensionOnline: !!ext,
        extensionVersion: ext?.extVersion,
        versionMismatch: !!ext && ext.extVersion !== VERSION,
        // 多实例是诊断信息，不是故障。doctor 要能说出「有两个 Chrome 连着」，
        // 否则「命令跑到另一个窗口去了」这种事只能靠猜。
        extensions: liveExtensions().map((e) => ({
          chrome: e.chromeVersion, version: e.extVersion, headless: e.headless, primary: e === ext,
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
      const target = primary();
      if (!target) return enqueue(ws, msg);
      return dispatch(ws, msg, target);
    }

    // extension → agent
    return routeBack(ws, msg);
  }

  // 扩展不在时先挂起，等它回来（或等到窗口用完）。
  // 窗口取「调用方自己声明的 timeout」和 WAIT_MAX 里更小的那个——
  // 调用方说只等 300ms，桥就不该替它等 40 秒，那只是换了个姿势干等。
  function enqueue(ws, msg) {
    const fail = () => send(ws, { type: 'res', id: msg.id, ok: false, error: { code: 'NO_EXTENSION', message: NO_EXT_MSG } });
    if (waiting.length >= WAIT_CAP) return fail();

    const ms = Math.min(Number(msg.timeout) || WAIT_MAX, WAIT_MAX);
    const item = { ws, msg };
    item.timer = setTimeout(() => {
      const i = waiting.indexOf(item);
      if (i >= 0) waiting.splice(i, 1);
      fail();
    }, ms);
    waiting.push(item);
    // 排队本身要留痕：否则「这条命令为什么慢了 8 秒」在审计里是查不出来的
    audit({ ev: 'queued', id: `${ws.connId}:${msg.id}`, cmd: msg.cmd, client: ws.client, waitMs: ms });
  }

  // 扩展一连上就把队列放出去。丢掉那些 agent 已经走掉的——
  // 往一个关闭的连接上回包不会报错，只会静默地什么都没发生。
  function flushWaiting() {
    const q = waiting.splice(0);
    for (const it of q) {
      clearTimeout(it.timer);
      if (agents.has(it.ws) && it.ws.readyState === 1) dispatch(it.ws, it.msg);
    }
    if (q.length) log(`扩展回来了，补发 ${q.length} 条排队的命令`);
  }

  function dispatch(ws, msg, target = primary()) {
    if (!target) return enqueue(ws, msg);
    const gate = checkSite(msg);
    if (gate) {
      audit({ ev: 'blocked', cmd: msg.cmd, client: ws.client, reason: gate.code });
      return send(ws, { type: 'res', id: msg.id, ok: false, error: gate });
    }

    // 下载、上传这类命令天然比一次点击慢得多，让调用方自己说要等多久
    const ms = Math.min(Math.max(Number(msg.timeout) || CMD_TIMEOUT, 1000), 600000);
    const key = `${ws.connId}:${msg.id}`;
    const timer = setTimeout(() => {
      pending.delete(key);
      send(ws, { type: 'res', id: msg.id, ok: false, error: { code: 'TIMEOUT', message: `扩展 ${Math.round(ms / 1000)}s 未响应` } });
    }, ms);

    // 记下**是哪个实例接的**：它断线时只该失败自己承接的这些，别误伤其他实例
    pending.set(key, { agent: ws, ext: target, cmd: msg.cmd, timer, startedAt: Date.now(), id: msg.id });
    // 审计里的 id 必须全局唯一，否则 cmd 和 res 根本配不上对：
    // msg.id 是每个 agent 进程内自增的（都从 c1 开始数），实测 5381 条 cmd
    // 只有 281 个不同的 id，最多的一个出现了 1088 次。
    // 路由用的一直是 connId:id，审计却记裸 id——「出事能查」这条承诺
    // 在数据结构层面就不成立。
    audit({ ev: 'cmd', id: key, cmd: msg.cmd, client: ws.client, sid: ws.sid, params: redact(msg.params) });
    // sid 盖章：扩展据此维护每个会话自己的受控 tab 槽（多 agent 并发隔离）。
    // live 是此刻还连着的会话，扩展拿它判断某个标签页「还有没有主」。
    // client 是给人看的：页面上的控制标记要写出「Claude Code」而不是一串 sid。
    send(target, { ...msg, __k: key, sid: ws.sid, client: ws.client, live: liveSessions() });   // __k 原样带回，用于精确路由
  }

  function routeBack(ws, msg) {
    // 扩展的保活心跳。以前这条消息掉进下面的分支里被默默丢掉，桥从不回应——
    // 而 Chrome 是靠 WebSocket 的**收发**活动去续 service worker 的空闲计时的，
    // 单向发等于只续了一半。回一条 pong，让扩展那侧也有「收到」这个事件。
    if (msg.type === 'ping') return send(ws, { type: 'pong' });

    // extension → agent
    if (msg.type === 'res') {
      if (!extensions.has(ws)) return;
      let key = msg.__k;
      let p = key ? pending.get(key) : null;
      if (!p) {
        // 老版本扩展不回传路由键——退回按 id 找，单会话下仍能工作
        for (const [k, v] of pending) if (v.id === msg.id) { key = k; p = v; break; }
      }
      if (!p) return; // 已超时，丢弃
      clearTimeout(p.timer);
      pending.delete(key);
      audit({ ev: 'res', id: key, cmd: p.cmd, ok: msg.ok, ms: Date.now() - p.startedAt, error: msg.error?.code });
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
    for (const e of liveExtensions()) {
      if (Date.now() - e.lastRx > EXT_SILENCE_MS) {
        log(`扩展静默超时，判定这条连接已死（${extLabel(e)}）`);
        e.terminate();
      }
    }
    if (agents.size === 0 && !liveExtensions().length && Date.now() - lastActivity > IDLE_EXIT_MS) {
      log('空闲超时，桥自行退出');
      process.exit(0);
    }
  }, 20000);
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
