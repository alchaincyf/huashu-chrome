#!/usr/bin/env node
// huashu-chrome CLI
//   mcp      给 agent 用的 MCP server（stdio）。agent 配置里填的就是这条。
//   bridge   桥 daemon。正常不用手动跑，mcp 会自己拉起。
//   doctor   诊断：这类产品的头号支持成本就是「连不上」，把排查做成一条命令。
//   extension  打印扩展路径和加载步骤
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readBridgeInfo, DEFAULT_PORT, HOME, AUDIT_FILE, LOG_FILE } from './lib/paths.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const argv = process.argv.slice(2);
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
    await install({ yes: has('--yes'), only: flag('--only', null) });
    break;
  }

  case 'doctor':
    await doctor();
    break;

  case 'extension':
    printExtension();
    break;

  case 'audit': {
    const n = Number(flag('-n', 30));
    const lines = fs.existsSync(AUDIT_FILE) ? fs.readFileSync(AUDIT_FILE, 'utf8').trim().split('\n').slice(-n) : [];
    if (!lines.length) console.log('还没有审计记录。');
    for (const l of lines) {
      const e = JSON.parse(l);
      console.log(`${e.t.slice(11, 19)}  ${(e.ev + '        ').slice(0, 8)} ${e.cmd || ''} ${e.ok === false ? '✗ ' + (e.error || '') : ''}`);
    }
    break;
  }

  default:
    console.log(`huashu-chrome — 让任何 AI agent 操控你自己的 Chrome

  huashu-chrome install        一键安装：自动配好所有 agent + 引导装扩展
  huashu-chrome mcp            启动 MCP server（agent 配置里填这条，install 会自动写）
  huashu-chrome doctor         诊断连接问题
  huashu-chrome extension      打印扩展加载步骤
  huashu-chrome audit [-n 30]  看最近的浏览器操作记录
  huashu-chrome bridge --foreground   前台跑桥（调试用）

配置目录 ${HOME}`);
}

async function doctor() {
  const ok = (s) => console.log(`  ✅ ${s}`);
  const bad = (s, fix) => { console.log(`  ❌ ${s}`); if (fix) console.log(`     → ${fix}`); };

  console.log('\nhuashu-chrome 体检\n');

  console.log('配置目录');
  fs.existsSync(HOME) ? ok(HOME) : bad(`${HOME} 不存在`, '跑一次 `huashu-chrome mcp` 会自动创建');

  console.log('\n桥');
  const info = readBridgeInfo();
  if (!info) {
    bad('桥没在跑', '不用管——agent 第一次调用浏览器工具时会自动拉起');
  } else {
    let alive = false;
    try { process.kill(info.pid, 0); alive = true; } catch {}
    alive ? ok(`pid ${info.pid} · 端口 ${info.port} · 起于 ${info.startedAt?.slice(11, 19)}`)
          : bad(`bridge.json 记着 pid ${info.pid}，但进程已经没了`, '陈旧记录，会被自动覆盖');

    if (alive) {
      const r = await probe(info);
      r.ok ? ok(`握手正常${r.extensionOnline ? ` · Chrome 扩展在线 (v${r.extensionVersion})` : ''}`) : bad('握手失败：' + r.error);
      if (r.versionMismatch) bad(`扩展版本 ${r.extensionVersion} 和 CLI 不一致`, '去 chrome://extensions 点重载，再刷新目标页面');
      if (r.ok && !r.extensionOnline) {
        // 这一句原先只说「确认扩展已启用」，而它最常见的原因根本不是没启用：
        // Chrome 会回收扩展的后台进程，桥这边就表现为「没连上」。先说这个，
        // 免得用户一上来就去重载一个其实好好的扩展。
        bad('Chrome 扩展这会儿没连着桥',
          '多半是 Chrome 回收了扩展的后台进程——去浏览器里点开任意页面，几秒后再跑一次 doctor。'
          + '还是不行再看：Chrome 开着吗、扩展启用了吗、改过扩展代码没去 chrome://extensions 重载？');
      }
    }
  }

  console.log('\n扩展');
  const mf = path.join(ROOT, 'extension', 'manifest.json');
  fs.existsSync(mf) ? ok(path.join(ROOT, 'extension')) : bad('扩展目录缺失', '重装 huashu-chrome');

  console.log('\n日志');
  console.log(`  桥日志   ${LOG_FILE}`);
  console.log(`  操作审计 ${AUDIT_FILE}   （huashu-chrome audit 查看）`);
  console.log('');
}

function probe(info) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${info.port}`);
    const t = setTimeout(() => { ws.close(); resolve({ ok: false, error: '超时' }); }, 3000);
    ws.onerror = () => { clearTimeout(t); resolve({ ok: false, error: '连接被拒' }); };
    ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', role: 'agent', token: info.token, client: 'doctor', v: 1 }));
    ws.onmessage = (ev) => {
      clearTimeout(t);
      const m = JSON.parse(ev.data);
      ws.close();
      resolve(m.type === 'welcome'
        ? { ok: true, extensionOnline: m.extensionOnline, extensionVersion: m.extensionVersion, versionMismatch: m.versionMismatch }
        : { ok: false, error: JSON.stringify(m) });
    };
  });
}

function printExtension() {
  const dir = path.join(ROOT, 'extension');
  console.log(`
扩展加载步骤（开发期用「加载已解压的扩展程序」，上架后从商店装）

  1. Chrome 打开  chrome://extensions
  2. 右上角打开「开发者模式」
  3. 点「加载已解压的扩展程序」，选这个目录：

     ${dir}

  4. 装好后扩展会自动连桥。跑 huashu-chrome doctor 应该看到「Chrome 扩展在线」
`);
}
