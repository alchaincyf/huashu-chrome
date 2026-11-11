// huashu-chrome run    --grant ID [--profile NAME] [--tab-id N] [--store-id S] [--format F] [-- COMMAND ARGS...]
// huashu-chrome grants [--profile NAME] [--json]
//
// run without a command prints what it would hand over (no cookie values).
// With a command, the session goes to that command's stdin and nowhere else:
// not to stdout, not to a file, not to an agent.
import { spawn as nodeSpawn } from 'node:child_process';
import { getSession, getStatus } from './index.js';
import { FORMATS, formatSession, summarize } from './formats.js';
import { safeError, sanitize } from './errors.js';

const USAGE_RUN = 'Usage: huashu-chrome run --grant ID [--profile NAME] [--tab-id N] [--store-id ID] [--format json|storage-state|netscape] [-- COMMAND ARGS...]';
const USAGE_GRANTS = 'Usage: huashu-chrome grants [--profile NAME] [--json]';

function parseRun(argv) {
  const out = { format: 'json' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (typeof v !== 'string' || v.startsWith('--')) throw safeError(`${a} needs a value. ${USAGE_RUN}`, 'USAGE');
      return v;
    };
    if (a === '--') {
      out.command = argv.slice(i + 1);
      if (!out.command.length) throw safeError(`Nothing after --. ${USAGE_RUN}`, 'USAGE');
      break;
    } else if (a === '--grant') out.grant = value();
    else if (a === '--profile') out.profile = value();
    else if (a === '--store-id') out.storeId = value();
    else if (a === '--format') {
      out.format = value();
      if (!FORMATS.includes(out.format)) throw safeError(`--format must be one of ${FORMATS.join(', ')}.`, 'USAGE');
    } else if (a === '--tab-id') {
      const raw = value();
      if (!/^[1-9]\d{0,15}$/.test(raw)) throw safeError('--tab-id must be a positive integer.', 'USAGE');
      out.tabId = Number(raw);
    } else throw safeError(`Unknown option ${a}. ${USAGE_RUN}`, 'USAGE');
  }
  if (!out.grant) throw safeError(`--grant is required. ${USAGE_RUN}`, 'USAGE');
  return out;
}

function parseGrants(argv) {
  const out = { json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--profile') {
      out.profile = argv[++i];
      if (typeof out.profile !== 'string' || out.profile.startsWith('--')) throw safeError(`--profile needs a value. ${USAGE_GRANTS}`, 'USAGE');
    } else throw safeError(`Unknown option ${a}. ${USAGE_GRANTS}`, 'USAGE');
  }
  return out;
}

/** Run COMMAND with the session on stdin; resolves to its exit code. */
export function runCommand(command, input, env, spawnProcess = nodeSpawn) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnProcess(command[0], command.slice(1), {
        stdio: ['pipe', 'inherit', 'inherit'], windowsHide: true, env: { ...process.env, ...env },
      });
    } catch {
      reject(safeError(`Could not start ${command[0]}.`, 'SPAWN'));
      return;
    }
    let done = false;
    child.once('error', () => { if (!done) { done = true; reject(safeError(`Could not start ${command[0]}.`, 'SPAWN')); } });
    child.once('close', (code, signal) => { if (!done) { done = true; resolve(code ?? (signal ? 1 : 0)); } });
    // A command that ignores stdin closes it early: that is not our failure.
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

function grantsText(report) {
  if (!report.profiles.length) return 'No Chrome profile is connected to the bridge.';
  const lines = [];
  for (const p of report.profiles) {
    lines.push(`${p.name ? `"${p.name}"` : '(unnamed profile)'}  id ${p.instanceId.slice(0, 8)}${p.version ? `  v${p.version}` : ''}`);
    if (p.error) { lines.push(`  ✗ ${p.error}`); continue; }
    for (const g of p.grants) {
      const state = g.ready ? 'on' : g.enabled ? 'on, needs cookie permission' : 'off';
      lines.push(`  ${g.ready ? '✓' : '·'} ${g.id.padEnd(14)} ${g.label} — ${state}, ${g.tabs} tab(s)${g.remembered ? '  [run uses this profile]' : ''}`);
    }
  }
  lines.push('', 'Turn a grant on in that profile\'s huashu-chrome side panel. Then: huashu-chrome run --grant ID -- COMMAND');
  return lines.join('\n');
}

/**
 * Entry for `run` and `grants`. Returns the process exit code.
 * deps (tests): getSession, getStatus, spawn, stdout, stderr, clientOptions.
 */
export async function runCli(cmd, argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  try {
    if (cmd === 'grants') {
      const opts = parseGrants(argv);
      const report = await (deps.getStatus || getStatus)({ ...(deps.clientOptions || {}), profile: opts.profile });
      stdout.write((opts.json ? JSON.stringify(report) : grantsText(report)) + '\n');
      return 0;
    }
    const opts = parseRun(argv);
    const session = await (deps.getSession || getSession)({
      ...(deps.clientOptions || {}), grant: opts.grant, profile: opts.profile, tabId: opts.tabId, storeId: opts.storeId,
    });
    if (!opts.command) {
      stdout.write(JSON.stringify(summarize(session)) + '\n');
      return 0;
    }
    stderr.write(`[huashu-chrome] ${opts.grant}: ${session.cookies.length} cookies from Chrome profile ${session.profile.name ? `"${session.profile.name}"` : session.profile.instanceId.slice(0, 8)} → ${opts.command[0]} (stdin, ${opts.format})\n`);
    return await runCommand(opts.command, formatSession(session, opts.format), {
      HUASHU_GRANT: opts.grant,
      HUASHU_SESSION_FORMAT: opts.format,
      HUASHU_PROFILE: session.profile.name || session.profile.instanceId,
    }, deps.spawn);
  } catch (error) {
    stderr.write(`[${sanitize(error).code || 'HANDOFF'}] ${sanitize(error).message}\n`);
    return 1;
  }
}
