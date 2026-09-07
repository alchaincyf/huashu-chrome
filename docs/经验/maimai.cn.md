# 脉脉（maimai.cn）

实测 2026-09-03。

## 登录

职言（gossip）**全部在登录墙后**。未登录时 `maimai.cn/web/*` 一律 302 到 `/platform/login`。
公开可读的只有 `maimai.cn/article/detail?fid=…&efid=…` 专栏文章，
但**那些几乎全是转载软文和招聘贴**，评论区也要登录才看得到。
要拿到从业者原话就必须先让用户在自己的 Chrome 里登录一次（手机号验证码或扫码）。

## 搜索

网页搜索页：`https://maimai.cn/web/search_center?type=gossip&query=<urlencoded>&highlight=true`

- `type=feed` = 实名动态，`type=gossip` = 职言交流
- 页面右上有「综合排序 / 时间排序 / 热门排序」

### 分页 JSON 接口（这条是关键）

```
GET /search/gossips?query=<urlencoded>&limit=20&offset=0&highlight=true&sortby=&jsononly=1
```

⚠️ **少了 `jsononly=1` 就返回整页 HTML**，`res.json()` 会抛 `Unexpected token '<'`。

响应形状：`{result:"ok", data:{gossips:[{gid, gossip:{id,username,text,crtime,likes,total_cnt,egid,…}}]}}`

- `username` 常带职位标签（形如「后端开发·5 年+」「某某公司员工」），
  这是判断「是不是真从业者」的主要依据
- `total_cnt` = 评论数，`likes` = 赞数
- 实名动态那一路是 `/sdk/search/web_get?query=…`，但它一次只回 2 条，别用它翻页

### 批量采集写法

`eval` **不会 await Promise**（返回 `{}`）。异步要 fire-and-forget 写进 `window.__xxx`，
下一次 eval 再读。存 `documentElement` 的 `data-*` 属性也行，
但 SPA 重渲染时会被抹掉，**存 window 更稳**。

```js
window.__r='RUNNING';(async()=>{const out={};for(const q of qs){…}window.__r=out;})();return 'started'
```

## 🚧 搜索有频次墙

连跑约 50 个 query（每个 2–3 页）之后，标签页会被弹到
`/n/member/mobile/access-limit?type=search`。每次搜索前页面还会打一个
`/search/check_access_limit?uid=…&word=…&type=gossip`。会员额度更高。
**所以要一次问对问题**：先把关键词列表想全，一批打完再筛，别一个个试。

## 内容质量提醒

职言里混了大量「XX 领域创作者」「招聘 HR」类账号，发的是搬运长文和 JD，不是本人经历。
筛选时按 `username` 排除 `/创作者/`，优先留带具体职级后缀（`·N年`、`·10年+`）
和「XX 员工」的账号。
