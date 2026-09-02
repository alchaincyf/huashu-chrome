// Content script —— 项目里最要紧的一块：把一个页面变成 LLM 读得懂又便宜的表示。
//
// 核心是 ref 机制：快照给每个可交互元素编号 e1/e2/…，agent 拿 ref 回来点。
// 不用坐标（会漂），不用 CSS selector（会因改版全崩），不用整棵 DOM（token 爆炸）。
// 一页通常 1–2k token。
//
// 快照失效的判定宁严勿松：宁可让 agent 多调一次 snapshot，也不能让它点错东西——
// 点错的代价在真实登录态下可能是一笔真订单。

(() => {
  if (window.__huashuChrome) return;
  window.__huashuChrome = true;

  let refMap = new Map();
  let snapshotSeq = 0;
  let snapshotId = null;
  // locate 刚定位到的那个元素。effect 拿它比对状态，不重新查找——
  // 重新查找要跑一次全页面收集，而 effect 每 100ms 就被调一次。
  let lastTarget = null;

  const INTERACTIVE_TAGS = new Set(['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'SUMMARY']);
  const INTERACTIVE_ROLES = new Set(['button', 'link', 'checkbox', 'radio', 'tab', 'menuitem', 'menuitemcheckbox', 'combobox', 'textbox', 'switch', 'option', 'searchbox']);

  // ---------- 可见性 ----------

  // getComputedStyle 是这里最贵的一次调用，可见性和可交互性共用它，别调两遍
  // anywhere：不管离视口多远。快照只收视口上下几屏内的元素（长列表页全收会撑爆），
  // 但「页面上有没有这段文字」这种问题不该被视口限制——那正是 agent 写 eval 的场景。
  function isVisible(el, s = getComputedStyle(el), anywhere = false) {
    if (!el.isConnected) return false;
    if (s.visibility === 'hidden' || s.display === 'none' || Number(s.opacity) < 0.02) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    // 视口外但能滚动到的，算可见——列表页大量元素在下面
    if (!anywhere && offWindow(r)) return false;
    return true;
  }
  const offWindow = (r) => r.bottom < -window.innerHeight * 2 || r.top > window.innerHeight * 3;

  // disabled 的元素**照收**，在 state 里标 disabled。以前这里直接 return false，
  // 于是「没有提交按钮」和「提交按钮被禁用」在快照里长得一模一样——而后者
  // 是表单校验没过的最常见信号，agent 看不见它就只能写 eval 去摸。
  // 点它会在 resolve 里被 NOT_INTERACTABLE 拦下，那句话比「找不到」有信息量。
  function isInteractive(el, s) {
    if (INTERACTIVE_TAGS.has(el.tagName)) {
      if (el.tagName === 'INPUT' && el.type === 'hidden') return false;
      if (el.tagName === 'A' && !el.getAttribute('href')) return false;
      return true;
    }
    const role = el.getAttribute('role');
    if (role && INTERACTIVE_ROLES.has(role)) return true;
    if (el.isContentEditable) return true;
    if (el.hasAttribute('onclick')) return true;
    const ti = el.getAttribute('tabindex');
    if (ti !== null && Number(ti) >= 0) return true;
    // div 按钮：现代前端最常见的写法，无语义标签、事件用 addEventListener 绑，
    // 上面那些判据一个都抓不到。唯一稳定的破绽是 cursor:pointer。
    // 小红书发布页第一次快照只抓到 2 个元素，就是漏在这里。
    if (s.cursor === 'pointer' && (el.innerText || '').trim()) return true;
    return false;
  }

  // ---------- 可访问名 ----------

  function accessibleName(el) {
    const byId = (ids) => (ids || '').split(/\s+/).map((i) => document.getElementById(i)?.innerText || '').join(' ').trim();
    const cands = [
      el.getAttribute('aria-label'),
      byId(el.getAttribute('aria-labelledby')),
      el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.innerText : '',
      el.closest('label')?.innerText,
      el.getAttribute('placeholder'),
      // contenteditable 没有原生 placeholder，各家都自己造一个属性配 ::before 显示。
      // 不查这几个，富文本编辑器在快照里就是一排没名字的 textbox，agent 分不清谁是标题。
      el.getAttribute('data-placeholder'),
      el.getAttribute('aria-placeholder'),
      el.dataset?.placeholder,
      el.getAttribute('title'),
      el.getAttribute('alt'),
      el.querySelector('img[alt]')?.getAttribute('alt'),
      // 图标按钮的名字常常只写在 <svg><title> 里
      el.querySelector('svg > title')?.textContent,
      el.tagName === 'INPUT' && ['submit', 'button', 'reset'].includes(el.type) ? el.value : '',
      // <select> 的 innerText 是它全部选项拼起来的一长串（"请选择 昆明 深圳"），
      // 当名字用只会把一行快照撑爆，而且看着像个多选控件。选项本来就在 state 里列了。
      el.tagName === 'SELECT' ? '' : el.innerText,
      // react-select 把占位符放在一个单独的 div 里，用 aria-describedby 指过去。
      // 不查这个，页面上所有 react-select 在快照里都是没名字的 combobox——
      // 而这个组件在现代表单里几乎无处不在，agent 分不出哪个是「省份」哪个是「城市」。
      byId(el.getAttribute('aria-describedby')),
      el.getAttribute('name'),
    ];
    for (const c of cands) {
      const t = (c || '').replace(/\s+/g, ' ').trim();
      if (t) return t.length > 60 ? t.slice(0, 60) + '…' : t;
    }
    return nearbyLabel(el);
  }

  // 最后的兜底：标签就在同一行里，但没有 for 关联。
  //
  // 这是真实表单里最常见的一种写法——设计稿上「生日」和输入框是同一行，
  // 前端就把 <label> 和 <input> 并排放进一个 .form-group，谁也没写 for。
  // 无障碍层面这是个缺陷，但它到处都是，而代价是快照里出现一排 textbox ""，
  // agent 只能靠顺序猜哪个是哪个——猜错了还看不见任何反馈。
  //
  // 只在前面所有正规途径都失败时才走这里，所以贵一点无所谓。
  const LABEL_SEL = 'label, legend, .form-label, [class*="label" i], [id$="-label"]';

  function nearbyLabel(el) {
    // 只给表单控件兜底。链接和按钮的名字本该来自它自己的文字，没有就是装饰性的；
    // 给它们从旁边捡一个标签只会造出「link "Name"」这种误导 agent 的假信息。
    const isControl = /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName)
      || el.isContentEditable
      || ['combobox', 'textbox', 'searchbox', 'checkbox', 'radio', 'switch'].includes(el.getAttribute('role'));
    if (!isControl) return '';

    let node = el.parentElement;
    // react-select 一类的组件会把真正的 input 埋在六七层 div 底下，
    // 层数给少了，页面上所有这类下拉都是没名字的
    for (let up = 0; node && up < 7; up++, node = node.parentElement) {
      if (node.tagName === 'FORM' || node.tagName === 'BODY') break;
      for (const cand of node.querySelectorAll(LABEL_SEL)) {
        if (cand.contains(el)) continue;                       // 包着自己的容器不算
        if (cand.htmlFor && cand.htmlFor !== el.id) continue;   // 明确指向别人的标签，不是我的
        const t = (cand.innerText || '').replace(/\s+/g, ' ').trim();
        if (t && t.length <= 40) return t;
      }
    }
    return '';
  }

  function roleOf(el) {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    switch (el.tagName) {
      case 'A': return 'link';
      case 'BUTTON': case 'SUMMARY': return 'button';
      case 'SELECT': return 'combobox';
      case 'TEXTAREA': return 'textbox';
      case 'INPUT': {
        const t = (el.type || 'text').toLowerCase();
        if (t === 'checkbox') return 'checkbox';
        if (t === 'radio') return 'radio';
        if (['submit', 'button', 'reset', 'image'].includes(t)) return 'button';
        if (t === 'search') return 'searchbox';
        // 文件框标成 textbox 是个静默陷阱：agent 看见 textbox 就会去 type，
        // 而往 file input 写字符串什么都不会发生（浏览器不允许），它还以为填上了。
        // 单列一个角色，工具描述里指向 upload。
        if (t === 'file') return 'file';
        return 'textbox';
      }
      default: return el.isContentEditable ? 'textbox' : 'button';
    }
  }

  // 靠 class 表达的状态：PrimeNG 的 ui-state-active、Element 的 is-checked、
  // 自家写的 .selected / .on。没有 role 也没有 aria-*，class 是它唯一的自述。
  // 只认「状态词在末尾」的 token（is-checked、tab-active、toggle-on），
  // 别把 button、onboarding 这类词里的 on 当成状态。
  const STATE_CLASS = /(?:^|[-_])(checked|selected|active|open|current|pressed|on|off|expanded|collapsed)$/i;
  function stateClass(el) {
    const cls = String(el.className?.baseVal ?? el.className ?? '');
    for (const t of cls.split(/\s+/)) if (t && STATE_CLASS.test(t)) return t;
    return '';
  }

  // 无名元素的可辨识标识：图标按钮、自定义开关、卡片上的「×」都没有可访问名，
  // 以前直接从快照里消失，agent 只能写 querySelector 去摸。给它一个
  // id / data-testid / 首个 class，至少能被 selector 指到。
  function idHint(el) {
    const id = el.id || '';
    if (id && id.length <= 40 && !/^[a-z0-9_-]{24,}$/i.test(id)) return `#${id}`;
    const tid = el.getAttribute('data-testid') || el.getAttribute('data-test') || el.getAttribute('data-qa');
    if (tid) return `[data-testid="${tid.slice(0, 40)}"]`;
    const cls = String(el.className?.baseVal ?? el.className ?? '').trim().split(/\s+/)[0] || '';
    if (cls && cls.length <= 40) return `.${cls}`;
    return '';
  }

  const isDisabled = (el) => !!(el.disabled || el.matches?.(':disabled') || el.getAttribute('aria-disabled') === 'true');

  // 状态后缀：让 agent 一眼看出「填没填」「勾没勾」「选中的是哪个」，省掉一轮试探
  function stateOf(el, role) {
    const bits = [];
    if (['checkbox', 'radio', 'switch', 'menuitemcheckbox', 'menuitemradio'].includes(role)) {
      const checked = el.checked ?? el.getAttribute('aria-checked') === 'true';
      bits.push(checked ? 'checked' : 'unchecked');
    }
    if (role === 'file') {
      const f = el.files?.[0];
      bits.push(f ? `已选 ${f.name}` : 'empty');
      if (el.accept) bits.push(`accept: ${el.accept}`);
      bits.push('用 upload 工具，不能 type');
    }
    if (role === 'textbox' || role === 'searchbox') {
      const v = (el.value ?? el.innerText ?? '').trim();
      // 输入类型决定该填什么格式。date 要 YYYY-MM-DD、number 不收字母、
      // password 填了也不回显——不报出来，agent 只能靠字段名猜，猜错了看不见反馈。
      const t = el.tagName === 'INPUT' ? (el.type || 'text').toLowerCase() : '';
      if (t && t !== 'text') bits.push(`type: ${t}`);
      if (el.required || el.getAttribute('aria-required') === 'true') bits.push('required');
      // 密码框只报位数。协议文档一直写着「type: password 的输入框不回显值」，
      // 但代码里回显了——快照是 agent 每一步都会读的东西，泄露面比效果证据还大。
      // 位数仍然有用：agent 能据此判断「填进去了没有」。
      if (!v) bits.push('empty');
      else if (isSecretField(el)) bits.push(`value: <${v.length} 位>`);
      else {
        // 富文本编辑器里「现在写了什么」得看得全一点：40 字看不出一段正文填没填对
        const cap = el.isContentEditable ? 200 : 40;
        bits.push(`value: "${v.length > cap ? v.slice(0, cap) + '…' : v}"`);
      }
    }
    if (role === 'combobox' && el.tagName === 'SELECT') {
      bits.push(`selected: "${el.options[el.selectedIndex]?.text || ''}"`);
      const opts = [...el.options].slice(0, 8).map((o) => o.text).join(' | ');
      if (opts) bits.push(`options: ${opts}${el.options.length > 8 ? ' …' : ''}`);
    }
    if (el.getAttribute('aria-expanded')) bits.push(`expanded: ${el.getAttribute('aria-expanded')}`);
    // tab 哪个是当前、option 哪个已选、toggle 按没按。以前只报 expanded，
    // 「现在选中的是哪个」这个问题 agent 只能写 eval 去问。
    for (const a of ['aria-selected', 'aria-pressed', 'aria-current']) {
      const v = el.getAttribute(a);
      if (v && v !== 'false') bits.push(`${a.slice(5)}${v === 'true' ? '' : ': ' + v}`);
    }
    const sc = stateClass(el);
    if (sc) bits.push(`class: ${sc}`);
    if (isDisabled(el)) bits.push('disabled');
    return bits.length ? ` (${bits.join(', ')})` : '';
  }

  // ---------- 快照 ----------

  // 候选收集从 buildSnapshot 里抽出来，因为 find（语义定位）要用同一套判据。
  // 两边如果各写一份，「快照里看得到、find 却找不到」这类问题会层出不穷，
  // 而且极难排查——agent 明明照着快照写的名字。
  function collectCandidates() {
    // 一阶段：收候选。同时遍历 open shadow root —— 现在大量站点把控件塞在里面
    const cands = [];
    // 视口窗口之外还有多少可交互元素。以前一个字不提，agent 看着一份「完整」的
    // 快照找不到底部的提交按钮，只能再拍一次或写 eval 去摸。
    let off = 0;
    const walk = (root) => {
      for (const el of root.querySelectorAll('*')) {
        if (el.shadowRoot) walk(el.shadowRoot);
        const s = getComputedStyle(el);
        if (!isInteractive(el, s)) continue;
        if (!isVisible(el, s)) {
          if (isVisible(el, s, true)) off += 1;
          continue;
        }
        const semantic = INTERACTIVE_TAGS.has(el.tagName)
          || INTERACTIVE_ROLES.has(el.getAttribute('role'))
          || el.isContentEditable;
        cands.push({
          el,
          semantic,
          // 「弱候选」：只靠 cursor:pointer 进来的，没有任何自己的交互证据。
          // 区分它很重要——弱候选可以放心丢，而带 onclick / tabindex 的元素
          // 即使嵌在链接里也可能是独立的操作（卡片上的「×」关闭就是这种），丢了就没了。
          weak: !semantic && !el.hasAttribute('onclick')
            && el.getAttribute('tabindex') === null && !el.getAttribute('role'),
        });
        if (cands.length >= 400) { cands.truncated = true; return; } // 极端长页的护栏
      }
    };
    walk(document);

    // 二阶段：去掉「同一个可点区域被算两次」的那些。
    // 这类重复不只是费 token——它给了 agent 一个点了不管用的选项。
    const has = (pred) => cands.some(pred);
    const keep = cands.filter(({ el, semantic, weak }) => {
      // label 是另一个控件的代言人。本尊也在候选里时，留 label 只会让 agent
      // 在「点 label」和「点输入框」之间犹豫，而前者只是把焦点转给后者。
      if (el.tagName === 'LABEL') {
        const target = el.htmlFor ? document.getElementById(el.htmlFor) : el.querySelector('input,select,textarea');
        if (target && has((o) => o.el === target)) return false;
      }
      if (semantic) return true;
      // 弱候选外面裹着别的候选 → 它就是那个候选的一部分（<button> 里的 <i>）
      if (weak && has((o) => o.el !== el && o.el.contains(el))) return false;
      // 候选里面还裹着别的候选 → 让里面那个代表。
      // 小红书的侧边导航整块是 pointer，不滤会冒出「首页 笔记管理 Builder hub…」这种
      // 把所有子项文本拼在一起的假按钮——点不中，还白占 token。
      if (has((o) => o.el !== el && el.contains(o.el))) return false;
      return true;
    });
    keep.truncated = !!cands.truncated;
    keep.offWindow = off;
    return keep;
  }

  function buildSnapshot() {
    // 编号跨快照保持不变 —— 老元素拿回它上一轮的号。
    //
    // 原先每次都从 e1 重新数。后果是 agent 上一轮建立的全部认知
    //（「提交按钮是 e12」）在下一次 snapshot 之后立刻作废，只能把整份快照
    // 重读一遍；页面上插进来一个元素，后面所有编号还会整体偏移，
    // 于是「变了什么」这个问题它根本没法回答，只能全量重新理解。
    //
    // 而实测同一页面连续两次快照，DOM 节点有 **100%** 是同一个对象
    //（GitHub 仓库页 164 个元素，一个都没换）——编号会变纯粹是我们
    // 自己重新数了一遍造成的，跟页面没关系。
    const prevRef = new Map();
    for (const [r, rec] of refMap) {
      if (rec.el?.isConnected) prevRef.set(rec.el, r);
    }

    refMap = new Map();
    snapshotId = 's' + ++snapshotSeq;
    const keep = collectCandidates();

    // 先定编号：老元素认领旧号，剩下的空号留给新元素，避免新元素抢了
    // 某个老元素的号——那会让 agent 手里的 ref 悄悄指向别的东西。
    const rows = [];
    const taken = new Set();
    let unnamed = 0, truncated = keep.truncated;
    for (const { el } of keep) {
      const role = roleOf(el);
      const name = accessibleName(el);
      let hint = '';
      if (!name && role === 'button') {
        // 无名按钮以前直接丢（「多半是装饰性图标」）。代价是图标按钮、自定义
        // checkbox（PrimeNG 的 <div class="ui-chkbox">）、卡片上的「×」在快照里
        // 根本不存在，agent 只能写 querySelector 去摸——v0.7 数据里那 129 次
        // 「看」的 eval 有相当一部分是在摸这些。现在给个标识收进来，但封顶：
        // 装饰性图标确实很多，40 个之后仍然丢。
        hint = idHint(el);
        if (!hint || unnamed >= 40) { if (hint) truncated = true; continue; }
        unnamed += 1;
      }
      const ref = prevRef.get(el) || null;
      if (ref) taken.add(ref);
      rows.push({ el, role, name, ref, hint });
      if (rows.length >= 300) { truncated = true; break; }
    }
    let next = 0;
    for (const row of rows) {
      if (row.ref) continue;
      do { next += 1; } while (taken.has('e' + next));
      row.ref = 'e' + next;
      taken.add(row.ref);
    }

    const lines = [];
    let n = 0;
    for (const { el, role, name, ref, hint } of rows) {
      n += 1;
      // 存下当时的 role 和名字：ref 现在能跨快照使用，就必须防住
      // 「元素还在、语义换了」——列表刷新后复用同一个 DOM 节点，
      // [e5] 的「删除」很可能已经是另一条记录的删除按钮了。resolve 会比对。
      // hint 只进显示不进 refMap：resolve 比对的是可访问名，无名元素的名字就是空。
      refMap.set(ref, { el, role, name });
      const st = stateOf(el, role);
      const tail = hint ? (st ? st.replace(/\)$/, `, ${hint})`) : ` (${hint})`) : st;
      lines.push(`[${ref}]  ${role.padEnd(9)} "${name}"${tail}`);
    }

    const excerpt = mainText().slice(0, 1500);
    const alerts = collectAlerts();
    const overlays = collectOverlays();
    const header = `# ${document.title} — ${location.href}\n[snapshot ${snapshotId}] ${n} 个可交互元素`
      + (truncated ? '（已截断：元素太多，只列了一部分；要看别处的，先滚动到那里再拍）' : '')
      + (keep.offWindow ? `（视口上下几屏之外还有 ${keep.offWindow} 个，scroll 过去再拍才看得到）` : '') + '\n'
      + (alerts.length ? `\n⚠️ 页面提示：\n${alerts.map((a) => '  · ' + a).join('\n')}\n` : '')
      + (overlays.length ? `\n🪟 浮层/对话框（盖在页面上，多半要先处理）：\n${overlays.map((a) => '  · ' + a).join('\n')}\n` : '');
    return {
      untrusted: true,
      meta: `url="${location.href}" snapshot="${snapshotId}"`,
      snapshotId,
      alerts,
      text: `${header}\n${lines.join('\n')}\n\n--- 正文节选（完整正文用 read_text）---\n${excerpt}${excerpt.length >= 1500 ? '…' : ''}`,
    };
  }

  // 表单流程最主要的失败模式是校验错误，而校验错误恰恰是最容易被漏看的东西：
  // 正文节选只截前 1500 字，长页面里的红字提示根本进不来，agent 于是以为自己成功了，
  // 接着往下走——「已提交」和「提示手机号格式不对」在它眼里长得一模一样。
  //
  // 所以提示单独收一遍，放在快照最上面。宁可偶尔多报一条，也不能漏报。
  const ALERT_SEL = [
    '[role="alert"]', '[role="alertdialog"]', '[aria-live="assertive"]', '[aria-live="polite"]',
    '[aria-invalid="true"]', '.error', '.errors', '.alert', '.flash', '.toast', '.message--error',
    '[class*="error" i]', '[class*="invalid" i]', '[class*="warning" i]', '[class*="toast" i]',
  ].join(',');

  // 风控挑战的**原始证据**。判定不在这里做——content script 是注入脚本不能 import，
  // 判定规则放 extension/risk.js 由 background 调用，那样 `npm test` 能直接跑到。
  // 这里只负责采：可见 iframe 的 src，加顶层浮层的文本。
  //
  // 只扫顶层浮层不扫全文：「验证」这两个字在正文里太常见，
  // 全文匹配会把「实名验证入口」这类静态文案当成挑战。
  function challengeEvidence() {
    const frames = [], overlays = [];
    try {
      for (const f of document.querySelectorAll('iframe[src]')) {
        if (frames.length >= 8) break;
        if (isVisible(f)) frames.push(f.src);
      }
      const tops = new Set([
        ...document.querySelectorAll('[role="dialog"],[role="alertdialog"],dialog[open]'),
        ...Array.from(document.body?.children || []).filter((e) => {
          const cs = getComputedStyle(e);
          return cs.position === 'fixed' && cs.display !== 'none' && +cs.zIndex >= 100;
        }),
      ]);
      for (const el of tops) {
        if (overlays.length >= 5) break;
        if (!isVisible(el)) continue;
        const t = (el.innerText || '').replace(/\s+/g, ' ').trim();
        if (t) overlays.push(t.slice(0, 300));
      }
    } catch { /* 跨源 iframe / 页面正在换页 */ }
    return { frames, overlays };
  }

  // 弹窗/对话框单列一段。它们的文字以前只喂给 risk.js 判风控，不进快照——
  // 而「页面上盖着一个弹窗」是 agent 最需要第一眼知道的事：不知道就会对着
  // 被遮住的按钮反复点，或者写 eval 去找「关闭」。
  // 判据比 challengeEvidence 窄：只认明确声明的 dialog，和 class 名自述是
  // modal/popup/drawer 的固定浮层。sticky 导航条不算，那是页面的一部分。
  const OVERLAY_CLASS = /modal|dialog|popup|drawer|overlay|mask|lightbox/i;
  function collectOverlays() {
    const out = [];
    try {
      const tops = new Set([
        ...document.querySelectorAll('[role="dialog"],[role="alertdialog"],dialog[open]'),
        ...Array.from(document.body?.children || []).filter((e) => {
          if (e.shadowRoot || !OVERLAY_CLASS.test(String(e.className?.baseVal ?? e.className ?? ''))) return false;
          const cs = getComputedStyle(e);
          return cs.position === 'fixed' && cs.display !== 'none';
        }),
      ]);
      for (const el of tops) {
        if (out.length >= 4) break;
        if (!isVisible(el)) continue;
        // 外层浮层里套着真正的 dialog 时只报里面那个
        if (el.querySelector('[role="dialog"],[role="alertdialog"]')) continue;
        const t = (el.innerText || '').replace(/\s+/g, ' ').trim();
        if (t) out.push(t.length > 200 ? t.slice(0, 200) + '…' : t);
      }
    } catch { /* 页面正在换页 */ }
    return out;
  }

  function collectAlerts() {
    const out = new Set();
    let nodes;
    try { nodes = document.querySelectorAll(ALERT_SEL); } catch { return []; }
    for (const el of nodes) {
      if (out.size >= 6) break;
      // 容器上挂着 error class、里面还套着更小的提示节点时，取最里层那个，
      // 否则会把整块表单的文字当成一条提示报出来
      if (el.querySelector(ALERT_SEL)) continue;
      if (!isVisible(el)) continue;
      const t = (el.innerText || '').replace(/\s+/g, ' ').trim();
      if (!t || t.length > 200) continue;

      // role=alert / aria-live / aria-invalid 是页面明确声明「这是一条提示」，
      // 无条件采信。靠 class 名猜中的那些要过滤，否则 Bootstrap 的 .alert
      // 推广框、导航里的 label 都会冒充成校验错误——实测抓到过一条
      // 「Playwright tutorials」，而 agent 会当成提交失败的原因。
      const declared = el.matches('[role="alert"],[role="alertdialog"],[aria-live],[aria-invalid="true"]');
      if (!declared) {
        if (el.closest('nav,header,footer,aside')) continue;
        // 整块内容就是一个链接 = 推广位/导航，不是提示
        const a = el.querySelector('a');
        if (el.tagName === 'A' || (a && (a.innerText || '').trim() === t)) continue;
      }
      out.add(t);
    }
    return [...out];
  }

  // ---------- 正文提取（渡口 grab 的思路：先找主容器，再剥噪声） ----------

  function mainText() {
    const cand = document.querySelector('article, main, [role="main"], #js_content, .article-content, .post-content') || document.body;
    const clone = cand.cloneNode(true);
    // form 不剥：以前剥了，于是表单页的字段标签、校验文案、说明文字全不在节选里，
    // 而表单向导正是最需要「读一眼再决定」的那类页面。<select> 的选项文本会跟着
    // 进来，是可接受的噪音。
    clone.querySelectorAll('script, style, nav, header, footer, aside, noscript, svg, iframe, [aria-hidden="true"]').forEach((n) => n.remove());
    return (clone.innerText || '')
      .replace(/[\u200b-\u200f\u2060\ufeff\u00ad]/g, '')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function toMarkdown() {
    const cand = document.querySelector('article, main, [role="main"], #js_content') || document.body;
    const clone = cand.cloneNode(true);
    clone.querySelectorAll('script, style, nav, header, footer, aside, noscript, svg, iframe, [aria-hidden="true"]').forEach((n) => n.remove());
    const out = [];
    const walk = (node) => {
      for (const c of node.children) {
        const tag = c.tagName.toLowerCase();
        // 零宽字符（\u200b 一类）在国内站点里遍地都是，用来防复制或撑布局。
      // 不清掉，它们会变成一行行看不见内容的「文字」，把 \n{3,} 的折叠也破坏掉——
      // 知乎一页正文里有几十行这种，全是白付的 token。
      const t = clean(c.innerText || '');
        if (/^h[1-6]$/.test(tag) && t) out.push('#'.repeat(+tag[1]) + ' ' + t);
        else if (tag === 'p' && t) out.push(t);
        else if (tag === 'blockquote' && t) out.push('> ' + t);
        else if (tag === 'pre') out.push('```\n' + c.innerText.trim() + '\n```');
        else if (tag === 'li' && t) out.push('- ' + t);
        // 懒加载站点的 src 是 1px 占位符，真地址在 data-src / data-original。
        // 不取这几个，导出的 markdown 里每张图都会变成同一个透明像素。
        else if (tag === 'img') {
          const real = c.getAttribute('data-src') || c.getAttribute('data-original') || c.getAttribute('data-actualsrc') || c.src;
          // 头像、图标、装饰性小图不是正文。评论区几十个头像会占掉整整一屏 markdown，
          // 而它们对「这篇文章讲了什么」毫无贡献。按渲染尺寸判断最准——
          // 正文配图不会只有 60 像素宽。
          const small = (c.naturalWidth && c.naturalWidth < 80) || c.clientWidth < 60;
          if (real && !real.startsWith('data:') && !small) out.push(`![${c.alt || ''}](${real})`);
        }
        else if (c.children.length) walk(c);
        else if (t) out.push(t);
      }
    };
    walk(clone);
    return out.filter(Boolean).join('\n\n').replace(/\n{3,}/g, '\n\n');
  }

  // 零宽空格、字节序标记、软连字符：肉眼看不见，token 照收
  const clean = (s2) => s2.replace(/[\u200b-\u200f\u2060\ufeff\u00ad]/g, '').replace(/\s+/g, ' ').trim();

  // ---------- ref 解析（防呆全在这里） ----------

  // ---------- 语义定位 ----------
  //
  // ref 绑在快照上，而批处理（act）走到第二步时页面往往已经变了——ref 要么指向
  // 别的元素，要么根本不存在。所以批处理需要一种「页面重渲染后还能找回来」的定位方式。
  //
  // 用的是快照里已经给 agent 看过的那两样东西：role 和可访问名。
  // 候选池来自 collectCandidates()，和快照完全同源——不能出现
  // 「快照里明明有这个按钮，find 却说找不到」。

  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();

  function findEl(spec) {
    if (spec.selector) {
      const el = document.querySelector(spec.selector);
      if (!el) throw fail('REF_NOT_FOUND', `选择器没匹配到元素：${spec.selector}`);
      return el;
    }

    const pool = collectCandidates()
      .map(({ el }) => el)
      .filter((el) => !spec.role || roleOf(el) === spec.role);

    const want = norm(spec.name);
    if (!want) {
      if (pool.length === 1) return pool[0];
      throw fail('REF_NOT_FOUND',
        `只给了 role="${spec.role}"，而页面上有 ${pool.length} 个。补一个 name。`);
    }

    // 三级匹配，先严后宽，**任一级有结果就停**。
    // 混在一起排序的话，一个包含匹配可能排在精确匹配前面——
    // 而「确定」和「确定删除」是两个完全不同的按钮。
    const named = pool.map((el) => ({ el, name: norm(accessibleName(el)) }));
    const bare = (s) => s.replace(/\s/g, '');
    const tiers = [
      named.filter((x) => x.name === want),
      named.filter((x) => bare(x.name) === bare(want)),
      // 快照里的名字截断到 60 字会带一个省略号，拿它去反查要把尾巴摘掉
      named.filter((x) => x.name && (x.name.includes(want) || want.includes(x.name.replace(/…$/, '')))),
    ];
    const hit = tiers.find((t) => t.length);

    if (!hit) {
      const sample = named.filter((x) => x.name).slice(0, 12).map((x) => `"${x.name}"`).join('、');
      throw fail('REF_NOT_FOUND',
        `找不到${spec.role ? ` role=${spec.role} 的` : ''}「${spec.name}」。`
        + `页面上能找到的是：${sample || '（没有带名字的可交互元素）'}`);
    }
    // 命中多个时报错而不是猜。猜错一个按钮的代价可能是一笔订单——
    // 「删除」和「删除全部」在页面上常常并排放着。
    if (hit.length > 1 && spec.nth === undefined) {
      throw fail('REF_NOT_FOUND',
        `「${spec.name}」匹配到 ${hit.length} 个，不猜。用 nth 指定第几个（从 0 数），`
        + `或者把 name 写得更完整。候选：${hit.slice(0, 8).map((x) => `"${x.name}"`).join('、')}`);
    }
    const picked = hit[spec.nth || 0];
    if (!picked) {
      throw fail('REF_NOT_FOUND', `nth=${spec.nth} 超出范围，「${spec.name}」只匹配到 ${hit.length} 个`);
    }
    return picked.el;
  }

  function resolve(p) {
    // find 走语义定位，不依赖快照，所以也不受 STALE_SNAPSHOT 约束——
    // 这正是它在批处理中间还能用的原因
    if (p.find) return findEl(p.find);
    // 两个都给 = 一定有一个是错的，而后果极其隐蔽：下面 selector 优先，
    // 但回执里印的是 `p.ref || p.selector`，也就是 ref。于是「已点击 [e26]」
    // 底下点的其实是 querySelector 匹配到的第一个元素。
    // 开发中真撞到过：传了 {selector:"button", ref:"e26"}，点掉的是页面顶部的
    // 通知关闭按钮，回执却说点了提交按钮——而两者的后果天差地别。
    if (p.selector && p.ref) {
      throw fail('INTERNAL',
        'ref 和 selector 只能给一个。同时给的话只有 selector 生效，而回执显示的是 ref，'
        + '点错了从返回里完全看不出来。要用快照编号就只传 ref，要用选择器就只传 selector。');
    }
    // selector 兜底：snapshot 有抓不到的时候（渲染尺寸为 0、异形编辑器、shadow 边界），
    // 没有这条退路就只能干瞪眼。它不走快照，所以也不做快照校验——
    // 代价是失去 ref 的防呆，因此只在 ref 走不通时用。
    if (p.selector) {
      const el = document.querySelector(p.selector);
      if (!el) throw fail('REF_NOT_FOUND', `选择器没匹配到元素：${p.selector}`);
      return el;
    }
    if (!snapshotId) throw fail('STALE_SNAPSHOT', '本页还没有快照，先调用 snapshot');
    if (p.snapshotId && p.snapshotId !== snapshotId) {
      throw fail('STALE_SNAPSHOT', `快照 ${p.snapshotId} 已作废（当前 ${snapshotId}）。重新 snapshot 再操作。`);
    }
    const rec = refMap.get(p.ref);
    if (!rec) throw fail('REF_NOT_FOUND', `快照里没有 ${p.ref}`);
    const el = rec.el;
    if (!el.isConnected) throw fail('REF_NOT_FOUND', `${p.ref} 已从页面移除，重新 snapshot`);
    // 编号现在跨快照保持不变，于是多了一种以前不可能出现的危险：元素还在原地，
    // 但它承载的东西换了。列表刷新时框架常常复用同一批 DOM 节点，
    // [e5] 的「删除」按钮转眼就是另一条记录的删除按钮了——而 agent 手里
    // 那个 e5 是它上一轮记住的。所以比对当时的名字，对不上就拦住。
    const now = accessibleName(el);
    if (rec.name && now !== rec.name) {
      throw fail('STALE_SNAPSHOT',
        `${p.ref} 现在是「${now}」，不再是你看到的那个「${rec.name}」——`
        + '这一片内容被换掉了。重新 snapshot 再操作。');
    }
    if (!isVisible(el)) throw fail('NOT_INTERACTABLE', `${p.ref} 当前不可见`);
    if (isDisabled(el)) throw fail('NOT_INTERACTABLE', `${p.ref} 处于 disabled 状态——多半是表单还没填完整或校验没过，看快照里的页面提示`);
    return el;
  }

  const fail = (code, message) => Object.assign(new Error(message), { code });

  // 真实的一次鼠标点击，浏览器会依次发出
  //   pointerover → mouseover → mousemove → pointerdown → mousedown → focus
  //   → pointerup → mouseup → click
  // 而 el.click() 只发最后那一个。
  //
  // 这个差别不是理论上的：react-select / Ant Design / Element UI / MUI 的下拉菜单
  // 都绑在 mousedown 上，只发 click 的话菜单根本不会打开，而且不报错——
  // 快照里 expanded 一直是 false，agent 会以为自己点错了元素，然后开始乱试。
  // demoqa 的 State 下拉就是这么卡住的。
  //
  // 最后仍然调 el.click()：链接跳转、复选框勾选这些「激活行为」由它触发最稳，
  // 合成的 MouseEvent('click') 虽然规范上也会触发，但走原生方法少一层不确定。
  // 回执里印**实际命中的那个元素**，而不是只印 agent 传来的编号。
  //
  // 「已点击 [e26]」这句话是拿参数回显的，它永远为真、也永远不提供信息——
  // 定位错了（编号复用、selector 匹配到了另一个、find 命中了同名的另一个）
  // 从返回里一个字都看不出来，而下游看到的是「成功」。
  // 印上 role 和名字之后，点错在下一轮就自己暴露出来，代价是十来个 token。
  const describeHit = (el) => {
    try {
      const name = accessibleName(el);
      return `${roleOf(el)}${name ? ` "${name.slice(0, 40)}"` : ''}`;
    } catch {
      return '';
    }
  };

  function realClick(el) {
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;

    // 真实点击的 event.target 是光标下**最内层**的元素，事件再往上冒泡。
    // 直接派发在容器上，target 就成了容器本身——组件按 event.target 分支的逻辑
    // 会走进另一条路。react-select 的 Control 就读 event.target.tagName。
    const inner = document.elementFromPoint(x, y);
    if (inner && el.contains(inner)) el = inner;
    const base = { bubbles: true, cancelable: true, composed: true, view: window, clientX: x, clientY: y, button: 0 };
    const ptr = { ...base, pointerId: 1, pointerType: 'mouse', isPrimary: true };

    const fire = (Ctor, type, extra) => el.dispatchEvent(new Ctor(type, { ...extra }));
    try {
      fire(PointerEvent, 'pointerover', ptr);
      fire(MouseEvent, 'mouseover', base);
      fire(MouseEvent, 'mousemove', base);
      fire(PointerEvent, 'pointerdown', { ...ptr, buttons: 1 });
      // 「移动焦点」是 mousedown 的默认行为，被 preventDefault 就不该发生。
      // 无条件 focus 会把控件刚刚自己设好的焦点抢回来——react-select 正是靠
      // 拦下 mousedown 再 focusInput() 来打开菜单的，抢一次它就永远打不开，
      // 而且不报错：快照里 expanded 一直是 false，看着像点错了元素。
      const notPrevented = el.dispatchEvent(new MouseEvent('mousedown', { ...base, buttons: 1 }));
      if (notPrevented) el.focus?.();
      fire(PointerEvent, 'pointerup', ptr);
      fire(MouseEvent, 'mouseup', base);
    } catch {
      /* 老浏览器没有 PointerEvent，退化成只发鼠标事件也够用 */
    }
    // 激活行为（链接跳转、复选框勾选、表单提交）由派发 click 事件触发，规范上
    // 会在事件目标最近的可激活祖先上执行——这正是真实点击落在 <a> 里的 <span> 上
    // 也能跳转的原因。
    //
    // 这里不能图省事写 el.click()：**SVG 元素根本没有 click() 方法**，
    // 而图标按钮的最内层几乎总是 <svg>/<path>。之前那版一碰到图标按钮就
    // 抛 "el.click is not a function"，而全网的图标按钮多到数不清。
    fire(MouseEvent, 'click', base);
  }

  // ---------- L2 交接：定位 ----------
  //
  // L2 不重新实现元素定位。ref 解析、滚动、遮挡检测这些防呆全都留在这里，
  // L2 只接管「派发事件」那一步——它拿到的就是这个函数返回的一对坐标。
  //
  // 两条必须守住的约束：
  // ① 取坐标和派发之间不能有任何等待。中间只要有一次 await sleep，页面一滚
  //    坐标就废了，点到的是别的东西。所以 locate 返回后 background 立刻派发。
  // ② 坐标是 CSS px、相对视口左上角，正是 getBoundingClientRect 的口径，
  //    和 CDP Input.dispatchMouseEvent 一致，不需要乘 DPR。

  // 这几类编辑器的状态在 JS 里而不在 DOM 上：applyText 改完 value/textContent，
  // 编辑器内部模型没变，一失焦就整段回滚，而且过程完全静默。
  // 普通 contenteditable 不列进来——它 execCommand 就能写，走 L1 更省（不闪黄条）。
  const EDITOR_HOSTS = '.monaco-editor,.CodeMirror,.cm-editor,[data-slate-editor],.ql-editor,.ProseMirror';

  // 自动升级的确定性闸门。命中这些的目标，L1 没证据也不自动用 L2 重试——
  // 因为 L1 可能其实已经生效（只是没留下可观测的痕迹），重试就是下第二笔单。
  const SENSITIVE_TEXT = /提交|支付|付款|下单|确认|删除|发布|转账|购买|立即|结算|确定|submit|pay|checkout|delete|publish|confirm|purchase/i;

  function preferOf(el) {
    // 原生 <select>：实测 L2 点击打开的是浏览器进程的原生 popup，
    // 它不在页面渲染树里，CDP 的 Input 域打不到，键盘事件被 popup 吃掉，
    // 下拉还会卡在打开状态挡住后面的操作。
    // 直接设 value + 派发 change（L1 的 applySelect）才是它的完整语义。
    if (el.tagName === 'SELECT') return 'L1';
    if (el.tagName === 'INPUT' && (el.type || '').toLowerCase() === 'file') return 'L2';
    if (el.closest?.(EDITOR_HOSTS)) return 'L2';
    return null;
  }

  function isSensitive(el) {
    const name = [el.innerText, el.value, el.getAttribute?.('aria-label'), el.getAttribute?.('title')]
      .map((s) => (s || '').trim()).find(Boolean) || '';
    if (SENSITIVE_TEXT.test(name.slice(0, 40))) return true;
    // 「在 form 里」这个条件不能省：**<button> 不写 type 时 el.type 就是 "submit"**，
    // 而绝大多数按钮都不写 type。只判 type 的话整个页面的按钮全成了敏感动作，
    // 闸门把自动升级全挡死，L2 等于没接上——实测就是这么撞出来的。
    // form 之外的 submit 按钮没有提交语义，不该进这道闸。
    if (/^(BUTTON|INPUT)$/.test(el.tagName)
      && /^(submit|image)$/i.test(el.type || '')
      && el.closest('form')) return true;
    const cls = `${el.className?.baseVal ?? el.className ?? ''} ${el.getAttribute?.('data-testid') || ''}`;
    return /\b(pay|submit|checkout|delete|remove|confirm|publish)\b/i.test(cls);
  }

  // ---------- 支付闸门 ----------
  //
  // 花钱的那一下要人点头。判据必须比 SENSITIVE_TEXT 窄得多——那条含
  // 「确认/确定/提交」，拿它弹窗的话几乎每个页面都要打断一次，
  // 而「烦」的终点是用户把整个功能关掉，那就一点保护都不剩了。
  // 所以这里只认花钱的语义，别的敏感动作照旧只走「不自动重试」那道闸。
  const PAY_TEXT = /支付|付款|下单|结算|购买|充值|提现|转账|打赏|续费|开通会员|确认订单|微信支付|支付宝|pay\s?now|checkout|place\s?order|buy\s?now|purchase|subscribe/i;

  // 金额是比文案更强的信号：「确认」两个字到处都是，但「确认 ¥1,280」
  // 只可能是一件事。真实支付页最后那一下常常就写着「确认」——
  // 只看文案会把最该拦的那一类漏掉。
  const MONEY = /[¥$€£￥]\s?\d[\d,]*(?:\.\d+)?|\d[\d,]*(?:\.\d+)?\s*(?:元|块|美元|USD|CNY|RMB)/i;
  const GENERIC_OK = /^(确认|确定|提交|同意|继续|下一步|ok|confirm|submit|continue|next)/i;

  const labelOf = (el) => [el.innerText, el.value, el.getAttribute?.('aria-label'), el.getAttribute?.('title')]
    .map((s) => (s || '').trim()).find(Boolean) || '';

  // 只看按钮自己和它的直接父元素。
  //
  // 试过往上找三四层，也试过用「容器文本量」当刹车，都不行：靶场里一个
  // 本不该拦的「确认」，被同一个 section 里另一笔订单的 ¥1,280 拦了下来，
  // 而那个 section 的文字量恰好在阈值以内。容器有多大是页面说了算的，
  // 拿它当判据就是在碰运气。
  //
  // 这么定会漏掉一类结构：金额在外层、按钮又被 .actions 多包了一层。
  // 认下这个漏——那种页面上的按钮通常自己就写着「确认支付」，
  // 早在文案那一关就被拦住了。而误报的代价要重得多：
  // 一个见「确认」就弹窗的闸门，用户两天就把它关了，剩下的保护是零。
  function moneyNear(el) {
    let box = el;
    for (let up = 0; box && up < 2; up++, box = box.parentElement) {
      const m = MONEY.exec((box.innerText || '').trim());
      if (m) return m[0].trim();
    }
    return '';
  }

  // ---------- eval 期间的支付防线 ----------
  //
  // 支付确认的闸门装在命令层（performCore 里），而 eval 不走那条路——
  // 它用 executeScript 直接在页面世界求值。实测一句
  // `document.getElementById('pay').click()` 就把确认整个绕过去了，
  // 而 eval 是使用频次第三高的命令。一个能被一句话绕过的确认等于没有确认。
  //
  // 所以在 eval 执行期间，于 document 的捕获阶段架一道拦截：合成的点击
  // （isTrusted=false）如果打在支付按钮上，就地拦下。捕获阶段在事件到达
  // 目标之前，stopImmediatePropagation 之后页面自己的 onclick 不会跑。
  //
  // **只在 eval 执行期间架**，这一点很要紧：常驻的话，页面框架自己转发的
  // 合成点击也会被拦——用户正在自己的浏览器里买东西，支付按钮突然点不动，
  // 那是比漏拦更糟的故障。
  //
  // 拦得住的是同步的 click 那条路。form.submit()、直接 fetch 下单接口、
  // location 跳转仍然绕得过去——eval 本质上是把整个页面的执行权交出去，
  // 不可能全堵。这道防线是提高门槛，不是保证。协议文档里写明了这一点。
  let payGuard = null;
  let payBlocked = null;

  function armPayGuard() {
    if (payGuard) return;
    payBlocked = null;
    payGuard = (e) => {
      if (e.isTrusted) return;                     // 真人点的，放行
      const el = e.target?.closest?.('button,a,[role="button"],input,[onclick]');
      if (!el) return;
      const pay = payInfo(el);
      if (!pay) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      payBlocked = pay;
    };
    document.addEventListener('click', payGuard, true);
  }

  function disarmPayGuard() {
    if (payGuard) document.removeEventListener('click', payGuard, true);
    payGuard = null;
    const was = payBlocked;
    payBlocked = null;
    return was;
  }

  // 返回 null 或 { label, amount }。amount 只是弹窗里给人看的证据，
  // 取不到不影响判定。
  function payInfo(el) {
    const label = labelOf(el).slice(0, 60);
    if (PAY_TEXT.test(label)) return { label, amount: moneyNear(el) };
    if (GENERIC_OK.test(label)) {
      const amount = moneyNear(el);
      if (amount) return { label, amount };
    }
    return null;
  }

  async function doLocate(p) {
    // fill 这类没有单一目标的操作只要基线，不要定位
    if (p.baselineOnly) {
      lastTarget = null;
      // fill 把要填的字段放在 fields 里，逐个采下基线——见 baselineOf 里的说明
      const refs = Array.isArray(p.fields) ? p.fields.map((f) => f.ref).filter(Boolean) : [];
      return { baseline: await baselineOf(null, refs) };
    }
    const el = resolve(p);
    lastTarget = el;
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;

    // 虚拟光标（mark.js，和本文件同一个 isolated world）：坐标就地递过去，
    // 零消息往返。L1 和 L2 都走 locate，所以两条路的光标一致。
    // **必须在下面的 elementFromPoint 之前调**——坐标落在驾驶舱底下时它要
    // 先让路（pointer-events:none 同步生效），否则遮挡检测会把我们自己的
    // 面板当成遮挡物，L2 的真实点击更会直接点进面板里。
    window.__hcCursor?.(x, y, ({ click: 'click', type: 'type', select: 'type', key: 'key' })[p.forCmd] || 'aim');

    // 遮挡检测和 doClick 保持同一套判断——L2 打的是坐标，遮挡时点中的是遮挡物，
    // 比 L1 更危险，更不能放过
    const top = document.elementFromPoint(x, y);
    if (top && top !== el && !el.contains(top) && !top.contains(el)) {
      throw fail('NOT_INTERACTABLE', `${p.ref || p.selector} 被其它元素遮挡（可能有弹窗/浮层）。先处理遮挡物。`);
    }
    // 视口外的坐标 CDP 打不中。scrollIntoView 之后仍在视口外，说明它在一个
    // 内部滚动容器里而容器没跟着滚——这时候不能硬点。
    const outside = x < 0 || y < 0 || x > innerWidth || y > innerHeight;

    // 基线放在最后采：前面的 scrollIntoView 本身会改变可见性和布局，
    // 先采就把自己造成的变化算进了「页面的反应」里
    const baseline = await baselineOf(el);
    return {
      x, y, outside,
      tag: el.tagName,
      role: roleOf(el),
      prefer: preferOf(el),
      sensitive: isSensitive(el),
      pay: payInfo(el),
      baseline,
    };
  }

  // ---------- L2 交接：效果证据 ----------
  //
  // 现在的做法是「固定 sleep(400) 后回一份新快照，agent 自己看」，三个问题：
  // 只看 URL 一个维度（SPA 里大多数交互不改 URL）；快页面白等、慢页面不够；
  // 最要命的是「有变化」和「没变化」返回的东西长得一模一样——
  // 于是「已提交」和「被校验拦下」在 agent 眼里没有区别。
  //
  // 这里不替模型判断成功失败（那需要理解意图，扩展没有意图），
  // 只回答一个确定性问题：**页面到底动没动。**

  const activeDesc = () => {
    const a = document.activeElement;
    return a && a !== document.body ? `${a.tagName.toLowerCase()}${a.id ? '#' + a.id : ''}${a.name ? `[name=${a.name}]` : ''}` : '';
  };

  // 密码、验证码这类字段的**值**绝不能进效果证据。
  //
  // fill 的回执早就脱敏了（下面的 receipt），但 targetState 这条路一直敞着：
  // 往密码框 type 一次，返回里就是「value 空 → 明文密码」，而这句话是要写进
  // agent 上下文的——上下文留痕、撤不回来，正是凭据隐去那一节的出发点。
  // 和审计日志漏掉 act.steps 是同一个模式：脱敏做在一条路上，另一条敞着。
  //
  // 换成长度就两全了：既不泄露，又照样能判断「值到底变没变」。
  const SECRET_FIELD = /pass|pwd|secret|token|cvv|captcha|verif|code|otp|密码|验证码/i;
  const isSecretField = (el) => {
    if ((el.type || '').toLowerCase() === 'password') return true;
    try {
      return SECRET_FIELD.test(`${el.name || ''} ${el.id || ''} ${el.getAttribute('autocomplete') || ''}`);
    } catch {
      return false;
    }
  };

  function targetState(el) {
    if (!el || !el.isConnected) return { gone: true };
    const raw = String(el.value ?? '');
    return {
      expanded: el.getAttribute('aria-expanded') ?? '',
      checked: String(el.checked ?? el.getAttribute('aria-checked') ?? ''),
      selected: el.getAttribute('aria-selected') ?? '',
      value: isSecretField(el) ? (raw ? `<${raw.length} 位>` : '') : raw.slice(0, 120),
      cls: String(el.className?.baseVal ?? el.className ?? '').slice(0, 200),
    };
  }

  // 这三样都不触发布局，随便调。
  const cheapStats = () => ({
    els: document.getElementsByTagName('*').length,
    active: activeDesc(),
    bodyKids: document.body?.children.length ?? 0,
  });

  // innerText 是另一回事：它强制 reflow。
  //
  // 但又非用不可——textContent 在最常见的一类交互上是瞎的：点「展开」让一个
  // display:none 的面板显示出来，元素本来就在 DOM 里（节点数不变），
  // textContent 把隐藏内容也算进去（长度也不变），目标按钮自己更没变，
  // 于是判定「页面完全没有反应」，而表单已经在用户眼前了。
  // 只有 innerText 统计**渲染出来**的文本，看得见可见性变化。
  //
  // 折中是**按需调用**：settle 每 100ms 轮询一次，全都算一遍的话成本被放大十几倍
  // ——实测把整套实景测试从 2 秒级拖到 10 秒级，有 iframe 的页面更糟。
  // 所以只在便宜指标全都没动、需要它兜底时才付这个成本。
  const renderedLen = (node) => (node?.innerText || '').length;

  // 「变化发生在哪里」比「有没有变化」可靠得多。
  //
  // 全页面的文本长度是个很脏的信号：直播弹幕、行情数字、懒加载列表每时每刻都在改它。
  // 实测点一个只认 isTrusted 的按钮（点击必然无效），返回却是「效果：正文 +7 字」——
  // 那 7 个字是页面自己的懒加载 feed 填进来的。
  //
  // 而一次点击如果真有效果，痕迹几乎必然落在这三个地方之一：目标自身的状态、
  // 目标所在的那个区块、或者以浮层/提示的形式新挂到 body 底下。噪声通常在别处。
  // 所以判定「动没动」只看这三处，全局数字降级成附带信息。
  const SCOPE_SEL = 'section,form,[role=dialog],[role=listbox],[role=menu],main,article,'
    + '[class*="modal" i],[class*="dialog" i],[class*="popover" i],[class*="dropdown" i]';

  // 找不到区块容器时退回 **body**，不是 parentElement。
  //
  // 用 parentElement 的那版漏掉了一整类最常见的交互：点「开始填写」，
  // 表单出现在按钮的**兄弟节点**里——按钮自己的父元素一个字都没变，
  // 于是判定「页面完全没有反应」，而表单已经在用户眼前了。
  //
  // 收窄 scope 是「页面有区块结构时」的优化（section/form/dialog 能把
  // 直播弹幕那类噪声挡在外面）；没有结构可依时，全局才是诚实的范围。
  function scopeBoxOf(el) {
    if (!el || !el.isConnected) return null;
    return el.closest(SCOPE_SEL) || document.body;
  }

  // 采基线时顺便测一下「页面自己动不动」。
  //
  // 不做这一步，动态页面上的证据全是假的：实测点一个什么都没绑的按钮，
  // 返回「效果：正文 -4 字」——那 4 个字是页面自己的懒加载列表在填充，
  // 跟这次点击毫无关系。而 agent 读到「有效果」就会以为操作成功了。
  //
  // 代价是每个写操作多 60ms。换来的是「报告可信」，值这个价——
  // 何况早停之后总耗时通常还是比原来固定的 400ms 短。
  async function baselineOf(el, fieldRefs = []) {
    const s1 = cheapStats();
    await sleep(60);
    const s2 = cheapStats();
    const volatile = Math.abs(s2.els - s1.els) >= 3;
    const box = scopeBoxOf(el);
    return {
      ...s2,
      volatile,
      textLen: renderedLen(document.body),
      scope: box ? { kids: box.getElementsByTagName('*').length, len: renderedLen(box) } : null,
      alerts: collectAlerts(),
      target: targetState(el),
      // fill 没有单一目标，但它有一组字段——把每个字段此刻的状态收下来。
      //
      // 不收的话，fill 的效果证据只剩全局那几个指标，而填表根本不改变 DOM 结构，
      // 于是每次 fill 都报「没有可归因于这次操作的变化」，哪怕值已经填进去了；
      // 更难看的是它还会把 fill 自己造成的焦点转移说成「这个页面本身在持续变化」。
      // 填表是浏览器自动化最高频的场景，而这条路上的证据是结构性缺失的。
      fields: fieldRefs.map((r) => {
        const rec = refMap.get(r);
        return rec ? { ref: r, ...targetState(rec.el) } : null;
      }).filter(Boolean),
    };
  }

  function doEffect(p) {
    const base = p.baseline || {};
    // 目标要能重新找回来，否则 targetState 拿到 null，会把「找不回」误报成
    // 「元素已从页面移除」——而后者是一条很强的证据，误报等于凭空造证据。
    // selector 路径尤其要照顾：它本来就绕过 refMap。
    // find 的目标**不重新查找**，用 locate 时记下的那个元素引用。
    //
    // 一开始这里写的是 `p.find ? findEl(p.find) : ...`，而 findEl 要跑
    // collectCandidates()——一次全页面遍历外加逐元素 getComputedStyle。
    // settle 每 100ms 轮询一次 effect，于是一个动作要付十几次全量遍历，
    // 实测把 act 的每一步拖到几十秒，直接撞穿 35 秒的 RPC 超时。
    //
    // 而且用引用比重新查找更对：我们要判断的是「刚才操作的那个元素怎么样了」，
    // 它被移除、被替换本身就是强证据；重新 find 到一个长得一样的新元素，
    // 反而会把这个信号抹掉。
    let el = null;
    try {
      el = p.ref ? refMap.get(p.ref)?.el
        : p.selector ? document.querySelector(p.selector)
        : lastTarget;
    } catch {
      /* 取不到就当没有，交给下面的 gone 分支表达 */
    }
    const now = cheapStats();

    // 证据分强弱。强证据几乎不可能是页面自己动出来的（目标自身的状态、新冒出来的
    // 提示、元素消失）；弱证据（DOM 数量、正文长度、焦点）在直播弹幕、行情、
    // 懒加载列表这类页面上每时每刻都在产生。
    // 页面本身在动时（volatile），只有强证据算数——否则报告就是在编。
    const strong = [], weak = [];
    const parts = weak;

    // 顺序是**按成本从低到高**排的，因为下面两处贵的检查会先看
    // 「已经有强证据了吗」——排错顺序的话，明明 checkbox 已经勾上了，
    // 还要再去 reflow 一遍全页面。

    // ① 目标自身的状态（最便宜，也最强）。展开下拉、勾选、受控组件把值回滚，
    // 这三样都不改 DOM 节点数，往往是唯一的证据。
    const bt = base.target || {}, nt = targetState(el);
    // 曾经多写了一个 `bt.gone !== undefined`，结果元素真的消失时反而不报「已移除」，
    // 还掉进下面的字段循环，把 gone 状态的一堆 undefined 和基线的空串逐个对比，
    // 输出「expanded 空 → 空；checked 空 → 空…」一长串废话。
    // 无目标的操作（fill、无 ref 的 key）baseline 里 target 本来就是 {gone:true}，
    // 两边都 gone，自然不会进这条分支——那个条件从一开始就是多余的。
    if (nt.gone && !bt.gone) strong.push('目标元素已从页面移除');
    else for (const k of ['expanded', 'checked', 'selected', 'value', 'cls']) {
      if (bt[k] === undefined || bt[k] === nt[k]) continue;
      if (k === 'cls') { strong.push('目标 class 变了'); continue; }
      strong.push(`${k} ${bt[k] || '空'} → ${nt[k] || '空'}`);
    }

    // ①b 各字段的状态。fill 走这条：它没有单一目标，但填进去的每个值都是证据，
    // 而且是强证据——value 从空变成「花叔」不可能是页面自己动出来的。
    for (const bf of (base.fields || [])) {
      const rec = refMap.get(bf.ref);
      if (!rec) continue;
      const nf = targetState(rec.el);
      if (nf.gone && !bf.gone) { strong.push(`${bf.ref} 已从页面移除`); continue; }
      for (const k of ['value', 'checked', 'selected']) {
        if (bf[k] === undefined || bf[k] === nf[k]) continue;
        strong.push(`${bf.ref} ${k} ${bf[k] || '空'} → ${nf[k] || '空'}`);
      }
    }

    // ② 新增的页面提示。表单流程最主要的失败模式就是校验错误，
    // 而它常在长页面下方，正文节选根本截不到。
    const fresh = collectAlerts().filter((a) => !(base.alerts || []).includes(a));
    if (fresh.length) strong.push(`⚠️ 页面提示：${fresh.join(' / ')}`);

    // ③ body 直接子元素增减。模态框、抽屉、toast 几乎都挂在这一层，
    // 而页面自己的内容更新极少动到 body 的直接子节点。
    const dBodyKids = now.bodyKids - (base.bodyKids ?? now.bodyKids);
    if (dBodyKids !== 0) {
      strong.push(dBodyKids > 0
        ? `页面顶层新增 ${dBodyKids} 个元素（多半是弹窗/浮层/toast）`
        : `页面顶层移除 ${-dBodyKids} 个元素（多半是整块内容被换掉了）`);
    }

    // ④ 目标所在区块。局部阈值可以定得很低（2 个字符），因为这块地方的变化
    // 几乎不可能是别处的噪声漂过来的。先比节点数（不触发布局），
    // 只有节点数没动、而且到这里还没有别的强证据时，才去算 innerText——
    // 「隐藏 → 显示」正是节点数不变的那种情况，也只有那时才值得付 reflow 的钱。
    const bs = base.scope, box = scopeBoxOf(el);
    if (bs && box) {
      const dKids = box.getElementsByTagName('*').length - bs.kids;
      if (dKids !== 0) strong.push(`目标区块 DOM ${dKids > 0 ? '+' : ''}${dKids} 节点`);
      // 只有「class 变了」时也算一次文本：那条几乎总是动画/激活态，真正的结果
      // （文字换了、提示出来了）常在几百毫秒后才到，settle 正等着这里报出来
      else if (!strong.length || (strong.length === 1 && strong[0] === '目标 class 变了')) {
        const dLen = renderedLen(box) - bs.len;
        if (Math.abs(dLen) >= 2) strong.push(`目标区块文本 ${dLen > 0 ? '+' : ''}${dLen} 字`);
      }
    }

    // ⑤ 以下是弱证据：页面自己也会产生，不参与「动没动」的判定，只作参考。
    // 阈值挡住噪声：时钟、轮播、埋点会让 DOM 一直微微地动，
    // 不设阈值就变成「永远有效果」，这个机制也就废了。
    const dEls = now.els - (base.els ?? now.els);
    if (Math.abs(dEls) >= 3) parts.push(`DOM ${dEls > 0 ? '+' : ''}${dEls} 节点`);

    // 全局正文长度是最贵也最脏的一个指标：贵在 reflow，脏在直播弹幕和懒加载
    // 每时每刻都在改它。既然已经有强证据，就没必要再付这笔钱。
    //
    // 阈值定 4 不定 20：实测「未触发」→「已触发（真实事件）」只差 6 字，
    // 阈值 20 会把这次真实的成功判成「页面完全没有反应」。两类误判的代价不对称——
    // 假阴性只是多一次幂等重试，假阳性会让 agent 带着错误前提往下走。
    // 比长度而不比内容，还顺带挡掉了时钟这类噪声（12:34:56 → 12:34:57 长度不变）。
    if (!strong.length && base.textLen !== undefined) {
      const dText = renderedLen(document.body) - base.textLen;
      if (Math.abs(dText) >= 4) parts.push(`正文 ${dText > 0 ? '+' : ''}${dText} 字`);
    }

    // 焦点落到目标自己身上不算证据——点击本来就会聚焦（L1 的 realClick 显式调
    // el.focus()，L2 的真实点击由浏览器聚焦），那是这个动作的机械后果，
    // 不是页面对它的反应。
    //
    // 这条不加的话整个机制会静默失效：任何一次点击都「有效果」，于是
    // 「零证据 → 自动升级 L2」永远不会触发。实测在只认 isTrusted 的按钮上撞到过——
    // 按钮的逻辑一行没跑，返回里却写着「效果：焦点 → button#trustedOnly」。
    //
    // 焦点移到**别的**元素仍然算：那是页面主动转移的（react-select 拦下 mousedown
    // 再把焦点交给内部 input 就是这种），属于真实反应。
    const focusedSelf = el && document.activeElement === el;
    if (now.active !== base.active && !focusedSelf) parts.push(`焦点 → ${now.active || '(无)'}`);

    // 判定只认强证据。全局数字（weak）照样报出来给 agent 参考，
    // 但不用它下「动没动」这个结论——它是页面里最脏的那个信号。
    const changed = strong.length > 0;
    return {
      changed,
      parts: [...strong, ...weak],
      alerts: fresh,
      volatile: !!base.volatile,
      // 页面在动、但没有一条能归到这次操作头上——必须说出来，
      // 不能让 agent 把别人的动静当成自己的战果
      unattributable: !strong.length && weak.length > 0,
      // 这次操作之后页面上有哪些浮层/iframe。background 用 risk.js 判断是不是
      // 风控挑战——是的话记住这个 origin，之后一律从 L2 起步，
      // 不再拿 isTrusted:false 的事件去撞风控。
      challengeEv: challengeEvidence(),
    };
  }

  // ---------- 动作 ----------

  async function doClick(p) {
    const el = resolve(p);
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    // 被遮挡检测：点下去要是命中别的元素，多半有弹层盖着，这时候点了就是误操作
    const r = el.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    if (top && top !== el && !el.contains(top) && !top.contains(el)) {
      throw fail('NOT_INTERACTABLE', `${p.ref} 被其它元素遮挡（可能有弹窗/浮层）。先处理遮挡物。`);
    }
    realClick(el);
    const retry = await retryCombobox(el);
    invalidate();
    return { data: { note: `已点击 [${p.ref || p.selector}] ${describeHit(el)}${retry}` } };
  }

  // 自定义下拉「点了没反应」是最常见的一类卡住，而且完全静默：
  // 快照里 aria-expanded 一直是 false，agent 看不出是没点中、还是这个组件就这样，
  // 于是开始乱试别的 ref。
  //
  // 各家组件把 mousedown 绑在不同的内层节点上（react-select v5 的控件本体就打不开，
  // 必须打在右侧那个箭头容器上）。与其把这份组件知识塞进 agent 的脑子，
  // 不如在这儿换个目标再试一次——箭头/图标是所有下拉都有的东西。
  async function retryCombobox(el) {
    const root = el.closest('[role="combobox"],[aria-haspopup="listbox"],[aria-haspopup="true"]')
      || (el.getAttribute('aria-expanded') !== null ? el : null);
    if (!root) return '';
    const flag = root.querySelector('[aria-expanded]') || root;

    // 必须先等一拍再判断。React 的 setState 是异步的，点完立刻读属性一定还是旧值——
    // 照着旧值去「补救」，补的是一个其实已经打开的菜单，而箭头是 toggle，
    // 于是刚开的菜单被自己关掉了。这个 bug 的表象和「根本没点开」一模一样。
    await sleep(250);
    if (flag.getAttribute('aria-expanded') !== 'false') return '';  // 开了，或者这组件不用这个属性

    // 箭头通常不是控件的子节点，而是外层容器里的兄弟节点，层数各家不一：
    // react-select 埋了三层（input → 值容器 → control → indicatorContainer）。
    // 一层层往上找，找到第一个不包含自己的箭头为止。
    const ARROW = '[class*="indicator" i],[class*="arrow" i],[class*="caret" i],[class*="toggle" i],svg';
    let target = null;
    let box = root;
    for (let up = 0; box && up < 4 && !target; up++, box = box.parentElement) {
      const hits = [...box.querySelectorAll(ARROW)].filter((a) =>
        !a.contains(el) && a !== el
        // 分隔线的类名里也带 indicator（react-select 的 indicatorSeparator 就是），
        // 而且排在真正的箭头前面。按文档序取第一个，点的就是那根线，永远没反应。
        && !/separator|divider/i.test(a.className?.baseVal ?? a.className ?? ''));
      // 箭头在控件最右端，取最后一个比取第一个可靠
      const a = hits[hits.length - 1];
      // svg 本身不带监听器，监听器在包着它的那个容器上
      if (a) target = a.tagName === 'svg' && a.parentElement ? a.parentElement : a;
    }
    if (!target || target === el || target.contains(el)) return '';

    realClick(target);
    await sleep(250);
    return flag.getAttribute('aria-expanded') === 'true'
      ? '（控件本体没反应，改点它的下拉箭头才展开——这是 react-select 一类组件的常见情况）'
      : '（点了但 aria-expanded 仍为 false：可能这个组件不用该属性，看下面的快照里有没有多出选项）';
  }

  function doType(p) {
    const el = resolve(p);
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    applyText(el, p.text, p.clear !== false);
    if (p.submit) {
      const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true };
      el.dispatchEvent(new KeyboardEvent('keydown', opts));
      el.dispatchEvent(new KeyboardEvent('keyup', opts));
      el.closest('form')?.requestSubmit?.();
    }
    invalidate();
    return { data: { note: `已在 [${p.ref || p.selector}] ${describeHit(el)} 输入${p.submit ? '并回车' : ''}` } };
  }

  function doSelect(p) {
    const el = resolve(p);
    if (el.tagName !== 'SELECT') {
      throw fail('NOT_INTERACTABLE',
        `${p.ref} 不是原生 <select>。自定义下拉（div 模拟的）要按真实交互来：` +
        `先 click 展开，再 snapshot 看选项，再 click 选中；或者 click 后用 key ArrowDown/Enter。`);
    }
    applySelect(el, p.value);
    invalidate();
    return { data: { note: `已选择「${p.value}」` } };
  }

  // ---------- 批量填表 ----------
  //
  // 存在理由是成本：一个动作一份快照，填 10 个字段就是 10 个来回、10 份快照、
  // 上万 token，而中间那 9 份快照没有任何人读。注册/登录/下单表单是最常见的
  // 浏览器任务，这条路不铺，agent 在最该用它的地方最贵。
  //
  // 能这么做的前提是：整批 ref 都取自同一份快照，作废发生在整批之后。
  //
  // 一个字段失败不中止整批——中止的话 agent 只知道「第 3 个挂了」，
  // 前两个填没填、后面几个动没动全靠猜。宁可全跑完，逐条报告。
  function doFill(p) {
    const fields = Array.isArray(p.fields) ? p.fields : [];
    if (!fields.length) throw fail('INTERNAL', 'fields 不能为空');
    if (fields.length > 60) throw fail('INTERNAL', `一次最多 60 个字段，收到 ${fields.length} 个`);

    const done = [], failed = [];
    for (const f of fields) {
      const spec = { ...f, snapshotId: p.snapshotId };
      try {
        const el = resolve(spec);
        const label = f.ref || f.selector;
        // 前一个字段的输入可能触发重渲染，把后面的元素换掉。ref 指向的旧节点
        // 还在 refMap 里，但已经脱离文档——resolve 会报出来，这里如实归到失败里。
        el.scrollIntoView({ block: 'center', behavior: 'instant' });
        // 填表是 locate 覆盖不到的多目标路径：光标逐个字段滑过去，
        // 用户看到的正是「它在一格一格填」
        const fr = el.getBoundingClientRect();
        window.__hcCursor?.(fr.left + fr.width / 2, fr.top + fr.height / 2, 'type');

        if (f.check !== undefined) {
          const want = !!f.check;
          const now = el.checked ?? el.getAttribute('aria-checked') === 'true';
          if (now !== want) realClick(el);
          done.push(`${label}=${want ? '勾选' : '取消'}`);
        } else if (el.tagName === 'SELECT') {
          applySelect(el, String(f.value ?? f.text));
          done.push(`${label}="${f.value ?? f.text}"`);
        } else {
          const text = String(f.text ?? f.value ?? '');
          applyText(el, text, f.clear !== false);
          done.push(`${label}=${receipt(el, text)}`);
        }
      } catch (e) {
        failed.push(`${f.ref || f.selector}: ${e.message}`);
      }
    }

    let submitted = '';
    if (p.submit && !failed.length) {
      // 有字段没填成还照样提交，等于替用户交了一份残表——这是不可逆的对外动作。
      const form = document.querySelector('form');
      const btn = p.submitRef
        ? resolve({ ref: p.submitRef, snapshotId: p.snapshotId })
        : document.querySelector('button[type=submit],input[type=submit]');
      if (btn) { btn.click(); submitted = '，已点击提交'; }
      else if (form) { form.requestSubmit?.(); submitted = '，已提交表单'; }
      else submitted = '，但没找到提交按钮';
    } else if (p.submit && failed.length) {
      submitted = '，因有字段失败已跳过提交（不替你交一份残表）';
    }

    invalidate();
    return {
      data: {
        note: `已填 ${done.length}/${fields.length}：${done.join('，')}`
          + (failed.length ? `\n未完成 ${failed.length} 个：${failed.join('；')}` : '')
          + submitted,
      },
    };
  }

  // 输入框和下拉的写入逻辑抽出来，doType / doSelect / doFill 三处共用，
  // 避免「批量填的行为和单个填的行为不一样」这种事后极难查的分叉
  function applyText(el, text, clear) {
    // 目标不是输入框时，原生 value setter 会抛 "Illegal invocation" —— 这句话
    // 对 agent 毫无信息量，它只会换个 ref 继续瞎试。说清楚它到底是什么东西。
    if (!el.isContentEditable && !/^(INPUT|TEXTAREA)$/.test(el.tagName)) {
      throw fail('NOT_INTERACTABLE',
        `目标是 <${el.tagName.toLowerCase()}>${el.getAttribute('role') ? ` role=${el.getAttribute('role')}` : ''}，不是输入框，写不进文字。`
        + `多半是快照过期了（页面重新渲染后编号会变），重新 snapshot 再取 ref。`);
    }
    if (el.tagName === 'INPUT' && /^(file|checkbox|radio|submit|button|image|reset)$/i.test(el.type)) {
      throw fail('NOT_INTERACTABLE',
        el.type === 'file'
          ? '这是文件选择框，写字符串不会有任何反应（浏览器不允许）。用 upload 工具。'
          : `这是 ${el.type} 类型的 input，不能写文字。复选/单选用 fill 的 check 参数，按钮用 click。`);
    }
    el.focus();
    if (el.isContentEditable) {
      if (clear) el.textContent = '';
      document.execCommand('insertText', false, text);
      return;
    }
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, clear ? text : (el.value || '') + text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function applySelect(el, value) {
    const opt = [...el.options].find((o) => o.value === value || o.text.trim() === value);
    // 元素找得好好的，是这个**选项值**不存在——补救动作是从下面列出的可选项里
    // 换一个，不是重新 snapshot。所以不能用 REF_NOT_FOUND。
    if (!opt) throw fail('NO_MATCH', `没有这个选项：${value}。可选：${[...el.options].map((o) => o.text).join(' | ')}`);
    el.value = opt.value;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // 回执会进 agent 的上下文，也会落进审计日志，所以不能原样回显输入。
  //
  // 只按长度截断是不够的——真实密码常常正好十来个字符，一个 12 位的密码
  // 会完完整整地印在回执里。**密码要按输入框类型判断，跟长度无关。**
  const SECRET_HINT = /pass|pwd|secret|token|cvv|captcha|verif|code|otp|密码|验证码/i;

  function receipt(el, text) {
    const t = (el.type || '').toLowerCase();
    const name = `${el.name || ''} ${el.id || ''} ${el.getAttribute('autocomplete') || ''}`;
    if (t === 'password' || SECRET_HINT.test(name)) return `<已填 ${text.length} 位，内容不回显>`;
    return `"${text.length > 20 ? text.slice(0, 10) + '…' : text}"`;
  }

  // ---------- 键盘 ----------
  //
  // 这里有一件必须先讲清楚的事，否则整个实现都会写错：
  // **合成的 KeyboardEvent 不产生任何默认行为。** isTrusted:false 的事件浏览器
  // 只负责派发给监听器，不会真的移动焦点、不会提交表单、不会插入字符、不会关弹窗。
  //
  // 所以「按 Tab」这类命令必须做两件事：① 派发事件，让页面的监听器听到；
  // ② 自己把默认行为补上。只做 ① 的实现在简单页面上「看起来能用」——因为那些页面
  // 恰好自己监听了 keydown；一碰到依赖浏览器原生行为的表单就静默失效。
  //
  // 补默认行为之前要先看监听器有没有 preventDefault：页面既然拦了，就该按它说的办。

  const KEYCODES = {
    Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, ' ': 32,
    ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39,
    Home: 36, End: 35, PageUp: 33, PageDown: 34,
  };
  // 老站（尤其国内的）到今天还在读 e.keyCode，缺了它们的 Enter 分支根本不触发
  const keyCodeOf = (k) => KEYCODES[k] ?? (k.length === 1 ? k.toUpperCase().charCodeAt(0) : 0);

  const FOCUSABLE = 'a[href],button,input,select,textarea,[tabindex],[contenteditable=""],[contenteditable="true"]';

  function focusables() {
    return [...document.querySelectorAll(FOCUSABLE)].filter(
      (el) => !el.disabled && el.tabIndex >= 0 && isVisible(el));
  }

  const MOD_NAMES = new Set(['ctrl', 'control', 'shift', 'alt', 'option', 'meta', 'cmd', 'command']);

  // "Escape" / "ctrl+a" / "Shift+Tab" 都认。写成 ctrl+a 比另开一个 mods 数组顺手得多，
  // 而 agent 生成 "ctrl+a" 的概率远高于生成 {key:"a", mods:["ctrl"]}——就着它的习惯来。
  function parseKey(spec, extraMods = []) {
    const parts = String(spec).split('+');
    const key = parts.pop();
    const mods = parts
      .map((m) => m.trim().toLowerCase())
      .filter((m) => MOD_NAMES.has(m))
      .map((m) => ({ control: 'ctrl', option: 'alt', cmd: 'meta', command: 'meta' }[m] || m));
    // "+" 自己被当成键的情况：split 后 key 为空
    return { key: key || '+', mods: [...new Set([...mods, ...extraMods])] };
  }

  function doKey(p) {
    // 一次调用按一串键。不给这条路，agent 想按 Tab Tab Enter 就要来回三趟，
    // 而且每趟都被强制重拍快照——三倍延迟、三倍 token，换来的信息量是零。
    const specs = Array.isArray(p.key) ? p.key : [p.key];
    if (!specs.length || !specs[0]) throw fail('INTERNAL', 'key 参数不能为空');

    // 指名目标的 key 在 locate 那一步已经给过光标坐标了；无目标的（Esc、
    // 全局快捷键）光标原地按一下就行
    if (!p.ref && !p.selector && !p.find) window.__hcCursor?.(null, null, 'key');
    const target0 = (p.ref || p.selector) ? resolve(p) : null;
    target0?.focus?.();

    const notes = [];
    for (const spec of specs) {
      // 序列里每一步都重新取焦点元素——Tab 之后焦点已经变了，
      // 抓着第一次的 target 不放，后面的键就全打在错的元素上。
      //
      // 但 focus() 不是总能成功：没有 tabindex 的 div 按钮调 focus() 是空操作，
      // activeElement 仍是 body，键就打到了 body 上。指名道姓要的那个元素优先。
      const live = document.activeElement;
      const target = (target0 && (live === target0 || live === document.body || !live))
        ? target0
        : (live || document.body);
      notes.push(pressOne(parseKey(spec, (p.mods || []).map((m) => m.toLowerCase())), target, p));
    }
    invalidate();
    return { data: { note: notes.join('；') } };
  }

  function pressOne({ key, mods }, target, p) {
    const init = {
      key, code: p.code || (key.length === 1 ? `Key${key.toUpperCase()}` : key),
      keyCode: keyCodeOf(key), which: keyCodeOf(key),
      ctrlKey: mods.includes('ctrl'), shiftKey: mods.includes('shift'),
      altKey: mods.includes('alt'), metaKey: mods.includes('meta'),
      bubbles: true, cancelable: true, composed: true,
    };

    const times = Math.min(Math.max(Number(p.repeat) || 1, 1), 50);
    let defaultPrevented = false;
    let acted = '';

    for (let i = 0; i < times; i++) {
      const down = new KeyboardEvent('keydown', init);
      const ok = target.dispatchEvent(down);
      defaultPrevented = !ok;
      // keypress 早已废弃，但仍有一批老站只监听它
      if (ok && key.length === 1) target.dispatchEvent(new KeyboardEvent('keypress', init));
      if (ok) acted = emulateDefault(target, key, mods) || acted;
      target.dispatchEvent(new KeyboardEvent('keyup', init));
    }

    const combo = [...mods, key].join('+') + (times > 1 ? ` ×${times}` : '');
    return defaultPrevented
      ? `${combo}（页面拦下了默认行为，说明它自己接管了这个键）`
      : `${combo}${acted ? ` → ${acted}` : ''}`;
  }

  // 把浏览器本该做、但合成事件不会做的那部分补上。返回一句描述，没补就返回空。
  function emulateDefault(el, key, mods) {
    const editable = el.isContentEditable ||
      (el.tagName === 'INPUT' && !/^(checkbox|radio|button|submit|file)$/i.test(el.type)) ||
      el.tagName === 'TEXTAREA';

    if (key === 'Tab') {
      const list = focusables();
      const at = list.indexOf(el);
      const next = list[(at + (mods.includes('shift') ? -1 : 1) + list.length) % (list.length || 1)];
      if (!next) return '页面上没有可聚焦元素';
      next.focus();
      return `焦点移到 ${describeEl(next)}`;
    }

    if (key === 'Enter') {
      if (/^(BUTTON|A|SUMMARY)$/.test(el.tagName) || el.getAttribute('role') === 'button') {
        el.click();
        return '触发了点击';
      }
      const form = el.closest?.('form');
      if (form && el.tagName === 'INPUT') {
        form.requestSubmit?.();
        return '提交了表单';
      }
      return '';
    }

    if (key === ' ' && (/^(BUTTON|SUMMARY)$/.test(el.tagName) ||
        (el.tagName === 'INPUT' && /^(checkbox|radio)$/i.test(el.type)) ||
        el.getAttribute('role') === 'button' || el.getAttribute('role') === 'checkbox')) {
      el.click();
      return '触发了点击';
    }

    if (key === 'Escape') {
      // <dialog open> 和 <details open> 的 Esc 关闭是浏览器行为，合成事件到不了
      const dlg = document.querySelector('dialog[open]');
      if (dlg) { dlg.close?.(); return '关闭了 <dialog>'; }
      return '';
    }

    if (editable && (key === 'Backspace' || key === 'Delete')) {
      if (el.isContentEditable) {
        document.execCommand(key === 'Backspace' ? 'delete' : 'forwardDelete');
      } else {
        const v = el.value || '';
        const s = el.selectionStart ?? v.length, e = el.selectionEnd ?? v.length;
        const [from, to] = s !== e ? [s, e] : key === 'Backspace' ? [Math.max(0, s - 1), s] : [s, s + 1];
        setNativeValue(el, v.slice(0, from) + v.slice(to));
        el.setSelectionRange?.(from, from);
      }
      return '删除了字符';
    }

    if (editable && mods.includes('ctrl') && key.toLowerCase() === 'a') {
      el.select?.();
      return '全选';
    }

    // 可打印字符：合成事件不会插入，得自己写进去
    if (editable && key.length === 1 && !mods.includes('ctrl') && !mods.includes('meta')) {
      if (el.isContentEditable) document.execCommand('insertText', false, key);
      else {
        const v = el.value || '';
        const s = el.selectionStart ?? v.length, e = el.selectionEnd ?? v.length;
        setNativeValue(el, v.slice(0, s) + key + v.slice(e));
        el.setSelectionRange?.(s + 1, s + 1);
      }
      return '插入了字符';
    }

    return '';
  }

  // 绕过 React/Vue 受控组件必须走原生 setter，doType 里也是这个道理
  function setNativeValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }

  const describeEl = (el) =>
    `${el.tagName.toLowerCase()}${el.name ? `[name=${el.name}]` : ''}` +
    `${el.placeholder ? ` "${el.placeholder}"` : ''}`;

  // 等到「能干活」，而不是「连最后一张广告图都下完」。
  //
  // background 原先等的是 chrome.tabs 的 status === 'complete'，而 Chrome 对这个
  // 状态的定义是 **load 事件**：所有子资源下载完毕。实测知乎 domInteractive 5.1 秒、
  // loadEventEnd 20.3 秒——中间那 15 秒白等，而 agent 要的东西 5 秒时就能点了。
  //
  // 更麻烦的是它**同时又太早**：SPA 的首屏是 DOMContentLoaded 之后才渲染的，
  // 所以原先还要跟一句 sleep(300) 去糊。300ms 对 SPA 不够、对静态页纯属浪费，
  // 于是日志里 navigate → wait 这个组合出现了 38 次——等了三秒半，
  // agent 还得自己再等一次。
  //
  // 换成两段，各自对着一个真问题：先等 DOM 能用，再等它安静下来。
  async function doReady(p) {
    if (document.readyState === 'loading') {
      await new Promise((r) => document.addEventListener('DOMContentLoaded', r, { once: true }));
    }
    const quiet = Math.max(Number(p.quiet) || 300, 50);
    // 硬上限必须卡死：直播弹幕、行情页永远等不到「完全没有 DOM 变化」，
    // 不设上限的话它们会一路跑满预算，反而比原来的等法更慢。
    const budget = Math.min(Math.max(Number(p.budget) || 1500, quiet), 1500);
    const quieted = await new Promise((resolve) => {
      let quietTimer = null;
      const hard = setTimeout(() => done(false), budget);
      const mo = new MutationObserver((records) => {
        // 只有**成规模**的 DOM 增长才说明首屏还在渲染。
        //
        // 判「完全静默」的那版在两类页面上一起垮掉：靶场自带事件记录仪、
        // 真实站点有时钟和弹幕——它们每几十毫秒往 DOM 里追加一两个节点，
        // 于是计时器永远被重置，每次都跑满预算。实测把本地靶场的用例
        // 从 1.8 秒拖到 10.5 秒，比它取代掉的那套还慢。
        //
        // 而这两件事的区别是规模：自娱自乐是一两个节点，首屏渲染是几十上百个。
        let added = 0;
        for (const r of records) added += r.addedNodes.length;
        if (added < 5) return;
        clearTimeout(quietTimer);
        quietTimer = setTimeout(() => done(true), quiet);
      });
      mo.observe(document.documentElement, { childList: true, subtree: true });
      quietTimer = setTimeout(() => done(true), quiet);
      function done(ok) {
        clearTimeout(quietTimer);
        clearTimeout(hard);
        mo.disconnect();
        resolve(ok);
      }
    });
    return { data: { ready: true, quieted } };
  }

  async function doWait(p) {
    const timeout = p.timeout || 10000;
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (p.for === 'selector' && document.querySelector(p.value)) return { data: { text: `已出现：${p.value}` } };
      if (p.for === 'text' && document.body.innerText.includes(p.value)) return { data: { text: `已出现文字：${p.value}` } };
      if (p.for === 'idle' && document.readyState === 'complete') {
        await sleep(500);
        return { data: { text: '页面已加载完成' } };
      }
      await sleep(200);
    }
    throw fail('TIMEOUT', `等待超时（${timeout}ms）：${p.for} ${p.value || ''}`);
  }

  // 滚动。懒加载列表拿不全的唯一解——但真要抓整份数据，先试 network/fetch，
  // 那边一次就能拿完，比在这儿滚四十次靠谱。
  function scrollBoxes(selector) {
    if (selector) return [...document.querySelectorAll(selector)];
    // 只挑最大的那个容器是错的：页面常有好几个嵌套滚动区，猜错了就是「滚了但没反应」。
    // 全滚一遍，成本可以忽略，省掉 agent 反复试探。
    return [...document.querySelectorAll('*')]
      .filter((e) => e.scrollHeight > e.clientHeight + 200 && /auto|scroll/.test(getComputedStyle(e).overflowY))
      .sort((a, b) => b.scrollHeight - a.scrollHeight)
      .slice(0, 6);
  }

  const describe = (e) =>
    `${e.tagName.toLowerCase()}${e.className ? '.' + String(e.className).trim().split(/\s+/)[0] : ''}(${e.scrollHeight})`;

  async function doScroll(p) {
    window.__hcCursor?.(null, null, 'scroll');   // 光标原地顺势一沉，示意在滚
    const times = Math.min(p.times || 1, 50);
    if (p.ref) {
      resolve(p).scrollIntoView({ block: 'center' });
      await sleep(p.wait || 500);
      return { data: { text: `已滚动到 [${p.ref}]` } };
    }

    const boxes = scrollBoxes(p.selector);
    const height = () => document.body.scrollHeight + boxes.reduce((n, b) => n + b.scrollHeight, 0);
    const top = p.to === 'top';

    let last = -1, stable = 0, grew = false;
    const started = height();
    for (let i = 0; i < times; i++) {
      const before = height();
      window.scrollTo(0, top ? 0 : document.body.scrollHeight);
      for (const b of boxes) b.scrollTop = top ? 0 : b.scrollHeight;

      // 这三行的每一行都对应一类「滚到底了却不加载」：
      //
      // ① wheel —— 虚拟列表常常只监听滚轮，不监听 scroll。
      // ② 往**每个容器**派发 scroll —— 关键的一条。改 scrollTop 本该由浏览器
      //    自动派发 scroll 事件，但**后台标签页不产生渲染帧，这个事件根本不会发**。
      //    实测：scrollTop 从 0 变到 298，scroll 事件计数是 0；手动派发一次，
      //    懒加载立刻补货。而「不抢用户焦点」是这个产品的硬规则，
      //    所以后台能滚动这件事必须自己兜住。
      // ③ window 上再补一次 —— 有些页面把监听挂在 window/document 上。
      const wheel = () => new WheelEvent('wheel', { deltaY: top ? -600 : 600, bubbles: true, cancelable: true });
      for (const b of boxes) {
        b.dispatchEvent(wheel());
        b.dispatchEvent(new Event('scroll'));   // scroll 在元素上不冒泡，必须逐个发
      }
      document.body.dispatchEvent(wheel());
      window.dispatchEvent(new Event('scroll'));
      document.dispatchEvent(new Event('scroll'));
      // 等这一轮的内容落地。原先是无条件 sleep(700)——而懒加载多数在
      // 100–300ms 内就补货了，后面那几百毫秒纯属白等，滚十次就是好几秒。
      // 改成轮询：高度一长就立刻进下一轮，只有真没动静时才等满预算。
      // 这和 settle 采效果证据是同一个思路，「更快」和「更稳」在这里是一件事：
      // 页面慢的时候它等得比原来久（到底判定更准），快的时候它早走。
      const budget = p.wait || 700;
      const deadline = Date.now() + budget;
      while (Date.now() < deadline) {
        await sleep(80);
        if (height() > before) break;   // 长出来了就说明这一轮的货已经补上
      }
      const h = height();
      if (h > started) grew = true;
      // 连续两轮没长才算到底：懒加载常有一轮的延迟，只判一次会提前收手
      if (h === last) { if (++stable >= 2) return { data: { text: `滚到底了（第 ${i + 1} 次，高度稳定在 ${h}）\n滚动容器：${boxes.map(describe).join(', ') || '仅 window'}` } }; }
      else stable = 0;
      last = h;
    }
    return {
      data: {
        text: `已滚动 ${times} 次，总高度 ${last}\n滚动容器：${boxes.map(describe).join(', ') || '仅 window'}\n`
          + (boxes.length ? '' : '（没找到内部滚动容器——若列表没加载出更多，用 selector 参数指定容器）\n')
          + (grew ? '' :
            '⚠️ 高度一直没变。可能是：① times 太小（默认只滚 1 次，要加载更多得传 times:10 这样的值）；'
            + '② 这个列表用 IntersectionObserver 判断加载时机，而后台标签页不产生渲染帧，'
            + '观察器不会回调——这时只能传 focus:true 把标签页切到前台（会打断用户）；'
            + '③ 本来就没有更多内容了。'),
      },
    };
  }

  // 文件上传。网页只认「用户选了文件」这个事件，而扩展碰不到系统文件对话框——
  // 唯一的路是自己造一个 File，塞进 input.files 再触发 change。
  // DataTransfer 是唯一能合法给 FileList 赋值的方式。
  function doUpload(p) {
    const bin = atob(p.base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const file = new File([bytes], p.name, { type: p.type || 'application/octet-stream' });

    // 调用方明确给了 dropSelector，就是明确要走拖放——哪怕页面上另有 file input。
    // 不尊重这个意图的话，参数给了却没生效，而返回值还说「已投入」，
    // 是最难查的那种失败。
    if (p.dropSelector) return dropFile(file, p, bytes.length);

    // 优先用调用方指定的 input；否则找页面上第一个能收这类文件的
    const input = p.selector
      ? document.querySelector(p.selector)
      : [...document.querySelectorAll('input[type=file]')].find((el) => {
          const acc = el.getAttribute('accept') || '';
          return !acc || acc.split(',').some((a) => {
            a = a.trim();
            return a === '*/*' || (a.endsWith('/*') ? (p.type || '').startsWith(a.slice(0, -1)) : (a.startsWith('.') ? p.name.toLowerCase().endsWith(a) : a === p.type));
          });
        });
    // 没有 file input 不等于不能上传：越来越多的编辑器（X 的 Article、Notion、语雀）
    // 只监听拖放，页面上根本不存在 <input type=file>。之前这里直接报错，
    // 等于把「往文章里插图」这一整类任务判了死刑。
    if (!input || (input.tagName !== 'INPUT' && !p.selector)) return dropFile(file, p, bytes.length);
    if (input.tagName !== 'INPUT') return dropFile(file, p, bytes.length, input);

    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return { data: { text: `已投入 ${p.name}（${Math.round(bytes.length / 1024)}KB）到 ${input.getAttribute('accept') ? 'accept="' + input.getAttribute('accept') + '"' : ''} input` } };
  }

  // 拖放上传。要点是**整套事件都要发**：只发 drop 的话，很多实现在 dragover 里
  // 才调 preventDefault 来「认领」这次拖放，没有它 drop 会被当成浏览器的默认行为
  // （在新标签页打开这个文件）而不是页面的上传。
  function dropFile(file, p, bytes, hinted) {
    const target = hinted
      || (p.dropSelector && document.querySelector(p.dropSelector))
      || document.querySelector('[class*="drop" i],[class*="upload" i],[contenteditable="true"],[role="textbox"]')
      || document.activeElement
      || document.body;
    if (!target) {
      throw fail('REF_NOT_FOUND',
        '页面上既没有 file input，也找不到可以拖放的目标。先点开上传入口让它出现，'
        + '或用 selector（指定 input）/ dropSelector（指定拖放区）明确告诉我往哪儿放。');
    }

    const dt = new DataTransfer();
    dt.items.add(file);
    const ev = (type) => {
      const e = new DragEvent(type, { bubbles: true, cancelable: true, composed: true, dataTransfer: dt });
      target.dispatchEvent(e);
      return e;
    };
    ev('dragenter');
    const over = ev('dragover');
    ev('drop');
    return {
      data: {
        text: `已把 ${p.name}（${Math.round(bytes / 1024)}KB）拖放到 ${target.tagName.toLowerCase()}`
          + `${target.className ? '.' + String(target.className).trim().split(/\s+/)[0] : ''}。`
          + (over.defaultPrevented
            ? '页面接管了这次拖放（dragover 被 preventDefault），说明目标选对了。'
            : '⚠️ 页面没有接管 dragover——多半拖错了地方，用 dropSelector 指定真正的拖放区。'),
      },
    };
  }

  // 结构化提取。存在的理由：eval 在有 CSP 的站点上直接废掉（小红书就禁了 unsafe-eval），
  // 而 read_text 会把表格的各列文本拼成「362223585554365」这种无法拆分的数字串。
  // selector 是数据不是代码，CSP 管不着它。
  // 按文本找元素。审计里 eval→eval 542 次，相当一部分是 TreeWalker 找「含某文本的
  // 节点」——读状态、验证某个值渲染出来没有、找自定义下拉里的某个选项。
  // 那些节点多半不可交互（span/td/h2），快照收不到、find 也只看交互池，
  // 所以这里单开一条路：返回能定位它的 selector 路径和它的文本，
  // 以及它在哪个已编号元素里面（有的话），agent 下一步直接能点。
  function cssPath(el) {
    const parts = [];
    for (let n = el, i = 0; n && n.nodeType === 1 && n !== document.body && i < 6; n = n.parentElement, i++) {
      if (n.id && /^[A-Za-z][\w-]*$/.test(n.id)) { parts.unshift(`#${CSS.escape(n.id)}`); break; }
      let s = n.tagName.toLowerCase();
      const sib = n.parentElement ? [...n.parentElement.children].filter((c) => c.tagName === n.tagName) : [];
      if (sib.length > 1) s += `:nth-of-type(${sib.indexOf(n) + 1})`;
      parts.unshift(s);
    }
    return parts.join(' > ');
  }

  function refOfAncestor(el) {
    for (const [r, rec] of refMap) if (rec.el === el || rec.el?.contains?.(el)) return r;
    return '';
  }

  function queryByText(p) {
    const want = norm(p.contains).toLowerCase();
    if (!want) throw fail('INTERNAL', 'contains 不能为空');
    const limit = Math.min(Number(p.limit) || 20, 100);
    const roots = p.selector ? [...document.querySelectorAll(p.selector)] : [document.body];
    const hits = [];
    outer: for (const root of roots) {
      // 输入框的值不在文本节点里，单独看一眼
      for (const el of root.querySelectorAll('input,textarea')) {
        if (String(el.value || '').toLowerCase().includes(want) && isVisible(el, undefined, true)) hits.push(el);
        if (hits.length >= limit) break outer;
      }
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode;
        if (!norm(node.nodeValue).toLowerCase().includes(want)) continue;
        const el = node.parentElement;
        if (!el || /^(SCRIPT|STYLE|NOSCRIPT)$/.test(el.tagName) || !isVisible(el, undefined, true)) continue;
        if (!hits.includes(el)) hits.push(el);
        if (hits.length >= limit) break outer;
      }
    }
    if (!hits.length) return { data: { untrusted: true, text: `页面上没有可见的「${p.contains}」（不查 shadow DOM 与 iframe 内部）` } };
    const lines = hits.map((el) => {
      const t = (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' ? el.value : el.innerText || '').replace(/\s+/g, ' ').trim();
      const role = roleOf(el);
      const st = INTERACTIVE_TAGS.has(el.tagName) || el.getAttribute('role') ? stateOf(el, role) : '';
      const within = refOfAncestor(el);
      return `${cssPath(el)}${st}  "${t.length > 160 ? t.slice(0, 160) + '…' : t}"${within ? `  ← 在 [${within}] 内` : ''}`;
    });
    return { data: { untrusted: true, text: `${hits.length} 处含「${p.contains}」（selector 路径 · 文本 · 所在的已编号元素）：\n${lines.join('\n')}` } };
  }

  // 读一个元素的状态/文本。act 的 read 步走这里：批处理以前只能「做」不能「看」，
  // 中间想读一眼就得回模型一趟。目标可以是 ref / find / selector；
  // 没给目标只给 contains 时退化成按文本找。
  function doRead(p) {
    if (!p.ref && !p.find && !p.selector) return queryByText({ ...p, limit: p.limit || 10 });
    let el = null;
    if (p.find) {
      try { el = findEl(p.find); } catch (e) {
        // 交互池里没有，可能是一段静态文本——按名字当文本再找一次
        if (p.find.name && !p.find.role) return queryByText({ contains: p.find.name, limit: 5 });
        throw e;
      }
    } else if (p.selector) el = document.querySelector(p.selector);
    else el = refMap.get(p.ref)?.el;
    if (!el || !el.isConnected) throw fail('REF_NOT_FOUND', `找不到 ${p.ref || p.selector}`);
    const role = roleOf(el);
    const bits = [`${role} "${accessibleName(el)}"${stateOf(el, role)}${isVisible(el, undefined, true) ? '' : ' (不可见)'}`];
    if (p.attr) bits.push(`${p.attr}: ${JSON.stringify(readAttr(el, p.attr))}`);
    const text = (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' ? '' : el.innerText || '').replace(/\s+/g, ' ').trim();
    if (text) bits.push(`text: "${text.length > 400 ? text.slice(0, 400) + '…' : text}"`);
    return { data: { untrusted: true, text: bits.join('\n') } };
  }

  function doQuery(p) {
    if (p.contains) return queryByText(p);
    if (!p.selector) throw fail('INTERNAL', 'query 需要 selector 或 contains');
    const nodes = [...document.querySelectorAll(p.selector)].slice(0, p.limit || 100);
    if (p.html) {
      return { data: { untrusted: true, text: nodes.map((el, i) => `--- [${i}] ---\n` + el.outerHTML.slice(0, p.html === true ? 1200 : p.html)).join('\n\n') } };
    }
    const rows = nodes.map((el) => {
      if (!p.extract) return (el.innerText || '').replace(/\s+/g, ' ').trim();
      const row = {};
      for (const [key, spec] of Object.entries(p.extract)) {
        const [sel, attr] = String(spec).split('@');           // ".cls@href" → 取属性；省略则取文本
        const target = !sel || sel === '.' ? el : el.querySelector(sel);
        row[key] = !target ? null : attr ? readAttr(target, attr)
          : (target.innerText || '').replace(/\s+/g, ' ').trim();
      }
      return row;
    });
    return { data: { untrusted: true, text: JSON.stringify(rows, null, 1) } };
  }

  // value / checked 必须读**属性**（property）而不是**特性**（attribute）：
  // getAttribute('value') 拿到的是 HTML 里写死的初始值，用户填过、脚本改过都不算。
  // 抓一张已经填好的表，用 getAttribute 会静默地全返回空——而「空」看着像
  // 「这个字段本来就没填」，没有任何迹象说明是取错了。
  function readAttr(el, attr) {
    if (attr === 'value') return el.value ?? el.getAttribute('value');
    if (attr === 'checked') return el.checked ?? el.hasAttribute('checked');
    if (attr === 'text') return (el.innerText || '').replace(/\s+/g, ' ').trim();
    return el.getAttribute(attr);
  }

  // 页面变了就作废快照 —— SPA 路由跳转不触发 load，只能自己钩
  function invalidate() { /* 留给下一次 snapshot 递增；此处不清空，click 后 background 会立刻重拍 */ }
  for (const m of ['pushState', 'replaceState']) {
    const orig = history[m];
    history[m] = function (...a) { snapshotId = null; refMap.clear(); return orig.apply(this, a); };
  }
  window.addEventListener('popstate', () => { snapshotId = null; refMap.clear(); });

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------- 消息入口 ----------

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || !msg.__hc) return;
    (async () => {
      try {
        switch (msg.__hc) {
          case 'ping': return sendResponse({ pong: true });
          case 'snapshot': return sendResponse({ data: buildSnapshot() });
          case 'locate': return sendResponse({ data: await doLocate(msg) });
          // ask 要高亮的目标可能是 ref（只有这里的 refMap 认得），而高亮画在
          // ask-overlay 那一侧。打个临时属性当交接凭证，用完就摘。
          case 'markTargets': {
            const selectors = [];
            (msg.targets || []).forEach((t, i) => {
              let el = null;
              try { el = refMap.get(t)?.el || document.querySelector(t); } catch { /* 不是合法 selector */ }
              if (!el) return;
              el.setAttribute('data-hc-mark', String(i));
              selectors.push(`[data-hc-mark="${i}"]`);
            });
            return sendResponse({ data: { selectors } });
          }
          case 'unmarkTargets':
            document.querySelectorAll('[data-hc-mark]').forEach((el) => el.removeAttribute('data-hc-mark'));
            return sendResponse({ data: { ok: true } });
          case 'payGuard':
            if (msg.on) { armPayGuard(); return sendResponse({ data: { armed: true } }); }
            return sendResponse({ data: { blocked: disarmPayGuard() } });
          case 'effect': return sendResponse({ data: doEffect(msg) });
          case 'click': return sendResponse(await doClick(msg));
          case 'type': return sendResponse(doType(msg));
          case 'select': return sendResponse(doSelect(msg));
          case 'fill': return sendResponse(doFill(msg));
          case 'key': return sendResponse(doKey(msg));
          case 'ready': return sendResponse(await doReady(msg));
          case 'wait': return sendResponse(await doWait(msg));
          case 'query': return sendResponse(doQuery(msg));
          case 'read': return sendResponse(doRead(msg));
          case 'upload': return sendResponse(doUpload(msg));
          case 'scroll': return sendResponse(await doScroll(msg));
          case 'history':
            if (msg.action === 'back') history.back();
            else if (msg.action === 'forward') history.forward();
            else location.reload();
            return sendResponse({ data: { text: 'ok' } });
          case 'read_text':
            return sendResponse({
              data: {
                untrusted: true,
                meta: `url="${location.href}"`,
                text: `# ${document.title}\n${location.href}\n\n` + (msg.format === 'text' ? mainText() : toMarkdown()),
              },
            });
          default:
            return sendResponse({ error: { code: 'INTERNAL', message: '未知指令 ' + msg.__hc } });
        }
      } catch (e) {
        sendResponse({ error: { code: e.code || 'INTERNAL', message: e.message } });
      }
    })();
    return true; // 异步响应
  });
})();
