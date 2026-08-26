// L2 —— 按需 attach 的真实事件层
//
// 存在理由：content script 派发的事件 isTrusted 永远是 false，而这挡住了四类场景：
// 风控站点的关键动作、自管输入的编辑器（Monaco/CodeMirror/富文本）、原生控件
// （<select> 下拉、日期选择器、文件对话框）、需要用户手势才解锁的 API。
// 这四类不是「再写点代码就能绕过」，是浏览器的设计边界。
//
// 但 attach 会在标签页顶上挂一条「已开始调试此浏览器」的黄带子，所以这一层
// **按需上、用完自动下**：首次 L2 操作 attach，之后粘住，L2_IDLE_MS 内没有
// 新的 L2 操作就自己 detach。一串连续操作 = 一次黄条，几秒后消失。
//
// 全程 attach 是另一条路（BrowserSkill 走的就是这条），代价是黄条常驻。
// 我们的差异点就在这里：同样的可靠性，只在必要的那几秒有黄条。

const L2_IDLE_MS = 5000;
const PROTOCOL = '1.3';

// tabId -> { timer, ready }
const sessions = new Map();

// 弹窗是 L1 完全够不着的东西：alert 一弹，页面 JS 停摆，content script 的
// sendMessage 永远不返回，整条链路卡死到超时。attach 状态下 CDP 仍然活着，
// 所以顺手把它接住——这是 L2 的附带收益里最实用的一条。
const dialogs = new Map();   // tabId -> { type, message, at }

export class L2Unavailable extends Error {
  constructor(reason, code = 'NEEDS_L2') {
    super(reason);
    this.code = code;
  }
}

// ---------- 开关 ----------
//
// 原本想让 debugger 走 optional_permissions，做成「默认安装轻量、用时再授权」。
// **这条路被 Chrome 堵死了**：`debugger` 在不可选权限的清单里
// （同类的还有 geolocation、proxy、declarativeNetRequest 等），
// 放进 optional_permissions 会被静默忽略，chrome.permissions.request() 直接回
// 「Only permissions specified in the manifest may be requested.」
//
// 所以权限只能进 manifest，安装时一次性授予。popup 上那个开关退化成**软开关**：
// 管的是「用不用」，不是「有没有」。默认开——权限既然装的时候就给了，
// 再让用户多点一次没有任何安全收益，只是多一道摩擦。想关的人随时能关。
export async function isEnabled() {
  if (!chrome.debugger) return false;
  try {
    const { l2Disabled } = await chrome.storage.local.get('l2Disabled');
    return !l2Disabled;
  } catch {
    return true;
  }
}

// ---------- attach / detach ----------

async function ensureAttached(tabId) {
  const s = sessions.get(tabId);
  if (s?.ready) return touch(tabId);

  if (!(await isEnabled())) {
    throw new L2Unavailable(
      '这一步需要「高保真模式」（浏览器级的真实输入事件），但它被关掉了。'
      + '让用户点开 huashu-chrome 扩展图标，把「高保真模式」打开，然后重试。');
  }

  try {
    await chrome.debugger.attach({ tabId }, PROTOCOL);
  } catch (e) {
    const m = String(e?.message || e);
    // 用户自己开着 DevTools 是最常见的一种：Chrome 一个标签页只允许一个调试器。
    // 这不该让整条链路失败——降级回 L1，把原因说清楚就行。
    if (/Another debugger is already attached/i.test(m)) {
      throw new L2Unavailable(
        '这个标签页已经被另一个调试器占用（多半是你自己开着 DevTools）。'
        + '关掉 DevTools 后重试，或者继续用普通模式。', 'L2_BUSY');
    }
    if (/Cannot access|chrome:\/\//i.test(m)) {
      throw new L2Unavailable(`浏览器保护页面不允许调试（${m}）`, 'L2_BUSY');
    }
    throw new L2Unavailable(`attach 失败：${m}`, 'L2_BUSY');
  }

  sessions.set(tabId, { ready: true, timer: null });

  // 这一行是整个 L2 能不能在后台标签页工作的开关，2026-08-26 实测确认：
  //
  //   后台标签页 + 不开焦点模拟 → mouseMoved 送达（isTrusted 已经是 true），
  //   但下一发 mousePressed 直接把调试会话打断，报 "Detached while handling command"。
  //   只有 pointerover/mouseover/mousemove 三个事件落地，点击等于没发生。
  //
  //   后台标签页 + 开焦点模拟 → 九个事件完整送达，全部 isTrusted:true，
  //   focus 和 click 都在。
  //
  // 没有它，L2 就只能在前台工作，而「后台干活不打扰用户」是这个产品的硬规则——
  // 那样等于要在「点得动」和「不打扰」之间二选一。有了它，两个都要。
  // detach 时浏览器自动恢复真实焦点状态，不用手工关。
  await send(tabId, 'Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});

  // Page.enable 只为拿 javascriptDialogOpening 事件。DOM/Runtime 不 enable——
  // 它们的命令都是一次性调用，enable 只会白白往 SW 里灌事件。
  await send(tabId, 'Page.enable').catch(() => {});
  touch(tabId);
}

function touch(tabId) {
  const s = sessions.get(tabId);
  if (!s) return;
  if (s.timer) clearTimeout(s.timer);
  s.timer = setTimeout(() => detach(tabId), L2_IDLE_MS);
}

export async function detach(tabId) {
  const s = sessions.get(tabId);
  if (s?.timer) clearTimeout(s.timer);
  sessions.delete(tabId);
  dialogs.delete(tabId);
  try {
    await chrome.debugger.detach({ tabId });
  } catch {
    /* 已经断了 */
  }
}

// SW 被回收时内存里的 sessions 全丢，但 attach 状态由浏览器持有——
// 于是黄条会一直挂着，没有任何东西再去 detach 它。SW 每次启动扫一遍，
// 把上一条命的残留清掉。
export async function reapOrphans() {
  return reap((tabId) => !sessions.has(tabId));
}

// 用户在 popup 里关闭高保真模式时用：不管是不是自己的，全断。
// 撤销权限之后就再也调不动 chrome.debugger 了，这是最后的机会。
export async function reapAll() {
  for (const [tabId] of sessions) {
    const s = sessions.get(tabId);
    if (s?.timer) clearTimeout(s.timer);
  }
  sessions.clear();
  dialogs.clear();
  return reap(() => true);
}

async function reap(pick) {
  try {
    const targets = await chrome.debugger.getTargets();
    for (const t of targets) {
      if (t.attached && t.tabId != null && pick(t.tabId)) {
        await chrome.debugger.detach({ tabId: t.tabId }).catch(() => {});
      }
    }
  } catch {
    /* 没权限时 getTargets 直接抛，忽略 */
  }
}

function send(tabId, method, params = {}) {
  return chrome.debugger.sendCommand({ tabId }, method, params);
}

// 对外的统一入口：确保 attach 后执行 fn，并重置空闲计时
export async function withL2(tabId, fn) {
  await ensureAttached(tabId);
  try {
    return await fn((method, params) => send(tabId, method, params));
  } finally {
    touch(tabId);
  }
}

// ---------- 输入 ----------

const MOD = { alt: 1, ctrl: 2, control: 2, meta: 4, cmd: 4, command: 4, shift: 8 };
const maskOf = (mods = []) => mods.reduce((n, m) => n | (MOD[String(m).toLowerCase()] || 0), 0);

// 真实点击。坐标是 CSS px、相对视口左上角——正是 getBoundingClientRect 的口径，
// 不需要乘 DPR。
//
// mouseMoved 那一发不能省：hover 才出现的菜单、以及靠 mouseover 预加载的组件，
// 少了它就和 L1 一样打不开。真实鼠标本来也是先移过去再按下的。
export async function click(tabId, x, y, { button = 'left', clickCount = 1, mods = [] } = {}) {
  const modifiers = maskOf(mods);
  return withL2(tabId, async (cmd) => {
    const base = { x, y, button, modifiers };
    await cmd('Input.dispatchMouseEvent', { ...base, type: 'mouseMoved', button: 'none', buttons: 0 });
    await cmd('Input.dispatchMouseEvent', { ...base, type: 'mousePressed', buttons: 1, clickCount });
    await cmd('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased', buttons: 0, clickCount });
    return true;
  });
}

export async function hover(tabId, x, y) {
  return withL2(tabId, (cmd) =>
    cmd('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 }));
}

const VK = {
  Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, ' ': 32,
  ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39,
  Home: 36, End: 35, PageUp: 33, PageDown: 34,
};

// 真实按键。和 L1 的根本区别：这里**不需要 emulateDefault**——
// 浏览器会自己移动焦点、提交表单、插入字符、关闭 <dialog>。
// content.js 里那一整套「把浏览器该做的事手工补上」的代码，在这条路上是多余的。
export async function key(tabId, spec, { mods = [], repeat = 1 } = {}) {
  const parts = String(spec).split('+');
  const k = parts.pop() || '+';
  const allMods = [...parts, ...mods];
  const modifiers = maskOf(allMods);
  const vk = VK[k] ?? (k.length === 1 ? k.toUpperCase().charCodeAt(0) : 0);
  const printable = k.length === 1 && !modifiers;

  return withL2(tabId, async (cmd) => {
    for (let i = 0; i < Math.min(Math.max(repeat, 1), 50); i++) {
      const base = {
        modifiers,
        key: k,
        code: k.length === 1 ? `Key${k.toUpperCase()}` : k,
        windowsVirtualKeyCode: vk,
        nativeVirtualKeyCode: vk,
      };
      // 可打印字符要用 keyDown+text 一起发，否则只有事件没有字符落进输入框
      await cmd('Input.dispatchKeyEvent', {
        ...base,
        type: printable ? 'keyDown' : 'rawKeyDown',
        ...(printable ? { text: k, unmodifiedText: k } : {}),
      });
      await cmd('Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
    }
    return true;
  });
}

// 整段文字一次插入。走的是浏览器的文本输入管线，所以 Monaco / CodeMirror /
// 富文本编辑器这类「状态在 JS 里不在 DOM 上」的控件也认——
// 而 L1 的 applyText 改完 DOM，编辑器内部状态没变，一失焦就回滚。
export async function insertText(tabId, text) {
  return withL2(tabId, (cmd) => cmd('Input.insertText', { text }));
}

// ---------- DOM ----------

// 原生文件选择。DataTransfer 那条路是伪造 FileList，站点一查 isTrusted 就废；
// 这条是浏览器自己的路径，和用户手点文件对话框走的是同一条。
// 传的是本机绝对路径——桥和浏览器在同一台机器上，不必再把文件 base64 搬一遍。
export async function setFileInput(tabId, selector, files) {
  return withL2(tabId, async (cmd) => {
    const { root } = await cmd('DOM.getDocument', { depth: 1 });
    const { nodeId } = await cmd('DOM.querySelector', { nodeId: root.nodeId, selector });
    if (!nodeId) throw new L2Unavailable(`页面上没有匹配 ${selector} 的元素`, 'REF_NOT_FOUND');
    await cmd('DOM.setFileInputFiles', { nodeId, files });
    return true;
  });
}

// ---------- 页面 ----------

// 截后台标签页。captureVisibleTab 截的是「那个窗口当前可见的那一页」，
// 所以现在的 screenshot 必须先把标签页切到前台——而那会打断用户，
// 与本产品「后台干活」的硬规则直接冲突。CDP 这条不需要前台。
export async function screenshot(tabId, { format = 'png' } = {}) {
  return withL2(tabId, async (cmd) => {
    const r = await cmd('Page.captureScreenshot', { format, captureBeyondViewport: false });
    return `data:image/${format};base64,${r.data}`;
  });
}

// 不受页面 CSP 管的求值。现在的 eval 走 MAIN world，大站的 CSP 一律拦下——
// 这条路是调试器的求值通道，CSP 管不着。
export async function evaluate(tabId, expression, { maxLength = 20000 } = {}) {
  return withL2(tabId, async (cmd) => {
    const r = await cmd('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,   // 剪贴板、全屏这类要用户手势的 API 靠这个解锁
    });
    if (r.exceptionDetails) {
      const msg = r.exceptionDetails.exception?.description || r.exceptionDetails.text;
      throw new L2Unavailable(`表达式执行失败：${msg}`, 'INTERNAL');
    }
    let s;
    try { s = JSON.stringify(r.result?.value, null, 2); } catch { s = String(r.result?.value); }
    if (s === undefined) s = 'undefined';
    return s.length > maxLength ? s.slice(0, maxLength) + '\n…（已截断）' : s;
  });
}

// ---------- 原生弹窗 ----------

// ⚠️ 这两个监听器必须用可选链挂。
//
// debugger 走的是 optional_permissions，**未授权时整个 chrome.debugger 命名空间
// 就是 undefined**。直接 chrome.debugger.onEvent.addListener 会在模块顶层抛
// TypeError，而这个模块被 background.js import —— 于是 service worker 根本起不来，
// 扩展彻底不工作，连桥都连不上。
//
// 症状极具迷惑性：doctor 显示「扩展没连上桥」，看着像是没重载扩展，
// 实际是代码在加载阶段就崩了。用户授权之后命名空间才会出现，所以还要在
// onPermissionAdded 里补挂一次。
function wireDebuggerEvents() {
  if (!chrome.debugger?.onEvent || wireDebuggerEvents.done) return;
  wireDebuggerEvents.done = true;

  chrome.debugger.onEvent.addListener((source, method, params) => {
    const tabId = source.tabId;
    if (tabId == null) return;
    if (method === 'Page.javascriptDialogOpening') {
      dialogs.set(tabId, { type: params.type, message: params.message, at: Date.now() });
    } else if (method === 'Page.javascriptDialogClosed') {
      dialogs.delete(tabId);
    }
  });

  // 用户手动点了黄条上的「取消」，或标签页关了
  chrome.debugger.onDetach.addListener((source) => {
    const tabId = source.tabId;
    if (tabId == null) return;
    const s = sessions.get(tabId);
    if (s?.timer) clearTimeout(s.timer);
    sessions.delete(tabId);
    dialogs.delete(tabId);
  });
}

wireDebuggerEvents();
chrome.permissions?.onAdded?.addListener(wireDebuggerEvents);

export const pendingDialog = (tabId) => dialogs.get(tabId) || null;

// 弹窗只能由人决定接不接受——扩展替用户点「确定」，等于替他做了那个决定。
// 所以这里只提供把它关掉的能力，默认走 dismiss（相当于点「取消」），
// 由调用方在明确知道该怎么办时传 accept:true。
export async function handleDialog(tabId, { accept = false, promptText } = {}) {
  const d = dialogs.get(tabId);
  if (!d) return null;
  await withL2(tabId, (cmd) =>
    cmd('Page.handleJavaScriptDialog', { accept, ...(promptText ? { promptText } : {}) }));
  dialogs.delete(tabId);
  return d;
}

export const isAttached = (tabId) => !!sessions.get(tabId)?.ready;
