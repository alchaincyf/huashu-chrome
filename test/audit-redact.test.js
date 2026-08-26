// 审计脱敏 —— 不需要浏览器，进 `npm test`
//
// 这套测试的由来是一次真实泄露：redact() 原先按顶层字段逐个点名
//（params.text、params.fields[].text），而 act 把动作放在 params.steps[] 里，
// 于是整条穿了过去。事后翻 ~/.huashu-chrome/audit.jsonl，里面躺着
// 5 条疑似密码和 27 个手机号的明文，最早的已经在那儿放了一整天。
//
// 更糟的是产品自己把用户往那条路上引：MCP 的说明文字写着
//「登录、多步表单、向导——全都一次说完」，也就是最敏感的输入恰好
// 走的就是唯一没脱敏的通道。而 README 同时承诺着「输入的文本做脱敏」。
//
// 这类失效是完全静默的：日志照写、命令照跑，没有任何报错。
// 所以它必须有一道跑得飞快、每次提交都会跑的测试。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redact } from '../src/bridge.js';

const PW = 'hunter2!SecretPass';

test('act 的 steps 里的输入被脱敏 —— 就是漏过密码的那条路', () => {
  const out = redact({
    steps: [
      { do: 'type', ref: 'e19', text: PW },
      { do: 'type', ref: 'e20', text: '13800138000' },
      { do: 'click', find: { role: 'button', name: '登录' } },
    ],
  });
  const s = JSON.stringify(out);
  assert.doesNotMatch(s, /hunter2/, '密码原文进了审计日志');
  assert.doesNotMatch(s, /13800138000/, '手机号原文进了审计日志');
  assert.match(out.steps[0].text, /^<\d+字>$/);
  // 该留的要留下：审计要能回答「谁在什么时候做了什么」
  assert.equal(out.steps[0].do, 'type');
  assert.equal(out.steps[0].ref, 'e19');
  assert.equal(out.steps[2].find.name, '登录');
});

test('顶层的 text 和 fill 的 fields 照旧脱敏（回归）', () => {
  assert.match(redact({ text: PW }).text, /^<\d+字>$/);
  const f = redact({ fields: [{ ref: 'e1', text: PW }, { ref: 'e2', value: PW }] });
  assert.match(f.fields[0].text, /^<\d+字>$/);
  assert.match(f.fields[1].value, /^<\d+字>$/);
});

test('再嵌几层也脱得掉', () => {
  // 按键名脱敏而不是按路径点名，图的就是这个：下一个带 text 的命令
  // 长什么样现在还不知道，但它一定也不该把内容写进日志
  const out = redact({ steps: [{ do: 'fill', fields: [{ ref: 'e1', text: PW }] }] });
  assert.doesNotMatch(JSON.stringify(out), /hunter2/);
});

test('base64 只留大小，不抄整个文件', () => {
  const out = redact({ base64: 'A'.repeat(40000), name: 'x.png' });
  assert.match(out.base64, /^<\d+KB>$/);
  assert.equal(out.name, 'x.png');
});

test('eval 的长表达式截断，短的原样留着', () => {
  assert.equal(redact({ expr: 'document.title' }).expr, 'document.title');
  assert.equal(redact({ expr: 'x'.repeat(300) }).expr.length, 201);
});

test('URL 和 selector 这类定位信息不该被脱掉', () => {
  // 脱过头审计就失去意义了——出事时要能看出 agent 去过哪、点了什么
  const out = redact({ url: 'https://example.com/pay?id=7', selector: '#submit', ref: 'e3' });
  assert.equal(out.url, 'https://example.com/pay?id=7');
  assert.equal(out.selector, '#submit');
  assert.equal(out.ref, 'e3');
});

test('不炸在循环引用和奇怪输入上', () => {
  const a = { steps: [] };
  a.self = a;
  assert.doesNotThrow(() => redact(a));
  assert.equal(redact(null), null);
  assert.equal(redact('字符串'), '字符串');
});
