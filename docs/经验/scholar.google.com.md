# Google 学术（scholar.google.com）

用途：Scholar 挡 API，但覆盖面比 OpenAlex 之类的开放索引广得多，
做引用扫描 / 找一手论文时值得走浏览器这条路。实测 2026-09-03。

## 直接拼 URL，不用点搜索框

```
https://scholar.google.com/scholar?q=%22精确短语%22&hl=en&as_sdt=0,5
```

`read_text` 就能拿到全部结果条目（标题、作者缩写、来源、被引数、摘要片段）。
实测**没有验证码**（浏览器里已登录 Google 的前提下）。

## 拿结果的真实链接

`read_text` 不回 `href`。要 PDF / 落地页 URL 用：

```
query(selector: ".gs_r a", extract: {"href":"@href"})
```

顺序对应页面上的条目。里面会混进 `/citations?user=XXXX` 的作者主页链接——
那正是判作者分量用的。

## 🔑 绕过反爬站：用 Scholar 的 HTML 缓存

上面那串 href 里会有一条

```
https://scholar.googleusercontent.com/scholar?q=cache:XXXXXXXX:scholar.google.com/+%22查询词%22&hl=en&as_sdt=0,5
```

就是结果条目里的 "View as HTML"。它是 Google 自己爬下来的 PDF 全文转 HTML，
**本体 403 的论文（ResearchGate 一类），从这里能读到全文**——curl / WebFetch /
浏览器 download 直取原站 PDF 一律 `SERVER_FORBIDDEN`。

打开后正文可以 `eval` 全文检索（这站不挡 eval）：

```js
(()=>{const t=document.body.innerText;const out=[];let i=-1;
while((i=t.indexOf('关键词',i+1))!==-1){out.push('...'+t.slice(Math.max(0,i-900),i+300)+'...');}
return out.join('\n=====\n');})()
```

一次性拿到「参考文献第几条」+「正文哪句引的」，比逐屏截图快得多。

## 判作者分量

作者主页 `https://scholar.google.com/citations?user=XXXX&hl=en`：`read_text` 拿被引数 /
h-index，机构那行要单独取：

```
query(selector: "#gsc_prf_i")
```

⚠️ Scholar 的作者链接是自动匹配的，可能张冠李戴——**机构要和论文 PDF 首页的署名对上才算数**。

## 一个负面结论

Semantic Scholar 的 `/graph/v1/paper/search` 是标题摘要级检索，**搜代码仓库名等于没搜**
（搜一个小写连字符的仓库名，回来一堆同名的大写学术项目）。
它的 `/paper/{id}/citations` 反向穿透好用，但限流很严。
