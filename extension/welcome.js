// 首装欢迎页：实时探测本地端，连上就变绿。
// 从商店装好扩展的人，以前落地后什么引导都看不到——终端那条路的引导页他根本没见过。

import { localizeDocument, t } from './i18n.js';

localizeDocument();

const copy = (btnId, srcId) => {
  const btn = document.getElementById(btnId);
  btn.onclick = async () => {
    try { await navigator.clipboard.writeText(document.getElementById(srcId).textContent); btn.textContent = t('welcome_copied'); } catch { btn.textContent = t('welcome_copy_manual'); }
    setTimeout(() => { btn.textContent = t('welcome_copy'); }, 1600);
  };
};
copy('copy', 'cmd');
copy('copy2', 'say');

async function poll() {
  const r = await chrome.runtime.sendMessage({ __hcPopup: 'status' }).catch(() => null);
  if (r?.connected) {
    document.getElementById('step2').classList.add('done');
    document.querySelector('#step2 .n').textContent = '✓';
    document.getElementById('live').classList.add('ok');
    document.getElementById('livetxt').textContent = t('welcome_connected', [`v${r.bridge || '?'}`]);
    return;
  }
  setTimeout(poll, 2000);
}
poll();
