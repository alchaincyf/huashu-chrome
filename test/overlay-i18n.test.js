import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const mark = read('extension/mark.js');
const background = read('extension/background.js');
const en = JSON.parse(read('extension/_locales/en/messages.json'));
const zh = JSON.parse(read('extension/_locales/zh_CN/messages.json'));

function overlayHelper(source, i18n) {
  const start = source.indexOf('function overlayMessage(');
  assert.notEqual(start, -1, 'overlayMessage helper is missing');
  const blankLine = /\r?\n\r?\n/g;
  blankLine.lastIndex = start;
  const end = blankLine.exec(source)?.index;
  assert.ok(end !== undefined, 'overlayMessage helper has no boundary');
  const context = { chrome: i18n ? { i18n } : undefined };
  vm.runInNewContext(`${source.slice(start, end)}\nglobalThis.overlayMessage = overlayMessage;`, context);
  return context.overlayMessage;
}

function paymentSection(source) {
  source = source.replace(/\r\n/g, '\n');
  const start = source.indexOf('async function confirmPay(id, pay) {');
  const end = source.indexOf('\n}\n\n// ---------- 写请求旁证 ----------', start);
  assert.ok(start >= 0 && end > start, 'confirmPay section is missing');
  return source.slice(start, end + 2);
}

test('overlay catalogs cover the same referenced keys and use Chrome positional placeholders', () => {
  const referenced = new Set(
    [...`${mark}\n${background}`.matchAll(/'overlay_[a-z_]+'/g)].map(([key]) => key.slice(1, -1)),
  );
  assert.deepEqual(new Set(Object.keys(en)), new Set(Object.keys(zh)));
  for (const key of referenced) {
    assert.ok(en[key] && zh[key], `missing locale entry: ${key}`);
  }
  for (const [key, entry] of Object.entries(en)) {
    assert.equal(typeof entry.message, 'string', `English message missing for ${key}`);
    assert.equal(typeof zh[key].message, 'string', `Chinese message missing for ${key}`);
    const placeholders = (value) => [...value.matchAll(/\$(\d+)/g)].map((m) => m[1]).sort();
    assert.deepEqual(placeholders(entry.message), placeholders(zh[key].message), `placeholder mismatch: ${key}`);
    assert.doesNotMatch(entry.message, /\$\d+\$/);
    assert.doesNotMatch(zh[key].message, /\$\d+\$/);
  }
});

test('overlayMessage uses native i18n and substitutes fallback values literally', () => {
  const dangerous = '$& $1 <b>literal</b>';
  for (const source of [mark, background]) {
    const requested = [];
    const nativeHelper = overlayHelper(source, {
      getMessage(key, substitutions) {
        requested.push([key, substitutions]);
        const template = en[key]?.message || '';
        return template.replace(/\$(\d+)/g, (_match, position) => String(substitutions?.[Number(position) - 1] ?? ''));
      },
    });
    assert.equal(nativeHelper('overlay_marker_working', '$1 is working', [dangerous]), `${dangerous} is working on this page`);
    assert.deepEqual(requested[0], ['overlay_marker_working', [dangerous]]);

    const fallbackHelper = overlayHelper(source);
    assert.equal(fallbackHelper('missing', 'prefix $1 / $2', [dangerous, '$&']), `prefix ${dangerous} / $&`);
  }
});

test('page marker has a localized accessible name and keyboard activation', () => {
  assert.match(mark, /b\.setAttribute\('aria-label', markerName\)/);
  assert.match(mark, /b\.setAttribute\('role', 'button'\)/);
  assert.match(mark, /b\.tabIndex = 0/);
  assert.match(mark, /event\.key === 'Enter' \|\| event\.key === ' '/);
  assert.match(mark, /overlay_marker_working/);
  assert.match(mark, /overlay_marker_open_hint/);
});

test('ask prompts and facts remain text-only data in the injected overlay', () => {
  assert.match(mark, /\.querySelector\('\.p'\)\.textContent = msg\.prompt/);
  assert.match(mark, /val\.textContent = v/);
  const template = mark.match(/askEl\.innerHTML = `([\s\S]*?)`;/)?.[1];
  assert.ok(template, 'static ask skeleton is missing');
  assert.doesNotMatch(template, /\$\{/);
});

test('localized payment confirmation allows only explicit consent and preserves payment facts', async () => {
  for (const locale of [en, zh]) {
    for (const outcome of ['continued', 'cancelled', 'timed_out']) {
      let shown, notification;
      const pay = { label: '<script>Pay $&</script>', amount: '$12.34' };
      const context = {
        payTimeout: 60000,
        pollPanel: async () => ({ outcome }),
        overlayMessage: (key) => locale[key].message,
        chrome: {
          tabs: { get: async () => ({ windowId: 2, title: 'Original 中文', url: 'https://example.com' }), update: async () => {}, sendMessage: async (_id, message) => { shown = message; } },
          windows: { update: async () => {} }, scripting: { executeScript: async () => {} },
          notifications: { create: (_id, message) => { notification = message; } }, runtime: {},
        },
      };
      vm.runInNewContext(`${paymentSection(background)}\nglobalThis.confirmPay = confirmPay;`, context);
      assert.equal(await context.confirmPay(1, pay), outcome === 'continued');
      assert.equal(shown.__hcAsk, 'show');
      assert.equal(shown.danger, true);
      assert.equal(shown.timeout, 60000);
      assert.equal(shown.okText, locale.overlay_pay_confirm.message);
      assert.equal(shown.noText, locale.overlay_pay_cancel.message);
      assert.equal(shown.facts[0][1], pay.label);
      assert.equal(shown.facts[1][1], pay.amount);
      assert.equal(shown.facts[2][1], 'Original 中文');
      assert.equal(notification.title, locale.overlay_pay_notification_title.message);
    }
  }
});
