// learnings 的纯逻辑测试 —— 不需要浏览器，进 `npm test`
//
// 域名解析是这个工具的全部智力所在：URL→域名、子域降级、别名归并。
// 任何一条断掉，agent 查经验就会静默空手而归——它不会报错，只会慢回试错模式。
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.LINGEE_CHROME_LEARNINGS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-learnings-'));
const { getLearnings, saveLearnings, lintPlaybooks, LEARNINGS_DIR, cleanNote, saveDraft, adoptDraft } = await import('../src/lib/learnings.js');
const { toRecipe } = await import('../extension/script.js');

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
  // 刻意用一个永远不会有出厂经验的域名——换成真站点，哪天它进了 docs/经验/ 这条就假失败
  saveLearnings('https://www.newsite.example/question/1', '回答正文接口是 answers/v2');
  const out = getLearnings('newsite.example');
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

// ---------- 回贴防护与留底 ----------

test('把 get 的全文原样存回去：出厂段、提示语、重复小节都被剥掉', () => {
  saveLearnings('paste.example', '## 发布\n先点发布。');
  const got = getLearnings('paste.example');
  // 模拟 agent 的惯用法：get 回来改一句，整段存回，而且同一节贴了两遍
  saveLearnings('paste.example', got + '\n\n## 发布\n先点发布。\n\n## 新发现\n草稿箱在右上角。');
  const file = fs.readFileSync(path.join(LEARNINGS_DIR, 'paste.example.md'), 'utf8');
  assert.doesNotMatch(file, /经验仅供参考/);
  assert.doesNotMatch(file, /## 本机经验/);
  assert.equal(file.match(/## 发布/g).length, 1);
  assert.match(file, /草稿箱在右上角/);
  assert.match(file, /^> 最后更新：\d{4}-\d{2}-\d{2}/);
});

test('回贴的出厂经验段整段剥掉，本机内容留下', () => {
  const pasted = '## 出厂经验（lingee-chrome v1.2.1）\n\n出厂的一大段\n\n## 本机经验\n\n## 我的发现\n本机的一句';
  const out = cleanNote(pasted);
  assert.doesNotMatch(out, /出厂的一大段/);
  assert.match(out, /本机的一句/);
});

test('覆盖保存前留底，留最近 10 份', () => {
  for (let i = 0; i < 12; i++) saveLearnings('hist.example', `## 第${i}版\n内容${i}`);
  const dir = path.join(LEARNINGS_DIR, '.history', 'hist.example');
  assert.equal(fs.readdirSync(dir).length, 10);
});

// ---------- 剧本草稿 ----------

test('跑通的 act 变草稿：ref 换 find，输入换占位符，原文不落盘', () => {
  const steps = [
    { do: 'click', ref: 'e3' },
    { do: 'type', ref: 'e5', text: '私信正文不能落盘' },
    { do: 'click', find: { role: 'button', name: '发送' } },
  ];
  const recipe = toRecipe(steps, { e3: { role: 'button', name: '私信' }, e5: { role: 'textbox', name: '消息' } });
  assert.deepEqual(recipe[0], { do: 'click', find: { role: 'button', name: '私信' } });
  assert.equal(recipe[1].text, '{{消息}}');
  assert.doesNotMatch(JSON.stringify(recipe), /私信正文/);
});

test('有无名元素、少于 3 步、或全是读操作的 act 不沉淀', () => {
  const three = [{ do: 'click', ref: 'e1' }, { do: 'click', ref: 'e2' }, { do: 'click', ref: 'e3' }];
  assert.equal(toRecipe(three, { e1: { role: 'button', name: 'a' }, e2: { role: 'button', name: '' }, e3: { role: 'button', name: 'c' } }), null);
  assert.equal(toRecipe(three.slice(0, 2), {}), null);
  assert.equal(toRecipe([{ do: 'read', contains: 'x' }, { do: 'wait', for: 'idle' }, { do: 'scroll', to: 'bottom' }], {}), null);
});

test('草稿：同样步骤再跑通只记次数；adopt 后进经验且列在最前', () => {
  const steps = [{ do: 'click', find: { role: 'button', name: '写笔记' } }, { do: 'type', find: { role: 'textbox', name: '标题' }, text: '{{标题}}' }, { do: 'click', find: { role: 'button', name: '存草稿' } }];
  const a = saveDraft('https://creator.draft.example/publish?token=secret', steps);
  const b = saveDraft('https://creator.draft.example/publish', steps);
  assert.equal(a.id, b.id);
  assert.equal(b.runs, 2);
  const before = getLearnings('draft.example');
  assert.match(before, /待确认的剧本草稿/);
  assert.doesNotMatch(before, /secret/);           // 起点只留 host+path
  assert.match(adoptDraft('draft.example', a.id, '存一篇笔记草稿'), /已收录/);
  const after = getLearnings('draft.example');
  assert.match(after, /可直接运行的剧本：「存一篇笔记草稿」/);
  assert.doesNotMatch(after, /待确认的剧本草稿/);
  assert.deepEqual(lintPlaybooks(after), []);
});
