// 会话身份的外观必须是 sid 的纯函数——这是「桥重启后标记不换色」的全部依据。
// 那个性质在浏览器里很难验（要真的重启桥、真的看颜色），在这里一行就验完。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { identityOf, prettyClient, stripMarkPrefix, MARK_PALETTE, MARK_SENTINEL } from '../extension/identity.js';

const EXT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'extension');

test('同一个 sid 永远算出同一套外观', () => {
  const a = identityOf('claude-code:p92310');
  const b = identityOf('claude-code:p92310');
  assert.deepEqual(a, b);
});

test('外观只由 sid 决定，不受 client 参数影响', () => {
  // client 只改显示名。要是它也参与配色，同一个会话在「桥传了 client」和
  // 「桥没传」两种情况下会是两个颜色——而后者在老版本桥上就是常态。
  const withClient = identityOf('codex:p1', 'codex');
  const without = identityOf('codex:p1');
  assert.equal(withClient.emoji, without.emoji);
  assert.equal(withClient.color, without.color);
});

test('短码取 sid 冒号后那截，也就是 agent 进程的父 pid', () => {
  assert.equal(identityOf('claude-code:p92310').code, 'p92310');
  assert.equal(identityOf('cursor:r8fk2p1x').code, 'r8fk2p1x');
});

test('宿主自定义的 sessionId 没有冒号结构也不能崩', () => {
  const id = identityOf('a-custom-session-identifier');
  assert.ok(id.code);
  assert.ok(id.emoji);
  // 不拿一段来路不明的会话标识去冒充 agent 名——真名由桥另外传 client 给出
  assert.equal(id.label, 'AI agent');
  assert.equal(identityOf('a-custom-session-identifier', 'cursor').label, 'Cursor');
});

test('client 名做机械美化，不维护第二张 agent 表', () => {
  assert.equal(prettyClient('claude-code'), 'Claude Code');
  assert.equal(prettyClient('codex'), 'Codex');
  assert.equal(prettyClient('kimi_code'), 'Kimi Code');
  assert.equal(prettyClient(''), 'AI agent');
  assert.equal(prettyClient('unknown'), 'AI agent');
});

test('client 缺省时从 sid 前缀推出来', () => {
  assert.equal(identityOf('gemini:p5').label, 'Gemini');
});

test('并发会话撞色要够罕见', () => {
  // 真实场景是同一台机器上开几个终端窗口，sid 只差 pid。
  // 这种「高度相似的输入」正是弱哈希最容易全撞在一起的地方。
  const seen = new Set();
  for (let pid = 3000; pid < 3020; pid++) {
    seen.add(identityOf(`claude-code:p${pid}`).emoji);
  }
  assert.ok(seen.size >= 7, `20 个相邻 pid 只分出 ${seen.size} 种外观`);
});

test('剥前缀：加上再剥掉要回到原样，且不误伤普通标题', () => {
  // v0.9.1 起 mark.js 不再写标题前缀（favicon 取代），但 stripMarkPrefix 还在
  // popup 侧做过渡清理——升级瞬间存活的旧页面标题上可能还挂着旧前缀。
  const bare = '小红书创作服务平台 - 数据中心';
  assert.equal(stripMarkPrefix(`🟣${MARK_SENTINEL}${bare}`), bare);
  assert.equal(stripMarkPrefix(`🟣🟫+2${MARK_SENTINEL}${bare}`), bare);
  assert.equal(stripMarkPrefix(bare), bare);
  // 站点自己在正文里用了窄空格，不能被当成前缀切掉。上限卡在 12 个 UTF-16 码元：
  // 最长的前缀是 3 个 emoji（各占 2 个码元）+「+N」+ 哨兵，也就到 10
  const wide = `一个很长很长很长很长很长的标题${MARK_SENTINEL}后半段`;
  assert.equal(stripMarkPrefix(wide), wide);
});

test('调色板里每个身份的 emoji 互不相同', () => {
  // 颜色可以重复（圆形🟣和方形🟪同色），emoji 不能——它是标签栏上唯一的信号
  assert.equal(new Set(MARK_PALETTE.map((p) => p.emoji)).size, MARK_PALETTE.length);
});

test('每个身份都带一个 Chrome 认识的标签组颜色', () => {
  // tabGroups.update 只认这 9 个名字，拼错或留空都是运行时才炸——
  // 而且炸在 syncGroup 的 catch 里，一声不响，标签组就是永远画不出来。
  const CHROME_GROUP_COLORS = new Set(['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange']);
  for (const p of MARK_PALETTE) {
    assert.ok(CHROME_GROUP_COLORS.has(p.group), `${p.emoji} 的组色 "${p.group}" 不是 Chrome 认识的名字`);
  }
  assert.ok(identityOf('claude-code:p1').group, 'identityOf 要把组色带出来，syncGroup 靠它上色');
});
