import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeLocale, resolveLocale, parseLanguageArgs, createTranslator } from '../src/lib/i18n.js';
import { compatNote } from '../extension/compat.js';

test('language selection prioritizes explicit choice, then environment, then system locale', () => {
  assert.equal(resolveLocale({ lang: 'en', env: { HUASHU_CHROME_LANG: 'zh_CN' }, systemLocale: 'zh-CN' }), 'en');
  assert.equal(resolveLocale({ env: { HUASHU_CHROME_LANG: 'zh_TW' }, systemLocale: 'en-US' }), 'zh-CN');
  assert.equal(resolveLocale({ env: { LC_ALL: 'zh_CN.UTF-8', LANG: 'en_US.UTF-8' } }), 'zh-CN');
  assert.equal(resolveLocale({ env: {}, systemLocale: 'zh-HK' }), 'zh-CN');
  assert.equal(resolveLocale({ env: {}, systemLocale: 'vi-VN' }), 'en');
  assert.equal(normalizeLocale('EN_us'), 'en');
});

test('language flags do not displace the command or its JSON argument', () => {
  for (const flags of [['--lang', 'en'], ['--lang=en']]) {
    assert.deepEqual(parseLanguageArgs([...flags, 'call', 'query', '{"contains":"--lang"}']), {
      args: ['call', 'query', '{"contains":"--lang"}'], locale: 'en',
    });
    assert.deepEqual(parseLanguageArgs(['extension', ...flags]), { args: ['extension'], locale: 'en' });
  }
  assert.throws(() => parseLanguageArgs(['--lang']), /requires/);
  assert.throws(() => parseLanguageArgs(['--lang=fr']), /requires/);
});

test('catalog fallback and interpolation preserve substituted values literally', () => {
  const catalog = { en: { greeting: 'Hello {name}', fallback: 'English fallback' }, 'zh-CN': { greeting: '你好 {name}' } };
  assert.equal(createTranslator(catalog, 'zh-CN')('greeting', { name: '$& <script>{other}</script>' }), '你好 $& <script>{other}</script>');
  assert.equal(createTranslator(catalog, 'zh-CN')('fallback'), 'English fallback');
  assert.throws(() => createTranslator(catalog, 'en')('missing'), /Missing translation/);
});

test('compatibility messages translate the recovery instructions without changing classification', () => {
  const versions = { ext: '1.2.0', cli: '1.3.0', locale: 'en' };
  assert.match(compatNote('protocol', versions), /incompatible communication protocols/);
  assert.match(compatNote('ext-old', versions), /chrome:\/\/extensions/);
  assert.match(compatNote('cli-old', versions), /huashu-chrome@latest install/);
  assert.equal(compatNote('same', versions), '');
  assert.equal(compatNote('patch', versions), '');
  assert.match(compatNote('ext-old', { ...versions, locale: 'zh-CN' }), /自动更新/);
});
