// 前台保护：agent 干活不该把用户正在看的页顶掉。
//
// 唯一一条会抢前台的自动路径是「页面自己 window.open 出新页」——Chrome 默认把
// 子页设成前台，扩展只是跟过去。这条链路上任何一环改名/漏调，用户就会觉得
// 「agent 每次打开都抢我的页面」，而所有测试照常绿。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const background = fs.readFileSync(path.join(ROOT, 'extension/background.js'), 'utf8');

test('动作前记住这一窗的前台页', () => {
  const i = background.indexOf('async function performCore');
  assert.ok(i > 0, 'performCore 不见了');
  const head = background.slice(i, i + 2500);
  assert.ok(/frontBefore\s*=/.test(head),
    'performCore 没记 frontBefore：子页抢走前台后无处可还');
});

test('跟过去的子页要被还回前台', () => {
  const i = background.indexOf('if (child) {');
  assert.ok(i > 0, '子页跟随分支不见了');
  const branch = background.slice(i, i + 900);
  assert.ok(/restoreFront\(frontBefore,\s*child\.id\)/.test(branch),
    '子页分支没调 restoreFront');
  assert.ok(/frontRestored/.test(branch), '回执里没有 frontRestored，排障时看不出前台有没有还被抢');
});

test('还前台只在确有必要时动手', () => {
  const i = background.indexOf('async function restoreFront');
  assert.ok(i > 0, 'restoreFront 不见了');
  const body = background.slice(i, i + 900);
  assert.ok(/windowId !== childTab\.windowId/.test(body), '没校验同窗：会把另一个窗口的标签页激活');
  assert.ok(/!childTab\.active/.test(body), '没校验子页是否真被切到前台：会无意义地改前台');
  assert.ok(/prevId === childId/.test(body), '没排除「记住的就是子页自己」');
});

test('创建即归还只动这次动作自己开的页', () => {
  // 两个会话在同一窗口里干活时，别的会话开的页也会触发 onCreated。
  // 归还只认 frontGuard.opened（noteGuardTab 按窗口登记过的），不认「同窗口」。
  // 退回按窗口判断，前台就会在两个会话的页之间来回跳。
  const i = background.indexOf('chrome.tabs.onCreated.addListener');
  assert.ok(i > 0, 'onCreated 监听不见了');
  const body = background.slice(i, i + 700);
  assert.ok(/frontGuard\.opened\.has\(tab\.id\)/.test(body),
    '创建即归还没有用「这次动作开出来的页」作判据：会把别的会话的页按回去');
  assert.ok(!/tab\.windowId === frontGuard\.winId/.test(body),
    '创建即归还还在按窗口判断');
});

test('要抢前台只能走 takeFront，它会先撤防', () => {
  // 新增一种「该抢前台」的场景时只加一处 takeFront 调用。
  // 直接 chrome.tabs.update({active:true}) 不会撤防，护栏会把这次动作开出的页按回后台。
  const def = background.slice(background.indexOf('async function takeFront'), background.indexOf('async function takeFront') + 400);
  assert.ok(/standDownFront\(\)/.test(def), 'takeFront 没有先撤防');
  const hits = [...background.matchAll(/chrome\.tabs\.update\([^)]*\{\s*active:\s*true/g)];
  for (const m of hits) {
    const around = background.slice(Math.max(0, m.index - 500), m.index);
    const allowed = /function takeFront|function restoreFront|frontGuard|__hcPopup/.test(around);
    assert.ok(allowed, `切前台绕过了 takeFront：…${background.slice(m.index - 80, m.index + 50)}…`);
  }
});

test('除显式 focus 外，没有别的地方把 agent 的页切到前台', () => {
  // 允许的自动切前台点只有三处：支付确认、ask 人工介入、截图显式要 focus。
  const hits = [...background.matchAll(/chrome\.tabs\.update\([^)]*\{\s*active:\s*true/g)];
  for (const m of hits) {
    const around = background.slice(Math.max(0, m.index - 1600), m.index);
    const allowed = /confirmPay|p\.focus|focus !== false|__hcPopup|restoreFront|settleFront|frontGuard|ask/i.test(around);
    assert.ok(allowed, `发现一处未受约束的切前台：…${background.slice(m.index - 80, m.index + 60)}…`);
  }
});
