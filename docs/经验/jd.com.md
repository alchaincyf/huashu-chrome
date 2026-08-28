# 京东（jd.com）

实测 2026-08-26，本机会话实抓（查图书销量评价）。

**不需要登录**，搜索和商品页的接口未登录就能读。是电商里最好抓的。

| 要什么 | 接口 | 怎么找 |
|---|---|---|
| 搜索结果（价格/评价数/好评率/店铺） | `functionId=pc_search_searchWare` | 开 `search.jd.com/Search?keyword=…`，`network` 里 200KB 那条 |
| 单品评价汇总 + 评价原文 + 标签 | `functionId=getLegoWareDetailComment` | 开 `item.jd.com/<wareId>.html`，15KB 那条 |

搜索结果的商品对象递归找 `wareId` 就能全捞出来，一页 30 条。有用的字段：

```
wareName  jdPrice  shopName  shopId
comment / commentFuzzy   评价数（500 封顶，超了都显示 "500+"）
good                     好评率百分比，整数
averageScore             星级
```

评价接口里：

```
allCntStr  "500+"        展示值
allCnt     100           接口实际能拉的上限，不是评价总数
goodCnt / normalCnt / badCnt   只统计有文字内容的评价
goodRate   "94%"         含系统默认好评，和上面三个数对不上是正常的
defaultGoodCountText     base64，解出来说明有多少是「默认评价」
semanticTagList          评价标签 + 各自人数
commentInfoList          评价原文
```

⚠️ **京东全站没有「累计销量」字段**。搜索页和商品页都只有评价数。
任何「已售 N 件」的说法要么来自别的平台，要么是推算——**别把评价数当销量报**。
