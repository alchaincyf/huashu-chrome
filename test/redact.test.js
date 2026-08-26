// 凭据隐去的纯逻辑测试 —— 不需要浏览器，进 `npm test`
//
// 这套测试存在的理由很具体：v0.4 开发中，redactCreds 有过一版把整套防护
// 归零的 bug（成组判定要求行号严格连续，而正文提取在块级元素之间留空行，
// 于是每组长度恒为 1，一行都没隐去）。当时代码写了、实测也写了，
// 但实测要开真 Chrome、手动重载扩展、跑两分半——那个 bug 因此活了很久。
// 凭据泄露是不可撤销的，守它的逻辑不该只有那么贵的一层覆盖。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactCreds, isCredLine, CRED_URL } from '../extension/redact.js';

const CODE = (n) => `${n}`.repeat(8) + 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';

test('空行隔开的恢复码照样算成组 —— 这正是当年归零的那个 bug', () => {
  // read_text 把每个 <li> 之间隔一个空行，而恢复码几乎总是一行一个 <li>。
  // 按「行号严格连续」实现的话，这里一行都隐不掉。
  const r = redactCreds([CODE(1), '', CODE(2), '', CODE(3), '', CODE(4)].join('\n'));
  assert.equal(r.count, 4);
  assert.match(r.text, /\[已隐去 4 行疑似凭据\]/);
  assert.doesNotMatch(r.text, /a1b2c3d4/);      // 一个字符都不该漏
});

test('严格连续的成组同样隐去', () => {
  const r = redactCreds([CODE(1), CODE(2), CODE(3)].join('\n'));
  assert.equal(r.count, 3);
});

test('不够 3 行不隐去 —— 单个长串常常是正常的 ID 或 hash', () => {
  const r = redactCreds([CODE(1), CODE(2)].join('\n'));
  assert.equal(r.count, 0);
  assert.match(r.text, /a1b2c3d4/);              // 原样保留
});

test('git commit hash 这类孤立长串不受影响', () => {
  const t = '最近一次提交是 2e64912\n完整 hash：9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c\n就这些';
  assert.equal(redactCreds(t).count, 0);
});

test('普通正文一个字都不动', () => {
  const t = '# 标题\n\n这是一段中文正文。\n\n还有一段。';
  const r = redactCreds(t);
  assert.equal(r.count, 0);
  assert.equal(r.text, t);
});

test('凭据被隐去后，前后的正文和排版还在', () => {
  const t = ['请保存好这些码：', '', CODE(1), '', CODE(2), '', CODE(3), '', '保存完点下一步。'].join('\n');
  const r = redactCreds(t);
  assert.match(r.text, /请保存好这些码：/);
  assert.match(r.text, /保存完点下一步。/);
  // 尾随空行属于下文的排版，不该被一起吃进隐去块里
  assert.match(r.text, /\[已隐去 3 行疑似凭据\]\n\n保存完点下一步。/);
});

test('同一页里两组分开的凭据各算各的', () => {
  const t = [CODE(1), CODE(2), CODE(3), '中间是正文', CODE(4), CODE(5), CODE(6)].join('\n');
  const r = redactCreds(t);
  assert.equal(r.count, 6);
  assert.match(r.text, /中间是正文/);
  assert.equal((r.text.match(/已隐去 3 行/g) || []).length, 2);
});

test('isCredLine 的边界：要够长、要混着字母和数字', () => {
  assert.equal(isCredLine('a1b2c3d4e5f6a7b8'), true);        // 16 位，刚好够
  assert.equal(isCredLine('a1b2c3d4e5f6a7b'), false);        // 15 位，不够
  assert.equal(isCredLine('1234567890123456789'), false);    // 纯数字：时间戳、订单号
  assert.equal(isCredLine('abcdefghijklmnopqrs'), false);    // 纯字母：普通英文词
  assert.equal(isCredLine('这是一句够长的中文句子啊啊啊啊啊啊'), false);
  assert.equal(isCredLine('hello world 12345678'), false);   // 带空格：是句子不是码
});

test('凭据类地址在 URL 层被认出来', () => {
  for (const u of [
    'https://github.com/settings/tokens',
    'https://github.com/settings/tokens?page=2',
    'https://www.npmjs.com/settings/~/tfa',
    'https://console.example.com/api-keys/',
    'https://example.com/account/recovery#codes',
    'https://example.com/backup_codes',
  ]) assert.equal(CRED_URL.test(u), true, u);
});

test('普通地址不会被误判成凭据页', () => {
  for (const u of [
    'https://github.com/alchaincyf/huashu-chrome',
    'https://example.com/articles/tokenomics',   // 「token」是子串，但不是完整路径段
    'http://127.0.0.1:8124/playground.html',
  ]) assert.equal(CRED_URL.test(u), false, u);
});
