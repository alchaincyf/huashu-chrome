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
