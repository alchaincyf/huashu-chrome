// 会话身份 —— 把一个 sid 变成「用户一眼能认出、且不会和别人撞」的一套外观。
//
// 多 agent 并发时，隔离做得再干净，用户面前也是一片安静：页面上没痕迹、
// 标签栏没痕迹。他不知道哪一页有主、有几个主、是谁。这个文件就是那套痕迹的真源。
//
// 三条设计约束：
//
// 1. **跨桥重启稳定。** 外观完全由 sid 决定（纯函数，无状态、不落盘）。
//    sid 本身就是为了「桥重启后会话身份不变」而存在的（见 src/lib/rpc.js），
//    外观跟着它走，就自动继承了那份稳定性——用户不会看见一个页面的标记
//    在桥抖一下之后突然换了颜色。
//
// 2. **形状 × 颜色，不只靠颜色。** 红绿色盲占男性 8%，一排只有颜色不同的
//    圆点对他们等于没有区分。所以调色板是 7 色 × 圆/方两种形状 = 14 个身份，
//    分不清颜色的人至少分得清圆和方。
//
// 3. **agent 显示名不维护第二张表。** src/agents.json 里那张表的承诺是
//    「加一个 agent 只要加一行，不用改代码」，在扩展侧再抄一份就把它作废了。
//    这里只做一次机械美化：claude-code → Claude Code。对绝大多数 slug 都对，
//    错了也只是大小写不好看，不影响识别。

// 圆形一组在前：只有一两个会话时（绝大多数时候）优先落在辨识度最高的圆点上。
// group 是 Chrome 标签组的颜色名（tabGroups API 只认它那 9 个名字，不认 hex）——
// 标签组是标签栏上最显著的信号，它的颜色必须和页内标记同源，否则用户要在
// 「标签组是绿的、页内边框也是绿的」这件事上得不到互相印证。棕色映射到 grey：
// Chrome 没有棕，灰是唯一不会被认成别的会话的中性色。
export const MARK_PALETTE = [
  { emoji: '🟣', color: '#a855f7', group: 'purple' },
  { emoji: '🟢', color: '#22c55e', group: 'green' },
  { emoji: '🔵', color: '#3b82f6', group: 'blue' },
  { emoji: '🟠', color: '#f97316', group: 'orange' },
  { emoji: '🔴', color: '#ef4444', group: 'red' },
  { emoji: '🟡', color: '#eab308', group: 'yellow' },
  { emoji: '🟤', color: '#a16207', group: 'grey' },
  { emoji: '🟪', color: '#a855f7', group: 'purple' },
  { emoji: '🟩', color: '#22c55e', group: 'green' },
  { emoji: '🟦', color: '#3b82f6', group: 'blue' },
  { emoji: '🟧', color: '#f97316', group: 'orange' },
  { emoji: '🟥', color: '#ef4444', group: 'red' },
  { emoji: '🟨', color: '#eab308', group: 'yellow' },
  { emoji: '🟫', color: '#a16207', group: 'grey' },
];

// 标签栏标题前缀的尾哨兵，U+2009 窄空格。
//
// v0.9.1 起标题前缀已退役（favicon 头像取代，mark.js 不再写它），这两个导出
// 只服务一件事：popup 的会话列表在升级瞬间可能读到旧页面残留的带前缀标题，
// stripMarkPrefix 负责把它剥干净。等一轮版本过去后可以整体删除。
export const MARK_SENTINEL = '\u2009';

// 认前缀只认哨兵，不认 emoji 列表：后者会在调色板加新颜色的那天悄悄失效。
// 位置上限是防呆——万一某个站点的标题真的用了 U+2009，也不会正好在最前面。
export function stripMarkPrefix(title) {
  const s = String(title || '');
  const i = s.indexOf(MARK_SENTINEL);
  return i >= 0 && i <= 12 ? s.slice(i + 1) : s;
}

// FNV-1a。选它不是因为快，是因为它短到可以原样抄进任何一侧，
// 且在不同 JS 引擎上结果一模一样——外观必须在扩展、桥、测试里算出同一个值。
function hash32(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

// claude-code → Claude Code
export function prettyClient(client) {
  const c = String(client || '').trim();
  if (!c || c === 'unknown') return 'AI agent';
  return c.split(/[-_\s]+/).filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');
}

// sid 的形状是 `<client>:p<ppid>`（见 src/lib/rpc.js）。冒号后那截就是短码——
// 它是 agent 进程的父 pid，用户能拿它对上自己的终端窗口，比一个哈希出来的
// 随机串有用得多。宿主自定义 sessionId 时没有这个结构，退回取尾部。
export function identityOf(sid, client) {
  const s = String(sid ?? '');
  const i = s.indexOf(':');
  const slug = client || (i > 0 ? s.slice(0, i) : '');
  const code = i >= 0 && i < s.length - 1 ? s.slice(i + 1) : s.slice(-6);
  const p = MARK_PALETTE[hash32(s) % MARK_PALETTE.length];
  return { sid: s, emoji: p.emoji, color: p.color, group: p.group, label: prettyClient(slug), code };
}
