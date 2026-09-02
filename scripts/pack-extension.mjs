#!/usr/bin/env node
// 打 Chrome Web Store 上传包。
//
// 上架是「自动更新 + 一键安装」的唯一路——unpacked 加载意味着开发者模式常开、
// 目录藏在 npx 缓存里、npx 原地刷新文件而 Chrome 跑的还是旧 SW。
// 商店包和开发目录只差一件事：manifest 里的 `key` 必须剥掉（首次上传带 key 会被拒，
// 商店会用自己的密钥签名；扩展 ID 由开发者账号下的首次上传决定）。
// 其余文件原样。不改 extension/ 目录本身——那是 unpacked 加载和 doctor 指向的真源。
//
//   node scripts/pack-extension.mjs            → dist/huashu-chrome-<version>.zip
//
// 剩下的是人做的：Chrome Web Store 开发者后台 → 新建项目 → 上传 zip → 填商店文案与
// PRIVACY.md → 提交审核。debugger 权限会被单独问用途，README「点不动的时候」那一节就是答案。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'extension');
const manifest = JSON.parse(fs.readFileSync(path.join(SRC, 'manifest.json'), 'utf8'));
const out = path.join(ROOT, 'dist', `huashu-chrome-${manifest.version}.zip`);

const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-pack-'));
fs.cpSync(SRC, stage, { recursive: true, filter: (p) => !/\.DS_Store$|\/content\/?$/.test(p) });
const { key, ...clean } = manifest;
fs.writeFileSync(path.join(stage, 'manifest.json'), JSON.stringify(clean, null, 2) + '\n');
fs.mkdirSync(path.dirname(out), { recursive: true });
try { fs.unlinkSync(out); } catch { /* 没有旧包 */ }
execFileSync('zip', ['-qr', out, '.'], { cwd: stage });
fs.rmSync(stage, { recursive: true, force: true });

console.log(`${out}  (${Math.round(fs.statSync(out).size / 1024)}KB)`);
console.log(`已剥掉 manifest.key${key ? '' : '（原本就没有）'}；版本 ${manifest.version}。`);
console.log('下一步是人做的：https://chrome.google.com/webstore/devconsole → 上传这个 zip → 填隐私声明（PRIVACY.md）→ 提交审核。');
