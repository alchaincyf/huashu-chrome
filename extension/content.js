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

  const INTERACTIVE_TAGS = new Set(['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'SUMMARY']);
  const INTERACTIVE_ROLES = new Set(['button', 'link', 'checkbox', 'radio', 'tab', 'menuitem', 'menuitemcheckbox', 'combobox', 'textbox', 'switch', 'option', 'searchbox']);

  // ---------- 可见性 ----------

  // getComputedStyle 是这里最贵的一次调用，可见性和可交互性共用它，别调两遍
  function isVisible(el, s = getComputedStyle(el)) {
    if (!el.isConnected) return false;
    if (s.visibility === 'hidden' || s.display === 'none' || Number(s.opacity) < 0.02) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    // 视口外但能滚动到的，算可见——列表页大量元素在下面
    if (r.bottom < -window.innerHeight * 2 || r.top > window.innerHeight * 3) return false;
    return true;
  }

  function isInteractive(el, s) {
    if (el.disabled) return false;
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

  // 状态后缀：让 agent 一眼看出「填没填」「勾没勾」，省掉一轮试探
  function stateOf(el, role) {
    const bits = [];
    if (role === 'checkbox' || role === 'radio' || role === 'switch') {
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
      bits.push(v ? `value: "${v.length > 40 ? v.slice(0, 40) + '…' : v}"` : 'empty');
    }
    if (role === 'combobox' && el.tagName === 'SELECT') {
      bits.push(`selected: "${el.options[el.selectedIndex]?.text || ''}"`);
      const opts = [...el.options].slice(0, 8).map((o) => o.text).join(' | ');
      if (opts) bits.push(`options: ${opts}${el.options.length > 8 ? ' …' : ''}`);
    }
    if (el.getAttribute('aria-expanded')) bits.push(`expanded: ${el.getAttribute('aria-expanded')}`);
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') bits.push('disabled');
    return bits.length ? ` (${bits.join(', ')})` : '';
  }

  // ---------- 快照 ----------

  function buildSnapshot() {
    refMap = new Map();
    snapshotId = 's' + ++snapshotSeq;

    // 一阶段：收候选。同时遍历 open shadow root —— 现在大量站点把控件塞在里面
    const cands = [];
    const walk = (root) => {
      for (const el of root.querySelectorAll('*')) {
        if (el.shadowRoot) walk(el.shadowRoot);
        const s = getComputedStyle(el);
        if (!isInteractive(el, s) || !isVisible(el, s)) continue;
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
        if (cands.length >= 400) return; // 极端长页的护栏
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

    const lines = [];
    let n = 0;
    for (const { el } of keep) {
      const role = roleOf(el);
      const name = accessibleName(el);
      if (!name && role === 'button') continue; // 无名按钮多半是装饰性图标，滤掉省 token
      const ref = 'e' + ++n;
      refMap.set(ref, el);
      lines.push(`[${ref}]  ${role.padEnd(9)} "${name}"${stateOf(el, role)}`);
      if (n >= 300) break;
    }

    const excerpt = mainText().slice(0, 1500);
    const alerts = collectAlerts();
    const header = `# ${document.title} — ${location.href}\n[snapshot ${snapshotId}] ${n} 个可交互元素\n`
      + (alerts.length ? `\n⚠️ 页面提示：\n${alerts.map((a) => '  · ' + a).join('\n')}\n` : '');
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
    clone.querySelectorAll('script, style, nav, header, footer, aside, noscript, svg, form, iframe, [aria-hidden="true"]').forEach((n) => n.remove());
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

  function resolve(p) {
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
    const el = refMap.get(p.ref);
    if (!el) throw fail('REF_NOT_FOUND', `快照里没有 ${p.ref}`);
    if (!el.isConnected) throw fail('REF_NOT_FOUND', `${p.ref} 已从页面移除，重新 snapshot`);
    if (!isVisible(el)) throw fail('NOT_INTERACTABLE', `${p.ref} 当前不可见`);
    if (el.disabled) throw fail('NOT_INTERACTABLE', `${p.ref} 处于 disabled 状态`);
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

  async function doLocate(p) {
    // fill 这类没有单一目标的操作只要基线，不要定位
    if (p.baselineOnly) return { baseline: await baselineOf(null) };
    const el = resolve(p);
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;

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

  function targetState(el) {
    if (!el || !el.isConnected) return { gone: true };
    return {
      expanded: el.getAttribute('aria-expanded') ?? '',
      checked: String(el.checked ?? el.getAttribute('aria-checked') ?? ''),
      selected: el.getAttribute('aria-selected') ?? '',
      value: String(el.value ?? '').slice(0, 120),
      cls: String(el.className?.baseVal ?? el.className ?? '').slice(0, 200),
    };
  }

  // textContent 而不是 innerText：innerText 会触发 reflow，而这个函数在
  // 一次操作里最多要跑十几遍。只比长度的话 textContent 足够，且便宜一个量级。
  const cheapStats = () => ({
    els: document.getElementsByTagName('*').length,
    textLen: (document.body?.textContent || '').length,
    active: activeDesc(),
    bodyKids: document.body?.children.length ?? 0,
  });

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

  function scopeOf(el) {
    if (!el || !el.isConnected) return null;
    const box = el.closest(SCOPE_SEL) || el.parentElement || document.body;
    return { len: (box.textContent || '').length, kids: box.getElementsByTagName('*').length };
  }

  // 采基线时顺便测一下「页面自己动不动」。
  //
  // 不做这一步，动态页面上的证据全是假的：实测点一个什么都没绑的按钮，
  // 返回「效果：正文 -4 字」——那 4 个字是页面自己的懒加载列表在填充，
  // 跟这次点击毫无关系。而 agent 读到「有效果」就会以为操作成功了。
  //
  // 代价是每个写操作多 60ms。换来的是「报告可信」，值这个价——
  // 何况早停之后总耗时通常还是比原来固定的 400ms 短。
  async function baselineOf(el) {
    const s1 = cheapStats();
    await sleep(60);
    const s2 = cheapStats();
    const volatile = Math.abs(s2.els - s1.els) >= 3 || Math.abs(s2.textLen - s1.textLen) >= 4;
    return { ...s2, volatile, alerts: collectAlerts(), target: targetState(el), scope: scopeOf(el) };
  }

  function doEffect(p) {
    const base = p.baseline || {};
    // 目标要能重新找回来，否则 targetState 拿到 null，会把「找不回」误报成
    // 「元素已从页面移除」——而后者是一条很强的证据，误报等于凭空造证据。
    // selector 路径尤其要照顾：它本来就绕过 refMap。
    const el = p.ref ? refMap.get(p.ref)
      : p.selector ? document.querySelector(p.selector)
      : null;
    const now = cheapStats();

    // 证据分强弱。强证据几乎不可能是页面自己动出来的（目标自身的状态、新冒出来的
    // 提示、元素消失）；弱证据（DOM 数量、正文长度、焦点）在直播弹幕、行情、
    // 懒加载列表这类页面上每时每刻都在产生。
    // 页面本身在动时（volatile），只有强证据算数——否则报告就是在编。
    const strong = [], weak = [];
    const parts = weak;

    // 强证据 ①：目标所在区块变了。局部阈值可以定得很低（2 个字符），
    // 因为这块地方的变化几乎不可能是别处的噪声漂过来的。
    const bs = base.scope, ns = scopeOf(el);
    if (bs && ns) {
      const dLen = ns.len - bs.len, dKids = ns.kids - bs.kids;
      if (Math.abs(dLen) >= 2) strong.push(`目标区块文本 ${dLen > 0 ? '+' : ''}${dLen} 字`);
      else if (dKids !== 0) strong.push(`目标区块 DOM ${dKids > 0 ? '+' : ''}${dKids} 节点`);
    }

    // 强证据 ②：body 直接子元素增减。模态框、抽屉、toast 几乎都挂在这一层，
    // 而页面自己的内容更新极少动到 body 的直接子节点。
    const dBodyKids = now.bodyKids - (base.bodyKids ?? now.bodyKids);
    if (dBodyKids !== 0) {
      strong.push(`页面顶层${dBodyKids > 0 ? '新增' : '移除'} ${Math.abs(dBodyKids)} 个元素（多半是浮层/弹窗）`);
    }

    // 阈值挡住噪声：页面上的时钟、轮播、埋点会让 DOM 一直微微地动，
    // 不设阈值就变成「永远有效果」，这个机制也就废了。
    const dEls = now.els - (base.els ?? now.els);
    if (Math.abs(dEls) >= 3) parts.push(`DOM ${dEls > 0 ? '+' : ''}${dEls} 节点`);
    // 阈值定 4 不定 20：实测「未触发」→「已触发（真实事件）」只差 6 字，
    // 阈值 20 会把这次真实的成功判成「页面完全没有反应」。
    //
    // 这两类误判的代价不对称，所以宁可松一点：
    //   假阴性（真动了却说没动）→ 多一次 L2 重试，对非敏感目标是幂等的，代价小；
    //   假阳性（没动却说动了）→ agent 以为成功继续往下走，掩盖真实失败，代价大。
    //
    // 比长度而不比内容，天然挡掉了最常见的一类噪声：时钟和计数器改数字时
    // 长度往往不变（12:34:56 → 12:34:57），根本进不到这里。
    const dText = now.textLen - (base.textLen ?? now.textLen);
    if (Math.abs(dText) >= 4) parts.push(`正文 ${dText > 0 ? '+' : ''}${dText} 字`);
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

    // 目标自身的状态变化不设阈值：它几乎不可能是噪声，而且往往是唯一的证据
    // （展开下拉、勾选、受控组件把值回滚，这三样都不改 DOM 节点数）
    const bt = base.target || {}, nt = targetState(el);
    // 无目标的操作（fill、无 ref 的 key）两边都是 gone，不会走进这条分支
    if (nt.gone && !bt.gone && bt.gone !== undefined) strong.push('目标元素已从页面移除');
    else for (const k of ['expanded', 'checked', 'selected', 'value', 'cls']) {
      if (bt[k] === undefined || bt[k] === nt[k]) continue;
      if (k === 'cls') { strong.push('目标 class 变了'); continue; }
      strong.push(`${k} ${bt[k] || '空'} → ${nt[k] || '空'}`);
    }

    // 新增的页面提示优先级最高——表单流程最主要的失败模式就是校验错误，
    // 而它常在长页面下方，正文节选根本截不到
    const fresh = collectAlerts().filter((a) => !(base.alerts || []).includes(a));
    if (fresh.length) strong.push(`⚠️ 页面提示：${fresh.join(' / ')}`);

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
    return { data: { note: `已点击 [${p.ref || p.selector}]${retry}` } };
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
    return { data: { note: `已在 [${p.ref || p.selector}] 输入${p.submit ? '并回车' : ''}` } };
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
    if (!opt) throw fail('REF_NOT_FOUND', `没有这个选项：${value}。可选：${[...el.options].map((o) => o.text).join(' | ')}`);
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
      await sleep(p.wait || 700);
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
  function doQuery(p) {
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
              try { el = refMap.get(t) || document.querySelector(t); } catch { /* 不是合法 selector */ }
              if (!el) return;
              el.setAttribute('data-hc-mark', String(i));
              selectors.push(`[data-hc-mark="${i}"]`);
            });
            return sendResponse({ data: { selectors } });
          }
          case 'unmarkTargets':
            document.querySelectorAll('[data-hc-mark]').forEach((el) => el.removeAttribute('data-hc-mark'));
            return sendResponse({ data: { ok: true } });
          case 'effect': return sendResponse({ data: doEffect(msg) });
          case 'click': return sendResponse(await doClick(msg));
          case 'type': return sendResponse(doType(msg));
          case 'select': return sendResponse(doSelect(msg));
          case 'fill': return sendResponse(doFill(msg));
          case 'key': return sendResponse(doKey(msg));
          case 'wait': return sendResponse(await doWait(msg));
          case 'query': return sendResponse(doQuery(msg));
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
