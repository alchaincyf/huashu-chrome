# 腾讯文档（docs.qq.com）

- 文档正文**渲染在 canvas 里**。`read_text` / `innerText` 只能拿到大纲标题和字数，
  网络层也没有正文接口（正文走 websocket）。WebFetch 只能拿到前几百字的摘要。
- 可靠读法：`eval` 把滚动容器 `div.scrollable--soyAp` 的 `scrollTop` 设到指定值
  （每屏约 950px），再 `screenshot full:true` 逐屏读图。600–1000 字的文档 3 屏读完。
- 只读权限的文档页面上有「生成图片 / PDF 转换」按钮，长文可以考虑走它导出（未实测）。
