// 经验库 —— 站点操作经验的读写。两层：
//   出厂经验  docs/经验/<域名>.md   随 npm 包分发，升级即更新
//   本机经验  ~/.lingee-chrome/learnings/<域名>.md   agent 干活时学到的增量，永不被升级覆盖
// 经验是提示不是规则：与页面实际不符时以实际为准，agent 负责改写本机那份。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOME } from './paths.js';
import { VERSION } from './version.js';
import { validateScript } from '../../extension/script.js';

const SEED_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'docs', '经验');
// 环境变量仅供测试隔离用
export const LEARNINGS_DIR = process.env.LINGEE_CHROME_LEARNINGS_DIR || path.join(HOME, 'learnings');

// 同一个站的多个门牌号归到一个键上
const ALIAS = {
  'tmall.com': 'taobao.com',
  'twitter.com': 'x.com',
  'larksuite.com': 'feishu.cn',
  'qpic.cn': 'weixin.qq.com',
  'weibo.com': 'weibo.cn',
};

// 'https://my.feishu.cn/base/x?y=1' → 'my.feishu.cn'
function normalize(input) {
  let d = String(input || '').trim().toLowerCase();
  d = d.replace(/^[a-z]+:\/\//, '').split(/[/?#]/)[0].split(':')[0];
  return d.replace(/^www\./, '');
}

function mdFiles(dir) {
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3));
  } catch {
    return [];
  }
}

// 逐级去子域找归属键：my.feishu.cn → feishu.cn。别名先展开。
function resolveKey(domain) {
  const known = new Set([...mdFiles(SEED_DIR), ...mdFiles(LEARNINGS_DIR)]);
  let d = normalize(domain);
  if (!d) return null;
  const parts = d.split('.');
  for (let i = 0; i < parts.length - 1; i++) {
    const cand = parts.slice(i).join('.');
    const key = ALIAS[cand] || cand;
    if (known.has(key)) return key;
  }
  if (ALIAS[d]) return ALIAS[d];
  // 没见过的站归到主域名：creator.foo.com 和 www.foo.com 是同一个站的经验，
  // 各记一份的话，草稿记在子域、agent 按主域去查，就永远对不上。
  // 托管平台的子域是各自独立的站，保留三段。
  const base = parts.slice(-2).join('.');
  const keep3 = SHARED_HOSTS.has(base) || (/^(com|net|org|gov|edu|co|ac)$/.test(parts[parts.length - 2]) && parts.at(-1).length === 2);
  return parts.length > 2 ? parts.slice(keep3 ? -3 : -2).join('.') : d;
}

const SHARED_HOSTS = new Set(['github.io', 'vercel.app', 'netlify.app', 'pages.dev', 'web.app', 'firebaseapp.com',
  'herokuapp.com', 'blogspot.com', 'gitbook.io', 'notion.site', 'feishu.cn', 'larksuite.com']);

function readIf(dir, key) {
  try {
    return fs.readFileSync(path.join(dir, key + '.md'), 'utf8').trim();
  } catch {
    return null;
  }
}

const HINT =
  '[经验仅供参考，不是规则。它记录的是过去某个时点的实况——站点会改版、环境各不相同。' +
  '与页面实际不符时，以你观察到的实际为准，并在收工时用 learnings(domain, save) 改写。]';

// ---------- 可执行剧本 ----------
//
// 经验笔记里的 ```act 代码块 = 剧本：内容就是 act 工具的 steps 数组（JSON），
// 摸清过的流程（登录、导出、翻页收集）下次一条 act 跑完，不用重新试错。
// 刻意不做成新工具、不进协议：剧本没有任何特权，执行、敏感闸、效果核对
// 全走 act 既有的那一套——它只是提前写好的 steps。
// 占位符约定 {{参数名}}，只出现在字符串值里，agent 运行前填实值。
//
// 这里只做「形状体检」：存进去的剧本至少得是能跑的形状（合法 JSON、
// 过 validateScript）。体检不合格也照存——经验不阻塞是硬约束——但要当面
// 说清，否则坏剧本会安静地躺到下个会话才炸。
const PLAYBOOK_RE = /```act\s*\n([\s\S]*?)```/g;

export function lintPlaybooks(md) {
  const warns = [];
  let m, i = 0;
  PLAYBOOK_RE.lastIndex = 0;
  while ((m = PLAYBOOK_RE.exec(String(md || ''))) !== null) {
    i++;
    let steps;
    try {
      // 占位符在体检前换成假值——{{关键词}} 本身不是错误
      steps = JSON.parse(m[1].replace(/\{\{[^{}]*\}\}/g, 'X'));
    } catch (e) {
      warns.push(`剧本块 ${i}：不是合法 JSON（${String(e.message).slice(0, 60)}）`);
      continue;
    }
    if (!Array.isArray(steps) || !steps.length) { warns.push(`剧本块 ${i}：应是 act 的 steps 数组`); continue; }
    const bad = validateScript(steps);
    if (bad) warns.push(`剧本块 ${i}：${bad}`);
  }
  return warns;
}

const countPlaybooks = (md) => (String(md || '').match(PLAYBOOK_RE) || []).length;
const playbookNames = (md) => [...String(md || '').matchAll(/^## 剧本：(.+)$/gm)].map((m) => m[1].trim());

// ---------- 剧本草稿 ----------
//
// act 完整跑通后，扩展把它整理成剧本（extension/script.js 的 toRecipe），这里落成草稿。
// 草稿不进经验正文——确认可复用后由 agent 用 adopt 收进去（花叔定的：先草稿、确认后入库）。
// 同一份步骤再跑通一次只记次数：跑通过两三次的流程，就是最值得收的那种。
const DRAFT_DIR = () => path.join(LEARNINGS_DIR, '_drafts');
const draftFile = (key) => path.join(DRAFT_DIR(), key + '.json');

function readDrafts(key) {
  try { return JSON.parse(fs.readFileSync(draftFile(key), 'utf8')); } catch { return []; }
}

// 起点只留 host + path：query 里常有 token、搜索词这类不该落盘的东西
const pathOnly = (url) => { try { const u = new URL(url); return u.host + u.pathname; } catch { return ''; } };

function draftsNote(key, drafts) {
  return `[有 ${drafts.length} 份待确认的剧本草稿（之前跑通过的 act，ref 已换成 find、输入已换成占位符）：`
    + drafts.map((d) => `${d.id}（${d.steps.length} 步，跑通 ${d.runs} 次，${d.at.slice(0, 10)}，起点 ${d.from}）`).join('；')
    + `。确认可复用就 learnings({domain:"${key}", adopt:"d…", name:"这段流程叫什么"}) 收进经验；不确定先问用户。]`;
}

export function saveDraft(url, steps) {
  const key = resolveKey(url);
  if (!key || !Array.isArray(steps) || !steps.length) return null;
  const list = readDrafts(key);
  const sig = JSON.stringify(steps);
  let d = list.find((x) => JSON.stringify(x.steps) === sig);
  if (d) { d.runs = (d.runs || 1) + 1; d.at = new Date().toISOString(); }
  else {
    const n = list.reduce((m, x) => Math.max(m, Number(String(x.id).slice(1)) || 0), 0) + 1;
    d = { id: `d${n}`, at: new Date().toISOString(), from: pathOnly(url), runs: 1, steps };
    list.push(d);
  }
  fs.mkdirSync(DRAFT_DIR(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(draftFile(key), JSON.stringify(list.slice(-5), null, 1));
  return { key, id: d.id, runs: d.runs };
}

export function adoptDraft(domain, id, name) {
  const key = resolveKey(domain);
  if (!key) return '缺 domain。';
  const list = readDrafts(key);
  const d = list.find((x) => x.id === id);
  if (!d) return `「${key}」没有草稿 ${id}。现有：${list.map((x) => x.id).join('、') || '无'}。`;
  const title = String(name || '').trim() || `${d.from} 上的 ${d.steps.length} 步流程`;
  const slots = [...new Set(JSON.stringify(d.steps).match(/\{\{[^{}]+\}\}/g) || [])];
  const block = `## 剧本：${title}\n\n${today()} 收录，跑通 ${d.runs} 次，起点 \`${d.from}\`。`
    + (slots.length ? `运行前替换：${slots.join('、')}。` : '')
    + `\n\n\`\`\`act\n${JSON.stringify(d.steps, null, 2)}\n\`\`\``;
  const local = readIf(LEARNINGS_DIR, key);
  writeNote(key, cleanNote([local, block].filter(Boolean).join('\n\n')));
  fs.writeFileSync(draftFile(key), JSON.stringify(list.filter((x) => x.id !== id), null, 1));
  const warns = lintPlaybooks(block);
  return `已收录剧本「${title}」→ learnings/${key}.md。下次 learnings 会把它列在最前面。`
    + (warns.length ? `\n⚠️ 剧本体检没过：${warns.join('；')}` : '');
}

export function getLearnings(domain) {
  if (!domain) {
    const all = [...new Set([...mdFiles(SEED_DIR), ...mdFiles(LEARNINGS_DIR)])].sort();
    return all.length
      ? `已有经验的站点：${all.join('、')}\n带 {domain} 再调一次取具体内容。`
      : '经验库是空的。做完任务学到非显而易见的规律时，用 {domain, save} 存下来。';
  }
  const key = resolveKey(domain);
  const seed = readIf(SEED_DIR, key);
  const local = readIf(LEARNINGS_DIR, key);
  if (!seed && !local) {
    const all = [...new Set([...mdFiles(SEED_DIR), ...mdFiles(LEARNINGS_DIR)])].sort();
    const drafts = readDrafts(key);
    return (
      (drafts.length ? `${draftsNote(key, drafts)}\n` : '') +
      `「${key}」还没有经验记录——按通用流程干就行，别让查询空手而归拖慢任务。\n` +
      (all.length ? `已有记录的站点：${all.join('、')}\n` : '') +
      `摸清这个站后用 {domain: "${key}", save} 把规律存下来，下次就快了。`
    );
  }
  const parts = [HINT];
  // 可运行的剧本放最前面：agent 先看到「这件事有现成的一条 act」，就不会从头摸
  const names = playbookNames([seed, local].filter(Boolean).join('\n'));
  if (names.length) parts.push(`[可直接运行的剧本：${names.map((x) => `「${x}」`).join('、')}——见下文 \`\`\`act 块]`);
  const drafts = readDrafts(key);
  if (drafts.length) parts.push(draftsNote(key, drafts));
  if (seed) parts.push(`## 出厂经验（lingee-chrome v${VERSION}）\n\n${seed}`);
  if (local) parts.push(`## 本机经验\n\n${local}`);
  // 有剧本才多说一句——没有就零噪音（经验不阻塞，也不添乱）
  const n = countPlaybooks(parts.join('\n'));
  if (n) {
    parts.push(`[上面有 ${n} 份可执行剧本（\`\`\`act 块）：内容就是 act 的 steps，`
      + `把 {{占位符}} 填成实值后可直接运行——一条 act 顶过去几十轮试错。`
      + `剧本可能过时：assert/until 会在页面不符时停下，停了就按现场重走，收工时把新流程写回来。]`);
  }
  return parts.join('\n\n');
}

// ---------- 保存前清洗 ----------
//
// agent 的惯用法是「get 一份 → 改几句 → 整段 save 回去」，而 get 返回的是出厂 + 本机
// 拼起来的全文，外加我们自己的提示语。原样存回去，出厂段就被复制进本机文件；
// 下次 get 再拼一遍、再存一遍——weixin.qq.com.md 里「出厂经验」段已经叠了 4 份，
// creator.douyin.com.md 的「本机经验」标题叠了 3 层。存的时候替它剥干净。
export function cleanNote(body) {
  let b = String(body || '');
  b = b.split(HINT).join('');
  b = b.replace(/^\[(上面有 \d+ 份可执行剧本|可直接运行的剧本|有 \d+ 份待确认的剧本草稿)[\s\S]*?\]\s*$/gm, '');
  // 回贴的出厂段：从「## 出厂经验（…）」到下一个「## 本机经验」或文末
  b = b.replace(/^## 出厂经验（[^\n]*\n[\s\S]*?(?=^## 本机经验[ \t]*$|(?![\s\S]))/gm, '');
  b = b.replace(/^## 本机经验[ \t]*$/gm, '');
  b = b.replace(/^> 最后更新：\d{4}-\d{2}-\d{2}[^\n]*\n?/m, '');
  // 一字不差的小节只留第一份
  const seen = new Set();
  b = b.split(/^(?=## )/m).filter((sec) => {
    const k = sec.trim();
    if (!k) return false;
    if (k.startsWith('## ') && seen.has(k)) return false;
    seen.add(k);
    return true;
  }).join('');
  return b.replace(/\n{3,}/g, '\n\n').trim();
}

const today = () => new Date().toISOString().slice(0, 10);

// 覆盖前留底：整文件覆盖是这个接口的语义，但 agent 合并失手时（B站经验被覆盖丢过一次）
// 要有地方找回来。每站留最近 10 份。
function backup(key) {
  const cur = path.join(LEARNINGS_DIR, key + '.md');
  if (!fs.existsSync(cur)) return;
  const dir = path.join(LEARNINGS_DIR, '.history', key);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // 同一毫秒连存两次（agent 先存再补一句）文件名会撞，带个序号
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  let n = 0, f;
  do f = path.join(dir, `${stamp}${n ? `-${n}` : ''}.md`); while (fs.existsSync(f) && ++n);
  fs.copyFileSync(cur, f);
  const old = fs.readdirSync(dir).sort();
  for (const f of old.slice(0, Math.max(0, old.length - 10))) fs.unlinkSync(path.join(dir, f));
}

function writeNote(key, body) {
  fs.mkdirSync(LEARNINGS_DIR, { recursive: true, mode: 0o700 });
  backup(key);
  fs.writeFileSync(path.join(LEARNINGS_DIR, key + '.md'), `> 最后更新：${today()}\n\n${body}\n`);
}

export function saveLearnings(domain, content) {
  const key = resolveKey(domain);
  if (!key) return '缺 domain，没存。';
  const raw = String(content || '').trim();
  const body = cleanNote(raw);
  if (!body) return '内容为空，没存。要清掉本机经验请直接说明再人工删。';
  writeNote(key, body);
  const warns = lintPlaybooks(body);
  const cleaned = raw.length - body.length > 40 ? `（已自动剥掉回贴的出厂段落、提示语和重复小节，少存了 ${raw.length - body.length} 字）` : '';
  return `已存 → learnings/${key}.md（${body.length} 字）${cleaned}。本机经验整文件覆盖：下次保存前先 get 合并旧内容；旧版本留底在 learnings/.history/。`
    + (warns.length
      ? `\n⚠️ 剧本体检没过：${warns.join('；')}。照存了（经验不阻塞），但这样的剧本下个会话直接跑会失败——修好再 save 一次。`
      : '');
}
