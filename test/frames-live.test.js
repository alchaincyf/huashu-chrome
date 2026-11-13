// Frame targeting, trusted input inside nested frames, whole-document editor
// edits, frame-scoped upload and stable screenshots — against a real Chrome.
//
// Like scenarios.test.js this needs Chrome with the extension connected, so it
// is not part of `npm test`. Run: `npm run test:frames`
// (HUASHU_TEST_PROFILE=<name> picks the Chrome profile; it opens one
// background tab and closes it at the end).
//
// The range (test/fixtures/frames.html): nine small "ad" frames come first in
// document order, then a hidden 0×0 frame, then the real work surface — a
// cross-site frame (127.0.0.1 ↔ localhost, out of process) holding a Monaco
// editor one level deeper. Monaco comes from jsdelivr, so this needs network.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { BridgeClient } from '../src/lib/rpc.js';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const PORT = 8125;
const PAGE = `http://127.0.0.1:${PORT}/frames.html`;
let server, server6, c, tabId;

const handler = (req, res) => {
  const p = (req.url || '/').split('?')[0].replace(/^\//, '') || 'frames.html';
  fs.readFile(path.join(DIR, p), (e, b) => {
    if (e) { res.writeHead(404); return res.end('nope'); }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(b);
  });
};

const call = (cmd, params = {}) => c.call(cmd, { tabId, ...params }, { tabId, timeoutMs: 60000 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function framesNow() {
  return (await call('frames')).frames;
}
const editorFrame = async () => (await framesNow()).find((f) => /frames-monaco\.html/.test(f.url));
const midFrame = async () => (await framesNow()).find((f) => /frames-mid\.html/.test(f.url));

before(async () => {
  server = http.createServer(handler);
  server6 = http.createServer(handler);
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  await new Promise((r) => server6.listen(PORT, '::1', r)).catch(() => {});
  c = new BridgeClient({ client: 'test' });
  await c.connect();
  if (!c.extensionOnline) throw new Error('Chrome extension not connected; run with Chrome open.');
  if (process.env.HUASHU_TEST_PROFILE) await c.call('profiles', { use: process.env.HUASHU_TEST_PROFILE });
  ({ tabId } = await c.call('tabs', { action: 'new', url: PAGE, label: 'huashu frames test' }));
  // wait for Monaco (CDN) in the nested cross-site frame
  for (let i = 0; i < 60; i++) {
    const f = await editorFrame().catch(() => null);
    if (f && (await call('eval', { frameId: f.frameId, expr: '!!window.editorReady' }).catch(() => ({}))).text === 'true') return;
    await sleep(500);
  }
  throw new Error('Monaco did not load in the nested frame (network?)');
});

after(async () => {
  try { await c.call('tabs', { action: 'close', tabId }); } catch { /* gone */ }
  c?.close();
  server?.close();
  server6?.close();
});

test('frames: every frame is listed with parent, size and status — more than eight, hidden ones marked', async () => {
  const list = await framesNow();
  assert.ok(list.length >= 13, `expected ≥13 frames (top + 9 ads + ghost + mid + editor), got ${list.length}`);
  const ed = list.find((f) => /frames-monaco/.test(f.url));
  const mid = list.find((f) => /frames-mid/.test(f.url));
  assert.equal(ed.parent, mid.frameId, 'editor frame is a child of the middle frame');
  assert.equal(mid.parent, 0);
  assert.equal(ed.status, 'visible');
  assert.equal(list.find((f) => /ghost=1/.test(f.url)).status, 'hidden');
  assert.match(ed.handle, /^\d+:[0-9a-f]{8}$/);
});

test('snapshot expands the big work frames even though nine small ones come first, and names the rest', async () => {
  const snap = await call('snapshot');
  const ed = await editorFrame();
  assert.match(snap.text, new RegExp(`iframe f${ed.frameId} `), 'the editor frame is expanded');
  assert.match(snap.text, /另有 \d+ 个 iframe 没展开|没有可交互元素的 iframe/, 'truncated / empty frames are named');
  assert.match(snap.text, /隐藏（0×0）的 iframe/);
  const one = await call('snapshot', { frameId: ed.frameId });
  assert.match(one.text, new RegExp(`\\[e\\d+@f${ed.frameId}\\]\\s+button\\s+"Import"`));
});

test('selector / find / query / read_text / eval all run inside the chosen frame', async () => {
  const mid = await midFrame();
  const q = await call('query', { frameId: mid.frameId, contains: 'Middle frame' });
  assert.match(q.text, /Middle frame/);
  const top = await call('query', { contains: 'Middle frame' });
  assert.doesNotMatch(top.text, /mid-btn/, 'not found in the top document');
  const rt = await call('read_text', { frameId: mid.frameId, scope: 'page', format: 'text' });
  assert.match(rt.text, /frames-mid\.html/);
  const r = await call('click', { frameId: mid.frameId, selector: '#mid-btn', real: true });
  assert.match(r.text, /真实事件/, 'trusted input inside a cross-site frame');
  assert.equal((await call('eval', { frameId: mid.frameId, expr: 'document.getElementById("mid-out").textContent' })).text, '"clicked"');
});

test('editor: replace a nested Monaco JSON document with Vietnamese and multiline text, read back byte for byte', async () => {
  const ed = await editorFrame();
  const doc = JSON.stringify({
    name: 'Kiểm thử — đồng bộ dữ liệu “TEST”',
    note: 'Dòng một\nDòng hai\n\tthụt tab',
    objects: [{ table: 'Orders', partition: 'Probe' }, { table: 'Costs', partition: 'Probe' }],
  }, null, 4) + '\n';
  const r = await call('editor', { frameId: ed.handle, selector: '.monaco-editor textarea', action: 'replace', text: doc });
  assert.equal(r.match, true, r.text);
  assert.equal(r.sha256, crypto.createHash('sha256').update(doc).digest('hex'));
  // ground truth from the Monaco model itself
  const model = (await call('eval', { frameId: ed.frameId, expr: 'window.editor.getValue()' })).text;
  assert.equal(JSON.parse(model), doc);
  const back = await call('editor', { frameId: ed.frameId, selector: '.monaco-editor textarea', action: 'read' });
  assert.ok(back.text.endsWith(doc.replace(/\n$/, '')) || back.text.includes(doc.trim()), 'read returns the full text');
  assert.match(back.text, /JSON 语法：有效/);
});

test('editor: invalid JSON is reported, not passed off as success', async () => {
  const ed = await editorFrame();
  const r = await call('editor', { frameId: ed.frameId, selector: '.monaco-editor textarea', action: 'replace', text: '{\n  "a": [1, 2\n}' });
  assert.equal(r.match, true);
  assert.match(r.text, /JSON 语法：无效/);
});

test('upload: a button that opens the picker is driven without an OS dialog; invalid content is rejected by the app', async () => {
  const ed = await editorFrame();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-frames-'));
  const good = path.join(tmp, 'good.json');
  const bad = path.join(tmp, 'bad.json');
  fs.writeFileSync(good, '{"ok": true}');
  fs.writeFileSync(bad, '{"ok": ');
  const up = (p) => call('upload', { path: p, name: path.basename(p), type: 'application/json', bytes: fs.statSync(p).size, trigger: { frameId: ed.frameId, selector: '#import' } });
  await up(bad);
  assert.match((await call('eval', { frameId: ed.frameId, expr: 'document.getElementById("status").textContent' })).text, /rejected bad\.json/);
  await up(good);
  assert.match((await call('eval', { frameId: ed.frameId, expr: 'document.getElementById("status").textContent' })).text, /accepted good\.json/);
});

test('upload: no input and no dropSelector is an error, never a guessed drop', async () => {
  const mid = await midFrame();
  await assert.rejects(
    call('upload', { path: fileURLToPath(import.meta.url), name: 'x.json', type: 'application/json', bytes: 2, base64: 'e30=', frameId: mid.frameId }),
    (e) => e.code === 'NO_FILE_INPUT',
  );
});

test('a frame handle is refused once that frame has loaded another document', async () => {
  const mid = await midFrame();
  await call('eval', { frameId: mid.frameId, expr: 'location.reload(), 1' }).catch(() => {});
  await sleep(1500);
  await assert.rejects(call('query', { frameId: mid.handle, contains: 'Middle' }), (e) => e.code === 'STALE_FRAME');
});

test('screenshot leaves the viewport alone and says how image pixels map to CSS pixels', async () => {
  const size = async () => (await call('eval', { expr: '[innerWidth, innerHeight]' })).text.replace(/\s/g, '');
  const before = await size();
  const a = await call('screenshot');
  const b = await call('screenshot', { full: true });
  assert.equal(await size(), before, 'innerWidth/innerHeight unchanged');
  for (const s of [a, b]) {
    assert.ok(s.viewport && s.image, 'geometry returned');
    assert.equal(s.scale, Math.round((s.image.width / s.viewport.width) * 1000) / 1000);
  }
  assert.ok(Math.abs(a.scale - 0.6) < 0.02, `scaled shot is 60% of CSS px, got ${a.scale}`);
  assert.ok(Math.abs(b.scale - 1) < 0.02, `full shot is 1:1 CSS px, got ${b.scale}`);
});
