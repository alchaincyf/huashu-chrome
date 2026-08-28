// 呈现层的跨文件契约。这些约定散在三个不能互相 import 的文件里
// （注入脚本没法用模块，这是 Chrome 的硬限制），任何一侧单方面改名，
// 浏览器里都不报错——功能只是安静地消失。在这里一秒钟守住。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const mark = read('extension/mark.js');
const content = read('extension/content.js');
const background = read('extension/background.js');
const manifest = JSON.parse(read('extension/manifest.json'));

test('虚拟光标的钩子名两侧一致', () => {
  // content.js 在动作坐标处调 window.__hcCursor，mark.js 负责定义它。
  // 名字一旦分叉，光标永远不动，而所有动作照常成功——没有任何报错能提示这件事。
  assert.ok(/window\.__hcCursor\s*=/.test(mark), 'mark.js 里找不到 window.__hcCursor 的定义');
  assert.ok(/window\.__hcCursor\?\.\(/.test(content), 'content.js 里没有任何 __hcCursor 调用点');
});

test('光标钩子在遮挡检测之前调用', () => {
  // 顺序是安全约束不是风格：钩子内部会让驾驶舱对落点让路（pointer-events:none
  // 同步生效）。反过来的话，elementFromPoint 会把我们自己的面板当成遮挡物，
  // L2 的真实点击更会直接点进面板里。
  // 范围限定在 doLocate 里：realClick 在文件更早的位置也有一个
  // elementFromPoint，那个不归这条约束管
  const fn = content.slice(content.indexOf('async function doLocate'));
  const i = fn.indexOf('window.__hcCursor?.(x, y');
  const j = fn.indexOf('document.elementFromPoint(x, y)');
  assert.ok(i > 0 && j > 0 && i < j, 'doLocate 里光标钩子必须在 elementFromPoint 之前');
});

test('ask 协议的四个动词都由 mark.js 接住', () => {
  // ask-overlay.js 并入 mark.js 时协议原样保留。background 还在说这四个词，
  // 哪个没人接，人工介入链路就断在哪个动词上——而 sendMessage 对没有监听者
  // 的页面 resolve(undefined)，不报错。
  for (const verb of ['show', 'poll', 'flash', 'abort']) {
    assert.ok(mark.includes(`__hcAsk === '${verb}'`), `mark.js 没有处理 __hcAsk:'${verb}'`);
  }
  assert.ok(!background.includes('ask-overlay'), 'background 不该再注入已删除的 ask-overlay.js');
  assert.ok(!fs.existsSync(path.join(ROOT, 'extension/ask-overlay.js')), 'ask-overlay.js 应该已被 mark.js 取代');
});

test('幕帘协议两侧都在', () => {
  // 截图前 background 发 stealth，mark.js 应答并藏起所有浮层。少了任何一侧，
  // agent 的截图里就会出现一个页面上不存在的发光箭头——它会把那当成页面元素。
  assert.ok(mark.includes("__hcMark === 'stealth'"), 'mark.js 没有处理 stealth');
  assert.ok(background.includes("__hcMark: 'stealth'"), 'background 没有在截图前拉幕帘');
});

test('标签组所需的权限已在 manifest 里', () => {
  // 少了它，chrome.tabGroups 是 undefined，syncGroup 静默早退，
  // 彩色组永远画不出来且无任何报错。
  assert.ok(manifest.permissions.includes('tabGroups'));
});

test('status 命令不走受控 tab 槽', () => {
  // status 常在第一个 tab 存在之前就被调。不进 NO_SLOT_CMDS 的话，
  // 槽解析会抛 NO_TAB，agent 的第一句意图声明直接报错——它就再也不会用这个工具了。
  const m = background.match(/NO_SLOT_CMDS = new Set\(\[([^\]]*)\]\)/);
  assert.ok(m && m[1].includes("'status'"), 'status 必须在 NO_SLOT_CMDS 里');
  assert.ok(background.includes('async status('), 'background 缺 status handler');
});

test('时间线和动作文案不带用户输入的内容', () => {
  // actText 只说动词和目标 ref——type/fill 的值可能是密码或私信正文，
  // 而这些字会显示在一个可能正被录屏或投屏的页面上。
  const seg = background.slice(background.indexOf('function actText'), background.indexOf('function actText') + 1500);
  assert.ok(!/p\.text|p\.value/.test(seg), 'actText 不许引用 p.text / p.value');
  // act 批处理的逐步上屏走 panelStep（值脱敏、URL 只留域名），
  // describeStep 是给 agent 的完整回执，两者不能用混——质控抓过一次
  const loop = background.slice(background.indexOf('async act('), background.indexOf('async act(') + 8000);
  assert.ok(/act: `\$\{progress\} · \$\{panelStep\(st\)\}`/.test(loop), 'act 逐步上屏必须用 panelStep');
  assert.ok(!/act: `[^`]*describeStep/.test(loop), 'act 上屏文案不许用 describeStep');
});

test('页面的门牌我们都不碰：标题和 favicon', () => {
  // 花叔定的品牌边界：头像只出现在我们自己的标识位（驾驶舱/ask/扩展图标/
  // 标签组），favicon 是网站的门牌、标题是网站的名字，谁把「替换它们」的
  // 逻辑加回来都该在这里被拦下。盯代码不盯注释。
  assert.ok(!mark.includes('document.title ='), 'mark.js 不许写 document.title');
  assert.ok(!mark.includes('data-hc-fav') && !/rel~="icon"/.test(mark), 'mark.js 不许动 favicon link');
  // 指针是指针：光标必须是 svg 箭头，不是头像 canvas
  assert.ok(/<svg[^>]*viewBox="0 0 26 26"/.test(mark), '光标的箭头 svg 不见了');
  assert.ok(!mark.includes("avatarCanvas(30, 'face')"), '光标不许用头像替代箭头');
});

test('头像资产已内嵌且不走会被 CSP 拦的路', () => {
  const m = mark.match(/const AVATAR_B64 = '([^']*)'/);
  assert.ok(m && m[1].length > 1000 && !m[1].includes('__HC_'), 'AVATAR_B64 是占位符或缺失');
  assert.ok(mark.includes('createImageBitmap'), '页内头像必须走 createImageBitmap（纯内存，CSP 管不着）');
  // 盯代码不盯注释：createElement('img') / new Image 才是会被 CSP 拦的那条路
  assert.ok(!/createElement\(['"]img['"]\)|new Image\(/.test(mark),
    'mark.js 不许创建 img 元素——严格 CSP 站点 img-src 不带 data: 时会静默烂掉');
});
