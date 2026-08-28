// 统一呈现层 —— agent 在这个页面上的「身体」，人看的那一侧全在这里
//
// 这个产品最反直觉的一点：agent 干活时**不抢焦点**，全在后台标签页里。
// 好处是不打断用户，代价是他完全看不见发生了什么。隔离逻辑（agentTab:<sid> 槽）
// 早就有了，但它只对 agent 说话，从来没对人说过。这个文件补上人的那一侧，
// 按三个递进层次回答三个问题：
//
//   存在感 —— 它在哪：彩色标签组（background 侧）+ 页内四边描边
//   动作感 —— 它此刻在做什么：呼吸泛光的箭头光标，滑到哪就是在动哪
//   意图感 —— 它在想什么：右下角驾驶舱（正在做 / 准备做 / 时间线 / 需要确认）
//
// 品牌的边界（花叔定的）：头像只出现在**我们自己的标识位**——驾驶舱、ask 浮条、
// 扩展图标、标签组。favicon 是网站的门牌，不动；指针是指针，不拿头像替。
// 标题 emoji 前缀已退役（丑），标签栏的存在感交给彩色标签组；
// 顺手消掉「污染 document.title」的已知副作用（少数站点拿它做分享标题），
// identity.js 里的 stripMarkPrefix 留作过渡清理。
//
// ask（人工介入浮条）也并进来了：页面上只该有一套我们的 UI，两个文件各画
// 各的迟早叠在一起。合并还白捡一个修复——ask 从此也在 context 看门狗的
// 保护之下，扩展重载不再留下一块永远没人回应的浮条。
//
// 三条铁律（背后各有一次真实事故或一类必然事故）：
// 1. 呈现绝不挤进命令的关键路径——所有动画 fire-and-forget，永不被 await。
// 2. 数据不当代码用——agent 声明的意图、act 文案、ask 正文可能源自被注入的
//    页面，一律 textContent，绝不拼 innerHTML。
// 3. 信号诚实——呼吸=正在干活的承诺。会话空闲后光标必须休眠，不能骗人。
//
// 样式全装在 shadow root 里：页面一个 `div { font-size: 0 }` 就能让普通浮层
// 消失，shadow root 是唯一彻底的隔离。

(() => {
  if (window.__hcMark) return;
  window.__hcMark = true;

  // 顶层框架才画。content.js 是 allFrames 注入的，本文件按设计只注顶层，
  // 但防御性地守住：iframe 里也画的话，一个带广告的页面会冒出七八套 UI。
  const TOP = window.top === window;

  // 花叔 Q 版头像（渔夫帽+圆眼镜），64px 圆形裁剪 PNG。内嵌 base64 而不是
  // chrome.runtime.getURL：后者要开 web_accessible_resources，任何网页都能
  // 借它探测扩展存在（指纹）。页面里的呈现一律画到 canvas 上
  // （createImageBitmap(Blob) 是纯内存操作），绝不走 <img src="data:">——
  // 严格 CSP 的站点 img-src 不带 data: 时那条路会静默烂掉。
  const AVATAR_B64 = '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';

  let bitmapP = null;
  function avatarBitmap() {
    if (!bitmapP) {
      const bytes = Uint8Array.from(atob(AVATAR_B64), (ch) => ch.charCodeAt(0));
      bitmapP = createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    }
    return bitmapP;
  }

  // 头像 canvas（2x 抗高分屏）。位图异步到位，到位前是空白圆——几十毫秒的事。
  // 构建失败（极端环境）退化成色点，品牌让位给可用性。
  function avatarCanvas(size, cls) {
    const c = document.createElement('canvas');
    c.width = c.height = size * 2;
    c.style.width = c.style.height = `${size}px`;
    c.className = cls || 'ava';
    avatarBitmap().then((bmp) => {
      c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    }).catch(() => { c.style.background = '#a8a29e'; });
    return c;
  }

  // ---------- 状态 ----------

  let owners = [];      // [{ emoji, color, label, code, sid }]
  let logs = {};        // sid -> [{ t, text }] 新的在前（background 的环形缓冲）
  let intents = {};     // sid -> { text, t }   agent 用 status 声明的「准备做什么」
  let plan = [];        // 正在跑的批处理还剩哪些步（扩展生成的描述，不是 agent 的话）
  let expanded = false; // 驾驶舱展开还是收成胶囊。偏好落在 chrome.storage.local
  let host = null, wrap = null;
  let watchdog = null, flashTimer = null, tickTimer = null;
  const actState = new Map();   // sid -> { text, timer } 「刚刚做了什么」的短暂高亮

  const CSS = `
    :host { all: initial; }
    .wrap { font: 500 12px/1.6 -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif; }

    /* ---- 四边描边：常驻答「有没有主」，亮一下答「它刚动了」 ---- */
    .edge {
      position: fixed; pointer-events: none; z-index: 2147483645;
      opacity: .38; transition: opacity .18s ease, filter .18s ease;
    }
    .edge.t { top: 0; left: 0; right: 0; height: 2px; }
    .edge.b { bottom: 0; left: 0; right: 0; height: 2px; }
    .edge.l { top: 0; bottom: 0; left: 0; width: 2px; }
    .edge.r { top: 0; bottom: 0; right: 0; width: 2px; }
    .lit .edge { opacity: 1; filter: saturate(1.3); }

    /* ---- 虚拟光标：agent 的注意力在页面上的具象 ---- */
    /* 只动 transform/opacity——合成器动画，零重排。它要陪着页面跑几百个动作。 */
    .cursor {
      position: fixed; left: 0; top: 0; z-index: 2147483645;
      pointer-events: none; opacity: 0;
      transition: transform .24s cubic-bezier(.2,.8,.3,1), opacity .4s ease;
      will-change: transform;
    }
    .cursor.on { opacity: 1; }
    .cursor .glow {
      position: absolute; left: -32px; top: -32px; width: 64px; height: 64px;
      border-radius: 50%; background: radial-gradient(circle, var(--c) 0%, transparent 62%);
      opacity: .5; animation: hcBreathe 2.4s ease-in-out infinite;
    }
    @keyframes hcBreathe {
      0%, 100% { transform: scale(1); opacity: .38; }
      50%      { transform: scale(1.35); opacity: .68; }
    }
    /* 箭头就是箭头（花叔定的）：白箭头+会话色描边，品牌感交给色环和泛光 */
    .cursor svg { position: absolute; left: -2px; top: -2px; filter: drop-shadow(0 1px 2px rgba(0,0,0,.35)); }
    /* 休眠：呼吸是「正在干活」的承诺，空闲 30 秒就得收起来，不能骗人 */
    .cursor.doze { opacity: .45; }
    .cursor.doze .glow { animation: none; opacity: .15; transform: scale(.55); }
    .cursor.doze svg { opacity: .6; }
    .cursor .ring {
      position: absolute; left: -18px; top: -18px; width: 36px; height: 36px;
      border: 2.5px solid var(--c); border-radius: 50%;
      animation: hcRing .55s ease-out forwards;
    }
    @keyframes hcRing {
      from { transform: scale(.35); opacity: .95; }
      to   { transform: scale(1.9); opacity: 0; }
    }
    .cursor.typing .glow { animation: hcType .5s ease-in-out infinite; }
    @keyframes hcType {
      0%, 100% { transform: scale(.9); opacity: .5; }
      50%      { transform: scale(1.1); opacity: .8; }
    }
    .cursor.pressed svg { transform: scale(.85); transition: transform .12s; }
    /* bob 动画挂在 svg 上而不是 .cursor 上：.cursor 的 transform 是定位用的
       内联样式，keyframe 一接管它，光标会瞬移回 (0,0) */
    .cursor.bob svg { animation: hcBob .5s ease-in-out; }
    @keyframes hcBob {
      0%, 100% { transform: none; }
      50%      { transform: translateY(26px); }
    }

    /* ---- 驾驶舱：右下角，收起是胶囊、展开是卡片 ---- */
    .dock {
      position: fixed; right: 16px; bottom: 16px; z-index: 2147483646;
      display: flex; flex-direction: column; align-items: flex-end; gap: 8px;
      transition: opacity .25s ease;
    }
    /* 让路：agent 要点的目标落在驾驶舱底下时，它必须瞬间变成「不存在」——
       真实事件(L2)打的是坐标，不让路就是替 agent 点了我们自己的面板 */
    .dock.dodge { pointer-events: none; opacity: .12; }

    .chip {
      display: flex; align-items: center; gap: 6px;
      padding: 5px 11px 5px 9px; border-radius: 999px;
      background: rgba(24,24,27,.85); color: #fff; cursor: pointer;
      -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px);
      font-size: 11px; letter-spacing: .1px; white-space: nowrap;
      max-width: 46vw; overflow: hidden;
      box-shadow: 0 2px 10px rgba(0,0,0,.25);
      opacity: .78; transition: opacity .18s ease, transform .18s ease;
      animation: hcIn .24s cubic-bezier(.2,.8,.3,1);
    }
    .chip:hover { opacity: 1; }
    .chip.act { opacity: 1; transform: scale(1.03); }
    /* 只写 from：终态取元素自己的计算样式——chip 落在 .78、card 落在 1，
       写死 to 值的话总有一个在动画结束的瞬间跳变 */
    @keyframes hcIn { from { opacity: 0; transform: translateY(8px); } }

    .dot { width: 7px; height: 7px; border-radius: 50%; flex: none; }
    /* 胶囊/卡片上的小头像，色环=会话色 */
    .ava { border-radius: 50%; border: 1.5px solid transparent; flex: none; background: #fff; }
    .who { font-weight: 600; }
    .sep { opacity: .4; }
    .what { opacity: .78; font-variant-numeric: tabular-nums; }

    .card {
      width: 300px; max-width: calc(100vw - 40px);
      border-radius: 14px; overflow: hidden;
      background: rgba(24,24,27,.92); color: #f2f2f2;
      -webkit-backdrop-filter: blur(14px); backdrop-filter: blur(14px);
      box-shadow: 0 12px 40px rgba(0,0,0,.3), 0 2px 8px rgba(0,0,0,.15);
      animation: hcIn .22s cubic-bezier(.2,.8,.3,1);
    }
    .card .head {
      display: flex; align-items: center; gap: 7px;
      padding: 10px 12px; border-bottom: 1px solid rgba(255,255,255,.07);
    }
    .card .head .code { opacity: .45; font-size: 11px; font-variant-numeric: tabular-nums; }
    .card .head .fold {
      margin-left: auto; cursor: pointer; opacity: .5; padding: 0 2px;
      background: none; border: none; color: inherit; font: inherit; font-size: 13px; line-height: 1;
    }
    .card .head .fold:hover { opacity: 1; }
    .card .sec { padding: 8px 12px; border-bottom: 1px solid rgba(255,255,255,.05); }
    .card .sec:last-child { border-bottom: none; }
    .card .lab { font-size: 10px; letter-spacing: .8px; opacity: .45; margin-bottom: 3px; }
    /* agent 说的话和扩展观察到的事实分开呈现：前者带引用边，后者平铺。
       这条分界和 ask 的 facts 盒是同一个思路——正文可能被注入，事实是我们自己看到的 */
    .card .intent { border-left: 2px solid var(--c, #888); padding-left: 8px; opacity: .92; }
    .card .intent .ago { opacity: .45; font-size: 10px; margin-left: 6px; }
    .card .now { display: flex; align-items: center; gap: 6px; }
    .card .now .pulse { width: 6px; height: 6px; border-radius: 50%; flex: none; animation: hcPulse 1.6s ease-in-out infinite; }
    @keyframes hcPulse { 0%, 100% { opacity: 1; } 50% { opacity: .3; } }
    .card .plan { opacity: .75; }
    .card .tl { max-height: 132px; overflow-y: auto; display: flex; flex-direction: column; gap: 2px; }
    .card .tl .row { display: flex; gap: 8px; font-size: 11px; opacity: .62; }
    .card .tl .row:first-child { opacity: .95; }
    .card .tl .ago { flex: none; width: 44px; text-align: right; font-variant-numeric: tabular-nums; opacity: .7; }

    /* ---- ask：人工介入。刻意做成浮条不是遮罩——用户正被请求去操作页面，页面必须能点 ---- */
    .ask {
      width: 340px; max-width: calc(100vw - 40px);
      background: #fff; color: #1a1a1a; border-radius: 14px;
      box-shadow: 0 12px 40px rgba(0,0,0,.18), 0 2px 8px rgba(0,0,0,.08);
      border: 1px solid rgba(0,0,0,.08); font-size: 14px;
      overflow: hidden; animation: hcIn .22s cubic-bezier(.2,.8,.3,1);
      pointer-events: auto;
    }
    .ask .head {
      display: flex; align-items: center; gap: 8px;
      padding: 13px 16px; background: linear-gradient(135deg,#fff7ed,#ffedd5);
      border-bottom: 1px solid rgba(0,0,0,.06); font-weight: 600; font-size: 14px;
    }
    .ask .head .dot { width: 8px; height: 8px; background: #f97316; animation: hcPulse 1.6s ease-in-out infinite; }
    .ask .body { padding: 14px 16px 4px; white-space: pre-wrap; word-break: break-word; }
    .ask .note { width: 100%; box-sizing: border-box; margin: 10px 0 2px; padding: 8px 10px;
                 border: 1px solid #e2e2e2; border-radius: 8px; font: inherit; font-size: 13px;
                 resize: vertical; min-height: 34px; }
    .ask .note:focus { outline: 2px solid #fdba74; outline-offset: -1px; border-color: transparent; }
    .ask .foot { display: flex; gap: 8px; padding: 10px 16px 14px; align-items: center; }
    .ask .clock { font-size: 12px; color: #9a9a9a; margin-right: auto; font-variant-numeric: tabular-nums; }
    .ask button { font: inherit; font-size: 13px; border-radius: 8px; padding: 7px 14px;
                  border: 1px solid transparent; cursor: pointer; transition: .15s; }
    .ask .ok { background: #f97316; color: #fff; font-weight: 600; }
    .ask .ok:hover { background: #ea580c; }
    .ask .no { background: #fff; color: #666; border-color: #e2e2e2; }
    .ask .no:hover { background: #f6f6f6; }
    /* 支付确认：同一个浮条换一身红。这类打断一年遇不上几次，
       必须一眼就和「帮我解个验证码」区分开——看错了是要花钱的。 */
    .ask.danger .head { background: linear-gradient(135deg,#fef2f2,#fee2e2); }
    .ask.danger .head .dot { background: #dc2626; }
    .ask.danger .ok { background: #dc2626; }
    .ask.danger .ok:hover { background: #b91c1c; }
    .ask .what { margin-top: 8px; padding: 8px 10px; border-radius: 8px; background: #f8f8f8;
                 font-size: 13px; word-break: break-all; }
    .ask .amount { font-weight: 700; font-size: 16px; color: #dc2626; }
    @media (prefers-color-scheme: dark) {
      .ask { background: #1c1c1e; color: #f2f2f2; border-color: rgba(255,255,255,.1); }
      .ask .head { background: linear-gradient(135deg,#3b2a1a,#2c1f14); border-bottom-color: rgba(255,255,255,.07); }
      .ask .note { background: #2a2a2c; border-color: #3a3a3c; color: #f2f2f2; }
      .ask .no { background: #2a2a2c; color: #ccc; border-color: #3a3a3c; }
      .ask .no:hover { background: #333; }
      .ask.danger .head { background: linear-gradient(135deg,#3f1d1d,#2a1414); }
      .ask .what { background: #2a2a2c; }
      .ask .amount { color: #f87171; }
    }
  `;

  // ---------- host ----------

  function ensureHost() {
    if (host) return;
    // z-index 顶格：ask 并进来之后这个 host 不再是纯装饰层——「需要确认」的
    // 浮条绝不能被页面自己的最高层弹窗盖住（支付确认被遮住=没有确认）。
    // 边框和光标跟着顶格没有代价，它们 pointer-events:none。
    host = document.createElement('div');
    host.style.cssText = 'all:initial;position:fixed;z-index:2147483647';
    const root = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = CSS;
    wrap = document.createElement('div');
    wrap.className = 'wrap';
    // 骨架是静态模板，动态内容全走 textContent（铁律 2）
    wrap.innerHTML = '<div class="edge t"></div><div class="edge b"></div>'
      + '<div class="edge l"></div><div class="edge r"></div>'
      + '<div class="cursor"><div class="glow"></div>'
      + '<svg width="26" height="26" viewBox="0 0 26 26">'
      + '<path d="M4 2 L4 21 L9 16.5 L12.5 24 L16 22.3 L12.5 15 L19 15 Z" fill="#fff" stroke="var(--c)" stroke-width="1.6" stroke-linejoin="round"/>'
      + '</svg></div>'
      // own 装会话胶囊/卡片，ask 直接挂在 dock 下。分开是为了重画会话区时
      // 不动 ask 节点——它有输入框，挪一下用户打了一半的字就丢焦点
      + '<div class="dock"><div class="own"></div></div>';
    root.append(style, wrap);
    document.documentElement.appendChild(host);
    if (stealthed) host.style.visibility = 'hidden';
    watchContext();
  }

  // host 只在「既没有主、也没有挂着的 ask」时才拆——ask 是功能件不是装饰件，
  // 用户把标记开关关掉（收到 clear）时它必须还在。
  function maybeTeardown() {
    if (owners.length || askSettle) return;
    if (host) { host.remove(); host = null; wrap = null; }
    for (const s of actState.values()) clearTimeout(s.timer);
    actState.clear();
    if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
    if (dozeTimer) { clearTimeout(dozeTimer); dozeTimer = null; }
    cursorShown = false;
    if (watchdog) { clearInterval(watchdog); watchdog = null; }
  }

  // 扩展一旦被重载、更新或停用，这个页面里的脚本就永远收不到消息了
  // （chrome.runtime.id 变成 undefined，俗称 context invalidated）。
  // 没有这条自检，标记会永久钉在页面上：background 那边的记账在扩展重载时
  // 一起清空了，再没有任何人知道该来摘它。ask 同理——重载后 background 的
  // 轮询已经死了，浮条留着也永远没人收结果，一并拆掉。
  function watchContext() {
    if (watchdog) return;
    watchdog = setInterval(() => {
      if (chrome.runtime?.id) return;
      owners = [];
      if (askSettle) closeAsk('cancelled', '扩展已重载');
      askSettle = null;
      maybeTeardown();
    }, 5000);
  }

  // ---------- 边框 ----------

  // 一条边的底色。单主用实色；多主用 45° 双色条纹——「这页有两个主」
  // 是最该被一眼看出来的状态，它意味着两个 agent 正在同一个页面上互相踩。
  function edgePaint() {
    if (owners.length === 1) return owners[0].color;
    const stops = [];
    const w = 9;
    owners.forEach((o, i) => stops.push(`${o.color} ${i * w}px ${(i + 1) * w}px`));
    return `repeating-linear-gradient(45deg, ${stops.join(', ')})`;
  }

  // ---------- 驾驶舱 ----------

  const relTime = (t) => {
    const s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 5) return '刚刚';
    if (s < 60) return `${s}秒前`;
    if (s < 3600) return `${Math.floor(s / 60)}分前`;
    return `${Math.floor(s / 3600)}时前`;
  };

  function render() {
    if (!TOP) return;
    if (!owners.length && !askSettle) return maybeTeardown();
    ensureHost();

    const paint = owners.length ? edgePaint() : '';
    wrap.querySelectorAll('.edge').forEach((e) => {
      e.style.background = paint;
      e.style.display = owners.length ? '' : 'none';
    });

    // 会话区每条 set 消息整个重画。频率是「每条命令一次」，量级远够不着
    // 性能问题，换来的是状态永远和消息一致——增量更新才是这类 UI 历史 bug
    // 的高发地。ask 节点不在这个区里，完全不被触碰。
    const own = wrap.querySelector('.own');
    own.textContent = '';
    for (const o of owners) {
      own.appendChild(expanded ? buildCard(o) : buildChip(o));
    }

    // 时间线的相对时间要走字——只在展开时付这个定时器
    if (expanded && owners.length && !tickTimer) tickTimer = setInterval(render, 20000);
    if ((!expanded || !owners.length) && tickTimer) { clearInterval(tickTimer); tickTimer = null; }

    syncCursorIdle();
  }

  function buildChip(o) {
    const chip = document.createElement('div');
    chip.className = 'chip';
    const act = actState.get(o.sid);
    if (act) chip.classList.add('act');
    const av = avatarCanvas(18); av.style.borderColor = o.color;
    const who = document.createElement('span'); who.className = 'who'; who.textContent = o.label;
    const sep = document.createElement('span'); sep.className = 'sep'; sep.textContent = '·';
    const what = document.createElement('span'); what.className = 'what';
    what.textContent = act ? act.text : o.code;
    chip.append(av, who, sep, what);
    chip.addEventListener('click', () => setExpanded(true));
    return chip;
  }

  function buildCard(o) {
    const card = document.createElement('div');
    card.className = 'card';
    card.style.setProperty('--c', o.color);

    const head = document.createElement('div');
    head.className = 'head';
    const av = avatarCanvas(20); av.style.borderColor = o.color;
    const who = document.createElement('span'); who.className = 'who'; who.textContent = o.label;
    const code = document.createElement('span'); code.className = 'code'; code.textContent = o.code;
    const fold = document.createElement('button'); fold.className = 'fold'; fold.textContent = '⌄';
    fold.title = '收起';
    fold.addEventListener('click', () => setExpanded(false));
    head.append(av, who, code, fold);
    card.appendChild(head);

    const sec = (label) => {
      const s = document.createElement('div');
      s.className = 'sec';
      if (label) {
        const l = document.createElement('div'); l.className = 'lab'; l.textContent = label;
        s.appendChild(l);
      }
      card.appendChild(s);
      return s;
    };

    // 准备做：agent 自己声明的计划。它是 agent 写的（可能源自被注入的页面），
    // 所以带引用边、标时间，和下面扩展观察到的事实在视觉上分开。
    const intent = intents[o.sid];
    if (intent?.text) {
      const s = sec('准备做');
      const q = document.createElement('div'); q.className = 'intent';
      q.textContent = intent.text;
      const ago = document.createElement('span'); ago.className = 'ago'; ago.textContent = relTime(intent.t);
      q.appendChild(ago);
      s.appendChild(q);
    }

    // 接下来：批处理里还没跑到的步骤。这是扩展从 act 的 steps 里读到的事实，
    // 不需要 agent 配合就有。
    if (plan.length) {
      const s = sec('接下来');
      const p = document.createElement('div'); p.className = 'plan';
      p.textContent = plan.slice(0, 3).join(' → ') + (plan.length > 3 ? ` →（还有 ${plan.length - 3} 步）` : '');
      s.appendChild(p);
    }

    const act = actState.get(o.sid);
    if (act) {
      const s = sec('正在做');
      const n = document.createElement('div'); n.className = 'now';
      const pulse = document.createElement('span'); pulse.className = 'pulse'; pulse.style.background = o.color;
      const t = document.createElement('span'); t.textContent = act.text;
      n.append(pulse, t);
      s.appendChild(n);
    }

    const rows = logs[o.sid] || [];
    if (rows.length) {
      const s = sec('时间线');
      const tl = document.createElement('div'); tl.className = 'tl';
      for (const r of rows.slice(0, 12)) {
        const row = document.createElement('div'); row.className = 'row';
        const ago = document.createElement('span'); ago.className = 'ago'; ago.textContent = relTime(r.t);
        const txt = document.createElement('span'); txt.textContent = r.text;
        row.append(ago, txt);
        tl.appendChild(row);
      }
      s.appendChild(tl);
    }
    return card;
  }

  function setExpanded(on) {
    expanded = !!on;
    try { chrome.storage.local.set({ dockOpen: expanded }); } catch { /* context 正在失效 */ }
    render();
  }

  // ---------- 虚拟光标 ----------
  //
  // content.js 与本文件同处一个 isolated world，动作坐标在那边解析元素时
  // 就地传过来（window.__hcCursor），零消息往返、零延迟。真实点击(L2)和
  // 合成点击(L1)都先过 locate，所以两条路的光标一致。
  //
  // 顺路兼任「让路」职责：坐标落在驾驶舱底下时把它瞬间变成 pointer-events:none。
  // 这必须在 content.js 做 elementFromPoint 遮挡检测**之前**同步生效——
  // 调用方保证先调本钩子再检测，这里保证 classList 同步改完才返回。

  let cursorShown = false, dozeTimer = null, dodgeTimer = null;
  let curX = 0, curY = 0;

  const dozeSpot = () => ({ x: innerWidth - 30, y: innerHeight - 150 });

  function moveCursor(x, y) {
    const c = wrap.querySelector('.cursor');
    curX = x; curY = y;
    c.style.transform = `translate(${x}px, ${y}px)`;
    return c;
  }

  function syncCursorIdle() {
    if (!wrap) return;
    const c = wrap.querySelector('.cursor');
    c.style.setProperty('--c', owners[0]?.color || '#a855f7');
    if (!owners.length) { c.classList.remove('on'); cursorShown = false; return; }
    // 有主但还没动过手：光标以休眠态停靠在驾驶舱旁——存在感有了，
    // 但不呼吸。呼吸要等第一个动作（铁律 3）。
    if (!cursorShown) {
      const p = dozeSpot();
      c.classList.add('on', 'doze');
      moveCursor(p.x, p.y);
      cursorShown = true;
    }
  }

  function dodgeIfOver(x, y) {
    const dock = wrap.querySelector('.dock');
    const r = dock.getBoundingClientRect();
    if (!r.width || x < r.left - 8 || x > r.right + 8 || y < r.top - 8 || y > r.bottom + 8) return;
    dock.classList.add('dodge');
    clearTimeout(dodgeTimer);
    dodgeTimer = setTimeout(() => wrap && dock.classList.remove('dodge'), 1600);
  }

  window.__hcCursor = (x, y, kind) => {
    if (!TOP || !wrap || !owners.length) return;
    const c = wrap.querySelector('.cursor');
    c.classList.add('on');
    c.classList.remove('doze');

    if (x != null && y != null) {
      dodgeIfOver(x, y);
      moveCursor(x, y);
    }
    if (kind === 'click') {
      // 涟漪等滑行到位再放，否则爆点在起点。时长对齐 transition(240ms)。
      setTimeout(() => {
        if (!wrap) return;
        const ring = document.createElement('span');
        ring.className = 'ring';
        ring.addEventListener('animationend', () => ring.remove());
        c.appendChild(ring);
      }, 240);
    } else if (kind === 'type') {
      c.classList.add('typing');
      setTimeout(() => wrap && c.classList.remove('typing'), 900);
    } else if (kind === 'key') {
      c.classList.add('pressed');
      setTimeout(() => wrap && c.classList.remove('pressed'), 200);
    } else if (kind === 'scroll') {
      c.classList.remove('bob');
      void c.offsetWidth;   // 重启动画
      c.classList.add('bob');
    }

    // 30 秒没有新动作就休眠归位。每个动作重新计时。
    clearTimeout(dozeTimer);
    dozeTimer = setTimeout(() => {
      if (!wrap) return;
      const p = dozeSpot();
      c.classList.add('doze');
      moveCursor(p.x, p.y);
    }, 30000);
  };

  // ---------- ask：人工介入 ----------
  //
  // 从 ask-overlay.js 原样并入，协议不变（show/poll/flash/abort）。
  // 结果靠 background 轮询取，不攥着 sendResponse 等几分钟——页面一旦进
  // back/forward cache 消息通道当场关闭，长回调那版真实撞死过。

  let askEl = null;
  let askSettle = null;   // 当前这一轮的结算标志
  let askOutcome = null;  // 已结算的结果，等 background 来取
  let askTimer = null;

  function closeAsk(result, note) {
    if (askEl) { askEl.remove(); askEl = null; }
    if (askTimer) { clearInterval(askTimer); askTimer = null; }
    askSettle = null;
    askOutcome = { outcome: result, note: note || '' };
    maybeTeardown();
  }

  function showAsk(msg) {
    ensureHost();
    // 上一轮还开着就先结算掉，否则两个浮条叠在一起，旧的永远没人回应
    if (askSettle) closeAsk('cancelled', '被新的请求取代');
    askOutcome = null;
    askSettle = true;

    askEl = document.createElement('div');
    askEl.className = 'ask';
    askEl.innerHTML = `
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
    askEl.querySelector('.head').prepend(avatarCanvas(20));   // 是花叔的分身在请你搭把手
    askEl.querySelector('.t').textContent = msg.title || 'huashu-chrome 需要你搭把手';
    askEl.querySelector('.p').textContent = msg.prompt || '';
    if (msg.danger) askEl.classList.add('danger');
    if (msg.okText) askEl.querySelector('.ok').textContent = msg.okText;
    if (msg.noText) askEl.querySelector('.no').textContent = msg.noText;
    // 「点哪个按钮、在哪个站、多少钱」单独拎出来，不混在正文里。
    // 正文是 agent 写的（可能源自被注入的页面），这几样是扩展自己看到的事实。
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
      askEl.querySelector('.body').appendChild(box);
    }

    let noteEl = null;
    if (msg.wantNote) {
      noteEl = document.createElement('textarea');
      noteEl.className = 'note';
      noteEl.placeholder = '（可选）想对 agent 说的话';
      askEl.querySelector('.body').appendChild(noteEl);
    }

    askEl.querySelector('.ok').addEventListener('click', () => closeAsk('continued', noteEl?.value));
    askEl.querySelector('.no').addEventListener('click', () => closeAsk('cancelled', noteEl?.value));

    // 挂在 own 之外：会话区重画时不触碰 ask（输入框的焦点经不起挪动）
    wrap.querySelector('.dock').appendChild(askEl);

    // 倒计时。不显示的话用户不知道自己还有多久，而超时后 agent 那边已经走了，
    // 他还在慢慢操作——两边对不上。
    const deadline = Date.now() + (msg.timeout || 300000);
    const clock = askEl.querySelector('.clock');
    askTimer = setInterval(() => {
      const left = Math.max(0, Math.round((deadline - Date.now()) / 1000));
      clock.textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
      if (left <= 0) closeAsk('timed_out', noteEl?.value);
    }, 500);
  }

  // 高亮：把用户的视线直接送到该操作的地方，省掉「在哪儿？」这一步。
  // 描边画在覆盖层上而不是改元素自己的 style——后者会污染页面，
  // 而且遇到 overflow:hidden 的容器会被裁掉。
  function flashTargets(els) {
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

  // ---------- 幕帘 ----------
  //
  // 光标、边框、驾驶舱、ask 全会被 agent 自己的 screenshot 拍进去——它会看到
  // 一个页面上并不存在的发光箭头，把它当页面元素去理解甚至去点。所以 background
  // 在截图前拉幕帘、拍完放下。样式改动在 sendMessage 的应答路径里同步生效，
  // ack 返回时 visibility 已应用；两条截图路径都是 ack 之后才合成新帧。

  let stealthed = false;
  function setStealth(on) {
    stealthed = !!on;
    if (host) host.style.visibility = stealthed ? 'hidden' : '';
  }

  // ---------- 消息 ----------

  // agent 刚刚做了什么。驾驶舱打出动作名（记完在下一次 render 里出现），
  // 5 秒后自动淡出回短码。
  function recordAct(sid, text) {
    const prev = actState.get(sid);
    if (prev) clearTimeout(prev.timer);
    actState.set(sid, {
      text: String(text).slice(0, 40),
      timer: setTimeout(() => { actState.delete(sid); if (owners.length) render(); }, 5000),
    });
  }

  // 边框亮一下——常驻的淡边框回答「有没有主」，这一下回答「它此刻在动」。
  // 两个问题都要有答案，否则用户看着一个静止的页面无从判断。
  function flashEdges() {
    if (!wrap) return;
    wrap.classList.add('lit');
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => wrap?.classList.remove('lit'), 420);
  }

  chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
    if (msg && msg.__hcMark !== undefined) {
      // 非顶层框架照样要应答 ping，否则 background 会以为脚本没注入，
      // 于是每条命令都重注一次
      if (msg.__hcMark === 'ping') { sendResponse({ pong: true, top: TOP }); return true; }
      if (msg.__hcMark === 'set') {
        logs = msg.logs || {};
        intents = msg.intents || {};
        plan = Array.isArray(msg.plan) ? msg.plan : [];
        owners = Array.isArray(msg.owners) ? msg.owners.filter((o) => o && o.sid) : [];
        // 先记动作再画：act 的高亮状态要出现在这一次渲染里，分开就是两次渲染
        if (msg.act && msg.sid) recordAct(msg.sid, msg.act);
        if (TOP) { render(); if (msg.act) flashEdges(); }
        sendResponse({ ok: true });
        return true;
      }
      // clear 走完整 render 而不是直接 teardown：ask 还挂着时 host 必须留下，
      // 但边框/胶囊/标题这些「存在感」要立刻消失——直接拆会因 ask 在场而早退，
      // 留一屏已经没主的标记
      if (msg.__hcMark === 'clear') { owners = []; plan = []; render(); sendResponse({ ok: true }); return true; }
      if (msg.__hcMark === 'stealth') { setStealth(msg.on); sendResponse({ ok: true }); return true; }
      return;
    }
    if (msg && msg.__hcAsk !== undefined) {
      // show 立即返回，不攥着 sendResponse 等人——见 closeAsk 上面那段
      if (msg.__hcAsk === 'show') { showAsk(msg); sendResponse({ shown: true }); return true; }
      if (msg.__hcAsk === 'poll') { sendResponse(askOutcome || { pending: true }); return true; }
      if (msg.__hcAsk === 'flash') {
        const els = (msg.selectors || []).map((s) => {
          try { return document.querySelector(s); } catch { return null; }
        }).filter(Boolean);
        if (els[0]) els[0].scrollIntoView({ block: 'center', behavior: 'smooth' });
        flashTargets(els);
        sendResponse({ matched: els.length });
        return true;
      }
      if (msg.__hcAsk === 'abort') { closeAsk('cancelled', '被 agent 取消'); sendResponse({ ok: true }); return true; }
    }
  });

  // 展开/收起偏好跨页面记住。读取是异步的：先按收起画，偏好到了再重画一次，
  // 这个闪动只在「上一次是展开着的」且首条消息先到时可见，几乎察觉不到。
  try {
    chrome.storage.local.get('dockOpen').then((v) => {
      if (v?.dockOpen && !expanded) { expanded = true; if (owners.length) render(); }
    }).catch(() => {});
  } catch { /* context 正在失效 */ }
})();
