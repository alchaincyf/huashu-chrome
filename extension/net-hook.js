// 网络记录 hook —— 注入到页面的 MAIN world，document_start 执行。
//
// 必须赶在页面自己的 JS 之前跑，否则首屏那批 XHR 全漏掉，
// 而恰恰是首屏那批带着列表数据。
//
// 只往 window.__hcNet 里堆记录，不上报、不外发。读取由扩展按需拉。
(() => {
  if (window.__hcNet) return;
  window.__hcNet = [];

  const MAX_ENTRIES = 300;
  const MAX_BODY = 400000;

  const push = (r) => {
    window.__hcNet.push(r);
    if (window.__hcNet.length > MAX_ENTRIES) window.__hcNet.shift();
  };

  const origFetch = window.fetch;
  if (origFetch) {
    window.fetch = async function (...a) {
      const res = await origFetch.apply(this, a);
      try {
        const url = typeof a[0] === 'string' ? a[0] : a[0]?.url;
        const ct = res.headers.get('content-type') || '';
        const rec = { t: Date.now(), method: a[1]?.method || 'GET', url, status: res.status, ct, body: '' };
        // clone() 是必须的：响应体只能被读一次，直接读会把页面自己的那份吃掉。
        // 但绝不能 await 它：读完 clone 要等整个响应结束，await 着就迟迟不把 res
        // 交给页面——慢接口的首字节被拖到下载完，SSE（打字机、工具调用实时渲染）
        // 被拖到整轮结束才一次性倒出来（alchaincyf/huashu-chrome#15）。
        // event-stream 也不读：它可能永不结束，clone 那一路会一直攒内存。
        if (/json|text|javascript/.test(ct) && !/event-stream/i.test(ct)) {
          res.clone().text().then((b) => { rec.body = b.slice(0, MAX_BODY); push(rec); }, () => push(rec));
        } else push(rec);
      } catch { /* 记录失败绝不能影响页面本身 */ }
      return res;
    };
  }

  const oOpen = XMLHttpRequest.prototype.open;
  const oSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u, ...rest) {
    this.__hc = { method: m, url: String(u) };
    return oOpen.call(this, m, u, ...rest);
  };
  XMLHttpRequest.prototype.send = function (...a) {
    this.addEventListener('load', () => {
      try {
        push({
          t: Date.now(),
          ...this.__hc,
          status: this.status,
          ct: this.getResponseHeader('content-type') || '',
          body: String(this.responseText || '').slice(0, MAX_BODY),
        });
      } catch {}
    });
    return oSend.apply(this, a);
  };
})();
