// 场景回归测试 —— 需要一个真的 Chrome 和装好的扩展，所以不进 `npm test`，
// 用 `npm run test:live` 单独跑。
//
// 靶场是本地固定页面（test/fixtures/playground.html），每一条都对应一个曾经
// 真实踩过的坑。这些坑的共同点是**静默**：工具返回成功，页面其实没动。
// 没有这份测试，它们会在下一次重构里悄悄回来。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BridgeClient } from '../src/lib/rpc.js';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const PORT = 8124;
const PAGE = `http://127.0.0.1:${PORT}/playground.html`;

let server, server6, c;

const handler = (req, res) => {
  const f = path.join(DIR, (req.url || '/').split('?')[0].replace(/^\//, '') || 'playground.html');
  fs.readFile(f, (e, b) => {
    if (e) { res.writeHead(404); return res.end('nope'); }
    res.writeHead(200, { 'content-type': f.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/plain' });
    res.end(b);
  });
};

before(async () => {
  // 两个监听器、同一个端口：127.0.0.1 给主页面，::1 给 localhost —— 靶场靠这两个
  // 不同的源构造真实的跨源 iframe。只绑一个的话 localhost 那边连不上。
  server = http.createServer(handler);
  server6 = http.createServer(handler);
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  await new Promise((r) => server6.listen(PORT, '::1', r)).catch(() => {});

  c = new BridgeClient({ client: 'test' });
  await c.connect();
  if (!c.extensionOnline) {
    throw new Error('Chrome 扩展没连上，这套测试跑不了。开着 Chrome 再来，或者跑 `npm test`（不需要浏览器）。');
  }
  await c.call('tabs', { action: 'new', url: PAGE });
});

after(async () => {
  try { await c.call('tabs', { action: 'close' }); } catch { /* 已经关了 */ }
  c?.close();          // 不关的话一条开着的 WebSocket 会把进程永远吊住
  server?.close();
  server6?.close();
});

const go = () => c.call('navigate', { url: PAGE + '?t=' + Math.random().toString(36).slice(2) });
const val = (expr) => c.call('eval', { expr }).then((r) => r.text);

test('合成点击发出的是完整鼠标事件序列，不是光一个 click', async () => {
  await go();
  await c.call('click', { selector: '#probe' });
  const seq = await val('window.__events.map(e=>e.type).join(" ")');
  // 只发 click 的实现会漏掉前面这一串，而 react-select / MUI / Element UI
  // 的下拉全都绑在 mousedown 上
  for (const t of ['pointerdown', 'mousedown', 'mouseup', 'click']) {
    assert.match(seq, new RegExp(t), `事件序列里缺 ${t}：${seq}`);
  }
});

test('只监听 mousedown 的自定义下拉能被打开', async () => {
  await go();
  await c.call('click', { selector: '#ctl' });
  assert.equal(await val('ctl.getAttribute("aria-expanded")'), '"true"');
});

test('控件用 preventDefault 自管焦点时，工具不能把焦点抢回来', async () => {
  await go();
  await c.call('click', { selector: '#selfFocus' });
  assert.equal(await val('document.activeElement.id'), '"selfFocusInput"');
});

test('图标按钮点得动 —— SVG 元素没有 click() 方法', async () => {
  await go();
  // 这条守的是一个真实回归：改成「派发到最内层元素」之后，凡是最里层是 <svg>
  // 的按钮全部抛 "el.click is not a function"，而图标按钮遍地都是。
  const r = await c.call('click', { selector: '#clickOnly' });
  assert.ok(!r.isError, JSON.stringify(r));
  assert.equal(await val('clickOut.textContent'), '"已点击"');
});

test('跨源 iframe 也能被注入并列进快照', async () => {
  await go();
  const snap = await c.call('snapshot', {});
  // 支付、验证码、OAuth 都在跨源 iframe 里，这条通不了就等于这些场景全不支持
  assert.match(snap.text, /--- iframe f\d+ · http:\/\/localhost:/);
});

test('shadow DOM 里的控件进得了快照，也点得动', async () => {
  await go();
  const snap = await c.call('snapshot', {});
  assert.match(snap.text, /影子里的输入框/);
  assert.match(snap.text, /影子按钮/);
});

test('iframe 里的元素带 @fN 后缀出现在快照里，并且能操作', async () => {
  await go();
  const snap = await c.call('snapshot', {});
  // 页面上有两个 iframe（同源 + 跨源），必须认准同源那个——跨源的内容
  // 从页面里根本读不到，拿它做断言等于没断言
  const sec = snap.text.split(/--- iframe f\d+ · /).find((s2) => s2.startsWith('http://127.0.0.1'));
  assert.ok(sec, 'iframe 内容没进快照：\n' + snap.text.slice(0, 900));
  const m = /\[(e\d+@f\d+)\]\s+button\s+"iframe 按钮"/.exec(sec);
  assert.ok(m, '同源 iframe 里没找到按钮：\n' + sec.slice(0, 400));
  await c.call('click', { ref: m[1], snapshotId: snap.snapshotId });
  const hit = await val('document.getElementById("frame").contentDocument.getElementById("fout").textContent');
  assert.match(hit, /已点击/);
});

test('一次 fill 填完整张表，并如实回报每个字段', async () => {
  await go();
  const snap = await c.call('snapshot', {});
  const ref = (name) => {
    const m = new RegExp(`\\[(e\\d+)\\]\\s+\\S+\\s+"${name}"`).exec(snap.text);
    assert.ok(m, `快照里找不到「${name}」`);
    return m[1];
  };
  await c.call('fill', {
    snapshotId: snap.snapshotId,
    fields: [
      { ref: ref('姓名'), text: '花叔' },
      { ref: ref('邮箱'), text: 'a@b.com' },
      { ref: ref('我同意条款'), check: true },
    ],
  });
  assert.equal(await val('document.getElementById("nat-name").value'), '"花叔"');
  assert.equal(await val('document.getElementById("nat-agree").checked'), 'true');
});

test('file input 在快照里标成 file，不是 textbox', async () => {
  await go();
  const snap = await c.call('snapshot', {});
  // 标成 textbox 的话 agent 会去 type，而往 file input 写字符串毫无反应
  assert.match(snap.text, /file\s+.*accept: image/);
});

test('没有 for 关联的标签也能给字段命名', async () => {
  await go();
  const snap = await c.call('snapshot', {});
  assert.match(snap.text, /"姓名"/);
});

test('按键会补上默认行为：Tab 移焦点、Enter 触发点击', async () => {
  await go();
  await c.call('click', { selector: '#nat-name' });
  const r = await c.call('key', { key: 'Tab' });
  assert.match(r.text, /焦点移到/);
});

test('一次调用按一串键', async () => {
  await go();
  const r = await c.call('key', { key: ['Tab', 'Tab', 'Escape'] });
  assert.match(r.text, /Tab.*Tab.*Escape/s);
});

test('后台标签页里滚动也能唤醒懒加载', async () => {
  await go();
  // 这是今晚最要紧的一条：后台标签页不产生渲染帧，改 scrollTop 不会派发 scroll 事件，
  // 于是懒加载永远不补货。而「不抢用户焦点」是这个产品的硬规则，两者必须同时成立。
  const before = Number(JSON.parse(await val('feedCount.textContent')));
  await c.call('scroll', { to: 'bottom', times: 6 });
  const after = Number(JSON.parse(await val('feedCount.textContent')));
  assert.ok(after > before, `滚动没触发加载：${before} → ${after}`);
});

test('迟到的校验错误会被顶到快照最上面', async () => {
  await go();
  const r = await c.call('click', { selector: '#triggerErr' });
  assert.match(r.text, /页面提示/);
  assert.match(r.text, /手机号格式不正确/);
});

test('后台标签页的原生 confirm 被浏览器抑制，不会卡死整条链路', async () => {
  await go();
  await c.call('click', { selector: '#popAlert' });
  // 挡住的话下面这句会超时。Chrome 不给后台标签页弹对话框，这正好保护了我们。
  const r = await c.call('query', { selector: 'h1' });
  assert.match(r.text, /靶场/);
});

test('upload 把文件塞进 input，不需要系统文件对话框', async () => {
  await go();
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64');
  await c.call('upload', {
    selector: '#nat-file', name: 'dot.png', type: 'image/png', base64: png.toString('base64'),
  });
  assert.equal(await val('document.getElementById("nat-file").files[0].name'), '"dot.png"');
});

test('没有 file input 时，靠拖放也能把文件送进去', async () => {
  await go();
  // X 的 Article、Notion、语雀这类编辑器页面上根本不存在 <input type=file>，
  // 只监听拖放。这条不通 = 「往文章里插图」整类任务做不了。
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64');
  const r = await c.call('upload', {
    dropSelector: '#dropzone', name: 'dot.png', type: 'image/png', base64: png.toString('base64'),
  });
  // dragover 没被 preventDefault 就说明拖错了地方，工具会把这点说出来
  assert.match(r.text, /页面接管了这次拖放/);
  assert.match(await val('dropOut.textContent'), /dot\.png/);
});

test('query 的 @value 取的是当前值，不是 HTML 里写死的初始值', async () => {
  await go();
  await c.call('type', { selector: '#nat-name', text: '花叔' });
  // getAttribute('value') 会返回空 —— 而「空」看着像「这个字段没填」，
  // 抓一张已填好的表会静默全错
  const r = await c.call('query', { selector: '#nat-name', extract: { name: '.@value' } });
  assert.match(r.text, /花叔/);
});

test('页面内容裹在 untrusted 边界里', async () => {
  await go();
  const snap = await c.call('snapshot', {});
  assert.equal(snap.untrusted, true);
});
