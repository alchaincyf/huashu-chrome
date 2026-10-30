// 站点白名单 —— 纯裁决逻辑，不碰 chrome API、不读文件，为的是能被 `npm test` 直接跑到。
//
// 设计原则（lingee-chrome 的"带权限"卖点就靠这一层）：
//   · 裁决放在桥里做，agent 够不着——injection 让模型说任何话，也改不动它调不到的开关。
//   · 默认放行、主动开启：没配置时全放行（升级不打断现有用户）；
//     用户显式把 mode 设成 'allowlist' 后，才进入"默认拒绝、只许名单内"的严格模式。
//     这条是故意的——企业内部部署时把 mode 设 allowlist + sites 填内部域名，
//     就成了"只能操作金蝶内部系统"的闸门。
//
// 配置文件 ~/.lingee-chrome/allowlist.json 的形状：
//   { "mode": "allowlist", "sites": ["kdm.lingee.com", "kingdee.com"] }
//   mode 省略或非 'allowlist' = 关闭（全放行）。

// 从 url 取主机名；取不到回空串，不抛。
export function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

// 主机是否命中名单。子域也算：名单写 kingdee.com，www.kingdee.com / a.b.kingdee.com 都算同一机构。
// 反向不成立——写 a.kingdee.com 不会放行 kingdee.com。
// 防伪后缀：evil-kingdee.com 不是 kingdee.com 的子域，必须用 '.' + s 判，不能裸 endsWith。
export function hostAllowed(host, sites) {
  if (!host) return false;
  const list = Array.isArray(sites) ? sites : [];
  return list.some((s) => host === s || host.endsWith('.' + s));
}

// 核心裁决：给定一条命令的 url 和当前白名单配置，返回 null（放行）或一个 gate 对象（拦截）。
//   list 为 null/非对象/mode 非 allowlist  → 放行（白名单未开启）
//   url 为空（命令本身不带 url，如纯 click）→ 放行（这一层只管"去哪个站"）
//   url 解析不出主机名                      → 放行（交给下游处理，不在这里误伤）
//   主机不在名单                            → 拦截
export function decideSite(url, list) {
  if (!list || typeof list !== 'object' || list.mode !== 'allowlist') return null;
  if (!url) return null;
  const host = hostOf(url);
  if (!host) return null;
  if (hostAllowed(host, list.sites)) return null;
  return {
    code: 'SITE_NOT_ALLOWED',
    message: `${host} 不在授权站点列表里，请在扩展侧栏里授权`,
  };
}
