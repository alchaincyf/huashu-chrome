// 扩展文件夹的「最新修改」——doctor 判断哪个 profile 还在跑旧代码、dev 过滤无关改动，都靠它。
import fs from 'node:fs';
import path from 'node:path';

// 编辑器的临时文件、隐藏文件不算改动：保存一次 VS Code 会先写 .xxx.tmp 再改名，
// 拿它们去触发重载只会多重载一次
export function isNoiseFile(rel) {
  const parts = String(rel).split(/[\\/]/);
  const base = parts[parts.length - 1] || '';
  return parts.some((p) => p.startsWith('.')) || /~$|\.sw[a-p]$|\.tmp$|\.crdownload$/i.test(base);
}

// 递归找最新改过的文件。返回 { file（相对 dir）, mtimeMs }，空目录返回 null
export function newestFile(dir) {
  let best = null;
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      const rel = path.relative(dir, full);
      if (isNoiseFile(rel) || e.name === 'node_modules') continue;
      if (e.isDirectory()) { walk(full); continue; }
      let st;
      try { st = fs.statSync(full); } catch { continue; }
      if (!best || st.mtimeMs > best.mtimeMs) best = { file: rel, mtimeMs: st.mtimeMs };
    }
  };
  walk(dir);
  return best;
}

// 实例装载之后文件夹又被改过 → 它跑的是旧代码。给 1 秒余量：
// 「保存 → 立刻重载」时 mtime 和装载时刻可能落在同一秒里
export function staleInstances(extensions, newest) {
  if (!newest) return [];
  return (extensions || []).filter((e) => !e.headless && e.loadedAt && newest.mtimeMs > e.loadedAt + 1000);
}
