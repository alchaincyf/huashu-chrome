// A short-lived bridge connection for `huashu-chrome run` / `grants`.
// It speaks the agent protocol under the one client name the bridge lets
// through for handoff_* commands, and every command names its target profile.
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { BRIDGE_FILE } from '../lib/paths.js';
import { safeError, isSafe } from './errors.js';

export const HANDOFF_CLIENT = 'huashu-handoff';
export const HANDOFF_CAPABILITY = 'session-handoff-v1';
export const COMMAND_TIMEOUT_MS = 30_000;
export const CLIENT_TIMEOUT_MS = 35_000;

const CONTROL = /[\u0000-\u001f\u007f]/;
const ID = /^[A-Za-z0-9._:-]{1,128}$/;
const cleanText = (v, max) => (typeof v === 'string' && v.length <= max && !CONTROL.test(v) ? v : null);

export async function readLocalBridgeInfo() {
  let parsed;
  try { parsed = JSON.parse(await fs.readFile(BRIDGE_FILE, 'utf8')); } catch {
    throw safeError('The huashu-chrome bridge is not running. Open Chrome with the extension, then run `huashu-chrome doctor`.', 'BRIDGE_UNAVAILABLE');
  }
  return { port: parsed?.port, token: parsed?.token };
}

function validateBridgeInfo(info) {
  if (!info || !Number.isInteger(info.port) || info.port < 1 || info.port > 65_535
      || typeof info.token !== 'string' || !/^[a-f0-9]{64}$/i.test(info.token)) {
    throw safeError('The bridge configuration is invalid; run `huashu-chrome doctor`.', 'BRIDGE_UNAVAILABLE');
  }
  return { port: info.port, token: info.token };
}

/** The welcome message, reduced to fields we use and checked for shape. */
export function cleanWelcome(message) {
  if (!message || typeof message !== 'object' || message.type !== 'welcome') {
    throw safeError('Bridge authentication failed.', 'BRIDGE_AUTH');
  }
  const instances = (Array.isArray(message.extensions) ? message.extensions : []).flatMap((e) => {
    if (!e || typeof e !== 'object' || !ID.test(e.extensionId ?? '') || !ID.test(e.instanceId ?? '')) return [];
    return [{
      extensionId: e.extensionId,
      instanceId: e.instanceId,
      label: cleanText(e.label, 80) || '',
      version: cleanText(e.version, 128),
      headless: e.headless === true,
    }];
  });
  return {
    version: cleanText(message.bridge, 128),
    capabilities: Array.isArray(message.capabilities)
      ? message.capabilities.filter((c) => typeof c === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(c)).slice(0, 64) : [],
    instances,
  };
}

async function defaultSocketFactory(url) {
  const { default: WebSocket } = await import('ws');
  return new WebSocket(url);
}

function listen(socket, event, fn) {
  if (typeof socket.on === 'function') { socket.on(event, fn); return () => socket.off?.(event, fn); }
  socket.addEventListener(event, fn);
  return () => socket.removeEventListener?.(event, fn);
}

function text(event) {
  const data = event && typeof event === 'object' && 'data' in event ? event.data : event;
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data) || data instanceof Uint8Array) return Buffer.from(data).toString('utf8');
  return '';
}

// Error text from the bridge or extension is ours (fixed strings with a profile
// label at most), but cap and strip it anyway before it reaches a terminal.
function remoteError(error) {
  const code = typeof error?.code === 'string' ? error.code.slice(0, 64) : 'INTERNAL';
  const message = typeof error?.message === 'string' ? error.message : '';
  if (/^未知命令 handoff_/.test(message)) {
    return safeError('That Chrome profile runs an extension without session sharing. Reload it: `huashu-chrome dev --once`.', 'EXTENSION_OLD');
  }
  if (code.startsWith('HANDOFF_') || ['TARGET_NOT_FOUND', 'TARGET_REQUIRED', 'INVALID_TARGET', 'TIMEOUT', 'NO_EXTENSION', 'TARGET_AMBIGUOUS'].includes(code)) {
    return safeError(message || code, code);
  }
  return safeError('The Chrome extension could not complete the request.', code);
}

/**
 * Connect and authenticate. Resolves to { welcome, request(cmd, params, target, extra), close() }.
 */
export async function connect({
  readBridgeInfo = readLocalBridgeInfo, socketFactory = defaultSocketFactory,
  uuid = randomUUID, timeoutMs = CLIENT_TIMEOUT_MS,
} = {}) {
  let info;
  try { info = validateBridgeInfo(await readBridgeInfo()); } catch (e) {
    throw isSafe(e) ? e : safeError('The huashu-chrome bridge is not running.', 'BRIDGE_UNAVAILABLE');
  }
  let socket;
  try { socket = await socketFactory(`ws://127.0.0.1:${info.port}`); } catch {
    throw safeError('Could not connect to the huashu-chrome bridge.', 'BRIDGE_UNAVAILABLE');
  }
  return new Promise((resolve, reject) => {
    let phase = 'connecting';
    const pending = new Map();
    const cleanups = [];
    const cleanup = () => { for (const c of cleanups.splice(0)) { try { c(); } catch { /* ignore */ } } };
    const failPending = (error) => {
      for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); }
      pending.clear();
    };
    const fail = (message) => {
      if (phase === 'ready' || phase === 'closed') return;
      phase = 'closed';
      clearTimeout(timer);
      cleanup();
      try { socket.close?.(1000, 'done'); } catch { /* ignore */ }
      reject(safeError(message, 'BRIDGE_UNAVAILABLE'));
    };
    const timer = setTimeout(() => fail('The bridge connection timed out.'), timeoutMs);

    cleanups.push(listen(socket, 'open', () => {
      if (phase !== 'connecting') return;
      phase = 'authenticating';
      try {
        socket.send(JSON.stringify({
          type: 'hello', role: 'agent', token: info.token, client: HANDOFF_CLIENT,
          label: 'huashu-chrome run', sessionId: `${HANDOFF_CLIENT}:${uuid()}`, v: 1,
        }));
      } catch { fail('Could not connect to the huashu-chrome bridge.'); }
    }));

    cleanups.push(listen(socket, 'message', (event) => {
      let message;
      try { message = JSON.parse(text(event)); } catch {
        if (phase === 'authenticating') fail('The bridge sent an invalid response.');
        return;
      }
      if (phase === 'authenticating') {
        let welcome;
        try { welcome = cleanWelcome(message); } catch { return fail('Bridge authentication failed.'); }
        phase = 'ready';
        clearTimeout(timer);
        resolve({
          welcome,
          request(cmd, params, target, extra = {}) {
            if (phase !== 'ready') return Promise.reject(safeError('The bridge connection closed.', 'BRIDGE_CLOSED'));
            const id = `${cmd}-${uuid()}`;
            return new Promise((res, rej) => {
              const t = setTimeout(() => {
                pending.delete(id);
                rej(safeError(`${cmd} timed out.`, 'TIMEOUT'));
              }, timeoutMs);
              pending.set(id, { resolve: res, reject: rej, timer: t });
              try {
                socket.send(JSON.stringify({ type: 'cmd', id, cmd, params, target, timeout: COMMAND_TIMEOUT_MS, ...extra }));
              } catch {
                clearTimeout(t);
                pending.delete(id);
                rej(safeError('Could not send the request to the bridge.', 'BRIDGE_CLOSED'));
              }
            });
          },
          close() {
            if (phase === 'closed') return;
            phase = 'closed';
            failPending(safeError('The bridge connection closed.', 'BRIDGE_CLOSED'));
            try { socket.close?.(1000, 'done'); } catch { /* ignore */ }
            cleanup();
          },
        });
        return;
      }
      if (phase !== 'ready' || message?.type !== 'res' || typeof message.id !== 'string') return;
      const item = pending.get(message.id);
      if (!item) return;
      clearTimeout(item.timer);
      pending.delete(message.id);
      if (message.ok !== true) item.reject(remoteError(message.error));
      else if (!message.data || typeof message.data !== 'object' || Array.isArray(message.data)) {
        item.reject(safeError('The bridge sent an invalid response.', 'BAD_RESPONSE'));
      } else item.resolve(message.data);
    }));

    cleanups.push(listen(socket, 'error', () => {
      if (phase === 'ready') failPending(safeError('The bridge connection failed.', 'BRIDGE_CLOSED'));
      else fail('Could not connect to the huashu-chrome bridge.');
    }));
    cleanups.push(listen(socket, 'close', () => {
      if (phase === 'ready') { phase = 'closed'; failPending(safeError('The bridge connection closed.', 'BRIDGE_CLOSED')); }
      else fail('The bridge closed the connection.');
    }));
  });
}
