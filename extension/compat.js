// 扩展和本地端兼不兼容——扩展、桥、MCP、doctor 全用这一份判定。
//
// 以前比的是完整版本字符串，补丁号差一位就报「版本不一致，去重载」。可两边的
// 协议号从 0.x 起就没变过，绝大多数警告是误报；而商店审核要几天、npm 是即时的，
// 每次发版都有一段时间所有商店用户在看这条警告（1.2.1 那次挂了 17 天）。
// 现在分级：协议号不同才是真不兼容；版本号只用来说「哪边旧了、怎么更新」。
//
// 本文件不碰任何 chrome.* / node API，两边都能直接 import。

export const PROTOCOL = 1;

const parse = (v) => String(v || '').split('.').map((n) => parseInt(n, 10) || 0);

export function cmpVersion(a, b) {
  const x = parse(a), y = parse(b);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0) ? -1 : 1;
  return 0;
}

// level：
//   same      完全一致
//   patch     只差补丁号——静默，补丁版本互相兼容
//   ext-old   扩展落后一个次版本以上：新命令可能还不认识，出错时再提
//   cli-old   本地端落后：照常能用，只是缺新功能，提一次怎么升级
//   protocol  协议号不同：真不兼容
export function compat({ ext, cli, extProtocol = PROTOCOL, cliProtocol = PROTOCOL }) {
  if (!ext || !cli) return 'same';
  if (Number(extProtocol) !== Number(cliProtocol)) return 'protocol';
  const c = cmpVersion(ext, cli);
  if (c === 0) return 'same';
  const [a1, a2] = parse(ext), [b1, b2] = parse(cli);
  if (a1 === b1 && a2 === b2) return 'patch';
  return c < 0 ? 'ext-old' : 'cli-old';
}

export const UPDATE_EXT = '商店装的扩展 Chrome 会在几小时内自动更新；等不及就打开 chrome://extensions，开「开发者模式」后点「更新」。手动加载的扩展要去那一页点「重新加载」。';
export const UPDATE_CLI = '在终端跑一次 npx -y lingee-chrome@latest install，然后重启你的 agent。';

// 给人看的一句话。same / patch 返回空串——没事就别说话。
export function compatNote(level, { ext, cli }) {
  if (level === 'protocol') return `扩展 v${ext} 和本地端 v${cli} 的通信协议不兼容，命令可能失败。${cmpVersion(ext, cli) < 0 ? UPDATE_EXT : UPDATE_CLI}`;
  if (level === 'ext-old') return `扩展 v${ext} 比本地端 v${cli} 旧，新功能可能还用不了。${UPDATE_EXT}`;
  if (level === 'cli-old') return `本地端 v${cli} 比扩展 v${ext} 旧，有新功能没用上。${UPDATE_CLI}`;
  return '';
}
