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

// ——— 按键名脱敏漏掉的第二条路：写在正文里的凭据 ———
//
// 上面那批测试守的是「有名字的输入框」：text、value、fields[]、steps[]。
// 但 2026-08-26 翻日志发现，密码是从另一条路进去的——`ask` 的 prompt。
// 那不是输入框，是 agent 写给人看的一段话，原文长这样：
//
//   「TLScontact 登录页已打开，邮箱和密码我都填好了（alchaincyf@gmail.com / <密码>），
//     现在只剩验证码这一步，图片我读不了，得你亲手点。」
//
// 键名脱敏对它结构性无效：字段叫 prompt，而 prompt 的全部价值就是那段话本身，
// 把它整条脱成 <312字>，`ask` 的审计就废了。
//
// 更关键的是这条路不是意外——`ask` 就是「我填好密码了、验证码你来」这个
// 人工接管场景的专用通道，产品自己在把凭据往这里引。和 act 那次一模一样：
// 说明文字推荐什么，敏感数据就流向什么。
//
// 所以这里改成按词切：只挖掉长得像凭据的那几个词，正文一个字不动。
test('ask 的 prompt 里写在正文中的密码被挖掉，话还看得懂', () => {
  const out = redact({
    prompt: '登录页已打开，邮箱和密码我都填好了（alchaincyf@gmail.com / 027565FranceTLS!），'
          + '现在只剩图片验证码这一步，得你亲手点。',
  });
  assert.doesNotMatch(out.prompt, /027565France/, '密码原文进了审计日志');
  // 正文必须还在——否则 ask 的审计就没意义了
  assert.match(out.prompt, /图片验证码/);
  assert.match(out.prompt, /得你亲手点/);
  assert.match(out.prompt, /alchaincyf@gmail\.com/, '邮箱是身份不是凭据，脱掉就查不出谁在操作');
});

test('随机生成的新密码同样挖得掉', () => {
  const out = redact({ prompt: '新密码是 n6KRhYJcOA4ZnbpDGK_v ，存进密码管理器。' });
  assert.doesNotMatch(out.prompt, /n6KRhYJcOA4ZnbpDGK/);
  assert.match(out.prompt, /存进密码管理器/);
});

test('正文里的手机号也挖掉，但不误伤长数字 ID', () => {
  const out = redact({
    prompt: '他表里填的是 008618600755478，和项目记的 +8618600755479 对不上；'
          + '推文是 https://x.com/CVPR/status/2025091650171031 那条。',
  });
  assert.doesNotMatch(out.prompt, /18600755478/);
  assert.doesNotMatch(out.prompt, /18600755479/);
  // 19 位推文 ID 里嵌着 11 位数字，按词切+词边界才不会把它当手机号
  assert.match(out.prompt, /2025091650171031/, '推文 ID 被误当手机号挖了');
});

test('正文脱敏不能吃掉定位信息：URL、路径、选择器、代码', () => {
  // 审计的核心价值是「agent 去过哪、点了什么」，这些必须原样留下
  const out = redact({
    prompt: '在 https://video.twimg.com/amplify_video/2085812345678/vid/1280x720.mp4 上，'
          + '存到 /Users/alchain/Documents/写作/_X采集/2026-08-25/media/2085812345678.mp4',
    expr: 'document.querySelectorAll("input[name=is_author]")',
    url: 'https://registry.npmjs.org/huashu-chrome',
    selector: '#submit-btn-2026',
  });
  assert.match(out.prompt, /amplify_video\/2085812345678/, 'URL 被脱敏吃掉了');
  assert.match(out.prompt, /_X采集\/2026-08-25/, '文件路径被脱敏吃掉了');
  assert.equal(out.expr, 'document.querySelectorAll("input[name=is_author]")');
  assert.equal(out.url, 'https://registry.npmjs.org/huashu-chrome');
  assert.equal(out.selector, '#submit-btn-2026');
});
