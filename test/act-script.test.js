// act 剧本的形状规则。extension/script.js 是真源——background 按它执行、
// mcp-server 按它算超时预算、这里守它的规则，三方必须同源。
// 分叉的后果都不是「报错」而是静默：预算判死老实跑的剧本、
// 或者一个 schema 允许的合法剧本在运行时被莫名掐死。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateScript, flatCount, condText,
  REPEAT_MAX, REPEAT_DEFAULT, EXEC_BUDGET,
} from '../extension/script.js';

test('普通线性 steps 原样通过', () => {
  assert.equal(validateScript([{ do: 'click', ref: 'e1' }, { do: 'type', ref: 'e2', text: 'x' }]), null);
});

test('repeat 里嵌控制块被拦下，错误信息说清怎么改', () => {
  const msg = validateScript([{ do: 'repeat', steps: [{ do: 'if', cond: {}, then: [{ do: 'click' }] }] }]);
  assert.match(msg, /只允许一层/);
  const msg2 = validateScript([{ do: 'if', cond: {}, then: [{ do: 'repeat', steps: [{ do: 'click' }] }] }]);
  assert.match(msg2, /只允许一层/);
});

test('repeat 子步用 ref 被拦下——第二轮页面重渲染后 ref 必然作废', () => {
  const msg = validateScript([{ do: 'repeat', steps: [{ do: 'click', ref: 'e7' }] }]);
  assert.match(msg, /find/);
  // find 和 selector 都是循环安全的定位方式
  assert.equal(validateScript([{ do: 'repeat', steps: [{ do: 'click', find: { name: '下一页' } }], until: { selectorExists: 'x' } }]), null);
  assert.equal(validateScript([{ do: 'repeat', steps: [{ do: 'scroll', to: 'bottom' }, { do: 'click', selector: '.next' }] }]), null);
});

test('if 必须有 cond 和 then；assert 必须有 cond', () => {
  assert.match(validateScript([{ do: 'if', then: [{ do: 'click', selector: 'x' }] }]), /cond/);
  assert.match(validateScript([{ do: 'if', cond: {} }]), /then/);
  assert.match(validateScript([{ do: 'assert' }]), /cond/);
});

test('flatCount 把 repeat/if 展开成实际会执行的原子步数', () => {
  assert.equal(flatCount([{ do: 'click' }, { do: 'type' }]), 2);
  assert.equal(flatCount([{ do: 'repeat', steps: [{ do: 'click' }, { do: 'scroll' }], max: 5 }]), 10);
  assert.equal(flatCount([{ do: 'repeat', steps: [{ do: 'click' }] }]), REPEAT_DEFAULT);
  assert.equal(flatCount([{ do: 'repeat', steps: [{ do: 'click' }], max: 999 }]), REPEAT_MAX);
  // if 按较长的分支计——预算要按最坏路径给
  assert.equal(flatCount([{ do: 'if', cond: {}, then: [{ do: 'click' }], else: [{ do: 'click' }, { do: 'click' }] }]), 2);
});

test('schema 允许的合法剧本不能被执行预算掐死', () => {
  // 单个 repeat 顶格是 25 轮 × 2 步 = 50，必须落在 EXEC_BUDGET 之内，
  // 否则「schema 说可以、运行时说不行」——agent 没法从错误里学到规则
  assert.ok(REPEAT_MAX * 2 <= EXEC_BUDGET, `${REPEAT_MAX}×2 超出预算 ${EXEC_BUDGET}`);
});

test('condText 人话可读、not 取反、超长截短', () => {
  assert.equal(condText({ selectorExists: '.next' }), '有 .next');
  assert.match(condText({ urlContains: '/done', not: true }), /^非（/);
  assert.match(condText({ textContains: 'x'.repeat(99) }), /…?"?/);
  assert.ok(condText({ textContains: 'x'.repeat(99) }).length < 40);
  assert.equal(condText(null), '');
});
