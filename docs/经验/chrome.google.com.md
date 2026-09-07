# Chrome 应用商店（chrome.google.com/webstore）

实测 2026-09-05。这一份记的是一堵**过不去的墙**——写下来是为了让 agent 别在上面浪费回合。

## 扩展注入不了这个域名

`chrome.google.com/webstore/*`（包括开发者后台 devconsole）是**浏览器保护页**，
和 `chrome://` 同一类：Chrome 不允许任何扩展往里注入脚本。

具体表现：任何注入类工具都返回

```
The extensions gallery cannot be scripted
```

`snapshot` / `click` / `query` / `eval` / `ask` / `navigate` 全部不可用。
**这不是 bug，也不会因为重试而变好，看到这条报错就停。**

`tabs(new, url)` 能把标签页开出来（开标签页不需要注入），但之后别再对它调任何注入类工具。

## 出路

这个域名下的事只能人来做。agent 该做的是把标签页开到位、把要改的内容准备好，
然后用 `ask` 把这一步交还给用户，而不是换着花样重试。

> 同一类还有：`chrome://` 各页、Chrome 自己的设置页、以及各浏览器的扩展管理页。
> 判据一样——报「cannot be scripted」就是这一类。
