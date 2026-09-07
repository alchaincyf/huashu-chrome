# 微博（m.weibo.cn）· 搜索与评论采集

实测 2026-09-03。

## 关键前提

- **`s.weibo.cn` / `s.weibo.com` 桌面站要登录**，未登录直接跳登录页。
- **`m.weibo.cn` 移动站不用登录就能搜。所有采集走 m 站。**
- 终端 `curl` 打 m 站 API 会返回 **HTTP 432**（反爬），必须在浏览器页面里调
  （同源 + cookie）。绕代理（`env -u ALL_PROXY ...`）也照样 432——不是代理问题。

## 可用 API（都在 m.weibo.cn 页面内 fetch，同源）

| 用途 | 端点 |
|---|---|
| 综合搜索 | `/api/container/getIndex?containerid=100103type%3D1%26q%3D<URLencode 关键词>&page_type=searchall` |
| 单条全文 | `/statuses/extend?id=<mid>` → `data.longTextContent` |
| 单条详情 | `/statuses/show?id=<mid>` → `data`（含 `longText.longTextContent`） |
| 热评 | `/comments/hotflow?id=<mid>&mid=<mid>&max_id_type=0`（也试 `max_id_type=1`）→ `data.data[]`，二级回复在 `x.comments[]` |

搜索结果嵌套很深且字段名不固定，**递归找 `o.mblog` 即可**，别写路径：

```js
const ms=[];const walk=o=>{if(!o||typeof o!=='object')return;if(o.mblog)ms.push(o.mblog);Object.values(o).forEach(walk)};walk(json);
```

`m.isLongText` 为真时正文被截成 `...全文`，要再打 `/statuses/extend`。

## eval 的两个坑（会直接让你拿到空结果）

1. **`eval` 不 await Promise**，async IIFE 直接返回 `{}`。
   配方：第一次 eval 只「点火」（把结果写进 `window.__RES`），第二次 eval 读 `window.__RES`。
   隔离世界的 window 变量跨 eval 存活。
2. **别把结果存进 DOM 里新建的 div**——微博是 SPA，会重渲染把节点冲掉
   （实测报 `Cannot set properties of null`）。用 `window.__X` 全局变量。

其他：

- 每个 fetch 套 `Promise.race` + 12s 超时，否则一个请求卡死整批。
- 边跑边写 `window.__RES = out.join('\n')`，可以读到进度，不用等整批完。
- 请求之间 sleep 1–1.5s，太快会被限流返回 0 结果。
  **同一个 query 偶发返回 `empty_result`，重试一次常常就有了。**

## 内容质量提醒（做舆情 / 原话采集时很重要）

- 综合搜索首屏严重偏向**大号、营销号、软文和 SEO 垃圾**。真正的从业者原话基本都在
  **评论区**——命中一条好帖就立刻去打 `/comments/hotflow`，产出比再搜十个关键词高得多。
- 带「XX 创作大赛」「XX 创作激励」之类话题标签的，基本是激励计划刷量内容，别当真实民意。
- 热搜话题帖下的短评论常有成片的刷量互动号（同一时间窗、清一色十几个字），要警惕。
- 媒体号的长文里会带**记者采访到的化名员工原话**，那种可用，但必须标注「二手转述」。

## 多个 agent 同时用同一个 Chrome 时

tabId 会被别的会话抢走（实测两次：受控标签页被别的 agent 导航去了完全不相干的站）。
**每次 eval 顺手带上 `location.host` 一起返回**，发现不对立刻 `tabs(action:"new")` 重开。
别对着别人的页面 fetch——会得到误导性的 `Failed to fetch`，看起来像 CORS，其实是跑错站了。
