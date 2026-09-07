# 豆瓣（movie.douban.com）· 逐条目评分速查

实测 2026-08-29。

任一条目的「评分 + 标题 + 年份 + 原名 + 中文名」一站式入口：

```
https://m.douban.com/rexxar/api/v2/movie/{subject_id}?for_mobile=1
```

关键字段：`title` / `original_title` / `year` / `pubdate` / `rating{value,count}` /
`null_rating_reason`。

⚠️ `rating.value=0` + `count=0` + `null_rating_reason=暂无评分` = **豆瓣未开分，不是 0 分**。

必须在豆瓣站点上下文里发（受控标签页开着任意 `movie.douban.com` 页面即可）；
服务端 curl 会 400（`invalid_request_1284`，缺 ck cookie）。

**剧集中文名别靠搜索引擎猜**：同名词条很多，实测有一部英剧的豆瓣影评挂在一部同名
1983 年电影的条目下，差点误判成「这部剧有条目」。

IMDb 侧：WebFetch 直抓 `imdb.com` 403，但本工具的 `fetch` 走 `via:"extension"`
可以拿到完整 HTML，`og:image` 和 JSON-LD 的 `aggregateRating` 都在 `<head>` 里，
`maxBody` 给到 7000 就够。
