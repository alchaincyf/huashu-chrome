# 微信公众号（mp.weixin.qq.com）

实测 2026-08-25，本机会话实抓。

正文在 `mp.weixin.qq.com`，图在 `mmbiz.qpic.cn`——**跨域**。
`fetch` 下图必须走扩展（默认），加 `via:"page"` 会被 CORS 挡死。

懒加载的图真地址在 `data-src`，`src` 是 1px 占位符。

## 贴图（图片消息 / 小绿书）编辑器（2026-09-05 实测打通）

- 入口：首页「新的创作」里的「贴图」**不是 link 也不是 button**，`snapshot` 看不到。
  用 `query contains:"贴图"` 拿 selector 路径再 `act click selector`，会**开新标签页**，
  URL 形如 `appmsg_edit_v2&type=77&createType=8`。
  ⚠️ 直接拼 `type=8` 会进「商品消息」，不是它。
- **标题上限 20 字**（页面右侧有 `15/20` 这类计数，英文字母按半个算）。
- **图片上传**：页面有两个 `input[type=file]`。第一个（accept 含 `image/svg`）是正文编辑器的，
  投进去**没反应**；贴图要投给隐藏的第二个：
  `upload` 带 `selector:"input[type=file][accept^=\"image/bmp\"]"`。
  每次一张，按顺序投，顺序即轮播顺序，最多 9 张。投完约 2–3 秒才出现在缩略图条里。
- **描述栏是 ProseMirror**（`#guide_words_main .ProseMirror`）：`fill` / `type` 里的 `\n`
  全被吞掉，段落会连成一块；`act key Enter` 其实有效（插入 `<br>`），
  但工具判「无变化」会中途停。
  **可靠做法**：`eval` 直接写 DOM——清空后按段 append 文本节点，段间放两个 `<br>`，
  再 dispatch `InputEvent('input')`，ProseMirror 会接收。
  写完用 `snapshot` 看 textbox value 里有空行即成。
- `eval` 在这个站**能跑**（CSP 没挡）。
- 填了标题 + 首图后会**自动保存**成草稿，URL 变成 `appmsg_edit&appmsgid=xxx`，
  左下角显示「已保存」。「保存为草稿」按钮是 `button "保存为草稿"`。**别碰「发表」。**
