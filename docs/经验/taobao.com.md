# 淘宝 / 天猫（taobao.com / tmall.com）

实测 2026-08-26，本机会话实抓。

⚠️ **搜索必须登录**。未登录访问 `s.taobao.com/search?q=…` 会拿到一个完整的页面外壳，
但它**根本不发搜索接口**——`network` 里只有 `mtop.relationrecommend.wirelessrecommend`
这类推荐流和 `mtop.user.getUserSimple`。页面上能看到「亲，请登录免费注册」。

登录态得先存在：用户没登录时唯一的解是请他在自己的 Chrome 里登录一次，
不要试图代填账号密码。h5 版（`h5.m.taobao.com`）同样要扫码，不是绕过去的路。

登录之后走 `mtop.*` 系列接口，签名（`sign=`）是网关级的，
**自造请求必失败，只能 UI 驱动 + `network` 读响应**（同小红书）。
