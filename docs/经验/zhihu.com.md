# 知乎（zhihu.com）

实测 2026-09-03。

- `api/v4/search_v3` 本机 curl 无 cookie 回 400；**登录态浏览器后台标签页 navigate 到
  `www.zhihu.com/search?type=content&q=<词>` 之后直接 `read_text` 就能读**，
  每条结果带「赞同 N · M 条评论 · 日期」。
- 它回答的是「这个话题有多热、大家在争什么」，不是某一篇具体内容的数据。
- 信任排序：赞同 > 评论 > 收藏。页面里的「相关搜索」是现成的话题分支，顺手抄走。
