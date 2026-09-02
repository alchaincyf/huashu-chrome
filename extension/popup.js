const dot = document.getElementById('dot');
const state = document.getElementById('state');
const btn = document.getElementById('btn');
const conntip = document.getElementById('conntip');

// 版本号：用户自查「扩展和 CLI 是不是同一版」的唯一入口。npx 会原地刷新扩展文件，
// Chrome 跑的却还是旧的，这种错位只有版本号能看出来。
document.getElementById('ver').textContent = 'v' + chrome.runtime.getManifest().version;

// 「上次收到桥的消息是几秒前」「桥版本几」——用户以前只看得到一盏灯，
// 分不清是扩展断了、桥没起、还是终端根本没在跑。
function render(connected, r = {}) {
  dot.classList.toggle('on', connected);
  state.textContent = connected ? '已连接终端' : '未连接';
  btn.disabled = connected;
  btn.textContent = connected ? '一切正常' : '重连';
  const age = r.lastRx ? Math.round((Date.now() - r.lastRx) / 1000) : null;
  const bits = [];
  if (r.bridge) bits.push(`桥 v${r.bridge}${r.bridge !== chrome.runtime.getManifest().version ? '（和扩展版本不一致，去 chrome://extensions 重载一次）' : ''}`);
  if (age !== null) bits.push(`${age} 秒前收到心跳`);
  if (!connected && r.offscreenError) bits.push(`后台文档建不起来：${r.offscreenError}`);
  if (!connected && age === null) bits.push('从没连上过：终端那边跑过 agent 了吗？桥由 agent 第一次调用时拉起');
  conntip.textContent = bits.join(' · ');
  conntip.hidden = !bits.length;
}

chrome.runtime.sendMessage({ __hcPopup: 'status' }, (r) => render(!!r?.connected, r || {}));

btn.onclick = () => {
  btn.disabled = true;
  btn.textContent = '连接中…';
  chrome.runtime.sendMessage({ __hcPopup: 'connect' }, (r) => render(!!r?.connected, r || {}));
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

// ---------- 控制标记 ----------
//
// 这是个安全信号，默认开：agent 在后台操控一个带着用户全部登录态的页面，
// 而用户看不见——这件事本身就该有痕迹。给开关是因为有人会在录屏、演示，
// 那时页面上多一圈彩色边框确实碍事。

const markdot = document.getElementById('markdot');
const markstate = document.getElementById('markstate');
const markbtn = document.getElementById('markbtn');
const sess = document.getElementById('sess');

function renderMark(on) {
  markdot.classList.toggle('on', on);
  markstate.textContent = on ? '控制标记已开启' : '控制标记（已关闭）';
  markbtn.textContent = on ? '关闭' : '开启';
  markbtn.classList.toggle('on', on);
}

// 「现在有谁在控哪一页」。这一栏比开关本身有用：它是用户唯一能一眼看全
// 所有会话的地方——页面上的标记只说得清用户正在看的那一页。
function renderSessions(rows) {
  sess.textContent = '';
  for (const r of rows) {
    const line = document.createElement('div');
    line.className = 's';
    const sw = document.createElement('span');
    sw.className = 'swatch';
    sw.style.background = r.color;
    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = r.label;
    const page = document.createElement('span');
    page.className = 'page';
    // 全部 textContent：label 来自 agent 自己声明的 client 名，title 来自网页，
    // 两个都是外部输入
    page.textContent = r.title ? `· ${r.title}` : '· 还没认领标签页';
    line.append(sw, who, page);
    sess.appendChild(line);
  }
}

function refreshMark() {
  chrome.runtime.sendMessage({ __hcPopup: 'sessions' }, (r) => {
    renderMark(r?.enabled !== false);
    renderSessions(r?.sessions || []);
  });
}
refreshMark();

markbtn.onclick = () => {
  chrome.storage.local.get('markDisabled', ({ markDisabled }) => {
    chrome.storage.local.set({ markDisabled: !markDisabled }, () => {
      // 先落盘再让 background 去贴/摘——它读的就是这个开关
      chrome.runtime.sendMessage({ __hcPopup: 'markSync' }, () => refreshMark());
    });
  });
};

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
