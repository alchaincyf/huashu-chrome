// 人工介入的浮条 —— agent 干不了的那一步，交还给用户
//
// 验证码、扫码登录、短信 OTP、支付确认：这些不是「做得还不够好」，
// 是设计上就该由人来。没有这条路，任务链会在最关键的地方断掉，
// 而 agent 只能反复重试到超时。
//
// 形态上刻意做成右下角的浮条而不是覆盖式遮罩：
// 用户正被请求去解验证码，页面必须能点。BrowserSkill 用的是遮罩，
// 它仓库里已经有 issue 抱怨那个东西挡住内容。
//
// 样式全部装在 shadow root 里。这类浮层被站点 CSS 击穿是最常见的故障
// （页面一个 `div { font-size: 0 }` 就能让整个面板消失），shadow root
// 是唯一彻底的隔离。

(() => {
  if (window.__hcAsk) return;
  window.__hcAsk = true;

  let host = null;
  let settle = null;   // 当前这一轮的结算函数
  let outcome = null;  // 已结算的结果，等 background 来取

  const CSS = `
    :host { all: initial; }
    .panel {
      position: fixed; right: 20px; bottom: 20px; width: 340px; max-width: calc(100vw - 40px);
      background: #fff; color: #1a1a1a; border-radius: 14px;
      box-shadow: 0 12px 40px rgba(0,0,0,.18), 0 2px 8px rgba(0,0,0,.08);
      border: 1px solid rgba(0,0,0,.08);
      font: 14px/1.6 -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif;
      z-index: 2147483647; overflow: hidden;
      animation: hcIn .22s cubic-bezier(.2,.8,.3,1);
    }
    @keyframes hcIn { from { opacity: 0; transform: translateY(12px) } to { opacity: 1; transform: none } }
    .head {
      display: flex; align-items: center; gap: 8px;
      padding: 13px 16px; background: linear-gradient(135deg,#fff7ed,#ffedd5);
      border-bottom: 1px solid rgba(0,0,0,.06); font-weight: 600; font-size: 14px;
    }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: #f97316; flex: none;
           animation: hcPulse 1.6s ease-in-out infinite; }
    @keyframes hcPulse { 0%,100% { opacity: 1 } 50% { opacity: .35 } }
    .body { padding: 14px 16px 4px; white-space: pre-wrap; word-break: break-word; }
    .note { width: 100%; box-sizing: border-box; margin: 10px 0 2px; padding: 8px 10px;
            border: 1px solid #e2e2e2; border-radius: 8px; font: inherit; font-size: 13px;
            resize: vertical; min-height: 34px; }
    .note:focus { outline: 2px solid #fdba74; outline-offset: -1px; border-color: transparent; }
    .foot { display: flex; gap: 8px; padding: 10px 16px 14px; align-items: center; }
    .clock { font-size: 12px; color: #9a9a9a; margin-right: auto; font-variant-numeric: tabular-nums; }
    button { font: inherit; font-size: 13px; border-radius: 8px; padding: 7px 14px;
             border: 1px solid transparent; cursor: pointer; transition: .15s; }
    .ok { background: #f97316; color: #fff; font-weight: 600; }
    .ok:hover { background: #ea580c; }
    .no { background: #fff; color: #666; border-color: #e2e2e2; }
    .no:hover { background: #f6f6f6; }
    /* 支付确认：同一个浮条换一身红。这类打断一年也遇不上几次，
       它必须一眼就和「帮我解个验证码」区分开——看错了是要花钱的。 */
    .panel.danger .head { background: linear-gradient(135deg,#fef2f2,#fee2e2); }
    .panel.danger .dot { background: #dc2626; }
    .panel.danger .ok { background: #dc2626; }
    .panel.danger .ok:hover { background: #b91c1c; }
    .what { margin-top: 8px; padding: 8px 10px; border-radius: 8px; background: #f8f8f8;
            font-size: 13px; word-break: break-all; }
    .amount { font-weight: 700; font-size: 16px; color: #dc2626; }
    @media (prefers-color-scheme: dark) {
      .panel { background: #1c1c1e; color: #f2f2f2; border-color: rgba(255,255,255,.1); }
      .head { background: linear-gradient(135deg,#3b2a1a,#2c1f14); border-bottom-color: rgba(255,255,255,.07); }
      .note { background: #2a2a2c; border-color: #3a3a3c; color: #f2f2f2; }
      .no { background: #2a2a2c; color: #ccc; border-color: #3a3a3c; }
      .no:hover { background: #333; }
      .panel.danger .head { background: linear-gradient(135deg,#3f1d1d,#2a1414); }
      .what { background: #2a2a2c; }
      .amount { color: #f87171; }
    }
  `;

  function close(result, note) {
    if (host) { host.remove(); host = null; }
    settle = null;
    // 结果先落在这里，等 background 轮询来取。
    //
    // 上一版是把 sendResponse 攥在手里等用户操作，一等就是几分钟——
    // 而页面一旦被放进 back/forward cache，消息通道当场关闭，报
    // 「The page keeping the extension port is moved into back/forward cache」，
    // 整个 ask 直接失败。真实撞到过。
    // 现在每条消息都是短的：show 立刻回，结果靠轮询取，bfcache 不再有影响。
    outcome = { outcome: result, note: note || '' };
  }

  function show(msg) {
    // 上一轮还开着就先结算掉，否则两个面板叠在一起，而且旧的那个永远没人回应
    if (settle) close('cancelled', '被新的请求取代');
    outcome = null;
    settle = true;

    host = document.createElement('div');
    host.style.cssText = 'all:initial;position:fixed;z-index:2147483647';
    const root = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = CSS;

    const panel = document.createElement('div');
    panel.className = 'panel';
    panel.innerHTML = `
      <div class="head"><span class="dot"></span><span class="t"></span></div>
      <div class="body"><span class="p"></span></div>
      <div class="foot">
        <span class="clock"></span>
        <button class="no">取消</button>
        <button class="ok">我完成了</button>
      </div>`;
    // 文案一律走 textContent，绝不拼进 innerHTML——prompt 是从 agent 那边传过来的，
    // 而 agent 的内容可能源自页面（也就是可能被注入）。这里是最后一道
    // 「数据不当代码用」的边界。
    panel.querySelector('.t').textContent = msg.title || 'huashu-chrome 需要你搭把手';
    panel.querySelector('.p').textContent = msg.prompt || '';
    if (msg.danger) panel.classList.add('danger');
    if (msg.okText) panel.querySelector('.ok').textContent = msg.okText;
    if (msg.noText) panel.querySelector('.no').textContent = msg.noText;
    // 「点哪个按钮、在哪个站、多少钱」三样单独拎出来，不混在正文里。
    // 正文是 agent 写的（可能源自被注入的页面），这三样是扩展自己看到的事实。
    if (msg.facts) {
      const box = document.createElement('div');
      box.className = 'what';
      for (const [k, v] of msg.facts) {
        if (!v) continue;
        const line = document.createElement('div');
        const key = document.createElement('span');
        key.textContent = `${k}：`;
        const val = document.createElement('span');
        val.textContent = v;
        if (k === '金额') val.className = 'amount';
        line.append(key, val);
        box.appendChild(line);
      }
      panel.querySelector('.body').appendChild(box);
    }

    let noteEl = null;
    if (msg.wantNote) {
      noteEl = document.createElement('textarea');
      noteEl.className = 'note';
      noteEl.placeholder = '（可选）想对 agent 说的话';
      panel.querySelector('.body').appendChild(noteEl);
    }

    panel.querySelector('.ok').onclick = () => close('continued', noteEl?.value);
    panel.querySelector('.no').onclick = () => close('cancelled', noteEl?.value);

    root.append(style, panel);
    document.documentElement.appendChild(host);

    // 倒计时。不显示的话用户不知道自己还有多久，而超时后 agent 那边已经走了，
    // 他还在慢慢操作——两边对不上。
    const deadline = Date.now() + (msg.timeout || 300000);
    const clock = panel.querySelector('.clock');
    const tick = setInterval(() => {
      const left = Math.max(0, Math.round((deadline - Date.now()) / 1000));
      clock.textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
      if (left <= 0) { clearInterval(tick); close('timed_out', noteEl?.value); }
      if (!settle) clearInterval(tick);
    }, 500);
  }

  // 高亮：把用户的视线直接送到该操作的地方，省掉「在哪儿？」这一步。
  // 描边画在一个覆盖层上而不是改元素自己的 style——后者会污染页面，
  // 而且遇到 overflow:hidden 的容器会被裁掉。
  function flash(els) {
    for (const el of els) {
      const r = el.getBoundingClientRect();
      if (!r.width && !r.height) continue;
      const ring = document.createElement('div');
      ring.style.cssText = `position:fixed;left:${r.left - 4}px;top:${r.top - 4}px;`
        + `width:${r.width + 8}px;height:${r.height + 8}px;border:2px solid #f97316;`
        + `border-radius:8px;pointer-events:none;z-index:2147483646;`
        + `box-shadow:0 0 0 9999px rgba(0,0,0,.04);transition:opacity .3s`;
      document.documentElement.appendChild(ring);
      let n = 0;
      const blink = setInterval(() => {
        ring.style.opacity = (++n % 2) ? '0.25' : '1';
        if (n > 7) { clearInterval(blink); ring.remove(); }
      }, 300);
    }
  }

  chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
    if (!msg || msg.__hcAsk === undefined) return;
    // show 立即返回，不攥着 sendResponse 等人——见 close() 上面那段
    if (msg.__hcAsk === 'show') { show(msg); sendResponse({ shown: true }); return true; }
    if (msg.__hcAsk === 'poll') { sendResponse(outcome || { pending: true }); return true; }
    if (msg.__hcAsk === 'flash') {
      const els = (msg.selectors || []).map((s) => {
        try { return document.querySelector(s); } catch { return null; }
      }).filter(Boolean);
      if (els[0]) els[0].scrollIntoView({ block: 'center', behavior: 'smooth' });
      flash(els);
      sendResponse({ matched: els.length });
      return true;
    }
    if (msg.__hcAsk === 'abort') { close('cancelled', '被 agent 取消'); sendResponse({ ok: true }); return true; }
  });
})();
