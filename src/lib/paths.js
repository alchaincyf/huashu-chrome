// 配置目录与 token —— 桥和 MCP server 共用的落盘约定
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const HOME = path.join(os.homedir(), '.huashu-chrome');
export const BRIDGE_FILE = path.join(HOME, 'bridge.json');
export const LOCK_FILE = path.join(HOME, 'bridge.lock');
export const AUDIT_FILE = path.join(HOME, 'audit.jsonl');
export const ALLOWLIST_FILE = path.join(HOME, 'allowlist.json');
export const LOG_FILE = path.join(HOME, 'bridge.log');

export const DEFAULT_PORT = 8899;

export function ensureHome() {
  fs.mkdirSync(HOME, { recursive: true, mode: 0o700 });
  return HOME;
}

// 桥启动时写：端口、token、pid。token 每次启动轮换。
export function writeBridgeInfo(info) {
  ensureHome();
  const tmp = BRIDGE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(info, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, BRIDGE_FILE);
}

export function readBridgeInfo() {
  try {
    return JSON.parse(fs.readFileSync(BRIDGE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

export function newToken() {
  return crypto.randomBytes(32).toString('hex');
}

// 常数时间比较，避免 token 被计时侧信道试探出来
export function tokenEquals(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

// 审计日志：每条命令一行，出事能查。桥是唯一写入方。
export function audit(entry) {
  try {
    ensureHome();
    fs.appendFileSync(AUDIT_FILE, JSON.stringify({ t: new Date().toISOString(), ...entry }) + '\n');
  } catch {
    // 审计失败不能拖垮主流程
  }
}

// ---------- 桥只认自己的扩展（#14）----------
//
// 浏览器替扩展发的 Origin 是 chrome-extension://<id>，不可伪造；但以前桥对任何扩展 id 都放行，
// 用户装的随便哪个扩展都能冒充 huashu-chrome 连进来接命令。现在只放行：
//   1. 商店版的 id（商店分配，和 manifest 的 key 推出来的不是同一个）
//   2. manifest key 推出来的 id——「加载已解压的扩展程序」那条官方手动安装路径
//   3. 用户显式加的：环境变量 HUASHU_CHROME_TRUSTED_EXTENSION_IDS（逗号分隔），
//      或 ~/.huashu-chrome/trusted-extensions.json 里的 {"ids": [...]}。默认都没有。
// 改过 key 的 fork、删了 key 的本地构建，走第 3 条。
export const STORE_EXTENSION_ID = 'foiljmaplphdfimfcnfdpekhdnfbgfbf';
export const TRUSTED_EXTENSIONS_FILE = path.join(HOME, 'trusted-extensions.json');
const EXT_ID_RE = /^[a-p]{32}$/;

export function manifestExtensionId() {
  try {
    const manifest = new URL('../../extension/manifest.json', import.meta.url);
    const key = JSON.parse(fs.readFileSync(manifest, 'utf8')).key;
    if (!key) return null;
    const hex = crypto.createHash('sha256').update(Buffer.from(key, 'base64')).digest('hex').slice(0, 32);
    return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
  } catch {
    return null;
  }
}

// 每次有扩展来连时现读：改了配置不用重启桥
export function trustedExtensionIds() {
  const ids = new Set([STORE_EXTENSION_ID]);
  const fromManifest = manifestExtensionId();
  if (fromManifest) ids.add(fromManifest);
  for (const id of (process.env.HUASHU_CHROME_TRUSTED_EXTENSION_IDS || '').split(',')) {
    if (EXT_ID_RE.test(id.trim())) ids.add(id.trim());
  }
  try {
    const extra = JSON.parse(fs.readFileSync(TRUSTED_EXTENSIONS_FILE, 'utf8')).ids;
    if (Array.isArray(extra)) for (const id of extra) if (EXT_ID_RE.test(id)) ids.add(id);
  } catch {
    // 没有这个文件是常态
  }
  return ids;
}
