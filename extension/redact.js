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
