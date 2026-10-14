import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { t, localizeDocument } from '../extension/i18n.js';

const read = (file) => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const catalogs = Object.fromEntries(['en', 'zh_CN'].map((locale) => [locale, JSON.parse(read(`extension/_locales/${locale}/messages.json`))]));

test('Chrome catalogs cover manifest and every static and dynamic UI message', () => {
  const manifest = JSON.parse(read('extension/manifest.json'));
  assert.equal(manifest.default_locale, 'en');
  assert.equal(manifest.description, '__MSG_extension_description__');
  const keys = Object.keys(catalogs.en).sort();
  assert.deepEqual(Object.keys(catalogs.zh_CN).sort(), keys);
  const used = new Set(['extension_description', 'ui_document_language']);
  for (const page of ['panel', 'welcome']) {
    for (const match of read(`extension/${page}.html`).matchAll(/data-i18n(?:-[\w-]+)?="([\w]+)"/g)) used.add(`ui_${match[1]}`);
    for (const match of read(`extension/${page}.js`).matchAll(/\bt\('([\w]+)'/g)) used.add(`ui_${match[1]}`);
  }
  for (const file of ['background', 'mark']) {
    for (const match of read(`extension/${file}.js`).matchAll(/['"](overlay_[\w]+)['"]/g)) used.add(match[1]);
  }
  for (const locale of Object.keys(catalogs)) {
    for (const key of used) assert.ok(catalogs[locale][key]?.message, `${locale}: missing ${key}`);
    for (const key of keys) {
      const substitutions = (message) => [...message.matchAll(/\$\d+/g)].map((m) => m[0]).sort();
      assert.deepEqual(substitutions(catalogs.en[key].message), substitutions(catalogs[locale][key].message), `${locale}: ${key} substitutions`);
    }
  }
});

test('UI helper localizes safe text and attributes without reinterpreting external content', () => {
  const original = globalThis.chrome;
  try {
    globalThis.chrome = { i18n: { getMessage(key, substitutions) {
      if (key === '@@ui_locale') return 'en_US';
      const message = catalogs.en[key]?.message || '';
      const values = Array.isArray(substitutions) ? substitutions : [substitutions];
      return message.replace(/\$(\d+)/g, (_, n) => String(values[Number(n) - 1]));
    } } };
    const foreignTitle = '<script>alert(1)</script> $& 中文';
    assert.equal(t('panel_session_page_title', foreignTitle), `· ${foreignTitle}`);
    const node = { dataset: { i18n: 'panel_reconnect' }, textContent: '', getAttributeNames: () => ['data-i18n-title'], getAttribute: () => 'panel_settings_heading', setAttribute(name, value) { this[name] = value; } };
    const foreign = { textContent: foreignTitle, getAttributeNames: () => [] };
    const root = { documentElement: {}, querySelectorAll(selector) { return selector === '[data-i18n]' ? [node] : [node, foreign]; } };
    localizeDocument(root);
    assert.equal(root.documentElement.lang, 'en');
    assert.equal(node.textContent, 'Reconnect');
    assert.equal(node.title, 'Settings');
    assert.equal(foreign.textContent, foreignTitle);
  } finally { globalThis.chrome = original; }
});
