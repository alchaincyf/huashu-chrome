const dot = document.getElementById('dot');
const state = document.getElementById('state');
const btn = document.getElementById('btn');

function render(connected) {
  dot.classList.toggle('on', connected);
  state.textContent = connected ? '已连接终端' : '未连接';
  btn.disabled = connected;
  btn.textContent = connected ? '一切正常' : '立即连接';
}

chrome.runtime.sendMessage({ __hcPopup: 'status' }, (r) => render(!!r?.connected));

btn.onclick = () => {
  btn.disabled = true;
  btn.textContent = '连接中…';
  chrome.runtime.sendMessage({ __hcPopup: 'connect' }, (r) => render(!!r?.connected));
};

// ---------- 高保真模式 ----------
//
// 这是个**软开关**，不是权限开关。
//
// 原本的设计是让 debugger 走 optional_permissions，做成「默认安装轻量、用时再授权」。
// Chrome 不允许：`debugger` 在不可选权限清单里，放进 optional_permissions 会被
// 静默忽略，request() 直接回「Only permissions specified in the manifest may be
// requested.」——用户点了只会看到一句莫名其妙的报错。
//
// 所以权限在 manifest 里、安装时就给了，这里只管「用不用」。默认开：
// 权限既然已经拿到，再让用户多点一次没有安全收益，只是多一道摩擦。
// 关掉之后 L2 全部走不通，写操作会退回普通合成事件。

const l2dot = document.getElementById('l2dot');
const l2state = document.getElementById('l2state');
const l2btn = document.getElementById('l2btn');

function renderL2(on) {
  l2dot.classList.toggle('on', on);
  l2state.textContent = on ? '高保真模式已开启' : '高保真模式（已关闭）';
  l2btn.textContent = on ? '关闭' : '开启';
  l2btn.classList.toggle('on', on);
}

chrome.storage.local.get('l2Disabled', ({ l2Disabled }) => renderL2(!l2Disabled));

l2btn.onclick = () => {
  chrome.storage.local.get('l2Disabled', ({ l2Disabled }) => {
    const turningOff = !l2Disabled;
    if (turningOff) {
      // 关之前先把还挂着的调试会话断掉，否则开关关了、黄条还留在标签页上，
      // 而且再也没人会去摘它
      chrome.runtime.sendMessage({ __hcPopup: 'detachAll' }, () => {
        chrome.storage.local.set({ l2Disabled: true }, () => renderL2(false));
      });
    } else {
      chrome.storage.local.set({ l2Disabled: false }, () => renderL2(true));
    }
  });
};
