// act 剧本的形状真源 —— 校验、预算、条件文案，三方共用
//
// 「剧本长什么样」这一件事有三个消费方：background 执行它、mcp-server 按它
// 算超时预算、测试守它的规则。各抄一份的下场是静默分叉（哨兵事件的教训），
// 所以规则全部住在这里，谁要用谁 import。
//
// 剧本 = 线性 steps + 三个控制块：
//   repeat  子步循环，直到 until 条件命中或跑满 max（翻页、滚动收集）
//   if      条件成立才走 then 分支，否则走 else（可选的 cookie 横幅、登录态分岔）
//   assert  条件不成立就停下（中途护栏，防止在错误前提上继续跑）
//
// 条件词汇 {urlContains, selectorExists, textContains, not} 与 ask 的 until
// 同一套——agent 学一次，两处都会用。多字段取或，not 对整体取反。

// 控制块只允许一层：repeat/if 的子步里不得再嵌控制块。
// 不是实现不了，是不该实现——两层嵌套的剧本人已经读不懂了，而 agent 写错时
// 的调试成本全落在用户的真实页面上。需要更复杂的流程，拆成多次 act。
export const REPEAT_MAX = 25;       // 单个 repeat 的轮数上限
export const REPEAT_DEFAULT = 10;   // 不写 max 时的默认轮数
export const EXEC_BUDGET = 60;      // 单次 act 实际执行的原子步数上限（防 repeat 失控）

const BLOCKS = new Set(['repeat', 'if', 'assert']);

export const repeatMax = (st) => Math.min(Math.max(Number(st.max) || REPEAT_DEFAULT, 1), REPEAT_MAX);

// 静态校验：把注定失败的形状在跑之前拦下来，错误信息要说清怎么改。
// 返回 null 或错误消息字符串——不 throw，调用方自己决定错误的形状。
export function validateScript(steps) {
  for (let i = 0; i < steps.length; i++) {
    const st = steps[i] || {};
    if (st.do === 'repeat') {
      const inner = st.steps;
      if (!Array.isArray(inner) || !inner.length) return `第 ${i + 1} 步 repeat 没有 steps 子步`;
      for (const s of inner) {
        if (BLOCKS.has(s?.do)) return `第 ${i + 1} 步 repeat 里嵌了 ${s.do}——控制块只允许一层，拆成多次 act`;
        // ref 指向的是进入循环前那份快照，第二轮页面重渲染后必然作废。
        // 与其让它在第二轮神秘失败，不如现在就说清楚。
        if (s?.ref && !s?.find) return `第 ${i + 1} 步 repeat 的子步用了 ref="${s.ref}"——循环里页面每轮都会变，改用 find（role+名字）或 selector`;
      }
    }
    if (st.do === 'read') {
      if (!st.ref && !st.find && !st.selector && !st.contains) {
        return `第 ${i + 1} 步 read 没说读什么：给 ref / find / selector 读某个元素，或给 contains 按文本找`;
      }
    }
    if (st.do === 'if') {
      if (!st.cond) return `第 ${i + 1} 步 if 没写 cond`;
      for (const s of [...(st.then || []), ...(st.else || [])]) {
        if (BLOCKS.has(s?.do)) return `第 ${i + 1} 步 if 分支里嵌了 ${s.do}——控制块只允许一层，拆成多次 act`;
      }
      if (!Array.isArray(st.then) || !st.then.length) return `第 ${i + 1} 步 if 没有 then 分支`;
    }
    if (st.do === 'assert' && !st.cond) return `第 ${i + 1} 步 assert 没写 cond`;
  }
  return null;
}

// 预估会执行多少原子步——mcp-server 拿它算超时预算（一步约 8 秒上限），
// background 拿 EXEC_BUDGET 在运行时兜底。俩数字必须同源，否则预算判死
// 一个还在老实跑的剧本（「已经在做」被报成「没做，去重试」——最坏的错配）。
export function flatCount(steps) {
  return (Array.isArray(steps) ? steps : []).reduce((n, st) => {
    if (st?.do === 'repeat') return n + repeatMax(st) * (st.steps?.length || 1);
    if (st?.do === 'if') return n + Math.max(st.then?.length || 0, st.else?.length || 0, 1);
    return n + 1;
  }, 0);
}

// 条件的人话版，进回执和驾驶舱。条件是 agent 声明的期望而不是用户输入，
// 但仍截短——textContains 可能引用页面上的长句。
export function condText(cond) {
  if (!cond || typeof cond !== 'object') return '';
  const parts = [];
  if (cond.urlContains) parts.push(`url含"${String(cond.urlContains).slice(0, 30)}"`);
  if (cond.selectorExists) parts.push(`有 ${String(cond.selectorExists).slice(0, 30)}`);
  if (cond.textContains) parts.push(`文本含"${String(cond.textContains).slice(0, 20)}"`);
  if (cond.ref || cond.selector) {
    const who = cond.ref ? `[${cond.ref}]` : `(${String(cond.selector).slice(0, 30)})`;
    for (const k of ['checked', 'value', 'text']) if (k in cond) parts.push(`${who} ${k}=${JSON.stringify(cond[k]).slice(0, 30)}`);
  }
  const s = parts.join(' 或 ') || '（空条件）';
  return cond.not ? `非（${s}）` : s;
}
