// MCP 层冒烟测试：用官方 SDK 的 client 走一遍 stdio，确认 agent 那侧真的能挂上。
// tools/list 不碰桥，所以不需要 Chrome。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.js');

test('agent 能通过 stdio 挂上 MCP server 并拿到工具表', async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI, 'mcp', '--client', 'test'],
  });
  const client = new Client({ name: 'test', version: '0' }, { capabilities: {} });
  await client.connect(transport);

  // try/finally 不是讲究：断言一失败就 throw，close() 跑不到，子进程留在那儿，
  // node --test 于是永远不退出——症状是「测试卡住」而不是「测试失败」，
  // 排查成本天差地别。
  try {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();

  assert.deepEqual(names, ['ask', 'click', 'download', 'eval', 'fetch', 'fill', 'key', 'navigate', 'network', 'query', 'read_text', 'screenshot', 'scroll', 'select', 'snapshot', 'tabs', 'type', 'upload', 'wait']);

  // 工具描述是每轮都在付的 context 成本，别让它悄悄膨胀
  const total = tools.reduce((n, t) => n + t.description.length + JSON.stringify(t.inputSchema).length, 0);
  assert.ok(total < 16000, `工具表膨胀到 ${total} 字符了，压回 16000 以内`);

  // click 必须强制要 snapshotId，否则 ref 防呆整套失效
  assert.deepEqual(tools.find((t) => t.name === 'type').inputSchema.required, ['text']);

  } finally {
    await client.close();
  }
});
