# 小红书（xiaohongshu.com）

实测 2026-08-25，本机会话实抓（创作后台导数据）。

签名网关级，**任何自造请求一律 406**。别逆向，点它自己的按钮，
让页面发带签名的请求，你只负责用 `network` 读响应。

数据入口选「数据看板→内容分析」，不要用「笔记管理」——后者不分页，
前者指标还更全（曝光、封面点击率、涨粉、人均观看时长）。

⚠️ DOM 里五个指标糊成一串（`123.68万214560420187309160`），
按常识猜顺序会串位。接口里是
`{view_count, comments_count, likes, collected_count, shared_count}`，
真实顺序是「观看、**评论**、**点赞**、收藏、分享」。

## 创作平台发图文笔记（2026-09-07 实测打通，含定时发布）

入口 `creator.xiaohongshu.com/publish/publish?source=official`，默认停在「上传视频」，
先 `eval` 点文字为「上传图文」的 span 切 tab。

- **传图**：第一张投 `input.upload-input`；之后编辑器出现，那个 input 就没了，
  改投 `input[type=file][multiple]`（隐藏的，`upload` 工具照样能投）。
  **必须一张一张按顺序投**，顺序即笔记顺序，最多 18 张；每张投完 `eval` 读
  `innerText.match(/(\d+)\/18/)` 确认计数。**不收 GIF。**
- **标题**：`input[placeholder*=标题]`，20 字上限。
  ⚠️ 用 `fill` 填正文 ref 时曾把正文灌进了标题框——**填完必核标题 value**。
  改标题用原生 setter + `input` 事件。
- **正文**：`.tiptap.ProseMirror`，`fill` 进不去；用 `eval`：focus →
  `execCommand('selectAll')` + `delete` → 按行 `insertText` + `insertParagraph`。
  空行也要 `insertParagraph` 一次，结果是段落间恰好一个空段。
- **话题**：纯文本 `#xxx` 不算话题。正确做法：光标在末尾 `insertText(' #词')` →
  等约 1–3 秒候选框（`div.item` 里的 `.name`）出现 → `eval` 点文本完全等于 `#词` 的那个
  `div.item`（或第一个）→ 生成 `a.tiptap-topic`。**Enter 键有时有效有时不动，别依赖。**
  候选框加载期间页面脚本会卡 7–20 秒，`act wait` 会报 `DIALOG_BLOCKING`，
  不是真弹框，直接下一轮 eval 即可。用 `[...ed.querySelectorAll('a.tiptap-topic')]` 验收话题数。
- **定时发布**：「更多设置」里 `.custom-switch-wrapper`（含文本「定时发布」）→
  点里面的 `.d-switch`。时间框 `.d-datepicker-input-filter input`，
  用 `act click selector` 打开（JS `click()` 打不开）；弹层 `.d-popover` 里两根
  `.d-timepicker-timebar`，第一根小时第二根分钟，`eval` 点里面文本等于 `07`/`30` 的 span
  即生效，input value 立刻变。
- **🔑 发布按钮在封闭 shadow DOM 里**：`<xhs-publish-btn submit-text="定时发布" save-text="暂存离开">`，
  DOM 搜不到「发布」两个字，a11y click 和坐标 real click 全部无效（网络零请求）。
  宿主元素自带 `_sr`（shadow root），用
  `host._sr.querySelectorAll('button')` 找到文本为「定时发布」的 `button.ce-btn.bg-red`
  直接 `.click()` 就发出去了。成功跳 `/publish/success`，4 秒后回发布页。
- 后台标签页也能填，但最后发布前建议 `tabs select focus:true` 切前台一次。
- **发布前自检清单**：`N/18` 图数、标题 value、`/1000` 计数、`a.tiptap-topic` 数、时间框 value。
