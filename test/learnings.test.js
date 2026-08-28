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
const { getLearnings, saveLearnings, lintPlaybooks, LEARNINGS_DIR } = await import('../src/lib/learnings.js');

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

// ---------- 可执行剧本（L3）----------

test('剧本体检：好剧本零警告，坏 JSON 和坏形状都点名', () => {
  const good = '摸清的流程：\n```act\n[{"do":"navigate","url":"https://x.com/{{用户名}}"},{"do":"repeat","steps":[{"do":"scroll","to":"bottom"}],"until":{"textContains":"{{停止词}}"},"max":5}]\n```\n';
  assert.deepEqual(lintPlaybooks(good), []);
  // 占位符不是错误——体检前会替换成假值
  const badJson = '```act\n[{"do":"click",]\n```';
  assert.match(lintPlaybooks(badJson)[0], /JSON/);
  const badShape = '```act\n[{"do":"repeat","steps":[{"do":"click","ref":"e1"}]}]\n```';
  assert.match(lintPlaybooks(badShape)[0], /find/);
  // 不是数组也点名
  assert.match(lintPlaybooks('```act\n{"do":"click"}\n```')[0], /数组/);
});

test('存坏剧本：照存（经验不阻塞），但当面说清', () => {
  const r = saveLearnings('playbook-demo.example', '流程：\n```act\nnot json\n```');
  assert.match(r, /已存/);           // 硬约束：体检不合格也不挡存
  assert.match(r, /剧本体检没过/);
});

test('get 时有剧本才提示可执行，并保留「可能过时」的免责', () => {
  saveLearnings('playbook-demo.example', '导出流程：\n```act\n[{"do":"click","selector":".export"}]\n```');
  const out = getLearnings('playbook-demo.example');
  assert.match(out, /1 份可执行剧本/);
  assert.match(out, /可能过时/);
  assert.match(out, /经验仅供参考/);   // HINT 是硬约束，永远在
  // 没剧本的站点：零噪音
  const plain = getLearnings('jd.com');
  assert.ok(!plain.includes('可执行剧本'));
});
