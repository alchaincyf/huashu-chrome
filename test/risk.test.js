// 风控挑战判定 —— 不需要浏览器，进 `npm test`
//
// 这套测试的由来是 2026-08-28 的一轮真实实测：在 lovart.art 上连发两条消息，
// 两条都弹了「浏览器验证」，每条都要用户手动点一次，一轮实测被切得稀碎。
//
// 根因不在点击代码，在分层策略：L1 的事件 isTrusted 永远是 false，
// 而 L1 在这类站上**恰恰是"生效"的**——消息发出去了、DOM 也变了——
// 所以「零证据 → 升级 L2」那条路永远不触发，我们一路用不可信事件撞风控。
//
// 修法是把「弹了验证」本身当信号记住 origin。这条链路上最容易静默坏掉的是
// 判定本身：漏判就退回老样子（还是撞验证码），误判就让普通站点白挂黄条。
// 两头都得钉住。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchChallenge, hostOf, hostMatches, L2_ORIGINS_SEED } from '../extension/risk.js';

test('lovart 那个弹窗被认出来 —— 就是撞出这套机制的原文', () => {
  const ev = {
    frames: [],
    overlays: ['浏览器验证 请完成验证以继续 开始验证 在继续之前，我们需要检查您的连接安全性 继续'],
  };
  assert.equal(matchChallenge(ev), '浏览器验证');
});

test('Cloudflare / hCaptcha / reCAPTCHA 靠 iframe src 认出来，不必读里面', () => {
  for (const src of [
    'https://challenges.cloudflare.com/turnstile/v0/api.js?x=1',
    'https://newassets.hcaptcha.com/captcha/v1/x/static/hcaptcha.html',
    'https://www.google.com/recaptcha/api2/anchor?ar=1',
    'https://gcaptcha4.geetest.com/load?captcha_id=abc',
  ]) {
    assert.ok(matchChallenge({ frames: [src], overlays: [] }), `没认出 ${src}`);
  }
});

test('iframe 判定去掉 query —— 里面常带一次性 token，不该进日志也不该进记忆', () => {
  const got = matchChallenge({
    frames: ['https://challenges.cloudflare.com/turnstile/v0/api.js?token=SECRET123&s=abc'],
    overlays: [],
  });
  assert.doesNotMatch(got, /SECRET123/);
  assert.equal(got, 'https://challenges.cloudflare.com/turnstile/v0/api.js');
});

test('英文站的常见挑战文案', () => {
  for (const t of [
    'Verify you are human',
    'Checking your browser before accessing',
    "I'm not a robot",
    'Just a moment...',
    'Press and hold to confirm',
  ]) {
    assert.ok(matchChallenge({ frames: [], overlays: [t] }), `没认出 ${t}`);
  }
});

// 误判这一头比漏判更贵：判错一次，这个站点就被永久记进 L2 名单，
// 之后每次操作都常驻黄条，而用户根本不知道为什么。
test('正文里出现「验证」不算挑战 —— 顶层浮层才采，且要成句命中', () => {
  assert.equal(matchChallenge({ frames: [], overlays: ['实名认证入口'] }), null);
  assert.equal(matchChallenge({ frames: [], overlays: ['验证码已发送到您的手机'] }), null);
  assert.equal(matchChallenge({ frames: [], overlays: ['两步验证已开启'] }), null);
});

test('普通 iframe 不算 —— 广告、视频、地图天天有', () => {
  assert.equal(matchChallenge({
    frames: [
      'https://www.youtube.com/embed/abc',
      'https://td.doubleclick.net/x',
      'https://player.bilibili.com/player.html?aid=1',
    ],
    overlays: ['分享到微信'],
  }), null);
});

test('空证据 / 缺字段 / undefined 都不炸', () => {
  assert.equal(matchChallenge(), null);
  assert.equal(matchChallenge({}), null);
  assert.equal(matchChallenge({ frames: null, overlays: null }), null);
  assert.equal(matchChallenge({ frames: [undefined, 3], overlays: [null, {}] }), null);
});

test('frames 优先于 overlays —— 结构性证据比文案可靠', () => {
  const got = matchChallenge({
    frames: ['https://challenges.cloudflare.com/turnstile/v0/api.js'],
    overlays: ['人机验证'],
  });
  assert.match(got, /cloudflare/);
});

test('hostOf 只取主机名，垃圾输入回空串不抛', () => {
  assert.equal(hostOf('https://www.lovart.art/canvas?projectId=1'), 'www.lovart.art');
  assert.equal(hostOf('not a url'), '');
  assert.equal(hostOf(''), '');
  assert.equal(hostOf(undefined), '');
});

test('子域命中：记住 example.com，www 和 a.b 都算同一套风控', () => {
  assert.ok(hostMatches('www.lovart.art', ['lovart.art']));
  assert.ok(hostMatches('lovart.art', ['lovart.art']));
  assert.ok(hostMatches('a.b.lovart.art', ['lovart.art']));
});

test('子域命中不许放宽成后缀匹配 —— evil-lovart.art 不是 lovart.art', () => {
  assert.equal(hostMatches('evil-lovart.art', ['lovart.art']), false);
  assert.equal(hostMatches('notlovart.art', ['lovart.art']), false);
  assert.equal(hostMatches('', ['lovart.art']), false);
});

test('种子表里的站点确实会命中 —— 装上就生效，不必等它自己学一遍', () => {
  assert.ok(hostMatches('www.lovart.art', L2_ORIGINS_SEED));
  assert.ok(hostMatches('www.lovart.ai', L2_ORIGINS_SEED));
  assert.equal(hostMatches('www.google.com', L2_ORIGINS_SEED), false);
});
