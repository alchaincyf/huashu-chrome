# X（x.com / twitter.com）

实测 2026-08-25，本机会话实抓。

用户时间线接口叫 `UserOriginalsTimeline`，**不叫 `UserTweets`**。

⚠️ **后台标签页不发请求**。诊断顺序：① 切前台看是否恢复 ② 还不行就刷新
（SPA 首次路由初始化问题）。

响应是深层嵌套 GraphQL，递归找 `__typename === 'Tweet'` + `rest_id`，别写路径。

图片加 `?format=jpg&name=large` 取原图；视频在 `video_info.variants` 里挑最高码率。

Article 编辑器：空编辑器渲染尺寸为 0，`snapshot` 看不见，用 `selector` 兜底；
页面上没有 `<input type=file>`，插图要用 `dropSelector`。
