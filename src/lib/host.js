// 宿主识别 —— 页面右下角驾驶舱和审计日志里「谁在操控」那个名字的来源。
//
// 以前只认启动参数 --client。它由 install 写进各 agent 的配置，本该一家一个值，
// 但配置会被人手抄：花叔自己的 Codex 配置就抄成了 --client claude-code，于是
// Codex 干活时页面右下角写着「Claude Code」（2026-09-09）。开源出去之后用户
// 环境只会更杂（一段配置在 Codex / OpenClaw / Hermes / WorkBuddy 之间复制粘贴是
// 常态），一个给人看的身份不能押在一段手填的参数上。
//
// MCP 的 initialize 握手里宿主会自报家门（clientInfo.name）。那是宿主自己说的，
// 不经过任何人手，以它为准；--client 只在宿主没报、或报了个泛称时兜底。
// 显示名从 src/agents.json 取——那张表的承诺是「加一个 agent 只加一行」，
// 这里不另维护第二张表。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const AGENTS = JSON.parse(
  fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'agents.json'), 'utf8'),
).agents;

// 自报名和 agents.json 的 slug 连前缀都对不上的那几个。
// gemini-cli-mcp-client → gemini、cursor-vscode → cursor、roo-code → roo
// 这类靠前缀就能认，不进表。
//
// 实测过的自报名（2026-09-09）：Claude Code = "claude-code"，Codex = "codex-mcp-client"。
// 其余是凭印象写的，没上真机验过。每次会话都会往审计里记一条 {ev:"host", raw}，
// 某家显示不对就去那里看它到底报了什么，再补到这里。
const ALIAS = { 'claude-ai': 'claude-desktop' };

// 泛称：说的是「我是个 MCP 客户端」，不是「我是谁」——等于没报
const GENERIC = new Set(['', 'mcp', 'client', 'unknown', 'anonymous']);

// "Codex-MCP-Client" → codex；"Roo Code" → roo-code
export function slugOf(name) {
  const s = String(name || '').trim().toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/(-mcp)?-(client|host)$/, '')
    .replace(/^-+|-+$/g, '');
  return ALIAS[s] || s;
}

// 返回 { client, label, raw, source }：client 是审计和 sid 用的 slug，
// label 是给人看的显示名（agents.json 里没有就不给，扩展侧会机械美化 slug）。
export function resolveHost({ clientInfo, flag } = {}) {
  const raw = clientInfo?.name;
  const slug = slugOf(raw);
  if (!GENERIC.has(slug)) {
    const known = AGENTS.find((a) => slug === a.client || slug.startsWith(a.client + '-'));
    return { client: known ? known.client : slug, label: known?.name, raw, source: 'clientInfo' };
  }
  const f = slugOf(flag);
  const known = AGENTS.find((a) => f === a.client);
  return { client: GENERIC.has(f) ? 'unknown' : f, label: known?.name, raw, source: 'flag' };
}
