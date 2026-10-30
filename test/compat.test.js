// 扩展与本地端的兼容分级。以前补丁号差一位就报警，商店用户 17 天天天看见。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compat, compatNote, cmpVersion } from '../extension/compat.js';

test('补丁号不同 = 兼容，静默', () => {
  assert.equal(compat({ ext: '1.2.0', cli: '1.2.1' }), 'patch');
  assert.equal(compatNote('patch', { ext: '1.2.0', cli: '1.2.1' }), '');
});

test('次版本落后分清是哪一边', () => {
  assert.equal(compat({ ext: '1.2.1', cli: '1.3.0' }), 'ext-old');
  assert.equal(compat({ ext: '1.3.0', cli: '1.2.1' }), 'cli-old');
  assert.match(compatNote('cli-old', { ext: '1.3.0', cli: '1.2.1' }), /lingee-chrome@latest install/);
  assert.match(compatNote('ext-old', { ext: '1.2.1', cli: '1.3.0' }), /自动更新/);
});

test('协议号不同才是真不兼容，哪怕版本号一样', () => {
  assert.equal(compat({ ext: '1.3.0', cli: '1.3.0', extProtocol: 2 }), 'protocol');
});

test('版本号按数字比，不按字符串比', () => {
  assert.equal(cmpVersion('1.10.0', '1.9.9'), 1);
  assert.equal(compat({ ext: '1.10.0', cli: '1.9.0' }), 'cli-old');
});

test('缺任一边版本时不报警', () => {
  assert.equal(compat({ ext: '', cli: '1.2.1' }), 'same');
});

// 审计里的效果分类：只取类别、不存正文
import { effectOf } from '../src/bridge.js';

test('写操作回执按效果分类进审计', () => {
  assert.equal(effectOf({ text: '已点击 x\n⚠️ 操作已发出，但页面完全没有反应（DOM…）' }), 'none');
  assert.equal(effectOf({ text: '已点击 x\n效果：页面上暂时没有可见变化，但这次操作发出了请求：POST /a → 200。' }), 'request-only');
  assert.equal(effectOf({ text: '已点击 x\n效果：DOM +3\n请求：POST /a → 200' }), 'changed+request');
  assert.equal(effectOf({ text: 'act 完成（顶层 3/3）：', recipe: [] }), 'act-done+draft');
  assert.equal(effectOf({ text: 'act 停在第 2 步（顶层 1/3）：' }), 'act-stopped');
  assert.equal(effectOf({ text: '# 页面标题' }), undefined);
});
