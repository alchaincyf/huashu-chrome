// fetch 的自动翻页住在 MCP 这一侧（循环、停机判定、落盘都不该经过模型）。
// 用假桥喂固定响应，守三件事：页码递增、游标接力、每种停机判据都停得下来。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fetchPages } from '../src/mcp-server.js';

// 假桥：按 URL 回响应体，顺便记下被调了几次
const fakeBridge = (answer) => {
  const calls = [];
  return {
    calls,
    async call(cmd, p) {
      assert.equal(cmd, 'fetch');
      calls.push(p.url);
      const r = answer(new URL(p.url));
      return { text: `${r.status ?? 200}\n\n${r.body}` };
    },
  };
};

test('页码型：递增 param，空体就停', async () => {
  const b = fakeBridge((u) => {
    const page = Number(u.searchParams.get('page'));
    return { body: page <= 3 ? JSON.stringify([{ id: page }]) : '[]' };
  });
  const out = await fetchPages(b, { url: 'https://x.test/api?page=1&size=50', pages: { param: 'page' } });
  assert.equal(b.calls.length, 4);
  assert.match(out, /已抓 3 页/);
  assert.match(out, /翻到头了/);
  assert.match(b.calls[1], /page=2/);
  assert.match(b.calls[1], /size=50/);   // 别的参数原样保留
});

test('游标型：从响应里按路径取下一个游标，游标空了就停', async () => {
  const b = fakeBridge((u) => {
    const c = u.searchParams.get('cursor') || '';
    const next = { '': 'c1', c1: 'c2', c2: '' }[c];
    return { body: JSON.stringify({ data: { items: [c || 'first'], next_cursor: next } }) };
  });
  const out = await fetchPages(b, { url: 'https://x.test/feed', pages: { cursorParam: 'cursor', cursorPath: 'data.next_cursor' } });
  assert.equal(b.calls.length, 3);
  assert.match(b.calls[2], /cursor=c2/);
  assert.match(out, /游标为空/);
});

test('和上一页一模一样、非 2xx、跑满 max，各自停得下来并说明原因', async () => {
  const same = fakeBridge(() => ({ body: '{"a":1}' }));
  assert.match(await fetchPages(same, { url: 'https://x.test/a', pages: { param: 'p' } }), /一模一样/);
  assert.equal(same.calls.length, 2);

  const bad = fakeBridge((u) => ({ status: Number(u.searchParams.get('p')) === 2 ? 500 : 200, body: JSON.stringify({ p: u.searchParams.get('p') }) }));
  const out = await fetchPages(bad, { url: 'https://x.test/a', pages: { param: 'p' } });
  assert.match(out, /已抓 1 页/);
  assert.match(out, /返回 500/);

  let i = 0;
  const endless = fakeBridge(() => ({ body: JSON.stringify({ n: i++ }) }));
  assert.match(await fetchPages(endless, { url: 'https://x.test/a', pages: { param: 'p', max: 3 } }), /跑满 max=3/);
  assert.equal(endless.calls.length, 3);
});

test('带 savePath 时每页一行 JSON 落盘，回执只有摘要和第一页预览', async () => {
  const b = fakeBridge((u) => ({ body: JSON.stringify({ page: Number(u.searchParams.get('page')), rows: ['x'] }) }));
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hc-pages-')), 'out.jsonl');
  const out = await fetchPages(b, { url: 'https://x.test/api?page=1', pages: { param: 'page', max: 2 }, savePath: file });
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 2);
  assert.equal(lines[1].body.page, 2);           // JSON 能解析就存解析后的
  assert.match(out, new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(out, /第 1 页预览/);
  assert.doesNotMatch(out, /"page":2/);           // 第二页的内容不进回执
});

test('没给 param 也没给 cursorParam 时直接报错，不瞎猜', async () => {
  await assert.rejects(() => fetchPages(fakeBridge(() => ({ body: '' })), { url: 'https://x.test/a', pages: {} }), /param/);
});
