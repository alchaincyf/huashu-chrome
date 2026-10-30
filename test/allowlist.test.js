// 站点白名单裁决 —— 不需要浏览器，进 `npm test`
//
// 这是 lingee-chrome 的"带权限"卖点的核心闸门：企业内部部署时把 mode 设成
// allowlist、sites 填内部域名，agent 就只能操作名单内的站。这条链路上最容易
// 静默坏掉的两头：① 默认该放行却拦了（升级即炸，所有现有用户的 agent 停摆）；
// ② 开了严格模式却漏放行（防伪后缀 evil-kingdee.com 冒充 kingdee.com）。两头都钉住。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideSite, hostAllowed, hostOf } from '../src/lib/allowlist.js';

test('未配置（list=null）一律放行 —— 升级不打断现有用户', () => {
  assert.equal(decideSite('https://anything.com/x', null), null);
});

test('mode 不是 allowlist 视为关闭 —— 全放行', () => {
  assert.equal(decideSite('https://anything.com', { mode: 'off', sites: ['kingdee.com'] }), null);
  assert.equal(decideSite('https://anything.com', { sites: ['kingdee.com'] }), null);
});

test('开启后：名单内放行', () => {
  const list = { mode: 'allowlist', sites: ['kdm.lingee.com', 'kingdee.com'] };
  assert.equal(decideSite('https://kdm.lingee.com/kdops/pm-dashboard', list), null);
});

test('开启后：名单外拦截，返回 SITE_NOT_ALLOWED', () => {
  const list = { mode: 'allowlist', sites: ['kingdee.com'] };
  const gate = decideSite('https://baidu.com', list);
  assert.equal(gate?.code, 'SITE_NOT_ALLOWED');
});

test('子域命中：名单写 kingdee.com，www 和多级子域都算同一机构', () => {
  const list = { mode: 'allowlist', sites: ['kingdee.com'] };
  assert.equal(decideSite('https://www.kingdee.com', list), null);
  assert.equal(decideSite('https://a.b.kingdee.com', list), null);
});

test('防伪后缀：evil-kingdee.com 不是 kingdee.com 的子域，必须拦', () => {
  const list = { mode: 'allowlist', sites: ['kingdee.com'] };
  assert.equal(decideSite('https://evil-kingdee.com', list)?.code, 'SITE_NOT_ALLOWED');
  assert.equal(decideSite('https://kingdee.com.attacker.net', list)?.code, 'SITE_NOT_ALLOWED');
});

test('反向不成立：名单写 a.kingdee.com 不放行裸 kingdee.com', () => {
  const list = { mode: 'allowlist', sites: ['a.kingdee.com'] };
  assert.equal(decideSite('https://kingdee.com', list)?.code, 'SITE_NOT_ALLOWED');
});

test('命令不带 url（纯 click 等）这一层不管 —— 放行', () => {
  const list = { mode: 'allowlist', sites: ['kingdee.com'] };
  assert.equal(decideSite(undefined, list), null);
  assert.equal(decideSite('', list), null);
});

test('url 解析不出主机名 —— 放行，不在这层误伤', () => {
  const list = { mode: 'allowlist', sites: ['kingdee.com'] };
  assert.equal(decideSite('not-a-url', list), null);
});

test('hostOf 垃圾输入回空串不抛', () => {
  assert.equal(hostOf('https://x.com/a'), 'x.com');
  assert.equal(hostOf('garbage'), '');
});

test('hostAllowed：sites 缺省/非数组不抛，当空名单', () => {
  assert.equal(hostAllowed('x.com', undefined), false);
  assert.equal(hostAllowed('x.com', null), false);
});
