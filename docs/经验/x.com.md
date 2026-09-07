# X（x.com / twitter.com）

实测 2026-08-25，本机会话实抓。

用户时间线接口叫 `UserOriginalsTimeline`，**不叫 `UserTweets`**。

⚠️ **后台标签页不发请求**。诊断顺序：① 切前台看是否恢复 ② 还不行就刷新
（SPA 首次路由初始化问题）。

响应是深层嵌套 GraphQL，递归找 `__typename === 'Tweet'` + `rest_id`，别写路径。

图片加 `?format=jpg&name=large` 取原图；视频在 `video_info.variants` 里挑最高码率。

Article 编辑器：空编辑器渲染尺寸为 0，`snapshot` 看不见，用 `selector` 兜底；
页面上没有 `<input type=file>`，插图要用 `dropSelector`。

## 发帖 / 回复的可靠配方（2026-08-29，10 连发全部 200 验证通过）

1. navigate 到帖子 status 页 → `wait for selector [data-testid="tweetTextarea_0"]`
2. `click` textarea（展开 composer）
3. `eval` 用伪造 paste 事件写文字（draft-js 认 paste，不认注入）：

   ```js
   box.focus();
   document.execCommand('selectAll', false, null);
   const dt = new DataTransfer(); dt.setData('text/plain', TEXT);
   box.dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true}));
   ```

4. `eval` 查 `[data-testid="tweetButtonInline"]` 的 `aria-disabled`，非 true 才 `.click()`
5. 验证：`network match:"CreateTweet"` 出现 200 POST

## 搜索限制（重要）

- **索引只覆盖最近约 30 天**：`since:` 早于 30 天 → `SearchTimeline` 直接返回空
  （只有游标、0 条）。不是结果少，是平台限制。
- `min_faves:100` 实测**不完全生效**：83 赞的帖子也混进结果。
  别依赖它做硬过滤，拿到数据后本地筛。
- 引号词组 + 时间窗 + 赞数过滤三者叠加极易零结果；**宽词才能出量**。
- `lang:en` 有助过滤。

## ⚠️ 后台标签页里 React 完全不渲染（2026-09-06 补充，比上面那条更狠）

搜索页在后台 tab 里：GraphQL `SearchTimeline` 已经 200 返回 171KB，但
`article[data-testid="tweet"]` 永远等不到，`document.querySelectorAll('article').length === 0`，
不带 `focus` 的 `screenshot` 也强制不出帧、不触发渲染。

**唯一解：`tabs select` 带 `focus:true` 把受控 tab 切到前台**，切完立刻正常。
reload / 多等 25 秒 / 截图探测都没用。

判断依据：`network match:"SearchTimeline"` 有 200 大响应但 DOM 为空 = 渲染被冻，
不是没结果。

## ⚠️ 不能伪造 GraphQL 请求（403）

`fetch` 复刻 `/i/api/graphql/<qid>/SearchTimeline?...`（原样照抄 URL、走 page 上下文带 cookie）
一律 **403**，`/i/api/2/search/adaptive.json` 也 403 —— X 现在给自己每个请求签
`x-client-transaction-id`，扩展造不出来。

**只能驱动页面自己发请求，再用 `network` 读。** 拿 body 的技巧：
`body:"SearchTimeline"` + `maxBody:300`，返回头会打印**完整请求 URL**（含整段 features），
用来确认 queryId 很方便。

## 搜索页虚拟列表会卸载 DOM

滚到底之后回头 `eval` 提取，`article` 数可能是 0（上面的已被卸载）。

配方：先注入 `window.__seen={}` + `MutationObserver` 累加抓取，再上下滚几轮，
最后一次性读 `window.__seen`。隔离世界的全局变量在同一页面内跨 eval 调用是保留的，
整页 navigate 才清空。

## 长帖正文（>280 字符）补全

搜索流里 `[data-testid="tweetText"]` 会被截成「…Show more」。

`cdn.syndication.twimg.com/tweet-result?id=<id>&token=<tok>` 免登录可用，能拿**完整短帖正文
+ mediaDetails（视频封面 URL）**，但长帖只给 `note_tweet: {id}` 不给正文 —— 补全只能
逐条 navigate 到 status 详情页再 `eval` 读 `[data-testid="tweetText"]`。
token 算法：`((id/1e15)*Math.PI).toString(36)` 去掉 `0` 和 `.`。

## status 详情页的 wait 会挂

带视频的 status 页 `wait for selector` 有概率报
`[DIALOG_BLOCKING] 页面脚本 25 秒没有响应`（重脚本，不是真弹框）。
别在一个 `act` 里串 6 条 navigate + wait，改成 `navigate` → 单独 `eval` 读，稳。

## 帖子数据一把拿全

`eval` 遍历 `article[data-testid="tweet"]`，`div[role="group"]` 的 `aria-label` 形如
`264 replies, 687 reposts, 6523 likes, 3355 bookmarks, 1778078 views`，一条全有。

判断一条帖子的真实传播力时，信任排序：**reposts > bookmarks > likes > views**。

## X Articles 长文编辑器（2026-09-06）

- **别对这个页面用 `snapshot` / `act`**：编辑器把每一段渲染成 5 份 textbox
  （a11y 树重复），一次 snapshot 3 万 token 起。读状态用 `eval`，动作用 `eval` 点，
  只在必须时 `screenshot`。
- 页面**有** `input[type=file][data-testid="fileInput"]`（accept 只有 jpeg/png/webp，
  **不收 GIF**），但它插入的位置**不跟你用 `Range` 设的光标走**——实测把图插进了封面槽
  并弹出「Edit media」对话框。要往正文特定位置插图，只能靠拖放（`dropSelector`）或人工。
- 落地结果**要用 Preview 页数**：`eval` 数 `img[src*="media/"]` 与 `video`。
  标题旁的「N words」对中文不可信（5000 字文章显示 62 words）。
  实测一次：外部工具报 10 图，落地 6（GIF 被转成 `video.twimg.com/tweet_video/*` 视频，
  4 张 jpg 丢失），图与段落错位。
- 预览页不是虚拟列表（滚到不同位置数出来的媒体一样），可放心整页数。
- 新建草稿：编辑器加载要 20 秒以上，`wait for text` 会超时，直接 `wait idle` +
  `screenshot` 看转圈。「Uploading media…」出现在 `#detail-header`，消失即上传完。
- Publish 按钮 `button` 文本就是 "Publish"，点之前先过上面的数图闸。

## 其他

- `tabs new` 曾返回一个错误的 tabId；用 `tabs list` 找一个现成的 x.com tab 再 navigate 更稳。
