# 即刻网页版（web.okjike.com）

实测 2026-09-05（发动态 composer）。

- 首页 `/following` 顶部就是发动态框：snapshot 里能看到 textbox（空）+「未选择圈子」
  textbox + 图片/视频/链接按钮 +「发送」按钮（无内容时 disabled）。
- **编辑器是 Lexical contenteditable**（class `_contentEditable_…`），不是 textarea。
  `type` 工具能进字但**换行全丢、第一行也可能丢**，别用。
- **可靠写法**：`eval` 派发伪造 paste，段落（`\n\n`）完整保留。

  ```js
  box.focus();
  const dt = new DataTransfer(); dt.setData('text/plain', TEXT);
  box.dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true}));
  ```

- **清空**：`execCommand('selectAll'/'delete')` 和 Range 选区 + paste 都**不会替换**，
  只会往后追加（于是出现内容重复）。有效的是：Selection 选中全部
  （`range.selectNodeContents(box)`）后派发
  `new InputEvent('beforeinput',{inputType:'deleteContentBackward',bubbles:true,cancelable:true})`，
  Lexical 会吃掉整段。清空后再 paste。
- **图片**：页面有一个 `input[type=file]`（accept `image/png,image/jpeg,video/mp4`，multiple），
  `upload` 自动命中，一张一张投，顺序即九宫格顺序，最多 9 张。
  已传图数用 `img[src^="blob:"]` 数。
- `eval` 在这个站能跑。`eval` 里返回 Promise 拿不到结果（回 `{}`），要查状态就再发一次同步 eval。
- 发帖按钮是「发送」。**不要替用户点。**
