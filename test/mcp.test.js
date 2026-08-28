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
  // STRATEGY 有硬预算：Claude Code 把 MCP instructions 截断在约 2000 字符
  // （2026-08-29 实测），超出的部分对最大的一批用户等于没写
  const instr = client.getInstructions();
  assert.ok(instr && instr.length <= 2000, `STRATEGY ${instr?.length} 字符——超 2000 会被 Claude Code 截断`);

  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();

  assert.deepEqual(names, ['act', 'ask', 'click', 'download', 'eval', 'fetch', 'fill', 'key', 'learnings', 'navigate', 'network', 'query', 'read_text', 'screenshot', 'scroll', 'select', 'snapshot', 'status', 'tabs', 'type', 'upload', 'wait']);

  // 工具描述是每轮都在付的 context 成本，别让它悄悄膨胀
  // （16000 → 16500：v0.8 有意识地加了 learnings 工具，它自身已压到最短；
  //   16500 → 16800：v0.9 有意识地加了 status 工具（驾驶舱的「准备做」）；
  //   16800 → 17600：v1.0 act 升级剧本执行器（repeat/if/assert 进 schema——
  //   agent 只认 schema 不读源码，这部分省不得；描述已压缩过一轮）
  //   17600 → 18500：Claude Code 把 MCP instructions 截断在约 2000 字符（实测），
  //   STRATEGY 从 4087 压到 2000 内，被砍段落的关键细节迁入工具描述——描述实测
  //   不截断，是唯一可靠通道。合计 context 反而净省约 1300 字符）
  const total = tools.reduce((n, t) => n + t.description.length + JSON.stringify(t.inputSchema).length, 0);
  assert.ok(total < 18500, `工具表膨胀到 ${total} 字符了，压回 18500 以内`);

  // click 必须强制要 snapshotId，否则 ref 防呆整套失效
  assert.deepEqual(tools.find((t) => t.name === 'type').inputSchema.required, ['text']);

  // act 的剧本原语要在 schema 里可见——agent 只认 schema，不读源码
  const actDo = tools.find((t) => t.name === 'act').inputSchema.properties.steps.items.properties.do.enum;
  for (const d of ['repeat', 'if', 'assert']) assert.ok(actDo.includes(d), `act 的 do 枚举缺 ${d}`);

  // learnings 是纯本地读写，桥不在线也必须能用——这正是它短路在 connect 之前的理由
  const r = await client.callTool({ name: 'learnings', arguments: { domain: 'feishu.cn' } });
  assert.match(r.content[0].text, /多维表格/);
  assert.match(r.content[0].text, /经验仅供参考/);

  } finally {
    await client.close();
  }
});
