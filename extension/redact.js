// 凭据隐去 —— 纯字符串判定，不碰任何 chrome API
//
// 2026-08-26 的真实事故：agent 在用户的 npm 设置页上做了一次 read_text，
// 而那个标签页当时停在「2FA Successfully Enabled」——**整页恢复码进了对话上下文**。
// 上下文是留痕的：进去了就撤不回来，只能让用户去重新生成一套。
//
// 漂移警告防的是「读错了页面」；这一节防的是「读对了页面，
// 但页面上有不该被复制走的东西」。两者都需要——这次事故里两条都缺。
//
// 做法是隐去而不是拒绝：agent 有时确实需要在 tokens 页面上点按钮，
// 全拒绝会让一整类任务做不了。误报的代价是 agent 少看到几行乱码，
// 漏报的代价是凭据泄露——所以宁可误报。
//
// 单独一个文件，是因为这里的每一条都是纯函数，而它们守的东西最贵。
// 原先这段长在 background.js 里，只有开着真 Chrome 才跑得到；
// 于是 redactCreds 一个把整套防护归零的 bug（见下）活过了全部测试。
// 现在 `npm test` 直接覆盖，不需要浏览器。

// URL 层：这是不是一个「凭据页面」。认路径段而不是子串——真实站点长这样：
// github.com/settings/tokens、npmjs.com/settings/~/tfa、console/api-keys
export const CRED_URL = /\/(tfa|2fa|mfa|totp|recovery|backup[-_]?codes?|tokens?|api[-_]?keys?|credentials?|secrets?|password)(\/|$|\?|#)/i;

// 内容层：一行里全是高熵字符、既有字母又有数字、长度够长
// —— 恢复码、API key、私钥的共同长相
export const isCredLine = (l) => {
  const t = String(l).trim();
  return t.length >= 16 && t.length <= 256
    && /^[A-Za-z0-9+/=_-]+$/.test(t)
    && /[0-9]/.test(t) && /[a-zA-Z]/.test(t);
};

// ——— 正文层：凭据写在一句话里，而不是填在输入框里 ———
//
// isCredLine 判的是「整行就是一个码」，守的是恢复码列表那种排版。
// 但 2026-08-26 的第二次泄露走的是另一条路：`ask` 的 prompt——
// agent 写给人看的一段话里嵌着密码（「邮箱和密码我都填好了（x@y.com / 密码）」）。
// 整行判定对它无效，因为那一行绝大部分是正常中文。
//
// 所以按词切。三条边界都是踩出来的：
//
// ① **只处理带空白的字符串。** 一个不含空格的字符串是标识符——selector、URL、
//    ref、一段 JS——脱它只会让审计失去「agent 去过哪、点了什么」的能力，
//    而真正的密码字段早被键名那层接走了。有空白（或中文）才当正文看。
// ② **候选按 ASCII 可见字符成串取，不按标点切。** 全角的「），」天然不在
//    `[!-~]` 里，所以 `027565FranceTLS!），` 取出来正好是密码本身；
//    而 URL 会整条被取成一个词，才有机会被下面整条放行。
// ③ **URL、路径、邮箱整条放行。** 若先按 `/` 切碎再逐段判，
//    `…/media/2085812345678.mp4` 那一段就会被当成凭据挖掉。
const CRED_MIN = 12;

export const isCredToken = (w) => {
  if (w.length < CRED_MIN || w.length > 256) return false;
  if (w.includes('/') || w.includes('\\') || w.includes('@')) return false;  // URL / 路径 / 邮箱
  return /[0-9]/.test(w) && /[a-zA-Z]/.test(w);
};

// 手机号要卡数字边界：19 位的推文 ID 里嵌着 11 位「像手机号」的片段，
// 不卡边界会把 status/2025091650171031 一起挖掉——那正是审计最需要留下的东西。
const PHONE = /(?<![0-9])(?:(?:00|\+)?86)?1[3-9]\d{9}(?![0-9])/g;

export function scrubProse(s) {
  if (typeof s !== 'string' || !/[\s　]/.test(s)) return s;   // 无空白 = 标识符，不动
  return s
    .replace(/[!-~]+/g, (w) => (isCredToken(w) ? `<凭据${w.length}字>` : w))
    .replace(PHONE, '<手机号>');
}

// 只隐去**成组**出现的（≥3 行）。单个长串常常是正常的 ID、hash、短链，
// 一并隐去会把大量正常内容变成噪声；而恢复码和密钥列表天然成组。
//
// 「成组」不能理解成「行号严格连续」：read_text 在块级元素之间隔一个空行，
// 而恢复码几乎总是一行一个 <li>/<div>。第一版按严格连续算，实测在真实排版下
// 每组长度都是 1，**一行都没隐去**——测试写了、代码写了，防护值为零。
// 所以夹在凭据行之间的空行只当排版产物，不打断成组判定。
export function redactCreds(text) {
  const lines = String(text || '').split('\n');
  const out = [];
  let block = [];     // 当前区间的原始行（凭据行 + 夹在中间的空行）
  let creds = 0;      // 其中真正的凭据行数
  let count = 0;
  const flush = () => {
    // 尾随的空行属于下文的排版，别一起吃掉
    const tail = [];
    while (block.length && !block[block.length - 1].trim()) tail.unshift(block.pop());
    if (creds >= 3) { out.push(`  [已隐去 ${creds} 行疑似凭据]`); count += creds; }
    else out.push(...block);
    out.push(...tail);
    block = []; creds = 0;
  };
  for (const l of lines) {
    if (isCredLine(l)) { block.push(l); creds++; }
    else if (!l.trim() && creds) block.push(l);
    else { flush(); out.push(l); }
  }
  flush();
  return { text: out.join('\n'), count };
}
