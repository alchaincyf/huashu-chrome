import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseLanguageArgs } from '../src/lib/i18n.js';

const cliPath = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const runCli = (args) => spawnSync(process.execPath, [cliPath, ...args], {
  encoding: 'utf8',
  timeout: 10_000,
  env: { ...process.env, HUASHU_CHROME_LANG: 'en' },
});

test('help accepts --lang before the command and displays both locales', () => {
  const en = runCli(['--lang', 'en']);
  assert.equal(en.status, 0, en.stderr);
  assert.match(en.stdout, /One-step setup/);
  assert.match(en.stdout, /Configuration directory/);
  assert.doesNotMatch(en.stdout, /配置目录/);

  const zh = runCli(['--lang=zh-CN']);
  assert.equal(zh.status, 0, zh.stderr);
  assert.match(zh.stdout, /一键安装/);
  assert.match(zh.stdout, /配置目录/);
  assert.doesNotMatch(zh.stdout, /One-step setup/);
});

test('extension instructions accept --lang after the command in both locales', () => {
  const en = runCli(['extension', '--lang', 'en']);
  assert.equal(en.status, 0, en.stderr);
  assert.match(en.stdout, /One-click from the Chrome Web Store/);
  assert.match(en.stdout, /chrome:\/\/extensions/);
  assert.match(en.stdout, /Finder \/ File Explorer/);
  assert.doesNotMatch(en.stdout, /商店一键装/);

  const zh = runCli(['extension', '--lang=zh-CN']);
  assert.equal(zh.status, 0, zh.stderr);
  assert.match(zh.stdout, /商店一键装/);
  assert.match(zh.stdout, /chrome:\/\/extensions/);
  assert.match(zh.stdout, /访达 \/ 资源管理器/);
  assert.doesNotMatch(zh.stdout, /One-click from the Chrome Web Store/);
});

test('invalid --lang exits cleanly on stderr without running a command', () => {
  for (const args of [['--lang', 'fr', 'doctor'], ['doctor', '--lang']]) {
    const result = runCli(args);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /Invalid --lang value/);
  }
});

test('language parsing leaves JSON command arguments unchanged', () => {
  const payload = '{"domain":"example.com","save":"note"}';
  for (const argv of [
    ['call', '--lang', 'zh-CN', 'learnings', payload],
    ['call', 'learnings', payload, '--lang', 'zh-CN'],
  ]) {
    const parsed = parseLanguageArgs(argv);
    assert.deepEqual(parsed.args, ['call', 'learnings', payload]);
    assert.equal(parsed.locale, 'zh-CN');
  }
});
