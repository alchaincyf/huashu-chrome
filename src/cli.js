#!/usr/bin/env node
// huashu-chrome CLI
//   mcp      给 agent 用的 MCP server（stdio）。agent 配置里填的就是这条。
//   bridge   桥 daemon。正常不用手动跑，mcp 会自己拉起。
//   doctor   诊断：这类产品的头号支持成本就是「连不上」，把排查做成一条命令。
//   extension  打印扩展路径和加载步骤
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readBridgeInfo, DEFAULT_PORT, HOME, AUDIT_FILE, LOG_FILE } from './lib/paths.js';
import { VERSION } from './lib/version.js';
import { createTranslator, parseLanguageArgs, resolveLocale } from './lib/i18n.js';
import { cliMessages } from './locales/cli.js';
import { compat, compatNote } from '../extension/compat.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
let parsedArgs;
try {
  parsedArgs = parseLanguageArgs(process.argv.slice(2));
} catch {
  const t = createTranslator(cliMessages, resolveLocale());
  console.error(t('invalidLanguage'));
  process.exit(1);
}
const { args: argv, locale } = parsedArgs;
const t = createTranslator(cliMessages, locale);
const cmd = argv[0];
const flag = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? (argv[i + 1]?.startsWith('--') ? true : argv[i + 1]) : d; };
const has = (k) => argv.includes(k);

switch (cmd) {
  case 'mcp': {
    const { startMcpServer } = await import('./mcp-server.js');
    // stdio 是 MCP 的传输通道，任何 console.log 都会污染协议流。全部日志走 stderr。
    await startMcpServer({ client: flag('--client', 'unknown') });
    break;
  }

  case 'bridge': {
    const { startBridge } = await import('./bridge.js');
    startBridge({ port: Number(flag('--port', DEFAULT_PORT)), foreground: has('--foreground') });
    break;
  }

  // 手动发一条命令，开发和排错时不用绕道 agent
  //   huashu-chrome call snapshot
  //   huashu-chrome call tabs '{"action":"new","url":"https://example.com"}'
  case 'call': {
    // learnings 是纯本地读写，不需要桥和浏览器
    if (argv[1] === 'learnings') {
      const { getLearnings, saveLearnings } = await import('./lib/learnings.js');
      const p = argv[2] ? JSON.parse(argv[2]) : {};
      console.log(p.save != null ? saveLearnings(p.domain, p.save) : getLearnings(p.domain));
      break;
    }
    const { BridgeClient } = await import('./lib/rpc.js');
    const c = new BridgeClient({ client: 'cli' });
    await c.connect();
    const params = argv[2] ? JSON.parse(argv[2]) : {};
    if (argv[1] === 'upload' && params.path) {
      const buf = fs.readFileSync(params.path);
      const ext = path.extname(params.path).toLowerCase();
      params.type = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' }[ext] || 'application/octet-stream';
      params.name = path.basename(params.path);
      params.base64 = buf.toString('base64');
      delete params.path;
    }
    try {
      const data = await c.call(argv[1], params, { tabId: params.tabId });
      // download 走浏览器原生下载，文件先落在 Chrome 的下载目录，再挪到 savePath。
      // 不做这一步，CLI 路径的 savePath 会被静默忽略——工具报成功，文件却不在承诺的位置。
      if (data?.path && params.savePath) {
        fs.mkdirSync(path.dirname(params.savePath), { recursive: true });
        fs.renameSync(data.path, params.savePath);
        console.log(`${Math.round((data.bytes || 0) / 1024)}KB → ${params.savePath}`);
        process.exit(0);
      }
      if (data?.base64) {
        const out = params.savePath || path.join(process.cwd(), `download-${Date.now()}`);
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.writeFileSync(out, Buffer.from(data.base64, 'base64'));
        console.log(`${Math.round(data.bytes / 1024)}KB ${data.ct} → ${out}`);
        process.exit(0);
      }
      // 截图不往终端里倒 base64——落盘并报路径
      if (data?.dataUrl) {
        const out = params.savePath || path.join(process.cwd(), `screenshot-${Date.now()}.png`);
        fs.writeFileSync(out, Buffer.from(data.dataUrl.split(',')[1], 'base64'));
        console.log(out);
        process.exit(0);
      }
      // stdout 是异步的：console.log 一个大字符串后立刻 process.exit，没写完的部分会被
      // 静默丢弃。167KB 的接口响应就是这样被截成 61KB 的，而且 JSON 只是"看起来"损坏，
      // 不会有任何报错。必须等写入回调再退。
      const text = typeof data === 'string' ? data : (data.text ?? JSON.stringify(data, null, 2));
      process.stdout.write(text + '\n', () => process.exit(0));
      break;
    } catch (e) {
      console.error(`[${e.code || 'INTERNAL'}] ${e.message}`);
      process.exit(1);
    }
  }

  case 'install': {
    const { install } = await import('./install.js');
    await install({ yes: !has('--dry-run'), only: flag('--only', null), locale });
    break;
  }

  case 'doctor':
    await doctor();
    break;

  case 'extension':
    printExtension();
    // --reveal：在访达 / 资源管理器里选中扩展文件夹，用户拖进 chrome://extensions 就装好了。
    // 引导页故意不放本机路径（它每台机器都不一样，还常常躺在 npx 缓存里），
    // 「路径」这件事交给终端和文件管理器，页面只教手势。
    if (has('--reveal')) revealExtensionDir();
    break;

  case 'audit': {
    if (has('--stats')) { auditStats(Number(flag('--days', 7)), t); break; }
    const n = Number(flag('-n', 30));
    const lines = fs.existsSync(AUDIT_FILE) ? fs.readFileSync(AUDIT_FILE, 'utf8').trim().split('\n').slice(-n) : [];
    if (!lines.length) console.log(t('noAuditRecords'));
    for (const l of lines) {
      const e = JSON.parse(l);
      console.log(`${e.t.slice(11, 19)}  ${(e.ev + '        ').slice(0, 8)} ${e.cmd || ''} ${e.ok === false ? '✗ ' + (e.error || '') : ''}`);
    }
    break;
  }

  default:
    console.log(`${t('helpTitle')}

  huashu-chrome install        ${t('helpInstall')}
  huashu-chrome mcp            ${t('helpMcp')}
  huashu-chrome doctor         ${t('helpDoctor')}
  huashu-chrome extension      ${t('helpExtension')}
  huashu-chrome audit [-n 30]  ${t('helpAudit')}
  huashu-chrome audit --stats [--days 7]   ${t('helpAuditStats')}
  huashu-chrome bridge --foreground   ${t('helpBridge')}
  huashu-chrome install --dry-run     ${t('helpDryRun')}
  huashu-chrome --lang en|zh-CN       ${t('helpLanguage')}

${t('configDirectory')} ${HOME}`);
}

async function doctor() {
  const ok = (s) => console.log(`  ✅ ${s}`);
  const bad = (s, fix) => { console.log(`  ❌ ${s}`); if (fix) console.log(`     → ${fix}`); };

  console.log(`\n${t('doctorTitle')}\n`);

  console.log(t('configDirectory'));
  fs.existsSync(HOME) ? ok(HOME) : bad(`${HOME} ${t('missing')}`, t('createHomeHint'));

  console.log(`\n${t('bridge')}`);
  let info = readBridgeInfo();
  let alive = false;
  if (info) { try { process.kill(info.pid, 0); alive = true; } catch {} }
  if (!alive) {
    // 桥没跑时以前直接放弃探测，打一句「不用管」然后接着「扩展 ✅」——新机器上
    // 装完扩展跑 doctor 看到的就是这个假绿，引导页承诺的「扩展在线」永远看不到。
    // 桥本来就是谁先用谁拉起的，doctor 自己拉一个再探，才探得到真相。
    console.log(`  ·  ${t('bridgeStarting', { stalePid: info ? t('bridgeStalePid', { pid: info.pid }) : '' })}`);
    const { tryStartBridge } = await import('./lib/rpc.js');
    tryStartBridge();
    const until = Date.now() + 6000;
    while (Date.now() < until) {
      await new Promise((r) => setTimeout(r, 300));
      info = readBridgeInfo();
      if (info?.pid) { try { process.kill(info.pid, 0); alive = true; break; } catch {} }
    }
    if (!alive) {
      bad(t('bridgeCouldNotStart'), t('bridgeStartDetails', { log: LOG_FILE, port: DEFAULT_PORT }));
    }
  }
  if (alive) {
    ok(t('bridgePid', { pid: info.pid, port: info.port, startedAt: info.startedAt ? new Date(info.startedAt).toLocaleTimeString(locale, { hour12: false }) : '?' }));
    {
      const r = await probe(info, t);
      r.ok ? ok(`${t('handshakeOk')}${r.extensionOnline ? ` · ${t('extensionOnline', { version: r.extensionVersion })}` : ''}`) : bad(t('handshakeFailed', { error: r.error }));
      if (r.extensionVersion) {
        const level = compat({ ext: r.extensionVersion, cli: VERSION, extProtocol: r.extensionProtocol });
        if (level === 'protocol' || level === 'ext-old' || level === 'cli-old') bad(compatNote(level, { ext: r.extensionVersion, cli: VERSION, locale }));
        else if (level === 'patch') ok(t('patchCompatible', { ext: r.extensionVersion, cli: VERSION }));
      }
      // 多个 Chrome 实例连着不再是故障（桥按实例路由），但必须说出来：
      // 「命令为什么跑到另一个窗口去了」只有这一处看得见。
      if ((r.extensions || []).length > 1) {
        console.log(`  ℹ️  ${t('multipleInstances', { count: r.extensions.length })}`);
        for (const e of r.extensions) {
          console.log(`       ${t('chromeInstance', {
            arrow: e.primary ? '→' : ' ', chrome: e.chrome, version: e.version,
            headless: e.headless ? t('headless') : '', primary: e.primary ? t('primaryInstance') : '',
          })}`);
        }
        if (r.extensions.some((e) => e.headless)) {
          console.log(`       ${t('headlessOrphan')}`);
        }
      }
      if (r.ok && !r.extensionOnline) {
        // 话术和 popup、mcp-server 的 hint 一致：首选动作是弹窗里的「重连」。
        // 「去浏览器点开任意页面」对半开连接是错的——半开时 offscreen 自认为在线，
        // 不会因为你开了个页面就重连；「去 chrome://extensions」则把人引向重装。
        bad(t('extensionNotConnected'), `${t('reconnectHint')} ${t('missingIconHint')}`);
      }
    }
  }

  console.log(`\n${t('extensions')}`);
  const mf = path.join(ROOT, 'extension', 'manifest.json');
  fs.existsSync(mf)
    ? ok(t('extensionDirectoryPresent', { directory: path.join(ROOT, 'extension') }))
    : bad(t('extensionDirectoryMissing'), t('reinstall'));

  // bridge.log 里最近一次断连：用户体感的「插件消失」到底是什么时候、断了多久
  try {
    const lines = fs.readFileSync(LOG_FILE, 'utf8').trim().split('\n').slice(-400);
    let lastDown = null, lastUp = null;
    for (const l of lines) {
      if (l.includes('扩展断开')) lastDown = l.slice(1, 9);
      else if (l.includes('扩展已连接')) lastUp = l.slice(1, 9);
    }
    if (lastDown) console.log(t('recentDisconnect', { down: lastDown, up: lastUp ? t('connectedAt', { time: lastUp }) : t('neverReconnected') }));
  } catch { /* 没日志就没日志 */ }

  // 经验库里 agent 记下的「huashu-chrome 的 X 不生效」——产品 bug 住在经验库里，
  // 没有这一栏就永远回不到开发者手上（screenshot 的 savePath 就是这么躺了一周的）
  try {
    const { LEARNINGS_DIR } = await import('./lib/learnings.js');
    const hits = [];
    for (const f of fs.readdirSync(LEARNINGS_DIR)) {
      if (!f.endsWith('.md')) continue;
      for (const line of fs.readFileSync(path.join(LEARNINGS_DIR, f), 'utf8').split('\n')) {
        if (/huashu-chrome/.test(line) && /不生效|无效|没实现|不工作|静默|bug|坏了|绕过|绕法/i.test(line)) hits.push(`${f}: ${line.trim().slice(0, 110)}`);
        if (hits.length >= 6) break;
      }
    }
    if (hits.length) {
      console.log(`\n${t('learningsHeading')}`);
      for (const h of hits) console.log(`  ·  ${h}`);
    }
  } catch { /* 没有经验目录 */ }

  console.log(`\n${t('logs')}`);
  console.log(t('bridgeLog', { path: LOG_FILE }));
  console.log(t('auditLog', { path: AUDIT_FILE }));
  console.log('');
}

// 真实 agent 的用法统计。v0.8 规划就说该固化，每次评审都得重写一遍脚本。
// 口径：排除 test/cli 类客户端，按命令计数、算相邻二元组、算命令之间的空档
// （≈模型回合）。「同一件事的 eval 次数有没有少、snapshot→snapshot 有没有少」
// 是感知层改动唯一的验收方式——执行变快在这里毫无意义。
function auditStats(days, t) {
  if (!fs.existsSync(AUDIT_FILE)) return console.log(t('noStatsAudit'));
  const since = Date.now() - days * 86400000;
  const rows = [];
  for (const l of fs.readFileSync(AUDIT_FILE, 'utf8').split('\n')) {
    if (!l) continue;
    try { const r = JSON.parse(l); if (Date.parse(r.t) >= since) rows.push(r); } catch { /* 坏行跳过 */ }
  }
  const isReal = (c) => c && !/^(test|cli|doctor|probe|dbg|smoke|live|stamp|agent-|old-|stayer|reloader|cleanup|c$)/.test(c);
  // cmd/res 按出现顺序配对，不按 id 建全局表：id 是「连接序号:消息号」，
  // 桥每重启一次序号就从 1 重数，全局表会让上周的 res 配到这周的 cmd 上
  const cmds = [];
  const res = new Map();
  const open = new Map();
  for (const r of rows) {
    if (r.ev === 'cmd') { if (isReal(r.client)) { cmds.push(r); open.set(r.id, r); } }
    else if (r.ev === 'res' && open.has(r.id)) { res.set(open.get(r.id), r); open.delete(r.id); }
  }
  if (!cmds.length) return console.log(t('noRealAgentCalls', { days }));

  const count = new Map();
  for (const r of cmds) count.set(r.cmd, (count.get(r.cmd) || 0) + 1);
  const bySid = new Map();
  for (const r of cmds) { if (!bySid.has(r.sid)) bySid.set(r.sid, []); bySid.get(r.sid).push(r); }
  const bigrams = new Map();
  const gaps = [];
  for (const list of bySid.values()) {
    list.sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
    for (let i = 1; i < list.length; i++) {
      const a = list[i - 1], b = list[i];
      const k = `${a.cmd}→${b.cmd}`;
      bigrams.set(k, (bigrams.get(k) || 0) + 1);
      const g = (Date.parse(b.t) - Date.parse(a.t) - (res.get(a)?.ms || 0)) / 1000;
      if (g > 0 && g < 600) gaps.push(g);
    }
  }
  gaps.sort((a, b) => a - b);
  const pct = (p) => gaps.length ? gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * p))].toFixed(1) : '-';
  const ms = new Map();
  let bytes = 0, bytesN = 0;
  for (const r of cmds) {
    const rr = res.get(r);
    if (!rr) continue;
    if (rr.ms !== undefined) { if (!ms.has(r.cmd)) ms.set(r.cmd, []); ms.get(r.cmd).push(rr.ms); }
    if (rr.bytes !== undefined) { bytes += rr.bytes; bytesN++; }
  }
  const med = (arr) => { const s = [...arr].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
  const writes = ['click', 'type', 'select', 'fill', 'key', 'navigate'].reduce((n, c) => n + (count.get(c) || 0), 0);
  const act = count.get('act') || 0;
  const evalN = count.get('eval') || 0;

  console.log(t('statsHeader', { days, calls: cmds.length, sessions: bySid.size }));
  console.log(t('commandDistribution'));
  for (const [c, n] of [...count.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${c.padEnd(12)} ${String(n).padStart(5)}  ${(100 * n / cmds.length).toFixed(1).padStart(5)}%  ${ms.has(c) ? String(med(ms.get(c))).padStart(6) : '     -'}`);
  }
  console.log(t('turnGaps', { median: pct(0.5), p90: pct(0.9), count: gaps.length }));
  console.log(t('actEvalStats', {
    act, total: act + writes, share: act + writes ? (100 * act / (act + writes)).toFixed(1) : 0,
    evalCount: evalN, evalShare: (100 * evalN / cmds.length).toFixed(1),
  }));
  if (bytesN) console.log(t('responseSize', { size: Math.round(bytes / bytesN / 1024), count: bytesN }));
  console.log(t('bigramsHeading'));
  for (const [k, n] of [...bigrams.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) console.log(`  ${k.padEnd(24)} ${n}`);
  const errs = new Map();
  for (const r of cmds) { const rr = res.get(r); if (rr && rr.ok === false) { const k = `${r.cmd} ${rr.error || ''}`; errs.set(k, (errs.get(k) || 0) + 1); } }
  if (errs.size) {
    console.log(t('errorsHeading'));
    for (const [k, n] of [...errs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log(`  ${k.padEnd(28)} ${n}`);
  }
  // 1.3 起写操作回执带效果类别：none（真没反应）该越来越少，request-only 是以前会被误判的那批
  const eff = new Map();
  for (const r of cmds) { const e = res.get(r)?.effect; if (e) eff.set(e, (eff.get(e) || 0) + 1); }
  if (eff.size) {
    console.log(t('effectsHeading'));
    for (const [k, n] of [...eff.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(18)} ${n}`);
  }
  const lrn = cmds.filter((r) => r.cmd === 'learnings');
  if (lrn.length) {
    const adopt = lrn.filter((r) => r.params?.adopt).length, save = lrn.filter((r) => r.params?.save).length;
    console.log(t('learningsStats', { count: lrn.length, saved: save, adopted: adopt }));
  }
  console.log('');
}

function probe(info, t) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${info.port}`);
    const timeout = setTimeout(() => { ws.close(); resolve({ ok: false, error: t('probeTimeout') }); }, 3000);
    ws.onerror = () => { clearTimeout(timeout); resolve({ ok: false, error: t('probeConnectionRefused') }); };
    ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', role: 'agent', token: info.token, client: 'doctor', v: 1 }));
    ws.onmessage = (ev) => {
      clearTimeout(timeout);
      const m = JSON.parse(ev.data);
      ws.close();
      resolve(m.type === 'welcome'
        ? { ok: true, extensionOnline: m.extensionOnline, extensionVersion: m.extensionVersion, extensionProtocol: m.extensionProtocol, versionMismatch: m.versionMismatch, extensions: m.extensions || [] }
        : { ok: false, error: JSON.stringify(m) });
    };
  });
}

function printExtension() {
  const dir = path.join(ROOT, 'extension');
  console.log(t('extensionInstructions', {
    storeUrl: 'https://chromewebstore.google.com/detail/foiljmaplphdfimfcnfdpekhdnfbgfbf',
    directory: dir,
  }));
}

function revealExtensionDir() {
  const dir = path.join(ROOT, 'extension');
  try {
    if (process.platform === 'darwin') spawn('open', ['-R', dir], { detached: true, stdio: 'ignore' }).unref();
    else if (process.platform === 'win32') spawn('explorer', ['/select,' + dir], { detached: true, stdio: 'ignore' }).unref();
    else spawn('xdg-open', [path.dirname(dir)], { detached: true, stdio: 'ignore' }).unref();
  } catch { /* 打不开就算了，路径已经印在上面 */ }
}
