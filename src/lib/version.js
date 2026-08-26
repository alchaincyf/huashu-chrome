// 版本号的唯一真源 —— package.json。
//
// 曾经 bridge.js 里硬编码 '0.1.0'、manifest.json 里又写一遍，两处早晚分叉。
// 而版本号在这个产品里不是装饰：桥是长驻进程，用户 npm update 之后老桥还在跑
// 老代码，症状是「改了没用」而不是报错。要能自动发现，就必须有个可信的版本号。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function read(file, key) {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'))[key];
  } catch {
    return null;
  }
}

export const VERSION = read('package.json', 'version') || '0.0.0';
export const EXT_VERSION = read('extension/manifest.json', 'version') || '0.0.0';
