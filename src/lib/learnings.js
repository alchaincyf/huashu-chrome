// 经验库 —— 站点操作经验的读写。两层：
//   出厂经验  docs/经验/<域名>.md   随 npm 包分发，升级即更新
//   本机经验  ~/.huashu-chrome/learnings/<域名>.md   agent 干活时学到的增量，永不被升级覆盖
// 经验是提示不是规则：与页面实际不符时以实际为准，agent 负责改写本机那份。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOME } from './paths.js';
import { VERSION } from './version.js';
import { validateScript } from '../../extension/script.js';

const SEED_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'docs', '经验');
// 环境变量仅供测试隔离用
export const LEARNINGS_DIR = process.env.HUASHU_CHROME_LEARNINGS_DIR || path.join(HOME, 'learnings');

// 同一个站的多个门牌号归到一个键上
const ALIAS = {
  'tmall.com': 'taobao.com',
  'twitter.com': 'x.com',
  'larksuite.com': 'feishu.cn',
  'qpic.cn': 'weixin.qq.com',
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
  return ALIAS[d] || d;
}

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
    return (
      `「${key}」还没有经验记录——按通用流程干就行，别让查询空手而归拖慢任务。\n` +
      (all.length ? `已有记录的站点：${all.join('、')}\n` : '') +
      `摸清这个站后用 {domain: "${key}", save} 把规律存下来，下次就快了。`
    );
  }
  const parts = [HINT];
  if (seed) parts.push(`## 出厂经验（huashu-chrome v${VERSION}）\n\n${seed}`);
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

export function saveLearnings(domain, content) {
  const key = resolveKey(domain);
  if (!key) return '缺 domain，没存。';
  const body = String(content || '').trim();
  if (!body) return '内容为空，没存。要清掉本机经验请直接说明再人工删。';
  fs.mkdirSync(LEARNINGS_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(LEARNINGS_DIR, key + '.md'), body + '\n');
  const warns = lintPlaybooks(body);
  return `已存 → learnings/${key}.md（${body.length} 字）。本机经验整文件覆盖：下次保存前先 get 合并旧内容。`
    + (warns.length
      ? `\n⚠️ 剧本体检没过：${warns.join('；')}。照存了（经验不阻塞），但这样的剧本下个会话直接跑会失败——修好再 save 一次。`
      : '');
}
