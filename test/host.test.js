// 宿主识别：右下角驾驶舱和审计里「谁在操控」的名字，以宿主在 MCP 握手里自报的
// clientInfo 为准，--client 只兜底。2026-09-09 的真实事故：Codex 的配置被人手抄成
// --client claude-code，Codex 干活时页面上写着「Claude Code」。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveHost, slugOf } from '../src/lib/host.js';
import { BridgeClient } from '../src/lib/rpc.js';

test('宿主自报的身份压过抄错的 --client', () => {
  const h = resolveHost({ clientInfo: { name: 'codex-mcp-client', version: '0.1' }, flag: 'claude-code' });
  assert.equal(h.client, 'codex');
  assert.equal(h.label, 'Codex CLI');
  assert.equal(h.source, 'clientInfo');
});

test('各家自报名归一到 agents.json 的 slug，显示名从表里取', () => {
  const cases = [
    ['claude-code', 'claude-code', 'Claude Code'],
    ['gemini-cli-mcp-client', 'gemini', 'Gemini CLI'],
    ['cursor-vscode', 'cursor', 'Cursor'],
    ['claude-ai', 'claude-desktop', 'Claude Desktop'],
    ['Roo Code', 'roo', 'Roo Code'],
    ['Cline', 'cline', 'Cline (VS Code)'],
  ];
  for (const [raw, client, label] of cases) {
    const h = resolveHost({ clientInfo: { name: raw }, flag: 'unknown' });
    assert.equal(h.client, client, raw);
    assert.equal(h.label, label, raw);
  }
});

test('没听说过的宿主原样保留它自报的名字，不冒充别家', () => {
  const h = resolveHost({ clientInfo: { name: 'Hermes Agent' }, flag: 'claude-code' });
  assert.equal(h.client, 'hermes-agent');
  assert.equal(h.label, undefined);   // 扩展侧会美化成 Hermes Agent
});

test('宿主没报或报了泛称，才退回 --client', () => {
  assert.equal(resolveHost({ clientInfo: undefined, flag: 'codex' }).client, 'codex');
  assert.equal(resolveHost({ clientInfo: { name: 'mcp-client' }, flag: 'workbuddy' }).label, 'WorkBuddy');
  const h = resolveHost({ clientInfo: { name: '' }, flag: undefined });
  assert.equal(h.client, 'unknown');
  assert.equal(h.source, 'flag');
});

test('slugOf 只剥「我是 MCP 客户端」这种后缀，不动名字本身', () => {
  assert.equal(slugOf('Codex-MCP-Client'), 'codex');
  assert.equal(slugOf('kimi_code'), 'kimi-code');
  assert.equal(slugOf('claude-code'), 'claude-code');
});

test('BridgeClient 在连桥之前可以改口，连上之后不行', () => {
  const c = new BridgeClient({ client: 'claude-code' });
  assert.ok(c.sessionId.startsWith('claude-code:'));
  assert.equal(c.identify('codex', 'Codex CLI'), true);
  assert.equal(c.client, 'codex');
  assert.equal(c.label, 'Codex CLI');
  assert.ok(c.sessionId.startsWith('codex:'), 'sid 前缀要跟着换，扩展从它推显示名');
  // 宿主自带的 sessionId 是更准的身份，改口不能把它冲掉
  const pinned = new BridgeClient({ client: 'x', sessionId: 'host-given' });
  pinned.identify('codex');
  assert.equal(pinned.sessionId, 'host-given');
  c.ws = {};
  assert.equal(c.identify('gemini'), false);
  assert.equal(c.client, 'codex');
});
