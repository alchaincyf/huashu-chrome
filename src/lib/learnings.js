// 经验库 —— 站点操作经验的读写。两层：
//   出厂经验  docs/经验/<域名>.md   随 npm 包分发，升级即更新
//   本机经验  ~/.huashu-chrome/learnings/<域名>.md   agent 干活时学到的增量，永不被升级覆盖
// 经验是提示不是规则：与页面实际不符时以实际为准，agent 负责改写本机那份。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOME } from './paths.js';
import { VERSION } from './version.js';

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
  return parts.join('\n\n');
}

export function saveLearnings(domain, content) {
  const key = resolveKey(domain);
  if (!key) return '缺 domain，没存。';
  const body = String(content || '').trim();
  if (!body) return '内容为空，没存。要清掉本机经验请直接说明再人工删。';
  fs.mkdirSync(LEARNINGS_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(LEARNINGS_DIR, key + '.md'), body + '\n');
  return `已存 → learnings/${key}.md（${body.length} 字）。本机经验整文件覆盖：下次保存前先 get 合并旧内容。`;
}
