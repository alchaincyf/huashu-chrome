# Ollama（ollama.com）· 订阅管理

实测 2026-08-30。

**取消订阅的入口藏得很深，网站上没有任何写着「Cancel」的按钮。**

- `ollama.com/settings/billing` 页面上唯一的按钮文案是 **「Update payment method」**，
  但它的 `href` 其实是 `/manage-subscription` —— 这是个 302，跳到 Stripe 客户门户
  `billing.stripe.com/p/session?secret=live_...`（一次性 session，不能收藏）。
- Stripe 门户里才有 **「Cancel subscription」**，和「Update payment method」并排。
- 直接访问 `https://ollama.com/manage-subscription` 即可，不用先进 billing 页。
- 门户加载慢（首次 30s+ 会超时），先 `wait for idle` 再 `snapshot`。页面挂着一个
  invisible hCaptcha，snapshot 里会看到 "Please try again" 的 iframe 噪音，可忽略。
- 取消确认页 `/p/session/subscriptions/sub_xxx/cancel`：一个可选的离开原因下拉 +
  「Cancel subscription」按钮 + 「Go back」。原因不是必填。

`ollama.com/settings`（Usage 页）显示当前档位。

> 这套「按钮文案和 href 不是一回事」的形态在很多 SaaS 上通用：**读 `href`，别读文案**。
