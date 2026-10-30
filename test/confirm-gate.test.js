// 敏感动作确认闸裁决 —— 不需要浏览器，进 `npm test`
//
// 第二刀的核心：原版只有付款会弹窗，删除/发布/提交/转账在单次 click 时直接执行。
// 这一层回答「这一下危险动作要不要先问人」。链路上最容易静默坏掉的两头：
//   ① 默认该直接执行却弹窗了（升级即炸，现有 agent 全被打断、没人点头就卡死）；
//   ② 开了确认闸却漏判敏感（删除悄悄跑过去，等于闸没接上）。两头都钉住。
// 另外付款必须和本开关解耦：本层永远不替付款做决定，付款由 loc.pay 独立处理。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideConfirm, normalizeMode, CONFIRM_MODES } from '../extension/confirm-gate.js';

test('默认关闭：没配置时敏感动作直接执行 —— 升级不打断现有 agent', () => {
  assert.equal(decideConfirm(true, null), false);
  assert.equal(decideConfirm(true, undefined), false);
  assert.equal(decideConfirm(true, {}), false);
  assert.equal(decideConfirm(true, { mode: 'off' }), false);
});

test('开启后：敏感动作要人点头', () => {
  const gate = decideConfirm(true, { mode: 'sensitive' });
  assert.ok(gate, '开了确认闸、又是敏感动作，必须拦下来问人');
  assert.equal(gate.code, 'NEEDS_CONFIRM');
});

test('开启后：非敏感动作照旧直接执行 —— 普通点击不该被打断', () => {
  assert.equal(decideConfirm(false, { mode: 'sensitive' }), false);
  assert.equal(decideConfirm(undefined, { mode: 'sensitive' }), false);
  assert.equal(decideConfirm(null, { mode: 'sensitive' }), false);
});

test('不认识的 mode 当作关闭 —— 配置写错不能静默变成"全放行式"误解', () => {
  assert.equal(decideConfirm(true, { mode: 'allowlist' }), false);
  assert.equal(decideConfirm(true, { mode: 'strict' }), false);
  assert.equal(decideConfirm(true, { mode: '' }), false);
  assert.equal(decideConfirm(true, { mode: true }), false);
});

test('normalizeMode：只认识 sensitive，其余一律归到 off', () => {
  assert.equal(normalizeMode({ mode: 'sensitive' }), 'sensitive');
  assert.equal(normalizeMode({ mode: 'off' }), 'off');
  assert.equal(normalizeMode({}), 'off');
  assert.equal(normalizeMode(null), 'off');
  assert.equal(normalizeMode(undefined), 'off');
  assert.equal(normalizeMode('sensitive'), 'off');   // 不是对象
  assert.equal(normalizeMode({ mode: 'SENSITIVE' }), 'off'); // 大小写不放宽
});

test('确认闸永不替付款做决定 —— 付款由 loc.pay 独立处理，和本开关解耦', () => {
  // 本层输入只有「是否敏感」。无论开不开，它都不碰付款逻辑：
  // 关闭时敏感动作直接过（付款仍会在 confirmPay 那条路被拦），
  // 开启时也只对 sensitive 生效，不读任何 pay 字段。
  assert.equal(decideConfirm(false, { mode: 'off' }), false);
  assert.equal(decideConfirm(false, { mode: 'sensitive' }), false);
});

test('CONFIRM_MODES 暴露给 UI/CLI 用，含且仅含两档', () => {
  assert.deepEqual(CONFIRM_MODES, ['off', 'sensitive']);
});
