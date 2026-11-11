// Node side of session handoff: profile choice, decryption, formats, CLI.
// The bridge is a fake socket; handoff_session is answered by the real
// extension code (extension/handoff/session.js) over a fake chrome API, so the
// encryption is exercised end to end. No real cookie appears anywhere.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { webcrypto } from 'node:crypto';
import { handoffSession } from '../extension/handoff/session.js';
import { handoffStatus } from '../extension/handoff/control.js';
import { GRANTS_KEY } from '../extension/handoff/grants.js';
import { getSession, getStatus } from '../src/handoff/index.js';
import { createMemory, MEMORY_FILE } from '../src/handoff/profile.js';
import { formatSession, summarize } from '../src/handoff/formats.js';
import { runCli } from '../src/handoff/cli.js';
import { HOME } from '../src/lib/paths.js';

const TOKEN = 'a'.repeat(64);
const SECRET = 'cookie-value-must-not-be-printed';
const EXT = 'jmhgdchbmnppmgnkjbphomihijnjbiaj';
const SC = 'https://sellercentral.amazon.com/home';
const future = () => Math.floor(Date.now() / 1000) + 3600;

const WORK = { extensionId: EXT, instanceId: '259bd048-aaaa', label: 'Work', version: '1.4.0', headless: false };
const HOME_P = { extensionId: EXT, instanceId: '90d5e50c-bbbb', label: 'Home', version: '1.4.0', headless: false };
const HEADLESS = { extensionId: EXT, instanceId: 'cccc0000', label: '', version: '1.4.0', headless: true };

const goodCookie = (over = {}) => ({
  name: 'session-id', value: SECRET, domain: '.amazon.com', path: '/', secure: true, httpOnly: true,
  sameSite: 'lax', session: false, expirationDate: future(), ...over,
});

// One fake Chrome profile, answering the three handoff commands with the real extension code.
function browser(inst, { grantOn = true, cookies = [goodCookie()], old = false, statusOverride } = {}) {
  const chromeApi = {
    storage: { local: { get: async () => ({ [GRANTS_KEY]: { 'amazon-sc': grantOn } }) } },
    permissions: { contains: async () => true },
    tabs: { get: async () => ({ id: 42, url: SC }), query: async () => [{ id: 42, windowId: 1, incognito: false, status: 'complete', url: SC }] },
    cookies: { getAllCookieStores: async () => [{ id: '0', tabIds: [42] }], getAll: async () => cookies },
  };
  return {
    inst,
    async answer(msg) {
      if (old) throw Object.assign(new Error(`未知命令 ${msg.cmd}`), { code: 'INTERNAL' });
      if (msg.cmd === 'handoff_status') {
        const s = await handoffStatus(msg.params, inst, chromeApi);
        return statusOverride ? statusOverride(s) : s;
      }
      if (msg.cmd === 'handoff_resolve_tab') return { tabId: msg.params.tabId ?? 42, created: false, storeId: '0' };
      if (msg.cmd === 'handoff_session') return handoffSession(msg.params, msg.tabId, chromeApi, webcrypto);
      throw new Error('unexpected ' + msg.cmd);
    },
  };
}

class FakeSocket extends EventEmitter {
  constructor(world) {
    super();
    this.world = world;
    setImmediate(() => this.emit('open'));
  }

  send(raw) {
    const msg = JSON.parse(raw);
    this.world.sent.push(msg);
    if (msg.type === 'hello') {
      this.world.hellos = (this.world.hellos || 0) + 1;
      const empty = this.world.hellos <= (this.world.emptyFirst || 0);
      const welcome = {
        type: 'welcome', bridge: '1.4.0', v: 1,
        capabilities: this.world.capabilities ?? ['targeted-routing-v1', 'session-handoff-v1'],
        extensions: empty ? [] : this.world.browsers.map((b) => b.inst),
      };
      queueMicrotask(() => this.emit('message', Buffer.from(JSON.stringify(welcome))));
      return;
    }
    const b = this.world.browsers.find((x) => x.inst.instanceId === msg.target?.instanceId);
    Promise.resolve().then(() => {
      if (!b) throw Object.assign(new Error('target instance is not connected'), { code: 'TARGET_NOT_FOUND' });
      return b.answer(msg);
    }).then(
      (data) => this.emit('message', Buffer.from(JSON.stringify({ type: 'res', id: msg.id, ok: true, data }))),
      (e) => this.emit('message', Buffer.from(JSON.stringify({ type: 'res', id: msg.id, ok: false, error: { code: e.code || 'INTERNAL', message: e.message } }))),
    );
  }

  close() { this.world.closed = true; this.emit('close'); }
}

function tmpMemory() {
  // Under the isolated HUASHU_CHROME_HOME, which test/isolated-home.js removes on exit
  const dir = fs.mkdtempSync(path.join(HOME, 'handoff-mem-'));
  return { memory: createMemory(path.join(dir, 'handoff.json')), dir };
}

function world(browsers, extra = {}) {
  const w = { browsers, sent: [], closed: false, ...extra };
  const { memory } = tmpMemory();
  w.memory = memory;
  w.options = {
    readBridgeInfo: async () => ({ port: 9123, token: TOKEN }),
    socketFactory: () => new FakeSocket(w),
    memory,
  };
  w.cmds = () => w.sent.filter((m) => m.type === 'cmd').map((m) => `${m.cmd}@${m.target?.instanceId}`);
  return w;
}

const code = (c) => (e) => e?.code === c;

// ---------- getSession ----------

test('one profile with the grant on: decrypts the real extension envelope, remembers the profile, closes', async () => {
  const w = world([browser(WORK), browser(HOME_P, { grantOn: false }), browser(HEADLESS)]);
  const s = await getSession({ ...w.options, grant: 'amazon-sc' });
  assert.equal(s.grant, 'amazon-sc');
  assert.deepEqual(s.profile, { name: 'Work', instanceId: WORK.instanceId, source: 'auto' });
  assert.equal(s.cookies[0].value, SECRET);
  assert.equal(s.tabId, 42);
  assert.equal(w.closed, true);

  const hello = w.sent.find((m) => m.type === 'hello');
  assert.equal(hello.client, 'huashu-handoff');
  assert.ok(w.sent.filter((m) => m.type === 'cmd').every((m) => m.target?.instanceId), 'every command names its profile');
  assert.ok(!w.cmds().some((c) => c.includes(HEADLESS.instanceId)), 'headless instances are never asked');
  assert.deepEqual(w.cmds().filter((c) => !c.startsWith('handoff_status')), [
    `handoff_resolve_tab@${WORK.instanceId}`, `handoff_session@${WORK.instanceId}`,
  ]);
  assert.equal((await w.memory.get('amazon-sc')).instanceId, WORK.instanceId);
});

test('grant on in two profiles: refuses, names both, asks for nothing, remembers nothing', async () => {
  const w = world([browser(WORK), browser(HOME_P)]);
  await assert.rejects(getSession({ ...w.options, grant: 'amazon-sc' }),
    (e) => e.code === 'PROFILE_AMBIGUOUS' && /"Work"/.test(e.message) && /"Home"/.test(e.message) && /--profile/.test(e.message));
  assert.ok(!w.cmds().some((c) => c.startsWith('handoff_session')));
  assert.equal(await w.memory.get('amazon-sc'), null);
  assert.equal(w.closed, true);
});

test('grant on nowhere: says where to turn it on, and mentions profiles running an old extension', async () => {
  const w = world([browser(WORK, { grantOn: false }), browser(HOME_P, { old: true })]);
  await assert.rejects(getSession({ ...w.options, grant: 'amazon-sc' }),
    (e) => e.code === 'GRANT_DISABLED' && /side panel/.test(e.message) && /older extension/.test(e.message));
});

test('remembered profile offline: fails, never falls back to another profile that has the grant on', async () => {
  const w = world([browser(HOME_P)]);
  await w.memory.set('amazon-sc', WORK);
  await assert.rejects(getSession({ ...w.options, grant: 'amazon-sc' }),
    (e) => e.code === 'PROFILE_OFFLINE' && /"Work"/.test(e.message) && /--profile/.test(e.message));
  assert.deepEqual(w.cmds(), [], 'nothing was sent to the other profile');
});

test('remembered profile online: used without asking the others', async () => {
  const w = world([browser(WORK), browser(HOME_P)]);
  await w.memory.set('amazon-sc', HOME_P);
  const s = await getSession({ ...w.options, grant: 'amazon-sc' });
  assert.equal(s.profile.instanceId, HOME_P.instanceId);
  assert.equal(s.profile.source, 'remembered');
  assert.ok(w.cmds().every((c) => c.endsWith(HOME_P.instanceId)));
});

test('--profile picks by name (any case) or id prefix, overrides and rewrites the memory', async () => {
  const w = world([browser(WORK), browser(HOME_P)]);
  await w.memory.set('amazon-sc', WORK);
  const s = await getSession({ ...w.options, grant: 'amazon-sc', profile: 'home' });
  assert.equal(s.profile.instanceId, HOME_P.instanceId);
  assert.equal(s.profile.source, 'explicit');
  assert.equal((await w.memory.get('amazon-sc')).instanceId, HOME_P.instanceId);
  const byId = await getSession({ ...w.options, grant: 'amazon-sc', profile: '259bd' });
  assert.equal(byId.profile.instanceId, WORK.instanceId);
  await assert.rejects(getSession({ ...w.options, grant: 'amazon-sc', profile: 'Admin' }),
    (e) => e.code === 'PROFILE_NOT_FOUND' && /"Work"/.test(e.message));
});

test('explicit profile with the grant off: clear message, no tab resolution, nothing remembered', async () => {
  const w = world([browser(WORK, { grantOn: false })]);
  await assert.rejects(getSession({ ...w.options, grant: 'amazon-sc', profile: 'Work' }),
    (e) => e.code === 'GRANT_DISABLED' && /"Work"/.test(e.message));
  assert.deepEqual(w.cmds(), [`handoff_status@${WORK.instanceId}`]);
  assert.equal(await w.memory.get('amazon-sc'), null);
});

test('an old bridge is refused before any command; an old extension gets a reload hint', async () => {
  const w = world([browser(WORK)], { capabilities: ['targeted-routing-v1'] });
  await assert.rejects(getSession({ ...w.options, grant: 'amazon-sc' }), code('BRIDGE_OLD'));
  assert.deepEqual(w.cmds(), []);
  const o = world([browser(WORK, { old: true })]);
  await assert.rejects(getSession({ ...o.options, grant: 'amazon-sc', profile: 'Work' }),
    (e) => e.code === 'EXTENSION_OLD' && /dev --once/.test(e.message));
});

test('a status that names a different profile is refused before tab resolution', async () => {
  const w = world([browser(WORK, { statusOverride: (s) => ({ ...s, instanceId: 'someone-else' }) })]);
  await assert.rejects(getSession({ ...w.options, grant: 'amazon-sc', profile: 'Work' }), code('BAD_RESPONSE'));
  assert.deepEqual(w.cmds(), [`handoff_status@${WORK.instanceId}`]);
});

test('cookies outside the grant are refused; expired ones dropped; none left means signed out', async () => {
  const outside = world([browser(WORK, { statusOverride: (s) => ({ ...s, grants: s.grants.map((g) => ({ ...g, cookieDomains: ['sellercentral.amazon.com'] })) }) })]);
  await assert.rejects(getSession({ ...outside.options, grant: 'amazon-sc', profile: 'Work' }),
    (e) => e.code === 'BAD_SESSION' && !e.message.includes(SECRET));

  const past = Math.floor(Date.now() / 1000) - 10;
  const mixed = world([browser(WORK, { cookies: [goodCookie(), goodCookie({ name: 'old', expirationDate: past })] })]);
  const s = await getSession({ ...mixed.options, grant: 'amazon-sc', profile: 'Work' });
  assert.deepEqual(s.cookies.map((c) => c.name), ['session-id']);

  const gone = world([browser(WORK, { cookies: [goodCookie({ expirationDate: past })] })]);
  await assert.rejects(getSession({ ...gone.options, grant: 'amazon-sc', profile: 'Work' }), (e) => e.code === 'SIGNED_OUT' && /Sign in/.test(e.message));
  assert.equal(await gone.memory.get('amazon-sc'), null, 'a failed handoff does not become the remembered profile');
});

test('a tampered or re-labelled envelope does not decrypt', async () => {
  const tamper = (fn) => world([{
    inst: WORK,
    async answer(msg) {
      const real = await browser(WORK).answer(msg);
      return msg.cmd === 'handoff_session' ? fn(real) : real;
    },
  }]);
  const flip = tamper((e) => {
    const b = Buffer.from(e.ciphertext, 'base64');
    b[0] ^= 1;
    return { ...e, ciphertext: b.toString('base64') };
  });
  await assert.rejects(getSession({ ...flip.options, grant: 'amazon-sc', profile: 'Work' }), code('BAD_SESSION'));
  const relabel = tamper((e) => ({ ...e, grant: 'other' }));
  await assert.rejects(getSession({ ...relabel.options, grant: 'amazon-sc', profile: 'Work' }), code('BAD_SESSION'));
});

test('unexpected failures come out generic, and bad options fail before touching the bridge', async () => {
  let asked = 0;
  await assert.rejects(getSession({
    grant: 'amazon-sc', memory: tmpMemory().memory,
    readBridgeInfo: async () => { asked++; return { port: 9123, token: TOKEN }; },
    socketFactory: () => { throw new Error(`boom ${TOKEN}`); },
  }), (e) => e.code === 'BRIDGE_UNAVAILABLE' && !e.message.includes(TOKEN));
  for (const bad of [{ grant: 'Amazon SC' }, { grant: 'amazon-sc', tabId: 0 }, { grant: 'amazon-sc', profile: ' ' }]) {
    await assert.rejects(getSession({ ...bad, readBridgeInfo: async () => { asked += 100; return {}; } }), code('USAGE'));
  }
  assert.equal(asked, 1);
});

test('the memory file lives under HUASHU_CHROME_HOME', () => {
  assert.equal(path.dirname(MEMORY_FILE), HOME);
  assert.equal(HOME, process.env.HUASHU_CHROME_HOME, 'tests run against the isolated home, not ~/.huashu-chrome');
});

// ---------- getStatus ----------

test('getStatus lists every headed profile × grant without reading cookies', async () => {
  const w = world([browser(WORK), browser(HOME_P, { grantOn: false }), browser(HEADLESS)]);
  await w.memory.set('amazon-sc', WORK);
  const r = await getStatus(w.options);
  assert.deepEqual(r.profiles.map((p) => [p.name, p.grants[0].enabled, p.grants[0].remembered]), [['Work', true, true], ['Home', false, false]]);
  assert.ok(w.cmds().every((c) => c.startsWith('handoff_status@')));
});

// ---------- formats ----------

const SESSION = {
  grant: 'amazon-sc', profile: { name: 'Work', instanceId: WORK.instanceId, source: 'auto' }, tabId: 42,
  captured_at: '2026-11-11T00:00:00.000Z', userAgent: 'UA',
  cookies: [
    goodCookie({ expirationDate: 1900000000.5 }),
    { name: 'host', value: 'v2', domain: 'sellercentral.amazon.com', path: '/fba', secure: true, httpOnly: false, sameSite: 'no_restriction', session: true },
  ],
  skipped_partitioned: 1,
};

test('storage-state is what Playwright expects', () => {
  const st = JSON.parse(formatSession(SESSION, 'storage-state'));
  assert.deepEqual(st.origins, []);
  assert.deepEqual(st.cookies[0], { name: 'session-id', value: SECRET, domain: '.amazon.com', path: '/', expires: 1900000000.5, httpOnly: true, secure: true, sameSite: 'Lax' });
  assert.equal(st.cookies[1].expires, -1);
  assert.equal(st.cookies[1].sameSite, 'None');
});

test('netscape cookies.txt: subdomain flag from the leading dot, HttpOnly prefix, session = 0', () => {
  const lines = formatSession(SESSION, 'netscape').trim().split('\n');
  assert.equal(lines[0], '# Netscape HTTP Cookie File');
  assert.deepEqual(lines[2].split('\t'), ['#HttpOnly_.amazon.com', 'TRUE', '/', 'TRUE', '1900000000', 'session-id', SECRET]);
  assert.deepEqual(lines[3].split('\t'), ['sellercentral.amazon.com', 'FALSE', '/fba', 'TRUE', '0', 'host', 'v2']);
});

test('json keeps Chrome field names and says its format; the summary has no values', () => {
  const j = JSON.parse(formatSession(SESSION, 'json'));
  assert.equal(j.format, 'huashu-session/v1');
  assert.equal(j.cookies[0].expirationDate, 1900000000.5);
  const sum = JSON.stringify(summarize(SESSION));
  assert.ok(!sum.includes(SECRET) && !sum.includes('v2'));
  assert.match(sum, /"cookie_count":2/);
});

// ---------- CLI ----------

function streams() {
  const out = { text: '' };
  return { out, stream: { write: (s) => { out.text += s; return true; } } };
}

test('run without a command prints metadata only', async () => {
  const w = world([browser(WORK)]);
  const o = streams();
  const e = streams();
  const codeOut = await runCli('run', ['--grant', 'amazon-sc'], { clientOptions: w.options, stdout: o.stream, stderr: e.stream });
  assert.equal(codeOut, 0);
  assert.ok(!o.out.text.includes(SECRET) && !e.out.text.includes(SECRET));
  assert.equal(JSON.parse(o.out.text).profile.name, 'Work');
});

test('run -- COMMAND: the session goes to the child stdin only, in the chosen format, and its exit code comes back', async () => {
  const w = world([browser(WORK)]);
  const o = streams();
  const e = streams();
  let spawned;
  const spawn = (cmd, args, opts) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    let input = '';
    child.stdin.on('data', (d) => { input += d; });
    child.stdin.on('end', () => {
      spawned = { cmd, args, opts, input };
      setImmediate(() => child.emit('close', 3));
    });
    return child;
  };
  const rc = await runCli('run', ['--grant', 'amazon-sc', '--format', 'netscape', '--', 'python', 'ship.py', '--x'],
    { clientOptions: w.options, stdout: o.stream, stderr: e.stream, spawn });
  assert.equal(rc, 3);
  assert.equal(spawned.cmd, 'python');
  assert.deepEqual(spawned.args, ['ship.py', '--x']);
  assert.deepEqual(spawned.opts.stdio, ['pipe', 'inherit', 'inherit']);
  assert.match(spawned.input, /^# Netscape HTTP Cookie File/);
  assert.ok(spawned.input.includes(SECRET));
  assert.equal(spawned.opts.env.HUASHU_GRANT, 'amazon-sc');
  assert.equal(spawned.opts.env.HUASHU_SESSION_FORMAT, 'netscape');
  assert.equal(o.out.text, '', 'nothing on our stdout');
  assert.ok(!e.out.text.includes(SECRET));
  assert.match(e.out.text, /1 cookies from Chrome profile "Work" → python/);
});

test('run and grants usage errors exit 1 without touching the bridge', async () => {
  let called = 0;
  const deps = { getSession: async () => { called++; }, getStatus: async () => { called++; }, stdout: streams().stream };
  for (const argv of [[], ['--grant'], ['--grant', 'amazon-sc', '--format', 'har'], ['--grant', 'amazon-sc', '--tab-id', 'x'], ['--grant', 'amazon-sc', '--'], ['--bogus']]) {
    const e = streams();
    assert.equal(await runCli('run', argv, { ...deps, stderr: e.stream }), 1, argv.join(' '));
    assert.match(e.out.text, /\[USAGE\]/);
  }
  assert.equal(await runCli('grants', ['--nope'], { ...deps, stderr: streams().stream }), 1);
  assert.equal(called, 0);
});

test('grants prints each profile and grant, and marks the one run will use', async () => {
  const w = world([browser(WORK), browser(HOME_P, { grantOn: false })]);
  await w.memory.set('amazon-sc', WORK);
  const o = streams();
  assert.equal(await runCli('grants', [], { clientOptions: w.options, stdout: o.stream, stderr: streams().stream }), 0);
  assert.match(o.out.text, /"Work".*\n.*✓ amazon-sc .*on, 1 tab\(s\)  \[run uses this profile\]/);
  assert.match(o.out.text, /"Home".*\n.*· amazon-sc .*off/);
});

test('right after a bridge restart: waits for the extensions to dial back in, then gives up with NO_EXTENSION', async () => {
  const w = world([browser(WORK)], { emptyFirst: 2 });
  const s = await getSession({ ...w.options, grant: 'amazon-sc', profile: 'Work', extensionWaitMs: 3000 });
  assert.equal(s.profile.name, 'Work');
  assert.equal(w.hellos, 3, 'reconnected until a profile was there');

  const never = world([browser(WORK)], { emptyFirst: 99 });
  const started = Date.now();
  await assert.rejects(getSession({ ...never.options, grant: 'amazon-sc', profile: 'Work', extensionWaitMs: 1200 }), code('NO_EXTENSION'));
  assert.ok(Date.now() - started < 4000);
});
