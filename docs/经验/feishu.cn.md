# 飞书（feishu.cn / larksuite.com）· 多维表格 bitable

实测 2026-08-28，本机会话实抓（往「合作回款」多维表格加记录）。首次从零摸索用了
281 次调用 / 54 分钟；按本记录走，同类任务应在 10 轮以内。

## 网格是 canvas，DOM 里没有行

独立页（`/base/<token>` 或 `/wiki/<token>?table=…`）的网格容器是
`.faster-view canvas[faster="1"]`；docx 嵌入的是 `.embeded-faster-view canvas`。
**表格的行和单元格不在 DOM 里**——用 TreeWalker / querySelectorAll 找行是无用功
（首次摸索在这上面烧掉 40+ 次 eval）。

canvas 上合成事件一律无效（`isTrusted=false` 页面不认），只有 `real:true` 的真实
CDP 事件能穿透。需要按坐标点 canvas 时，用覆盖层法：`eval` 创建一个定位到目标坐标的
overlay div，再 `click real:true` 点它。但行选择、右键菜单这类 canvas 交互成功率低，
**能走 API 或表单 DOM 就别碰 canvas**。

## 读数据：内部 records API

```
GET /space/api/v1/bitable/<appToken>/records?tableID=<tblXXX>&viewID=<vewXXX>&pageSize=50&pageNum=1
```

同源 XHR/fetch 直接通（带登录态），响应在 `recordMap` 里。appToken/tableID/viewID
全在页面 URL 上。别碰 `/base/csr/config`（巨大且难解析）；`ssr_data` 接口有首屏数据可作补充。

**字段 ID（fldXXX）→ 字段名的映射，唯一可靠来源是表单 DOM 的 `data-field-id` 属性**
（添加记录弹窗 / 记录详情卡里）。

## 写数据（添加记录）：走表单 DOM，不碰 canvas

点「添加记录」按钮 → 弹出的表单是真实 DOM。各字段类型的正确操作：

| 字段类型 | 正确姿势 |
|---|---|
| 文本 | 点进字段，用真实键盘 `type`（act 里 click + type） |
| 单选 | 点开字段，JS 点 `.b-select-option`（按 textContent 匹配 + `offsetParent` 非空过滤） |
| 日期 | `input[placeholder="年/月/日"]`，直接 type 日期字符串 |

填完点「提交」。验证是否写入成功：重新拉一次 records API 比对，别信页面表象。

⚠️ **最大陷阱：JS 直写 `textContent` / `value` + dispatch input 事件，提交后字段全空。**
飞书是 React + 内部 store，只认真实输入产生的状态变更，直写 DOM 的值会被静默丢弃——
还会留下一条残缺记录。这是首次摸索中真实发生的事故。

新手引导弹窗（「我知道了」「立即使用」「继续编辑」）会拦操作，出现就先关。

## 删除 / 修改已有记录：直接走 OpenAPI，别逆向页面

页面内部的删除端点逆向未果：猜路径全部 404，下载 bundle 挖端点也没挖到
（首次摸索在这上面烧掉约 30 轮）。正解是飞书 OpenAPI：

```
DELETE /open-apis/bitable/v1/apps/<appToken>/tables/<tableID>/records/<recordID>
```

有 lark-cli / lark MCP 的环境直接用它们；修改已有记录同理优先 OpenAPI。
