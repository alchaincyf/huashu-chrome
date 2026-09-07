# 大麦网（damai.cn / m.damai.cn）· 演出与展览信息

实测 2026-09-03。

## 结论先说

- **PC 版 `detail.damai.cn/item.htm?id=` 是空壳**，`read_text` 只能读到一行公告，别用。
- **走 H5**：`https://m.damai.cn/shows/item.html?itemId=<id>`，`read_text` 能拿到
  票价区间、场次时间、场馆全名 + 街道地址、时长、限购、退票规则、想看人数、开票公告。
- **搜索**：`https://m.damai.cn/shows/search.html?keyword=<urlencoded>`，`read_text`
  直接吐出「项目名 + 日期 + 城市|场馆 + ¥xx 起」的列表，是查「某城市有哪些展览 / 演出」
  最快的一枪，一次能列出二三十个在展项目带起价和展期。

## 拿 itemId

搜索页点第一条，跳转后 URL 里就是 itemId。

## 底层 API（可选，通常不必）

H5 页会打 `//mtop.damai.cn/h5/mtop.damai.item.detail.getdetail/1.0/?...`，
用 `network body:"mtop.damai.item.detail.getdetail"` 能拿到完整 JSON：
`price.range`、`item.showTime`、`venue.venueAddr/lat/lng`、
`serviceTips.importantNotes`（含「初始开售总票数」）、退票规则时间戳。
带签名，**不要自己伪造请求**，让页面自己发。

## 坑

1. **H5 买不了票也看不到余票**：`buyButton` 常年是「该渠道不支持购票 请到大麦 App 购买」
   （disabled）。**所以「还有没有票」这个问题 H5 答不了**，只能报票价区间和「想看人数」。
   别把「H5 没显示售罄」写成「还有票」。
   - 例外：展览类项目反而会显示「立即购票」，那个是真的在售。
2. 详情正文里常埋**加开 / 三开公告**（「三开时间 ○年○月○日，本次开票不接受任何退票」）。
   这类「过了就没了」的信息只在 introduce 里，snapshot 看不到，**必须 `read_text`**。
3. 项目名里的城市不一定等于场馆城市，以 `venue.venueAddr` 为准。
