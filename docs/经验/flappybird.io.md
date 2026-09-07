# flappybird.io · 别读像素，读游戏自己的状态

实测 2026-08-29。这份笔记同样是样板：**遇到 canvas 游戏，第一件事是找它有没有
把状态挂在 `window` 上，而不是去截图认像素。**

## 一句话结论

游戏把整个确定性模拟内核挂在 `window.__game` 上，全量可读。
先前那版「canvas 像素直读 + 自己维护状态机」是绕远路，而且靠运气。

## `window.__game`（主世界全局）

字段全部可读、皆为定点整数：

- `currentState`：`getready` / `play` / `gameover`
- `birdY` `birdVy` `birdRot` `prevBirdY`
- `pipes[]`：`{x, gapY, halfGap, passed}`
- `score` `bestScore` `playStep` `spawnCount` `elapsed` `stateEnteredElapsed`
- `runSeed`(BigInt) `prng.state`(BigInt) `simVersion` `flaps[]` `deathCause`

`flaps` 是拍翅的**步号序列**，配 `runSeed` 可完整回放一局——也就是说服务端按这个校验，
**分数伪造不了**。

## 页内注入（本工具场景必读，这条最通用）

- MCP `eval` 跑在**隔离世界**，看不到 `window.__game` 这类页面自己的全局变量。
  必须注入主世界脚本：`document.createElement('script')` + `appendChild`
  ——**前提是这个页面没有 CSP**，有 CSP 的站这条路直接堵死。
- 回传数据走 DOM 桥：主世界 `documentElement.setAttribute('data-xxx', JSON)`，
  隔离世界读属性。
- 脚本体积大就本地起个带 `Access-Control-Allow-Origin: *` 的 http 服务，
  用 `el.src='http://127.0.0.1:PORT/x.js'`；**https 页面加载 `http://127.0.0.1`
  不触发混合内容拦截**（localhost 属可信来源）。

## 输入：多数游戏不校验 isTrusted

bundle 里 `isTrusted` 只出现在 React 合成事件系统里，游戏自己的
`window.addEventListener("keydown", handleKeyDown)` 只看 `e.code`。
所以 `window.dispatchEvent(new KeyboardEvent('keydown',{code:'Space'}))` 完全有效。

早期笔记里「合成事件几分钟后失效」的结论**不成立**——当时多半是被广告遮罩吃掉了事件。

## 三个会被误判成 bug 的现象

- **后台标签页里游戏根本不跑**：`handleVisibilityChange` 在 `visibilityState === 'hidden'`
  时停 rAF、暂停游戏，回到 visible 才 `restart()`。本工具默认在后台开标签页，
  所以驱动游戏必须 `tabs select focus:true` 切前台，且窗口别被完全遮住。
  好处是暂停不掉局，露出来就接着跑。
- **Google vignette 广告**：开局后 1–2 秒可能插入，`location.hash` 变
  `#google_vignette`，遮罩吃掉键盘事件。清理：
  `history.replaceState(null,'',location.pathname)` + 移除
  `iframe[id*=google_ads_iframe|aswift]`。
- **弹窗会 gate 掉整个 keydown handler**：DOM 弹窗开着时 Escape 也进不去，
  得走 DOM 点关闭。

## 控制粒度

主循环是定步长累加器 `advance(dt)`，`dt > 0.25s` 直接丢帧不追帧（卡一帧不会爆发式补步）。
rAF 60fps + 120Hz 步长 ⇒ **一帧跑 2 步**，只能在「每帧的第一步」上落拍。
要精确落到某一步，**monkey-patch `window.requestAnimationFrame`**，
包一层在游戏回调之前决策，此时 `playStep` 就是即将执行的那一步。

## 结果以游戏自己的数为准

用 `__game.score` / `bestScore` / 结算页截图，**不要用自己数的穿管数**
——早期会话自计 30，真实只有 1–2。
