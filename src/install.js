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
import { createTranslator, resolveLocale } from './lib/i18n.js';
import installMessages from './locales/install.js';

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
const REPO = 'https://github.com/alchaincyf/huashu-chrome';

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
export async function install({ yes = true, only = null, locale = resolveLocale() } = {}) {
  const language = resolveLocale({ lang: locale });
  const tr = createTranslator(installMessages, language);
  console.log(`\n${tr('terminalTitle')}\n`);

  const all = knownAgents().filter((a) => a.file);
  const discovered = discover(new Set(all.map((a) => a.file)));
  let found = [...all, ...discovered];

  if (only) {
    found = found.filter((a) => a.client === only);
    if (!found.length) {
      console.log(`  ${tr('onlyMissing', { client: only, clients: [...all, ...discovered].map((a) => a.client).join(' / ') || tr('noneLabel') })}\n`);
      return;
    }
  }

  if (!found.length) {
    console.log(`  ${tr('noAgents')}\n`);
    console.log(`  ${tr('knownAgents', { names: SPEC.agents.map((a) => a.name).join(language === 'zh-CN' ? '、' : ', ') })}`);
    console.log(`  ${tr('discoveryHint')}\n`);
    console.log(`  ${tr('customHint')}\n`);
    console.log('    ' + JSON.stringify({ mcpServers: { 'huashu-chrome': launcher('custom') } }, null, 2).split('\n').join('\n    '));
    console.log('');
    printExtensionStep(tr);
    const g = writeGuide([], language);
    console.log(`  ${tr('guidePath', { file: g })}`);
    openInBrowser(g);
    return;
  }

  console.log(tr('detectedAgents'));
  const plan = [];
  // rows 给引导页的「随附清单」：终端刚做完的事，让用户在页面上也看得见
  const rows = [];
  for (const t of found) {
    const done = alreadyConfigured(t);
    const tag = t.discovered ? tr('discoveredTag') : '';
    console.log(`  ${done ? '·' : '+'} ${pad(t.name + tag, 26)} ${done ? tr('statusSkipped') : tr('statusWillWrite')}`);
    if (!done) plan.push(t);
    else rows.push({ name: t.name, ok: true, written: false, status: tr('statusAlready') });
  }

  if (!plan.length) {
    console.log(`\n${tr('allConfigured')}`);
  } else {
    console.log(`\n${tr('writePlan', { count: plan.length })}`);
    if (!yes) {
      console.log(`\n${tr('dryRun')}\n`);
      printExtensionStep(tr);
      return;
    }
    let ok = 0;
    for (const t of plan) {
      try {
        const backup = `${t.file}.bak-${Date.now()}`;
        fs.copyFileSync(t.file, backup);
        t.kind === 'json' ? writeJson(t, tr) : writeToml(t, tr);
        console.log(`  ${tr('saved', { name: t.name, backup: path.basename(backup) })}`);
        rows.push({ name: t.name, ok: true, written: true, status: tr('statusWritten') });
        ok++;
      } catch (e) {
        console.log(`  ${tr('failed', { name: t.name, message: e.message })}`);
        console.log(tr('manualConfig', { file: t.file }));
        rows.push({ name: t.name, ok: false, written: false, status: tr('statusFailed') });
      }
    }
    if (ok) console.log(`\n${tr('configuredCount', { count: ok })}`);
  }

  printExtensionStep(tr);
  const guide = writeGuide(rows, language);
  console.log(`  ${tr('guideOpened', { file: guide })}`);
  openInBrowser(guide);
  console.log(`\n${tr('doctorHint')}`);
  // 现在多数用户是让 agent 代装的，从不路过仓库页。这一行是写给读 stdout 的 agent 的：
  // 请它转达、由人决定——绝不让 agent 替用户点，那是刷 star。
  console.log(`\n${tr('starAsk', { url: REPO })}\n`);
}

function printExtensionStep(t) {
  console.log(`\n${t('extensionHeading')}`);
  console.log(`  ${t('storeInstall', { url: STORE_URL })}`);
  console.log(`  ${t('browserRestriction')}`);
}

// ---------- 配置读写 ----------

function alreadyConfigured(t) {
  try {
    return fs.readFileSync(t.file, 'utf8').includes('huashu-chrome');
  } catch {
    return false;
  }
}

function writeJson(t, translate) {
  const raw = fs.readFileSync(t.file, 'utf8');
  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch (e) {
    throw new Error(translate('malformedJson', { message: e.message }));
  }
  cfg.mcpServers = cfg.mcpServers || {};
  cfg.mcpServers['huashu-chrome'] = launcher(t.client);
  fs.writeFileSync(t.file, JSON.stringify(cfg, null, 2) + '\n');
}

// TOML 不做完整解析——用户的 config.toml 里可能有注释和自定义格式，
// 解析再序列化会把它们全抹掉。只在末尾追加一段。
function writeToml(t, translate) {
  const l = launcher(t.client);
  const block = [
    '',
    translate('tomlComment'),
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
//
// 模板住在 src/guide.html（设计稿见 design-demos/，2026-09-09 选定「说明书」方向）。
// 这一页给的是「agent 替他跑完 install 之后弹出来的那个人」看的：主路径是商店
// 一键安装，开发者手动加载收在附录里。页面里**不放任何本机绝对路径**——
// 手动加载那步让用户回终端跑 `extension --reveal`，文件夹自己在访达里选中。
const STORE_URL = 'https://chromewebstore.google.com/detail/foiljmaplphdfimfcnfdpekhdnfbgfbf';

const escapeHtml = (value) => String(value)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

export function renderGuide(template, { locale = resolveLocale(), rows = [], version = '', extensionId: id = null, siteCount = 0, icon = '' } = {}) {
  const language = resolveLocale({ lang: locale });
  const tr = createTranslator(installMessages, language);
  const ok = rows.filter((r) => r.ok).length;
  const written = rows.filter((r) => r.written).length;
  const check = '<svg width="16" height="16" viewBox="0 0 16 16"><path class="ac" d="M2.5 8.4 6.2 12 13.5 4"/></svg>';
  const cross = '<svg width="16" height="16" viewBox="0 0 16 16"><path class="ln2" d="M4 4 12 12 M12 4 4 12"/></svg>';
  const agentRows = rows.length
    ? rows.map((row) => `      <div class="agent">${row.ok ? check : cross}<span class="nm">${escapeHtml(row.name)}</span><span class="st">${escapeHtml(row.status)}</span></div>`).join('\n')
    : `      <div class="agent">${cross}<span class="nm">${escapeHtml(tr('noKnownAgentRow'))}</span><span class="st">${escapeHtml(tr('manualSnippet'))}</span></div>`;
  const foot = rows.length
    ? [
      written ? tr('footWritten', { count: written }) : '',
      ok - written ? tr('footExisting', { count: ok - written }) : '',
      tr('footCommon'),
    ].filter(Boolean).join(' ')
    : tr('footNoRows');
  const fields = {
    LOCALE: language,
    COPY_FEEDBACK: JSON.stringify(tr('copied')).replace(/</g, '\\u003c'),
    ICON: escapeHtml(icon), VERSION: escapeHtml(version),
    EXT_ID: escapeHtml(id || tr('noFixedId')),
    AGENT_COUNT: `${ok} / ${rows.length}`,
    AGENT_ROWS: agentRows, AGENT_FOOT: escapeHtml(foot),
  };
  // A single pass prevents data containing template tokens from being processed again.
  return String(template).replace(/\{\{(t:[\w]+|[A-Z_]+)\}\}/g, (token, key) => {
    if (!key.startsWith('t:')) return Object.hasOwn(fields, key) ? fields[key] : token;
    const message = key.slice(2);
    const values = message === 'handshakeOnline' ? { version }
      : message === 'siteNotes' ? { count: siteCount || tr('siteCountFallback') } : {};
    return escapeHtml(tr(message, values));
  });
}

function writeGuide(rows = [], locale = resolveLocale()) {
  const dir = path.join(os.tmpdir(), 'huashu-chrome');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'install.html');
  const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  const icon = fs.readFileSync(path.join(ROOT, 'extension', 'icons', 'icon128.png')).toString('base64');
  let siteCount = 0;
  try { siteCount = fs.readdirSync(path.join(ROOT, 'docs', '经验')).filter((f) => f.endsWith('.md')).length; } catch { /* docs may be omitted from an installation */ }
  const template = fs.readFileSync(path.join(ROOT, 'src', 'guide.html'), 'utf8');
  const html = renderGuide(template, { locale, rows, version, extensionId: extensionId(), siteCount, icon });
  fs.writeFileSync(file, html);
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
