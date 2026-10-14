import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderGuide } from '../src/install.js';
import installMessages from '../src/locales/install.js';

const template = fs.readFileSync(fileURLToPath(new URL('../src/guide.html', import.meta.url)), 'utf8');

test('installation guide translates every template placeholder in both locales', () => {
  const keys = [...template.matchAll(/\{\{t:([^}]+)\}\}/g)].map((match) => match[1]);
  assert.ok(keys.length > 50);
  for (const key of new Set(keys)) {
    assert.equal(typeof installMessages.en[key], 'string', `English translation missing: ${key}`);
    assert.equal(typeof installMessages['zh-CN'][key], 'string', `Chinese translation missing: ${key}`);
  }

  const english = renderGuide(template, { locale: 'en-US', version: '1.3.0', extensionId: 'abc123', siteCount: 8 });
  assert.match(english, /<html lang="en">/);
  assert.match(english, /The terminal setup is done/);
  assert.match(english, /8 tested site guides/);
  assert.match(english, /s\.textContent = "Copied"/);
  assert.doesNotMatch(english, /\{\{(?:t:|[A-Z_]+\}\})/);

  const chinese = renderGuide(template, { locale: 'zh-CN', version: '1.3.0', extensionId: 'abc123' });
  assert.match(chinese, /<html lang="zh-CN">/);
  assert.match(chinese, /终端那边已经配好了/);
  assert.match(chinese, /已复制/);
  assert.doesNotMatch(chinese, /\{\{(?:t:|[A-Z_]+\}\})/);
});

test('guide escapes agent-provided names and statuses in generated HTML', () => {
  const replacementTokens = ['$&', "$'", '$`'].join(' ');
  const escapedTokens = replacementTokens.replaceAll('&', () => '&amp;').replaceAll("'", () => '&#39;');
  const attack = `${replacementTokens} <img src=x onerror="alert(1)">&`;
  const status = `${replacementTokens} "><script>alert(2)</script>`;
  const html = renderGuide(template, {
    locale: 'en',
    rows: [{ name: attack, status, ok: false, written: false }],
  });

  assert.ok(html.includes(`${escapedTokens} &lt;img src=x onerror=&quot;alert(1)&quot;&gt;&amp;`));
  assert.ok(html.includes(`${escapedTokens} &quot;&gt;&lt;script&gt;alert(2)&lt;/script&gt;`));
  assert.ok(!html.includes(attack));
  assert.ok(!html.includes('<img src=x onerror="alert(1)">'));
  assert.ok(html.includes(`<span class="st">${escapedTokens} &quot;&gt;&lt;script&gt;alert(2)&lt;/script&gt;</span>`));
});

test('source values resembling guide placeholders remain literal', () => {
  const html = renderGuide(template, { locale: 'en', version: '{{AGENT_ROWS}}', rows: [
    { name: '{{AGENT_FOOT}} {{t:guideTitle}}', status: '{{VERSION}}', ok: true },
  ] });
  assert.ok(html.includes('<span class="nm">{{AGENT_FOOT}} {{t:guideTitle}}</span>'));
  assert.ok(html.includes('<span class="st">{{VERSION}}</span>'));
});
