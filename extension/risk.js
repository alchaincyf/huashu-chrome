// 风控挑战判定 —— 纯字符串判定，不碰任何 chrome API
//
// 2026-08-28 的真实一轮：在 lovart.art 上连发两条消息，两条都弹了「浏览器验证」，
// 每条都要用户手动点一次「开始验证」，一轮实测被切得稀碎。
//
// 根因不是点击方式写错了，是**分层策略在这类站点上失效**：
// L1（content script 派发的事件）isTrusted 永远是 false，而风控正是靠这个判人机。
// 偏偏 L1 在这些站上**是"生效"的**——消息确实发出去了、DOM 确实变了——
// 于是 background 里那条「零证据 → 升级 L2」的路根本不会触发。
// 我们一路用不可信事件操作，风控一路攒分，攒够了弹验证码。
// 等看见验证码时这一轮已经废了，而且是只有人能解的那种废法。
//
// 所以把「弹了验证」本身当信号：记住这个 origin，之后一律从 L2 起步。
// 判定放这里是为了能被 `npm test` 直接跑到，不必开真 Chrome。

// 挑战文案。只用于顶层浮层的文本，不扫全文——「验证」这两个字在正文里太常见，
// 全文匹配会把「实名验证入口」这类静态文案当成挑战。
export const CHALLENGE_TEXT = /浏览器验证|人机验证|安全验证|滑动验证|请完成验证|开始验证|拖动滑块|按住不放|verify (you|that you)|are you (a )?human|i'?m not a robot|checking your browser|just a moment|press (and|&) hold|complete the (security )?check/i;

// 挑战组件的宿主。命中 iframe src 就够了，不必看里面（跨源也看不了）。
export const CHALLENGE_FRAME = /challenges\.cloudflare\.com|hcaptcha\.com|recaptcha|geetest|captcha|arkoselabs|funcaptcha|perimeterx|datadome/i;

// content.js 采回来的原始证据 → 一句话的挑战标签（没有就是 null）。
// frames 先判：它是结构性证据，比文案可靠，也不会被正文噪声干扰。
// 默认值只挡 undefined，挡不住显式的 null——而 content script 在页面换页途中
// 正好会回 null。所以这里用 Array.isArray 兜，不靠解构默认值。
export function matchChallenge(ev) {
  const frames = Array.isArray(ev?.frames) ? ev.frames : [];
  const overlays = Array.isArray(ev?.overlays) ? ev.overlays : [];
  for (const src of frames) {
    if (typeof src === 'string' && CHALLENGE_FRAME.test(src)) {
      return src.replace(/\?.*/, '').slice(0, 120);
    }
  }
  for (const t of overlays) {
    if (typeof t !== 'string') continue;
    const m = t.match(CHALLENGE_TEXT);
    if (m) return m[0];
  }
  return null;
}

// 种子只放实测撞过的站，不猜。列表会随使用自己长（见 background 的 rememberL2Origin）。
export const L2_ORIGINS_SEED = ['lovart.art', 'lovart.ai'];

export function hostOf(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}

// 子域也算：a.example.com 撞过，b.example.com 大概率是同一套风控。
// 反过来不成立——记住的是 example.com 时，www.example.com 要能命中，
// 所以两个方向都判。
export function hostMatches(host, keys) {
  if (!host) return false;
  return keys.some((k) => host === k || host.endsWith(`.${k}`));
}
