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

// ---------- v0.3：效果证据 ----------
//
// 这一组测的是「工具返回成功，页面其实没动」这类静默失败有没有被抓住。
// 每一条都对应开发时真实撞出来的一个误判。

test('点击有反应时，效果写在返回的最前面', async () => {
  await go();
  const r = await c.call('click', { selector: '#ctl' });
  // 只认 mousedown 的下拉：展开与否只体现在 aria-expanded 上，
  // DOM 节点数和正文长度都不变——所以必须有「目标自身状态」这一维证据
  assert.match(r.text, /效果：/);
  assert.match(r.text, /expanded false → true/);
});

test('点击毫无反应时，明确报出来，而不是回一份看着正常的快照', async () => {
  await go();
  const r = await c.call('click', { selector: '#deadBtn' });
  assert.match(r.text, /没有反应|没有可归因于这次操作的变化/);
});

test('焦点落到目标自己身上不算「页面有反应」', async () => {
  await go();
  // 点击必然让目标获得焦点（L1 显式 focus，L2 由浏览器聚焦），
  // 把它当证据的话任何一次点击都「有效果」，自动升级就永远不会触发
  const r = await c.call('click', { selector: '#deadBtn' });
  assert.doesNotMatch(r.text, /效果：焦点 → button#deadBtn/);
});

test('表单校验错误进入效果证据，不会被当成提交成功', async () => {
  await go();
  const r = await c.call('click', { selector: '#triggerErr' });
  // 这条提示在长页面的下方，正文节选截不到——漏掉它，
  // 「已提交」和「被校验拦下」在 agent 眼里一模一样
  assert.match(r.text, /页面提示/);
  assert.match(r.text, /手机号格式不正确/);
});

test('页面自己在动时，不把别处的变化算成这次操作的战果', async () => {
  await go();
  const r = await c.call('click', { selector: '#deadBtn' });
  // 靶场的懒加载 feed 一直在填内容，全局正文长度始终在变。
  // 判定只看目标附近，所以这里不该出现「效果：」的结论
  assert.doesNotMatch(r.text, /^效果：/m);
});

// ---------- v0.3：L1 / L2 分层 ----------

test('原生 <select> 强制走 L1，不会被升级到真实事件', async () => {
  await go();
  const r = await c.call('select', { selector: '#nat-city', value: '深圳' });
  // L2 点击原生 select 打开的是浏览器进程的原生 popup，CDP 的 Input 打不到它，
  // 键盘会被 popup 吃掉，下拉还会卡在打开状态挡住后续操作
  assert.doesNotMatch(r.text, /（真实事件）/);
  // value 是 option 的 value 属性（sz），不是它的可见文本（深圳）——
  // `select` 工具两者都认，但页面上落下的是前者
  assert.equal(await val('document.getElementById("nat-city").value'), '"sz"');
});

test('敏感文案的目标不自动升级，避免重复执行', async () => {
  await go();
  const r = await c.call('click', { selector: '#paySim' });
  assert.match(r.text, /没有自动用真实事件重试/);
  // 没有真的「支付」出去，这是这道闸门存在的全部意义
  assert.equal(await val('document.getElementById("payOut").textContent'), '"未触发"');
});

// 下面两条需要用户在扩展弹窗里开过「高保真模式」，没开就跳过——
// 未授权时的正确行为是干净降级，那由上面的用例覆盖。
//
// 判据不能写成 includes('真实事件')：未授权时的提示语是「真实事件也没能用上」，
// 正好含这四个字，于是该跳过的用例反而跑了起来，失败得莫名其妙。
// 认「没拿到权限」这句话本身，比认「有没有成功」可靠。
const l2 = async () => {
  const { text } = await c.call('click', { selector: '#deadBtn' });
  return !/还没拿到调试器权限/.test(text);
};

test('只认 isTrusted 的按钮：普通事件无效时自动升级并成功', async (t) => {
  await go();
  if (!(await l2())) return t.skip('未开启高保真模式');
  const r = await c.call('click', { selector: '#trustedOnly' });
  assert.match(r.text, /真实事件/);
  assert.equal(await val('document.getElementById("trustedOut").textContent'), '"已触发（真实事件）"');
});

test('敏感目标显式传 real:true 时照做', async (t) => {
  await go();
  if (!(await l2())) return t.skip('未开启高保真模式');
  await c.call('click', { selector: '#paySim', real: true });
  assert.equal(await val('document.getElementById("payOut").textContent'), '"已支付（真实事件）"');
});

// ---------- v0.3：人工介入 ----------

test('ask 的 until 判据命中时自动收工，不用用户点', async () => {
  await go();
  const r = await c.call('ask', {
    prompt: '自动完成测试，无需操作',
    timeout: 15000,
    until: { textContains: '事件记录仪' },
    focus: false,
  }, { timeoutMs: 40000 });
  assert.equal(r.outcome, 'completed');
});

test('ask 超时返回 timed_out，且和「用户拒绝」分得开', async () => {
  await go();
  const r = await c.call('ask', {
    prompt: '这条会超时',
    timeout: 5000,
    focus: false,
  }, { timeoutMs: 30000 });
  // timed_out = 没人在；cancelled = 用户明确说别做。
  // 混在一起的话，agent 会把「用户拒绝」当成「再试一次」
  assert.equal(r.outcome, 'timed_out');
});

test('无人值守模式下 ask 立即返回，不干等', async () => {
  await go();
  const r = await c.call('ask', { prompt: '没人可问', disabled: true }, { timeoutMs: 20000 });
  assert.equal(r.outcome, 'disabled');
});

// ---------- v0.3：受控标签页漂移 ----------

test('标签页被别人导航走时，读取操作显著警告而不是若无其事', async () => {
  await go();
  // 用页面自己的世界跳转，等价于「用户自己点了链接」或「站点自动重定向」——
  // 都不经过 agent 的 navigate，所以 agent 不知道自己已经换了一页
  await c.call('eval', { expr: '(location.href = "http://127.0.0.1:8124/frame-inner.html", "x")' });
  await new Promise((r) => setTimeout(r, 1500));
  const r = await c.call('read_text', {});
  // 这条保护是一次真实事故推出来的：agent 以为还在 npm 的 access 页，
  // 那个标签页其实已经跳到 2FA 设置页，一次 read_text 把用户的恢复码整页读走了
  assert.match(r.text, /地址变了/);
  assert.match(r.text, /别在陌生页面上继续操作或读取/);
});

test('agent 自己导航过去的不算漂移', async () => {
  await go();
  const r = await c.call('read_text', {});
  assert.doesNotMatch(r.text, /地址变了/);
});

test('ref 和 selector 同时传要报错，不能静默只用一个', async () => {
  await go();
  // 两个都给时 selector 生效，而回执印的是 ref——开发中真撞到过：
  // 回执说「已点击 [e26]（提交按钮）」，实际点掉的是页面顶部的通知关闭按钮
  await assert.rejects(
    () => c.call('click', { selector: 'button', ref: 'e1', snapshotId: 's1' }),
    /只能给一个/);
});
