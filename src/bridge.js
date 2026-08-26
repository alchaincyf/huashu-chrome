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

// writeInfo=false 供测试用：不写 bridge.json，否则测试桥的 token 会盖掉
// 真在跑的那个桥，用户所有 agent 会话当场断连。
export function startBridge({ port = DEFAULT_PORT, token = newToken(), writeInfo = true } = {}) {
  ensureHome();

  const agents = new Set();      // role=agent 的连接
  let extension = null;          // role=extension，同时只认一个
  // key 是「连接序号:消息id」，不是裸 id——每个 agent 进程的 id 都从 c1 开始数，
  // 只按 id 存会让两个会话的 c1 互相覆盖，响应串到别人的请求上，而且毫无征兆。
  const pending = new Map();
  let connSeq = 0;

  // 这一代桥的身份。connId 是进程内从 1 开始的递增序号，桥一重启就重头数——
  // 而扩展那边的连接级 tab 槽存在 storage.local 里，跨重启活着。
  // 不给扩展一个「换代了」的信号，新连上的第一个 agent 就会拿到 connId=1，
  // 捡到上一代同号会话的槽，并且以为那本来就是自己的。
  // 扩展拿它跟上次记的比对，一变就清槽。见 background.js 的 syncBridgeEpoch。
  //
  // 生成在这里而不是模块级：一个进程里可能起多个桥实例（测试就是这么干的），
  // 而 epoch 标识的是「这一个桥」，不是「这份代码」。
  const epoch = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  let lastActivity = Date.now();

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

      if (!ws.helloed) {
        clearTimeout(helloTimer);
        return handleHello(ws, msg);
      }
      route(ws, msg);
    });

    ws.on('close', () => {
      clearTimeout(helloTimer);
      if (agents.delete(ws)) {
        // agent 走了：让扩展清掉它的连接级槽，否则死槽会让「别人在操控」警告一直误报
        send(extension, { type: 'event', event: 'agent_closed', connId: ws.connId });
      }
      if (ws === extension) {
        extension = null;
        log('扩展断开');
        broadcast({ type: 'event', event: 'extension_offline' });
        // 扩展没了，所有在途命令立刻失败，别让 agent 干等 30 秒
        for (const [, p] of pending) {
          clearTimeout(p.timer);
          send(p.agent, { type: 'res', id: p.id, ok: false, error: { code: 'NO_EXTENSION', message: '扩展在命令执行中断开' } });
        }
        pending.clear();
      }
    });

    ws.on('error', () => {});
  });

  function handleHello(ws, msg) {
    if (msg.type !== 'hello') return ws.close(4000, 'expected hello');

    if (msg.role === 'extension') {
      if (!ws.isExtension) return ws.close(4003, 'role/origin mismatch');
      if (extension && extension.readyState === 1) extension.close(4009, 'replaced'); // 后来者接管，避免重载扩展后卡死
      extension = ws;
      ws.helloed = true;
      ws.extVersion = msg.version || '?';
      // 改了扩展代码却忘记去 chrome://extensions 重载，是这类产品最高频的故障，
      // 症状还都是些莫名其妙的行为。这里把它变成一句明确的话。
      if (ws.extVersion !== VERSION) {
        log(`⚠️  版本不一致：扩展 ${ws.extVersion} vs 桥 ${VERSION} —— 去 chrome://extensions 重载扩展`);
      }
      log(`扩展已连接（Chrome ${msg.chrome || '?'} · 扩展 ${ws.extVersion}）`);
      send(ws, { type: 'welcome', bridge: VERSION, v: PROTOCOL, epoch });
      broadcast({ type: 'event', event: 'extension_online' });
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
      log(`agent 已连接：${ws.client}`);
      send(ws, {
        type: 'welcome', bridge: VERSION, v: PROTOCOL,
        extensionOnline: !!extension,
        extensionVersion: extension?.extVersion,
        versionMismatch: !!extension && extension.extVersion !== VERSION,
      });
      return;
    }

    ws.close(4000, 'unknown role');
  }

  function route(ws, msg) {
    // agent → extension
    if (msg.type === 'cmd') {
      if (!agents.has(ws)) return;
      if (!extension || extension.readyState !== 1) {
        return send(ws, { type: 'res', id: msg.id, ok: false, error: { code: 'NO_EXTENSION', message: 'Chrome 扩展未连接——请确认 Chrome 开着、huashu-chrome 扩展已启用' } });
      }
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

      pending.set(key, { agent: ws, cmd: msg.cmd, timer, startedAt: Date.now(), id: msg.id });
      // 审计里的 id 必须全局唯一，否则 cmd 和 res 根本配不上对：
      // msg.id 是每个 agent 进程内自增的（都从 c1 开始数），实测 5381 条 cmd
      // 只有 281 个不同的 id，最多的一个出现了 1088 次。
      // 路由用的一直是 connId:id，审计却记裸 id——「出事能查」这条承诺
      // 在数据结构层面就不成立。
      audit({ ev: 'cmd', id: key, cmd: msg.cmd, client: ws.client, connId: ws.connId, params: redact(msg.params) });
      // connId 盖章：扩展据此维护每个 agent 连接自己的受控 tab 槽（多 agent 并发隔离）
      send(extension, { ...msg, __k: key, connId: ws.connId });   // __k 原样带回，用于精确路由
      return;
    }

    // extension → agent
    if (msg.type === 'res') {
      if (ws !== extension) return;
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

    if (msg.type === 'event' && ws === extension) broadcast(msg);
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
    if (agents.size === 0 && !extension && Date.now() - lastActivity > IDLE_EXIT_MS) {
      log('空闲超时，桥自行退出');
      process.exit(0);
    }
  }, 60000);
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
