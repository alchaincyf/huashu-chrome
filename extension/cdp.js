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
//
// ⚠️ 但黄条的根治手段不在扩展里，在浏览器启动参数：
//
//     chrome --silent-debugger-extension-api
//
// 这是 Chromium 的正式开关（chrome/common/chrome_switches.h 的
// kSilentDebuggerExtensionApi），带上它 attach 就不再弹黄条。扩展自己关不掉
// 这条原生 UI——它由浏览器画在页面之上，不在 DOM 里，content script 碰不到。
//
// 除了吵，黄条还有个隐性代价：**它会挤压页面视口高度**（约 55px），attach 时
// 出现、detach 时消失，于是同一批截图的前后帧尺寸会对不上。2026-09-26 在
// ip33 魔方页实测：连续截图的高度在 1610 / 1722 之间来回跳，根因就是它跟着
// L2 的通断反复出现。screenshot() 里为此钉了一层视口覆盖（见该函数注释）。

import { imageSize } from './image-size.js';

const L2_IDLE_MS = 5000;
const PROTOCOL = '1.3';

// tabId -> { timer, ready }
const sessions = new Map();

// 弹窗是 L1 完全够不着的东西：alert 一弹，页面 JS 停摆，content script 的
// sendMessage 永远不返回，整条链路卡死到超时。attach 状态下 CDP 仍然活着，
// 所以顺手把它接住——这是 L2 的附带收益里最实用的一条。
const dialogs = new Map();   // tabId -> { type, message, at }
// 文件选择拦截期间收到的 Page.fileChooserOpened（见 chooseFiles）
const choosers = new Map();  // tabId -> [{ backendNodeId, frameId, mode, sessionId }]
// 进程外 iframe（跨站）的子会话。attach 标签页只拿到主框架那棵 DOM 和那一个
// Page 域；跨站框架的 DOM、文件选择事件都在它自己的 target 上，要 auto-attach 才够得着。
const children = new Map();  // tabId -> Map(sessionId -> targetInfo)

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

  sessions.set(tabId, { ready: true, timer: null, leases: 0 });

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

// 空闲计时只在没有人持有租约时走。以前计时器在 attach 时就开始倒数、命令执行
// 期间也不停——一条跑过 5 秒的命令（长 Monaco 粘贴、慢页面上的文件选择）会在
// 半路被 detach，报「Detached while handling command」。现在每次 withL2 持一份
// 租约，最后一份释放后才开始倒数。
function touch(tabId) {
  const s = sessions.get(tabId);
  if (!s) return;
  if (s.timer) clearTimeout(s.timer);
  s.timer = s.leases > 0 ? null : setTimeout(() => detach(tabId), L2_IDLE_MS);
}

export async function detach(tabId) {
  const s = sessions.get(tabId);
  if (s?.timer) clearTimeout(s.timer);
  sessions.delete(tabId);
  dialogs.delete(tabId);
  choosers.delete(tabId);
  children.delete(tabId);
  attachRefs.delete(tabId);
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

// 调试器错误分三类报：被别的调试器顶掉 / 标签页导航走了 / 别的。
// 「Detached」不再伪装成 INTERNAL——调用方据此决定不要盲目重试。
async function send(tabId, method, params = {}) {
  try {
    return await chrome.debugger.sendCommand({ tabId }, method, params);
  } catch (e) {
    const m = String(e?.message || e);
    if (/Detached while handling|not attached|Debugger is not attached/i.test(m)) {
      sessions.delete(tabId);
      throw new L2Unavailable(`调试连接在 ${method} 途中断开（标签页被关闭/重新加载，或用户点了黄条上的「取消」）。没有自动重试。`, 'L2_DETACHED');
    }
    throw e;
  }
}

// 对外的统一入口：确保 attach 后执行 fn。执行期间持租约，空闲计时不走
export async function withL2(tabId, fn) {
  await ensureAttached(tabId);
  const s = sessions.get(tabId);
  if (s) { s.leases++; if (s.timer) { clearTimeout(s.timer); s.timer = null; } }
  try {
    return await fn((method, params) => send(tabId, method, params));
  } finally {
    if (s) s.leases = Math.max(0, s.leases - 1);
    touch(tabId);
  }
}

// 多步操作（点击 → 全选 → 粘贴 → 读回）整段持一份租约：步与步之间夹着
// content script 的往返，不持租约的话中间任何一次慢应答都可能让调试器在半路断开
export const lease = (tabId, fn) => withL2(tabId, () => fn());

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

// 真实拖拽：按下 → 分几步移过去 → 松开。画布类应用（react-flow、地图、游戏）
// 靠 mousemove 的中间点判断拖拽意图，一步跳到终点很多库不认。
export async function drag(tabId, x1, y1, x2, y2, { steps = 8 } = {}) {
  return withL2(tabId, async (cmd) => {
    await cmd('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x1, y: y1, button: 'none', buttons: 0 });
    await cmd('Input.dispatchMouseEvent', { type: 'mousePressed', x: x1, y: y1, button: 'left', buttons: 1, clickCount: 1 });
    for (let i = 1; i <= steps; i++) {
      const x = x1 + (x2 - x1) * i / steps, y = y1 + (y2 - y1) * i / steps;
      await cmd('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1 });
    }
    await cmd('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x2, y: y2, button: 'left', buttons: 0, clickCount: 1 });
    return true;
  });
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
//
// selector 可能指向 iframe 里的元素（content script 在那个框架里打的一次性标记）。
// DOM.querySelector 只查顶层文档，所以先查顶层，查不到再用 performSearch——
// 它在 pierce 过的整棵树上找，同进程的 iframe（含同站跨源，如 app.powerbi.com 里的
// pbidpe.powerbi.com）都在里面。跨站的进程外 iframe（OOPIF）不在这棵树上，
// 抛 OOPIF 让上游退回框架内的 DataTransfer 路径。
async function nodeBySelector(cmd, selector) {
  const { root } = await cmd('DOM.getDocument', { depth: -1, pierce: true });
  const { nodeId } = await cmd('DOM.querySelector', { nodeId: root.nodeId, selector }).catch(() => ({ nodeId: 0 }));
  if (nodeId) return nodeId;
  const { searchId, resultCount } = await cmd('DOM.performSearch', { query: selector, includeUserAgentShadowDOM: false });
  try {
    if (!resultCount) return 0;
    const { nodeIds } = await cmd('DOM.getSearchResults', { searchId, fromIndex: 0, toIndex: 1 });
    return nodeIds?.[0] || 0;
  } finally {
    await cmd('DOM.discardSearchResults', { searchId }).catch(() => {});
  }
}

// 子会话上的命令：chrome.debugger 从 Chrome 125 起认 { tabId, sessionId }
const sessionCmd = (tabId, sessionId) => (method, params = {}) =>
  chrome.debugger.sendCommand({ tabId, sessionId }, method, params);

// 把标签页里所有进程外 iframe 都 attach 上（含嵌套：每个子会话也开 auto-attach），
// 返回 [{ sessionId, cmd, url }]。用完调 release 摘掉——不摘的话子 target
// 会一直挂着，后面每个 DOM 事件都多往 SW 里灌一份。
// 可重入：chooseFiles 里 trigger 的点击也会走 clickInFrame 再 attach 一次，
// 内层 release 不能把外层还在用的子会话摘掉——按标签页计数，最后一个 release 才真摘
const attachRefs = new Map();
async function attachChildren(tabId, cmd) {
  if (!children.has(tabId)) children.set(tabId, new Map());
  attachRefs.set(tabId, (attachRefs.get(tabId) || 0) + 1);
  const auto = { autoAttach: true, waitForDebuggerOnStart: false, flatten: true };
  await cmd('Target.setAutoAttach', auto);
  const seen = new Set();
  for (let round = 0; round < 4; round++) {
    await new Promise((r) => setTimeout(r, 150));
    const fresh = [...children.get(tabId).keys()].filter((s) => !seen.has(s));
    if (!fresh.length && round) break;
    for (const s of fresh) {
      seen.add(s);
      await sessionCmd(tabId, s)('Target.setAutoAttach', auto).catch(() => {});
    }
  }
  const list = [...children.get(tabId)]
    .filter(([, info]) => info?.type === 'iframe')
    .map(([sessionId, info]) => ({ sessionId, url: info.url, cmd: sessionCmd(tabId, sessionId) }));
  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    const left = (attachRefs.get(tabId) || 1) - 1;
    if (left > 0) { attachRefs.set(tabId, left); return; }
    attachRefs.delete(tabId);
    await cmd('Target.setAutoAttach', { ...auto, autoAttach: false }).catch(() => {});
    for (const s of [...(children.get(tabId)?.keys() || [])]) {
      await cmd('Target.detachFromTarget', { sessionId: s }).catch(() => {});
    }
    children.delete(tabId);
  };
  return { list, release };
}

// 跨站 iframe 里的真实点击。坐标打给顶层时，浏览器要靠合成器的命中测试数据
// 才知道该交给哪个进程——而后台标签页里的进程外框架从不交帧，那份数据是空的/旧的，
// 点击于是落在父框架上（2026-11-13 实测：焦点进不去、按钮没反应）。
// 直接把鼠标事件发给那个框架自己的 target，用它自己的坐标系，绕开命中测试。
// docSelector 是框架 content script 给自己 <html> 打的标记，用来认出是哪个子会话。
export async function clickInFrame(tabId, docSelector, x, y, { clickCount = 1 } = {}) {
  return withL2(tabId, async (cmd) => {
    const { list, release } = await attachChildren(tabId, cmd);
    try {
      let target = null;
      for (const child of list) {
        if (await nodeBySelector(child.cmd, docSelector).catch(() => 0)) { target = child; break; }
      }
      if (!target) throw new L2Unavailable('没找到这个框架对应的调试子会话', 'OOPIF');
      const t = target.cmd;
      const base = { x, y, button: 'left', modifiers: 0 };
      await t('Input.dispatchMouseEvent', { ...base, type: 'mouseMoved', button: 'none', buttons: 0 });
      await t('Input.dispatchMouseEvent', { ...base, type: 'mousePressed', buttons: 1, clickCount });
      await t('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased', buttons: 0, clickCount });
      return true;
    } finally {
      await release();
    }
  });
}

export async function setFileInput(tabId, selector, files) {
  return withL2(tabId, async (cmd) => {
    const nodeId = await nodeBySelector(cmd, selector);
    if (nodeId) {
      await cmd('DOM.setFileInputFiles', { nodeId, files });
      return true;
    }
    // 不在主进程这棵树上：去每个进程外 iframe 的子会话里找
    const { list, release } = await attachChildren(tabId, cmd);
    try {
      for (const child of list) {
        const id = await nodeBySelector(child.cmd, selector).catch(() => 0);
        if (!id) continue;
        await child.cmd('DOM.setFileInputFiles', { nodeId: id, files });
        return true;
      }
    } finally {
      await release();
    }
    throw new L2Unavailable(`调试器在主框架和 ${list.length} 个跨站 iframe 里都没找到 ${selector}`, 'OOPIF');
  });
}

// 「点了按钮才临时造一个 input 并立刻 .click()」的上传入口（Fabric 的 Import、
// 很多 Angular Material 页面）事先根本没有 input 可找，一点就弹系统文件对话框——
// 那是扩展够不着、只能让用户去点的东西。打开文件选择拦截后，Chrome 不弹对话框，
// 改发 Page.fileChooserOpened（带那个 input 的 backendNodeId），我们直接把文件塞给它。
// 拦截要在**每个** target 上开：跨站 iframe 里的 input 只在它自己的子会话上报事件。
// trigger 是调用方传进来的「执行那次点击」的函数；拦截在 finally 里一定关掉，
// 否则这一页之后用户自己点上传也不会再弹对话框。
export async function chooseFiles(tabId, trigger, files, { timeout = 8000 } = {}) {
  return withL2(tabId, async (cmd) => {
    choosers.set(tabId, []);
    const { list, release } = await attachChildren(tabId, cmd);
    const targets = [cmd, ...list.map((c) => c.cmd)];
    for (const t of targets) {
      await t('Page.enable').catch(() => {});
      await t('Page.setInterceptFileChooserDialog', { enabled: true }).catch(() => {});
    }
    try {
      await trigger();
      const end = Date.now() + timeout;
      let hit = null;
      while (!hit && Date.now() < end) {
        hit = choosers.get(tabId)?.[0] || null;
        if (!hit) await new Promise((r) => setTimeout(r, 100));
      }
      if (!hit) {
        throw new L2Unavailable(`点了 trigger 之后 ${timeout / 1000}s 内页面没有打开文件选择（trigger 不是上传入口，或点击没落到它上面）`, 'NO_FILE_CHOOSER');
      }
      if (hit.mode === 'selectSingle' && files.length > 1) {
        throw new L2Unavailable('这个文件选择只接受一个文件', 'BAD_PARAMS');
      }
      const on = hit.sessionId ? sessionCmd(tabId, hit.sessionId) : cmd;
      await on('DOM.setFileInputFiles', { backendNodeId: hit.backendNodeId, files });
      return { frameId: hit.frameId, mode: hit.mode };
    } finally {
      choosers.delete(tabId);
      for (const t of targets) await t('Page.setInterceptFileChooserDialog', { enabled: false }).catch(() => {});
      await release();
    }
  });
}

// ---------- 页面 ----------

// 截后台标签页。captureVisibleTab 截的是「那个窗口当前可见的那一页」，
// 所以现在的 screenshot 必须先把标签页切到前台——而那会打断用户，
// 与本产品「后台干活」的硬规则直接冲突。CDP 这条不需要前台。
//
// 默认 60% 缩放的 JPEG：视觉 token 按像素数算，缩到 0.6 就是省掉 64%，而
// 「这一页大概长什么样、按钮在哪」这类问题 60% 足够看清。要读小字、量像素
// 传 full:true 拿 1:1（以 CSS px 计）PNG。缩放走 clip.scale——Chrome 在合成时缩。
//
// 不再钉视口（以前用 setDeviceMetricsOverride 钉住第一次量到的尺寸）。钉视口本身
// 就会改页面：覆盖值按「不含滚动条」的宽度给，页面当场重排；detach 时撤掉又重排一次。
// 截图那一刻的布局和随后真实点击时的布局因此不是同一个，按截图算出的坐标会偏。
// 现在一律按此刻的视口拍，并把换算需要的一切跟图一起交回去：CSS 视口尺寸、
// 实际位图尺寸（从字节里量，不是按请求的比例推）、两者之比、devicePixelRatio、滚动偏移。
// 高 DPI 屏上 clip.scale 输出的是设备像素，所以按 DPR 折算，让「60%」真的是 CSS 的 60%。

// 后台标签页不出帧：rAF 不跑、IntersectionObserver 不回调，靠它们水合的页面停在骨架屏
// （经验库约 18 个站记过「骨架，不是未登录」）。截一帧会推一次渲染管线——agent 的绕法
// 就是「先截个图」，这里做成内建的，结果丢掉不用。
// 截 1×1 像素就够：要的是那一次合成，不是图。真实点击前也用它——刚重新加载、
// 还没出过一帧的后台标签页，浏览器按旧布局做命中测试，点击会落空（Fabric 实测）。
//
// 有上限：页面里有进程外 iframe（跨站）时，后台标签页的截图会等那些子框架交帧，
// 一等就是 30 秒（2026-11-13 实测）。推帧只是锦上添花，等不到就照常往下走——
// 没回来的那次截图在浏览器里自己收尾，不挡后面的输入事件。
export async function forceFrame(tabId, { timeout = 0 } = {}) {
  const shot = withL2(tabId, (cmd) => cmd('Page.captureScreenshot', {
    format: 'jpeg', quality: 1, captureBeyondViewport: false, clip: { x: 0, y: 0, width: 1, height: 1, scale: 1 },
  }));
  if (!timeout) return shot;
  shot.catch(() => {});
  await Promise.race([shot, new Promise((r) => setTimeout(r, timeout))]);
}

export async function screenshot(tabId, { full = false } = {}) {
  return withL2(tabId, async (cmd) => {
    const m = await cmd('Page.getLayoutMetrics');
    const v = m.cssVisualViewport || {};
    const width = Math.max(1, Math.round(v.clientWidth || 1));
    const height = Math.max(1, Math.round(v.clientHeight || 1));
    const scrollX = Math.round(v.pageX || 0);
    const scrollY = Math.round(v.pageY || 0);
    let dpr = 1;
    try {
      const r = await cmd('Runtime.evaluate', { expression: 'devicePixelRatio', returnByValue: true });
      dpr = Number(r?.result?.value) > 0 ? Number(r.result.value) : 1;
    } catch { /* 量不到按 1 算，实际比例下面从位图里量 */ }
    const want = full ? 1 : 0.6;
    // clip 用文档坐标：视口左上角 = 滚动偏移。以前写死 (0,0)，页面一滚就截到别处
    const r = await cmd('Page.captureScreenshot', {
      format: full ? 'png' : 'jpeg', ...(full ? {} : { quality: 80 }), captureBeyondViewport: false,
      clip: { x: v.pageX || 0, y: v.pageY || 0, width: v.clientWidth || width, height: v.clientHeight || height, scale: want / dpr },
    });
    const img = imageSize(r.data) || { width: Math.round(width * want), height: Math.round(height * want) };
    return {
      dataUrl: `data:image/${full ? 'png' : 'jpeg'};base64,${r.data}`,
      scale: Math.round((img.width / width) * 1000) / 1000,
      viewport: { width, height }, image: img, dpr, scroll: { x: scrollX, y: scrollY },
    };
  });
}

// 不受页面 CSP 管的求值。现在的 eval 走 MAIN world，大站的 CSP 一律拦下——
// 这条路是调试器的求值通道，CSP 管不着。
export async function evaluate(tabId, src, { maxLength = 20000 } = {}) {
  return withL2(tabId, async (cmd) => {
    const run = (expression, extra = {}) => cmd('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,   // 剪贴板、全屏这类要用户手势的 API 靠这个解锁
      ...extra,
    });
    // 和页面世界那条路同样的两档：先当表达式（对象字面量要括号），
    // 语法不对再按语句跑——replMode 顺带允许顶层 await，和 DevTools 控制台一样
    let r = await run(`(${src})`);
    if (r.exceptionDetails && /SyntaxError/.test(r.exceptionDetails.exception?.description || r.exceptionDetails.text || '')) {
      r = await run(src, { replMode: true });
    }
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

// 在某个 iframe 的上下文里、不受该框架 CSP 管地求值。Runtime.evaluate 只认顶层，
// 所以借一个节点：框架里的 content script 给 <html> 打了一次性标记，这里按标记
// 找到节点（同进程框架都在 pierce 树上），callFunctionOn 就在那个节点所在的
// 框架里执行。函数体由调试器编译，页面 CSP 管不着。
export async function evaluateAt(tabId, selector, src, { maxLength = 20000 } = {}) {
  return withL2(tabId, async (cmd) => {
    const nodeId = await nodeBySelector(cmd, selector);
    if (!nodeId) throw new L2Unavailable('调试器看不到这个框架（跨站的进程外 iframe），只能在它允许的页面世界里求值', 'OOPIF');
    const { object } = await cmd('DOM.resolveNode', { nodeId });
    try {
      const call = (body) => cmd('Runtime.callFunctionOn', {
        objectId: object.objectId, functionDeclaration: body,
        returnByValue: true, awaitPromise: true, userGesture: true,
      });
      let r = await call(`async function () { return (${src}\n); }`);
      if (r.exceptionDetails && /SyntaxError/.test(r.exceptionDetails.exception?.description || r.exceptionDetails.text || '')) {
        r = await call(`async function () { ${src}\n}`);
      }
      if (r.exceptionDetails) {
        throw new L2Unavailable(`表达式执行失败：${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`, 'INTERNAL');
      }
      let s;
      try { s = JSON.stringify(r.result?.value, null, 2); } catch { s = String(r.result?.value); }
      if (s === undefined) s = 'undefined';
      return s.length > maxLength ? s.slice(0, maxLength) + '\n…（已截断）' : s;
    } finally {
      await cmd('Runtime.releaseObject', { objectId: object.objectId }).catch(() => {});
    }
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
    if (method === 'Target.attachedToTarget') {
      if (!children.has(tabId)) children.set(tabId, new Map());
      children.get(tabId).set(params.sessionId, params.targetInfo);
    } else if (method === 'Target.detachedFromTarget') {
      children.get(tabId)?.delete(params.sessionId);
    } else if (method === 'Page.fileChooserOpened') {
      choosers.get(tabId)?.push({ backendNodeId: params.backendNodeId, frameId: params.frameId, mode: params.mode, sessionId: source.sessionId || null });
    } else if (method === 'Page.javascriptDialogOpening') {
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

// 超时诊断用：页面脚本不应答时，确认到底有没有对话框。没 attach 时弹出来的框
// 我们收不到事件——attach 时的 Page.enable 会让 Chrome 把已经开着的框补发一次
// javascriptDialogOpening，所以挂上后稍等片刻就知道答案。
export async function probeDialog(tabId, ms = 400) {
  if (dialogs.has(tabId)) return dialogs.get(tabId);
  await withL2(tabId, async () => {});
  await new Promise((r) => setTimeout(r, ms));
  return dialogs.get(tabId) || null;
}

// 后台标签页被 Chrome 冻结（Tab.frozen）时，内容脚本收不到任何消息，
// 表现和弹窗一模一样。CDP 能把它拉回 active。
export async function unfreeze(tabId) {
  await withL2(tabId, (cmd) => cmd('Page.setWebLifecycleState', { state: 'active' }));
}

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
