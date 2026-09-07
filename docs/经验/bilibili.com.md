# B 站（bilibili.com）

实测 2026-08-25，本机会话实抓（创作中心）。

`fetch` 改分页参数能通，但**服务端会静默降级**：传 `ps=100`，它按 10 条返回，
`page:{"ps":10,"count":186}` 才是真相。每次都核对响应里的分页对象。

## 本机直连能用 / 不能用（2026-09-02 复核）

| 端点 | 本机直连 |
|---|---|
| `x/web-interface/view?bvid=` | ✅ 免登录（含 stat: view/like/coin/favorite/share/danmaku/reply） |
| `x/relation/stat?vmid=` | ✅ 免登录，`data.follower` 粉丝数 |
| `x/web-interface/nav` | ✅ |
| `x/tag/archive/tags?bvid=` | ✅ |
| `x/web-interface/search/all/v2?keyword=` | ✅ 免登录 |
| `x/web-interface/search/type?search_type=bili_user&keyword=` | ✅ 免登录，查账号（含 fans/videos/official_verify） |
| `x/series/recArchivesByKeywords?mid=` | ✅ 免登录，UP 投稿列表 |
| `x/v2/reply?type=1&oid=&sort=1&ps=20` | ⚠️ 通，但未登录**静默只给 3 条**（`page.size` 仍写 20） |
| `x/v2/reply/main?type=1&oid=&mode=3` | ❌ 本机 -352；走 `fetch via:"page"` 登录态可拿 20 条热评 + `top.upper` 置顶 |
| `x/space/wbi/arc/search` | ❌ -352 风控 |
| `x/web-interface/view/detail` | ❌ 412 |
| `x/player/wbi/v2` | ⚠️ 通，但未登录 `subtitles` 恒为空 |

本机直连搜索 / 空间接口容易撞 IP 风控（-412 / -352），走登录态 Chrome 稳。

### 🔑 省上下文的关键写法

`fetch` 加 `binary:true` + `savePath` + `via:"page"` → 响应直接落盘，回给你的只有一行
「已保存 XX KB」。**批量拉 API JSON 全都该这么写**，否则几十 KB 的 JSON 会灌进上下文。

## AI 字幕批量提取（2026-08-29，已修正一次严重错误）

### 🔴 头号坑：`player/v2` 会静默返回**别的视频**的字幕

`api.bilibili.com/x/player/v2?bvid=&cid=` **不能用来取字幕**。它带登录态、返回 `code:0`、
`bvid` / `cid` 回显都正确，但 `subtitle` 块给的是随机另一个视频的字幕路径。

实锤三条：

- 同一视频连续隔开请求 5 次 → 5 个完全不同的字幕路径
- 9 组不同时长的视频 → 拿到**字节完全相同**的字幕文件
- 51 分钟的合集 → 拿到一段手机测评的字幕；另一次拿到股市行情解说

**误判警告**：若发现「两个不同视频的字幕 URL 完全相同」，那是投毒证据，
不是「B 站按视频指纹复用了同源字幕」——第一次踩这个坑时就是这么自我说服过去的。

### ✅ 正确链路

1. 拿 cid（免登录）：`api.bilibili.com/x/web-interface/view?bvid=BVxxx` → `data.cid`
2. 拿字幕 URL（**必须登录态**，未登录 `subtitles` 恒为空）：
   **`api.bilibili.com/x/player/wbi/v2?bvid=<BV>&cid=<cid>`** ← 播放器自己用的端点
   - 即使不带 WBI 签名参数也返回真值（有字幕就给 cid 匹配的路径，没有就老实回 `subtitles: []`）
   - 走本工具的 `fetch`（带 cookie）；**`eval` 会被 B 站 CSP 挡掉**，别用
   - 取 `lan=="ai-zh"`；若同时有 `lan=="zh-CN"/"zh-Hans"` 且 `type==0`，
     那是 UP 主投稿字幕，质量更高，优先用
3. **校验闸（必做）**：ai-zh 字幕的 URL 路径里内嵌本视频的 cid，
   用 `str(cid) in path` 正向验证，不通过直接拒收。
   **这道闸是区分「真字幕」和「投毒字幕」的唯一可靠手段。**
4. 下载：`https:<subtitle_url>` 加 `-H "Referer: https://www.bilibili.com/"`
   → `{"body":[{"from":0.12,"to":3.08,"content":"文本"}]}`

### 其他坑

- 字幕 URL 的 `auth_key` **每次请求重新签名**，第一段就是过期时间戳，**有效期约 7 分钟**
  → 拿到就立刻下载。攒 8 条再批量下载是安全的，攒几十条不安全。
- `subtitle_url` 可能是空字符串（条目在但 URL 空）= B 站还在生成，不是失败。
- **新视频字幕是渐进生成的**：实测一条 71 分钟的视频，上传次日只覆盖前 10 分钟。
  验收必须比对 `body[-1].to` 与视频实际时长，差太多等 48 小时重拉。
  传了超过一周的老视频完整率高（实测一批 29/30 完整）。

**实战规模**：一轮 94 条清单 → 77 组字幕、55 万字，全部通过 cid 校验；
第二轮 140 条 → 137 组，零 CID GATE FAIL。

**附带彩蛋**：响应里的 `view_points[]` 是官方章节点（`from`/`to`/`content`），
长视频里常常就是每个段落的标题 + 时间边界，可直接拿来切分。

## 空间视频枚举

`x/space/wbi/arc/search` 本机直连必被风控（-352），即使 WBI 签名算对也一样。可行链路：

**本地算 WBI 签名 → 用 `fetch` 带 `via:"page"` 发出去**（页面上下文带登录态，过风控）。
签名参数：`mid/ps/tid/pn/keyword/order=pubdate/platform=web/web_location=1550101/order_avoided=true/index/special_type`，
WBI keys 取自 `x/web-interface/nav`（这个端点本机直连可用）。`ps=50` 实测不被降级。

**更省事的替代**：`x/series/recArchivesByKeywords?mid=<mid>&keywords=&ps=30&pn=1`
本机 curl 免登录免签名直接返回该 UP 的投稿列表（含 `stat.view/reply`、`pubdate`、`duration`），
`page.total` 给总数。连续打 10 个 mid 会有几次返回 HTML（风控页），隔 2 秒重试即可。
缺 like/coin，要再走 view。

## 搜索接口

- `api.bilibili.com/x/web-interface/search/all/v2?keyword=xxx` 免登录可用
  （新版 `wbi/search/type` 会返回 voucher 风控）。结果在 `data.result[]` 里
  `result_type=="video"` 那一项的 `data[]`。
- **`x/web-interface/search/type?search_type=video&keyword=&order=click|totalrank|pubdate&page=1&page_size=30`**
  走 `fetch via:"page"`（登录态）稳定可用（实测 12 连发无风控），`page_size=30` 如实返回。
  字段：`bvid/aid/mid/author/title`（带 `<em>` 高亮标签）`/play/like/favorites/review/video_review/duration/pubdate/tag/hit_columns`。
  - ⚠️ `pubtime_begin_s` 时间过滤参数**被静默忽略**，几年前的视频照样返回，时间要自己过滤。
  - ⚠️ `hit_columns` 只有 `["tag"]` 的结果 = 关键词只在 tag 里命中；
    大 UP 的无关视频挂了活动 tag 会霸榜「最多播放」，要按 title / desc 二次过滤。

## 话题页热度榜

话题页 `www.bilibili.com/v/topic/detail?topic_id=<id>` 背后是

```
api.bilibili.com/x/polymer/web-dynamic/v1/feed/topic?topic_id=<id>&sort_by=0&page_size=20
```

（`sort_by=0` 是热度序，另有 `topic_sort_by_conf` 列出可选排序）。
走 `fetch via:"page"` 带登录态稳。

- **翻页**：响应 `data.topic_card_list.offset`（形如 `heat_xxxxxxx_20_20`）回填到 `offset` 参数，
  `has_more:false` 停。1s/页无风控；但 60 页（1200 卡）仍 `has_more=true`，
  **大话题抓不完，按样本量主动停**。
- 每条在 `items[].dynamic_card_item.modules`：`module_author.name/mid/pub_ts`、
  `module_dynamic.major.archive.{bvid,title,duration_text,stat.play,stat.danmaku}`、
  `module_stat.{like,comment,forward}.count`。
- ⚠️ 播放量是「108万」这种**字符串**，精确数要再打 `x/web-interface/view`。
- ⚠️ 话题 feed 里混着只挂了话题、不是活动作品的视频，要二次过滤。
  标题会有变体（活动名里多一个空格），**纯子串匹配会漏，靠 tag 兜住**
  （`x/tag/archive/tags?bvid=`，免登录；话题 tag 有稳定 `tag_id`，按 id 判定最稳）。

## 分区名和合集（2026-09-05 复核）

- 🔴 **`x/web-interface/view` 的 `tname` 已改回空串**（`tid` / `tname_v2` 也空，
  视频页 HTML 里也没有）。分区名改用
  `x/web-interface/search/type?search_type=video&keyword=<BV 号>` 的 `result[].typename`，
  按 tid 等值映射；**必须带 buvid3 cookie（匿名 uuid 即可）+ `Referer: https://search.bilibili.com/`**，
  否则返回非 JSON。34 个 tid 各查 1 条 + 同 tid 第二条抽查，一致性 100%。
- ✅ `ugc_season` 在 view 响应里（官方合集：id / 标题 / `sections[].episodes[]` 含全部成员 bvid），
  「合集」维度不用退化成「同一 UP」近似。视频不在合集时该键缺失。
- 1s 间隔连续约 350 次 view / relation / tag / search 调用，零风控零验证码。

## 判断一条视频是不是商单

热评 `top.upper`（UP 置顶）里出现 `b23.tv/cm-yaoyue-*` 或 `b23.tv/cm-cmt-*` 短链
= 花火平台的商单跳转链接，可作为硬证据。

## ⚠️ 搬运号会把老内容混进新更新流里

做「按上传日期推断这条属于哪一期 / 哪一季」之前必读。实测三家综艺搬运号都会把
去年老季的片段混在今年的更新流里重发，**包括看起来最像跟播的那家**——
其中一家某个月的更新里有 14 条其实是上一年的内容。

标题、`desc`、`dynamic`、`tags` 里**都没有任何季次信号**，元数据层面无法区分。

唯一可靠办法：**拿已有的老内容语料做文本反查**（10-gram 包含率）。
实测分布是干净的双峰，≥0.35 和 ≤0.006 之间是空的，阈值取 0.20 稳妥。
没有对照语料就不要下季次结论。

同一场内容常被 2–3 家各发一条，8-gram Jaccard ≥0.30 可聚类去重
（实测同一场落在 0.34~0.86）。

## 创作中心 · 专栏发布（2026-09-06）

- 编辑器在 iframe `member.bilibili.com/york/read-editor`，`snapshot` 能看见
  （refs 带 `@fN`），标题 `textbox` 用 `fill` 可直接改。
- **GIF 上限 8MB**：超限的图变成「[图片上传失败]」占位，页面顶部只闪一条
  「请上传小于 8MB 的 GIF 文件」。发之前先压到 8MB 内；jpg 无此问题。
- **标题最多 50 字**，超出被静默截断（不报错）。
- 验收图是否落地：`eval` 进 iframe 的 `contentDocument`，数 `img[src^="data:"]`；
  `src` 为空的那两条是编辑器自己的占位，不算失败。
- 底部「发布设置」「发布」两个按钮：a11y `click` 和 `real:true` 都报「页面没反应」，
  **但 `real:true` 点「发布」其实生效了**（异步，几秒后才弹「你的专栏已提交成功」）。
  **别因为「没反应」连点。**
  「发布设置」是 `div.publish-settings` 里的 span，不是 button，用 `eval` 派发 mouse 事件才展开。
- 发出去就是**专栏**（内容管理 → 图文管理 → 专栏 标签下可见，含实时播放数），不走审核等待。
  文章链接从公开接口拿最省事：
  `curl --noproxy '*' 'https://api.bilibili.com/x/space/article?mid=<mid>&pn=1&ps=5'`
  → `data.articles[].id` → `https://www.bilibili.com/read/cv<id>`。
- 成功弹窗的「点击查看」跳到 `upload-manager/opus`（图文管理），不是文章页。
