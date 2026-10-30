// 敏感动作二次确认闸 —— 纯裁决逻辑，不碰 chrome API、不读文件，为的是能被 `npm test` 直接跑到。
//
// 背景（第二刀）：原版只有「付款」这一下会弹窗让人点头（confirmPay / loc.pay）。
// 别的危险动作——删除、发布、提交表单、转账——在单次 click 时是直接执行的，
// 只有在「批处理」里才会被挡（performCore 的 blockSensitive，要求 agent 单独调一次）。
// 也就是说：agent 单独调一次 click 去删一条记录，没有任何人看得见、也没人点头。
// 对「带权限」的企业版，这正是最该补的闸。
//
// 这一层回答一个确定性问题：**这一下危险动作，要不要先问人？**
// 判定 agent 够不着——injection 让模型说任何话，也改不动它调不到的开关。
//
// 设计原则（和白名单那一层一致）：
//   · 默认关闭：没配置时一切照旧（付款仍然弹、别的敏感动作直接做），升级不打断现有 agent。
//   · 主动开启：用户显式把 mode 设成 'sensitive'，才进入「每个危险动作先问人」。
//     企业内部部署时把 mode 设 sensitive，就成了「删/发/提交/转账都要人点头」的闸门。
//   · 付款永远独立于本开关：loc.pay 命中时照旧弹 confirmPay，和这里设成什么无关——
//     花钱那一下的保护不该被任何配置关掉。
//
// 配置文件 ~/.lingee-chrome/confirm.json 的形状：
//   { "mode": "sensitive" }      → 开启：删除/发布/提交/转账等命中 isSensitive 的单次动作都要人点头
//   mode 省略或非 'sensitive'     → 关闭（只有付款仍弹窗，与原版一致）

export const CONFIRM_MODES = ['off', 'sensitive'];

// 把任意配置对象归一成一个确定的模式字符串。
//   null / 非对象 / mode 缺失或不认识  → 'off'
export function normalizeMode(cfg) {
  if (!cfg || typeof cfg !== 'object') return 'off';
  return cfg.mode === 'sensitive' ? 'sensitive' : 'off';
}

// 核心裁决：给定一次操作的「是否敏感」和当前确认闸配置，
// 返回 false（直接执行）或一个 gate 对象（先问人）。
//
//   mode 为 off                 → 直接执行（闸未开启）
//   isSensitive 为假            → 直接执行（本来就不是危险动作）
//   mode 为 sensitive + 敏感    → 要人点头
//
// 注意：这一层不管付款。付款由 loc.pay / confirmPay 独立处理，始终生效。
// 传进来的 sensitive 应是 loc.sensitive（已排除掉纯付款语义之外的噪声，见 content.js 的 isSensitive）。
export function decideConfirm(sensitive, cfg) {
  if (normalizeMode(cfg) !== 'sensitive') return false;
  if (!sensitive) return false;
  return {
    code: 'NEEDS_CONFIRM',
    message: '这是删除/发布/提交/转账一类的危险动作，确认闸已开启，需要用户点头后才执行',
  };
}
