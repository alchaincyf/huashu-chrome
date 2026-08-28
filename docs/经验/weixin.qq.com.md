# 微信公众号（mp.weixin.qq.com）

实测 2026-08-25，本机会话实抓。

正文在 `mp.weixin.qq.com`，图在 `mmbiz.qpic.cn`——**跨域**。
`fetch` 下图必须走扩展（默认），加 `via:"page"` 会被 CORS 挡死。

懒加载的图真地址在 `data-src`，`src` 是 1px 占位符。
