// 一键安装：把 6 步压成 1 步。
//
// 这个文件服务的是「素未谋面的用户，在他自己那台机器上」——
// 可能是 Windows，可能用 nvm 管 node，可能一个 agent 都没装，
// 可能装的 agent 我们还没听说过。所以这里的每一处都不假设环境，
// 探测不到就说清楚，绝不猜。
//
// 一条铁律：**绝不静默改用户的配置文件**。先展示要做什么，备份，再写。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const H = os.homedir();
const WIN = process.platform === 'win32';
const MAC = process.platform === 'darwin';

// ---------- 配置文件位置：每个平台都不一样，一个都不能想当然 ----------

function appData() {
  if (WIN) return process.env.APPDATA || path.join(H, 'AppData', 'Roaming');
  if (MAC) return path.join(H, 'Library', 'Application Support');
  return process.env.XDG_CONFIG_HOME || path.join(H, '.config');
}

// 已知 agent 表放在 agents.json 里，加一个不用改代码。
// 但表永远追不上新产品，所以还有自动发现兜底——见 discover()。
const SPEC = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'agents.json'), 'utf8'));

const expand = (p) => p
  .replace(/^~/, H)
  .replace(/^\$APPDATA/, appData())
  .split('/').join(path.sep);

function knownAgents() {
  return SPEC.agents.map((a) => ({
    ...a,
    file: a.paths.map(expand).find((f) => fs.existsSync(f)) || null,
  }));
}

// 自动发现：在 home 的点目录里翻常见的 MCP 配置文件名。
// 这是这套设计的关键——国产 agent 一个月冒一个，硬编码列表永远追不上，
// 但只要它遵循 {mcpServers:{}} 这个惯例（实测所有主流产品都遵循），就能被认出来。
function discover(knownFiles) {
  const out = [];
  // 排除范围要用表里**所有候选路径**算，不能只用「命中的那个」。
  // 同一个 agent 常有多个配置位置：Claude Code 既读 ~/.claude.json 也读
  // ~/.claude/mcp.json，命中前者之后，后者还是会被当成一个叫「claude」的
  // 新 agent 发现出来——用户看到同一个产品列两遍，还被写两份配置。
  const claimed = new Set();
  for (const a of SPEC.agents) {
    for (const f of a.paths.map(expand)) {
      claimed.add(f);
      claimed.add(path.dirname(f));
    }
  }
  let entries = [];
  try { entries = fs.readdirSync(H, { withFileTypes: true }); } catch { return out; }

  for (const e of entries) {
    if (!e.isDirectory() || !e.name.startsWith('.')) continue;
    if (SPEC._discovery.skipDirs.includes(e.name)) continue;
    for (const fname of SPEC._discovery.filenames) {
      const f = path.join(H, e.name, ...fname.split('/'));
      if (knownFiles.has(f) || claimed.has(f) || claimed.has(path.dirname(f))) continue;
      if (!fs.existsSync(f) || out.some((o) => o.file === f)) continue;
      if (!looksLikeMcp(f)) continue;
      out.push({
        name: e.name.replace(/^\./, ''),
        client: e.name.replace(/^\./, ''),
        kind: f.endsWith('.toml') ? 'toml' : 'json',
        file: f,
        discovered: true,
      });
    }
  }
  return out;
}

// padEnd 数的是码元，而中日韩字符在终端里占两格 —— 直接用它，
// 带中文名的那几行永远是歪的。这个工具的用户里中文名 agent 不少。
function pad(s, width) {
  let w = 0;
  for (const ch of s) w += /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/.test(ch) ? 2 : 1;
  return s + ' '.repeat(Math.max(0, width - w));
}

function looksLikeMcp(f) {
  try {
    const raw = fs.readFileSync(f, 'utf8');
    if (!/"mcpServers"|\[mcp_servers/.test(raw)) return false;
    if (f.endsWith('.json')) JSON.parse(raw);   // 坏 JSON 不碰
    return true;
  } catch {
    return false;
  }
}

// ---------- 启动方式：优先 npx，因为它跟着版本走且到处都有 ----------

const FROM_NPM = ROOT.includes(`${path.sep}node_modules${path.sep}`);

// process.execPath 常常是 /opt/homebrew/Cellar/node/26.0.0/bin/node 或
// ~/.nvm/versions/node/v22.1.0/bin/node 这种带版本号的真实路径——node 一升级它就消失，
// 所有 agent 同时失联，报错还只会说「命令不存在」。优先用 PATH 里的稳定入口。
function nodeBin() {
  try {
    const out = execFileSync(WIN ? 'where' : 'which', ['node'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const first = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
    // 路径里带版本号的（nvm / homebrew Cellar / volta）不要，它们会随升级失效
    if (first && fs.existsSync(first) && !/[\\/]v?\d+\.\d+\.\d+[\\/]/.test(first)) return first;
  } catch { /* PATH 里找不到就退回真实路径，总比不能跑强 */ }
  return process.execPath;
}

function launcher(client) {
  if (FROM_NPM) return { command: WIN ? 'npx.cmd' : 'npx', args: ['-y', 'huashu-chrome', 'mcp', '--client', client] };
  return { command: nodeBin(), args: [path.join(ROOT, 'src', 'cli.js'), 'mcp', '--client', client] };
}

// ---------- 主流程 ----------

// yes 默认 true：README 承诺的是「一条命令」，而以前不加 --yes 只打印计划——
// 新用户照着 README 跑完发现什么都没写，第二条命令才是真的。备份照做，
// 「绝不静默改配置」靠的是先备份再写、每一处都打印出来，不是靠让人跑两遍。
// 想只看不写，用 --dry-run。
export async function install({ yes = true, only = null } = {}) {
  console.log('\nhuashu-chrome 安装\n');

  const all = knownAgents().filter((a) => a.file);
  const discovered = discover(new Set(all.map((a) => a.file)));
  let found = [...all, ...discovered];

  if (only) {
    found = found.filter((a) => a.client === only);
    if (!found.length) {
      console.log(`  这台机器上没找到 ${only}。检测到的有：${[...all, ...discovered].map((a) => a.client).join(' / ') || '（无）'}\n`);
      return;
    }
  }

  if (!found.length) {
    console.log('  没在这台机器上找到任何 agent 的 MCP 配置。\n');
    console.log('  已知的会自动配置：' + SPEC.agents.map((a) => a.name).join('、'));
    console.log('  没列出来的 agent 也会被自动发现，只要它把 MCP 配置写在 ~/.<名字>/ 下。\n');
    console.log('  都不匹配的话，把下面这段填进它的 MCP 配置：\n');
    console.log('    ' + JSON.stringify({ mcpServers: { 'huashu-chrome': launcher('custom') } }, null, 2).split('\n').join('\n    '));
    console.log('');
    printExtensionStep();
    const g = writeGuide();
    console.log(`  引导页：${g}`);
    openInBrowser(g);
    return;
  }

  console.log('检测到这些 agent：');
  const plan = [];
  for (const t of found) {
    const done = alreadyConfigured(t);
    const tag = t.discovered ? ' (自动发现)' : '';
    console.log(`  ${done ? '·' : '+'} ${pad(t.name + tag, 26)} ${done ? '已配置，跳过' : '将写入 MCP 配置'}`);
    if (!done) plan.push(t);
  }

  if (!plan.length) {
    console.log('\n所有检测到的 agent 都已经配好了。');
  } else {
    console.log(`\n将修改 ${plan.length} 个配置文件，每个都会先备份成 <文件名>.bak-<时间戳>。`);
    if (!yes) {
      console.log('\n（--dry-run：只看不写。去掉它重跑就会写入）\n');
      printExtensionStep();
      return;
    }
    let ok = 0;
    for (const t of plan) {
      try {
        const backup = `${t.file}.bak-${Date.now()}`;
        fs.copyFileSync(t.file, backup);
        t.kind === 'json' ? writeJson(t) : writeToml(t);
        console.log(`  ✅ ${t.name}（原文件已备份为 ${path.basename(backup)}）`);
        ok++;
      } catch (e) {
        console.log(`  ❌ ${t.name}：${e.message}`);
        console.log(`     手动加进 ${t.file} 也可以，格式见 README`);
      }
    }
    if (ok) console.log(`\n${ok} 个 agent 配好了。它们需要重启一次才会加载新的 MCP server。`);
  }

  printExtensionStep();
  const guide = writeGuide();
  console.log(`  引导页已生成并尝试打开：${guide}`);
  openInBrowser(guide);
  console.log('\n装完扩展后跑 `huashu-chrome doctor` 验证。\n');
}

function printExtensionStep() {
  console.log('\n还差一步：装 Chrome 扩展');
  console.log('  （浏览器不允许脚本代装扩展，这一下必须你自己点）');
}

// ---------- 配置读写 ----------

function alreadyConfigured(t) {
  try {
    return fs.readFileSync(t.file, 'utf8').includes('huashu-chrome');
  } catch {
    return false;
  }
}

function writeJson(t) {
  const raw = fs.readFileSync(t.file, 'utf8');
  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch (e) {
    throw new Error(`这个文件不是合法 JSON（${e.message}），不敢动它`);
  }
  cfg.mcpServers = cfg.mcpServers || {};
  cfg.mcpServers['huashu-chrome'] = launcher(t.client);
  fs.writeFileSync(t.file, JSON.stringify(cfg, null, 2) + '\n');
}

// TOML 不做完整解析——用户的 config.toml 里可能有注释和自定义格式，
// 解析再序列化会把它们全抹掉。只在末尾追加一段。
function writeToml(t) {
  const l = launcher(t.client);
  const block = [
    '',
    '# --- huashu-chrome (由 huashu-chrome install 添加) ---',
    '[mcp_servers.huashu-chrome]',
    `command = ${JSON.stringify(l.command)}`,
    `args = [${l.args.map((a) => JSON.stringify(a)).join(', ')}]`,
    '',
  ].join('\n');
  const prev = fs.readFileSync(t.file, 'utf8');
  fs.writeFileSync(t.file, prev + (prev.endsWith('\n') ? '' : '\n') + block);
}

// ---------- 扩展 ID：从 manifest 的公钥算，别写死 ----------

export function extensionId() {
  try {
    const key = JSON.parse(fs.readFileSync(path.join(ROOT, 'extension', 'manifest.json'), 'utf8')).key;
    if (!key) return null;
    const hex = crypto.createHash('sha256').update(Buffer.from(key, 'base64')).digest('hex').slice(0, 32);
    return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
  } catch {
    return null;
  }
}

// ---------- 扩展引导页 ----------

function writeGuide() {
  const dir = path.join(os.tmpdir(), 'huashu-chrome');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'install.html');
  const extDir = path.join(ROOT, 'extension');
  const id = extensionId();
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

  fs.writeFileSync(file, `<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<title>安装 huashu-chrome 扩展</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{color-scheme:light dark}
body{max-width:660px;margin:7vh auto;padding:0 24px;font:15px/1.75 -apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",system-ui,sans-serif}
h1{font-size:23px;margin:0 0 4px}.sub{color:#8a8f98;margin-bottom:34px}
ol{padding-left:22px}li{margin-bottom:20px}
code{background:color-mix(in srgb,currentColor 10%,transparent);padding:2px 6px;border-radius:5px;font-size:13px}
.row{display:flex;gap:8px;align-items:center;margin-top:9px}
.row input{flex:1;min-width:0;padding:9px 11px;font:12px ui-monospace,Menlo,Consolas,monospace;border:1px solid color-mix(in srgb,currentColor 22%,transparent);border-radius:8px;background:transparent;color:inherit}
button{padding:9px 14px;font:inherit;font-size:13px;border:0;border-radius:8px;background:#2563eb;color:#fff;cursor:pointer;white-space:nowrap}
button:disabled{opacity:.55;cursor:default}
.tip{margin-top:10px;padding:13px 15px;border-radius:10px;background:color-mix(in srgb,currentColor 7%,transparent);font-size:13px;color:#8a8f98}
.done{margin-top:34px;padding:16px 18px;border-radius:12px;border:1px solid color-mix(in srgb,currentColor 18%,transparent)}
</style>
<h1>装上 huashu-chrome 扩展</h1>
<div class="sub">终端那边已经配好了，只差浏览器这一下</div>
<ol>
  <li>把这个地址粘到浏览器地址栏，回车：
    <div class="row"><input readonly value="chrome://extensions"><button data-copy>复制</button></div>
    <div class="tip">网页不允许直接跳到 <code>chrome://</code> 开头的地址，只能你自己粘。<br>
      Edge 用 <code>edge://extensions</code>，Brave 用 <code>brave://extensions</code>。</div>
  </li>
  <li>打开页面右上角的<b>「开发者模式」</b>开关</li>
  <li>点<b>「加载已解压的扩展程序」</b>，选中这个文件夹：
    <div class="row"><input readonly value="${esc(extDir)}"><button data-copy>复制</button></div>
    ${/[\\/]\.[^\\/]+[\\/]/.test(extDir) ? `<div class="tip">这个文件夹在隐藏目录里，选择框默认看不见它：
      macOS 在选择框里按 <code>⌘⇧G</code> 粘贴路径回车；Windows 直接把路径粘进选择框顶部的地址栏。</div>` : ''}
  </li>
  <li>装好后扩展会自动连上终端，工具栏图标上的灰点会消失</li>
</ol>
<div class="done">
  <b>验证一下</b><div class="row"><input readonly value="npx huashu-chrome doctor"><button data-copy>复制</button></div>
  <div class="tip" style="margin-top:9px">看到「握手正常 · Chrome 扩展在线」就成了。<br>
  ${id ? `扩展 ID 固定为 <code>${esc(id)}</code>，换机器也一样。` : ''}
  之后上架 Chrome 商店，前三步会变成点一下「添加至 Chrome」。</div>
</div>
<script>
document.querySelectorAll('[data-copy]').forEach(b=>b.onclick=async()=>{
  const v=b.previousElementSibling.value;
  try{await navigator.clipboard.writeText(v)}catch{b.previousElementSibling.select();document.execCommand('copy')}
  const t=b.textContent;b.textContent='已复制';b.disabled=true;
  setTimeout(()=>{b.textContent=t;b.disabled=false},1400);
});
</script></html>`);
  return file;
}

// 各平台打开浏览器的方式不同；失败不抛错，路径已经打印给用户了
function openInBrowser(target) {
  try {
    if (WIN) spawn('cmd', ['/c', 'start', '', target], { detached: true, stdio: 'ignore' }).unref();
    else if (MAC) spawn('open', [target], { detached: true, stdio: 'ignore' }).unref();
    else spawn('xdg-open', [target], { detached: true, stdio: 'ignore' }).unref();
  } catch { /* 打不开就算了，上面已经把路径打出来了 */ }
}
