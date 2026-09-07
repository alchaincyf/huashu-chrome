# sudoku.com · canvas 游戏怎么驱动

实测 2026-08-29。这份笔记的价值不在数独本身，在于它是**「棋盘在 canvas 里、
DOM 里什么都没有」这类页面的完整样板**。

## 结构要点

- 棋盘是 **canvas**（2000×2000 隐藏像素，CSS 500×500），DOM 里没有格子元素，
  `snapshot` 拍出来是空的，无法直接读值。
- 题目从 API 来：
  `GET https://sudoku.com/api/v2/classic/{easy|medium|hard|expert|master|extreme}/app_start`
  → `{"id":698,"mission":"81 位、空格为 0 的串","solution":"81 位标准解","win_rate":61.35}`
- **读盘正路**：页面加载后用 `network match:"app_start"` 取最新一条。
  **别截图肉眼读盘**——实测会读错。
- 题目每次访问 / 换局随机（reload 即新局新 id）。

## 往 canvas 里点和填（合成事件，不需要真实鼠标）

`eval` 里派发到 canvas：

1. **选格**：`pointermove / pointerdown / mousedown / pointerup / mouseup / click`
   六个事件全部带 `clientX/Y`，格子中心 = `rect` 起点 + `(c+0.5)*rect.width/9`。
2. **填值**：向 `document` 派发 `KeyboardEvent`，`keydown/keypress/keyup` 三发
   （带 `keyCode`），才命中游戏内部状态。
3. 一个 eval 里循环 81 格、只填 `mission` 为 0 的格，几秒完成。

## 会让人以为是 bug 的两件事

- **换局确认框**：「确定」是 `BUTTON` 元素但 `role` 查找找不到，用
  `[...document.querySelectorAll('button')].find(b => b.textContent.trim()==='确定').click()`。
  点完有概率新局加载失败（转圈 + `404 /api/content/zh/undefined/undefined`），
  **保险动作是直接 navigate reload**，重开后重新拿 `app_start`。
- **reload 后可能插入 IMA preroll 视频广告**：点击层在宿主 DOM（`.ima-play-heading`，
  `element.click()` 即可触发播放），但「跳过广告」按钮在**跨域 IMA iframe 内，
  宿主页够不着**（eval / snapshot 都碰不到），只能等它自然播完（约 15–20 秒）。
  广告期间 canvas 看着空白，**但游戏在后台已就绪，期间照样能操作**。
- reload 会清掉页面上一切临时 JS 修改（zoom、隐藏广告等）。

## 验证

DOM 里读不到结果，直接截图确认。页面上的 `win_rate` 文案与 `app_start` 里的
`win_rate` 一致，可以用来确认「当前这局」和「刚拿到的 API 数据」是同一局。

页面 60+ 个请求全是广告和 GA，题目本身是纯 GET、无鉴权。
