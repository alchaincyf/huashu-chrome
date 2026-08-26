// MCP server 侧的桥客户端：确保桥活着（不在就拉起），连上，发 cmd 收 res。
//
// 「确保桥活着」是这里最容易写错的地方：N 个 agent 会话可能同时冷启动，
// 都发现桥没跑、都去 spawn，就会有 N-1 个进程撞 EADDRINUSE 后死掉，
// 顺带把 bridge.json 里的 token 写乱。用排它文件锁把启动权收敛到一个进程。
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { DEFAULT_PORT, LOCK_FILE, LOG_FILE, BRIDGE_FILE, readBridgeInfo, ensureHome } from './paths.js';
import { VERSION } from './version.js';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'cli.js');

export class BridgeClient {
  constructor({ client = 'unknown' } = {}) {
    this.client = client;
    this.ws = null;
    this.seq = 0;
    this.waiting = new Map();
    this.extensionOnline = false;
    this.onEvent = () => {};
  }

  async connect({ timeoutMs = 15000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let spawned = false;
    while (Date.now() < deadline) {
      const info = readBridgeInfo();
      // 桥是长驻单例：它一旦起来就再也不会读磁盘上的代码。用户 npm update 之后
      // 老桥还在跑老逻辑，症状是「新版本的修复没生效」，而且不报错。
      // 版本对不上就当场换掉——这是唯一能自动发现的时机。
      if (info && info.version && info.version !== VERSION && !spawned) {
        stopBridge(info);
        spawned = tryStartBridge();
        await sleep(400);
        continue;
      }
      if (info) {
        try {
          await this.#open(info);
          return this;
        } catch {
          /* 桥信息陈旧（上次没清干净），往下走去拉一个新的 */
        }
      }
      if (!spawned) spawned = tryStartBridge();
      await sleep(250);
    }
    throw new Error('连不上 huashu-chrome 桥。跑 `huashu-chrome doctor` 看看哪儿卡住了');
  }

  #open(info) {
    return new Promise((resolve, reject) => {
      // Node 原生 WebSocket 客户端不发 Origin 头 —— 桥正是靠这一点区分 agent 和扩展
      const ws = new WebSocket(`ws://127.0.0.1:${info.port || DEFAULT_PORT}`);
      const fail = (e) => reject(e instanceof Error ? e : new Error('桥连接失败'));
      const t = setTimeout(() => { ws.close(); fail(new Error('握手超时')); }, 4000);

      ws.onerror = fail;
      ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', role: 'agent', token: info.token, client: this.client, v: 1 }));
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'welcome') {
          clearTimeout(t);
          this.ws = ws;
          this.extensionOnline = !!msg.extensionOnline;
          ws.onmessage = (e2) => this.#dispatch(JSON.parse(e2.data));
          ws.onclose = () => { this.ws = null; this.#failAll('桥连接已断开'); };
          ws.onerror = () => {};
          return resolve(this);
        }
        clearTimeout(t);
        fail(new Error('握手被拒：' + (msg.error?.message || JSON.stringify(msg))));
      };
    });
  }

  #dispatch(msg) {
    if (msg.type === 'res') {
      const w = this.waiting.get(msg.id);
      if (!w) return;
      this.waiting.delete(msg.id);
      clearTimeout(w.timer);
      msg.ok ? w.resolve(msg.data ?? {}) : w.reject(Object.assign(new Error(msg.error?.message || '命令失败'), { code: msg.error?.code || 'INTERNAL' }));
      return;
    }
    if (msg.type === 'event') {
      if (msg.event === 'extension_online') this.extensionOnline = true;
      if (msg.event === 'extension_offline') this.extensionOnline = false;
      this.onEvent(msg);
    }
  }

  // 主动断开。少了这个方法，进程会被一条开着的 WebSocket 一直吊着不退出——
  // 测试跑完不返回、MCP server 关不干净，都是这个原因。
  close() {
    this.#failAll('客户端主动关闭');
    try { this.ws?.close(1000, 'bye'); } catch { /* 已经断了 */ }
    this.ws = null;
  }

  #failAll(reason) {
    for (const [, w] of this.waiting) {
      clearTimeout(w.timer);
      w.reject(Object.assign(new Error(reason), { code: 'INTERNAL' }));
    }
    this.waiting.clear();
  }

  // 桥侧已有 30s 超时兜底；这里的 35s 只防「桥自己也没了」的情况
  async call(cmd, params = {}, { tabId, timeoutMs = 35000 } = {}) {
    if (!this.ws) await this.connect();
    const id = 'c' + ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(Object.assign(new Error('桥无响应'), { code: 'TIMEOUT' }));
      }, timeoutMs);
      this.waiting.set(id, { resolve, reject, timer });
      // 桥侧也要知道这条命令能等多久，否则它按默认 30s 就把慢命令判死了
      this.ws.send(JSON.stringify({ type: 'cmd', id, cmd, params, tabId, timeout: timeoutMs - 3000 }));
    });
  }
}

// 抢锁开桥：拿到锁的那个进程 spawn，其余的什么都不做、轮询等它起来
// 停掉旧桥。只认 bridge.json 里记的 pid，且发的是 SIGTERM——桥收到会先把
// 在途命令回成错误再退，不会让 agent 干等到超时。
export function stopBridge(info) {
  if (!info?.pid) return false;
  try {
    process.kill(info.pid, 'SIGTERM');
  } catch {
    return false; // 早就死了
  }
  try { fs.unlinkSync(BRIDGE_FILE); } catch {}
  return true;
}

function tryStartBridge() {
  ensureHome();
  let fd;
  try {
    fd = fs.openSync(LOCK_FILE, 'wx'); // O_EXCL：只有一个进程能建成功
  } catch {
    const age = Date.now() - (fs.statSync(LOCK_FILE).mtimeMs || 0);
    if (age > 30000) { try { fs.unlinkSync(LOCK_FILE); } catch {} } // 上次崩在这儿留下的死锁
    return false;
  }
  try {
    const out = fs.openSync(LOG_FILE, 'a');
    const child = spawn(process.execPath, [CLI, 'bridge'], {
      detached: true,
      stdio: ['ignore', out, out],
    });
    child.unref();
    return true;
  } finally {
    fs.closeSync(fd);
    setTimeout(() => { try { fs.unlinkSync(LOCK_FILE); } catch {} }, 3000).unref?.();
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
