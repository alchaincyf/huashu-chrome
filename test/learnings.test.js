// learnings 的纯逻辑测试 —— 不需要浏览器，进 `npm test`
//
// 域名解析是这个工具的全部智力所在：URL→域名、子域降级、别名归并。
// 任何一条断掉，agent 查经验就会静默空手而归——它不会报错，只会慢回试错模式。
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.HUASHU_CHROME_LEARNINGS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-learnings-'));
const { getLearnings, saveLearnings, LEARNINGS_DIR } = await import('../src/lib/learnings.js');

test('无参调用列出出厂经验的站点', () => {
  const out = getLearnings();
  assert.match(out, /feishu\.cn/);
  assert.match(out, /jd\.com/);
});

test('完整 URL 归到域名，子域降级到已有键', () => {
  const out = getLearnings('https://my.feishu.cn/base/XXX?table=1');
  assert.match(out, /多维表格/);
  assert.match(out, /经验仅供参考/);   // 「经验不是桎梏」的提示必须在
});

test('别名归并：tmall → taobao，twitter → x', () => {
  assert.match(getLearnings('detail.tmall.com'), /淘宝/);
  assert.match(getLearnings('twitter.com'), /UserOriginalsTimeline/);
});

test('没有记录的站点：明确说没有、不阻塞，并引导回流', () => {
  const out = getLearnings('never-seen-site.example');
  assert.match(out, /还没有经验记录/);
  assert.match(out, /save/);
});

test('保存写进本机目录，get 时与出厂经验合并展示', () => {
  const r = saveLearnings('sub.jd.com', '搜索接口新增了 xx 参数');
  assert.match(r, /learnings\/jd\.com\.md/);   // 子域归到已有键，不另立门户
  assert.ok(fs.existsSync(path.join(LEARNINGS_DIR, 'jd.com.md')));
  const out = getLearnings('jd.com');
  assert.match(out, /## 出厂经验/);
  assert.match(out, /## 本机经验/);
  assert.match(out, /xx 参数/);
});

test('新站点保存后立即可查', () => {
  saveLearnings('https://www.zhihu.com/question/1', '回答正文接口是 answers/v2');
  const out = getLearnings('zhihu.com');
  assert.doesNotMatch(out, /## 出厂经验/);
  assert.match(out, /answers\/v2/);
});

test('空内容不落盘', () => {
  const r = saveLearnings('empty.example', '   ');
  assert.match(r, /没存/);
  assert.ok(!fs.existsSync(path.join(LEARNINGS_DIR, 'empty.example.md')));
});
