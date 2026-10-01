#!/usr/bin/env node
/**
 * 打一个可以直接发给别人的分享包。
 *
 * 为什么需要它：这个网页不是双击 HTML 就能用的，它靠一个本地服务
 * 读写每个武将文件夹里的 武将.json。所以发给别人必须两样一起给：
 *
 *   素材（武将卡图 + 28 份 武将.json）  ← 数据，约 205 MB，大头
 *   武将牌库（网页 + 服务）              ← 程序，约 0.2 MB
 *
 * 而且必须摆成「素材」和「武将牌库」平级的结构，否则服务找不到素材。
 *
 * 用法：
 *   node scripts/make-share-package.mjs              # 打包到 桌面\武将牌库-分享
 *   node scripts/make-share-package.mjs --out D:\x   # 指定输出位置
 *   node scripts/make-share-package.mjs --zip        # 再压成一个 zip
 *   node scripts/make-share-package.mjs --no-assets  # 只打包程序（素材你自己拷）
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ASSETS_SRC = path.resolve(ROOT, '..', '素材');

const argv = process.argv.slice(2);
const argOf = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const WANT_ZIP = argv.includes('--zip');
const NO_ASSETS = argv.includes('--no-assets');
const OUT = path.resolve(argOf('--out', path.join(os.homedir(), 'Desktop', '武将牌库-分享')));
const PKG_PROJECT = path.join(OUT, '武将牌库');
const PKG_ASSETS = path.join(OUT, '素材');

/** 不往分享包里带的东西：运行痕迹、截图、临时文件 */
const EXCLUDE_DIRS = new Set(['.data', '_shots', 'node_modules', '.git', '回收站']);
const EXCLUDE_FILES = new Set(['server.pid', '.DS_Store', 'Thumbs.db']);

let copiedFiles = 0;
let copiedBytes = 0;

function copyTree(src, dest, { skipHiddenData = false } = {}) {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (EXCLUDE_FILES.has(e.name)) continue;
    if (e.isDirectory()) {
      if (EXCLUDE_DIRS.has(e.name)) continue;
      copyTree(path.join(src, e.name), path.join(dest, e.name));
      continue;
    }
    if (!e.isFile()) continue;
    const destFile = path.join(dest, e.name);
    fs.copyFileSync(path.join(src, e.name), destFile);
    copiedFiles++;
    try { copiedBytes += fs.statSync(destFile).size; } catch { /* 忽略 */ }
  }
}

function fmt(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

console.log('');
console.log('  打包分享包');
console.log('  ────────────────────────────────────────');
console.log(`  来源项目   ${ROOT}`);
if (!NO_ASSETS) console.log(`  来源素材   ${ASSETS_SRC}`);
console.log(`  输出到     ${OUT}`);
console.log('');

if (!NO_ASSETS && !fs.existsSync(ASSETS_SRC)) {
  console.error(`  ✗ 找不到素材目录：${ASSETS_SRC}`);
  console.error('    如果素材在别处，先把「素材」放到「武将牌库」的同一级再打包。');
  process.exit(1);
}

fs.rmSync(OUT, { recursive: true, force: true });

// 1) 程序本体
console.log('  复制程序…');
copyTree(ROOT, PKG_PROJECT);
console.log(`    ${PKG_PROJECT}`);

// 2) 数据
if (!NO_ASSETS) {
  console.log('  复制素材（约 200 MB，会慢一点）…');
  copyTree(ASSETS_SRC, PKG_ASSETS);
  console.log(`    ${PKG_ASSETS}`);
}

// 3) 附一份最简使用说明，省得对方不知道先看哪个
const readmePath = path.join(PKG_PROJECT, 'README.md');
if (fs.existsSync(readmePath)) {
  fs.writeFileSync(path.join(OUT, '先看这里.txt'), [
    '武将牌库 · 使用说明',
    '==================',
    '',
    '1. 安装 Node.js（只需一次）：https://nodejs.org/',
    '   装 LTS 版，一路下一步即可。',
    '',
    '2. 双击  武将牌库\\启动.cmd',
    '   会自动打开浏览器，地址是 http://127.0.0.1:3456/',
    '',
    '3. 想关掉服务：关掉那个黑色命令行窗口，或双击 武将牌库\\停止.cmd',
    '',
    '',
    '目录结构不要改动，这两个文件夹必须并排放：',
    '    武将牌库-分享\\',
    '      ├─ 武将牌库\\   ← 程序（双击里面的 启动.cmd）',
    '      └─ 素材\\       ← 武将卡图与描述数据',
    '',
    '',
    '常见问题',
    '--------',
    '· 双击没反应/窗口闪一下：先确认 Node.js 装好了（命令行敲 node -v 能看到版本号）。',
    '· 打开后一位武将都没有：说明「素材」和「武将牌库」没并排放。',
    '  窗口里会打印出它实际找的路径，按提示把两个文件夹摆到一起即可。',
    '· 端口被占用：编辑 武将牌库\\start.ps1，把 $port = 3456 改成别的（如 3457）。',
    '· 服务只监听本机（127.0.0.1），局域网里的其他人访问不到，这是有意为之。',
    '',
    '数据都在「素材\\<武将名>\\武将.json」里，用记事本也能直接看和改。',
    '建议在网页上改，改完点保存会自动写回该文件。',
    '',
  ].join('\r\n'), 'utf8');
  console.log('  已附「先看这里.txt」');
}

console.log('');
console.log(`  完成：${copiedFiles} 个文件，${fmt(copiedBytes)}`);

// 4) 可选打包成 zip
if (WANT_ZIP) {
  const zipPath = `${OUT}.zip`;
  console.log('');
  console.log('  正在压缩…');
  fs.rmSync(zipPath, { force: true });
  try {
    execFileSync('powershell', [
      '-NoProfile', '-NonInteractive', '-Command',
      `Compress-Archive -Path '${OUT}\\*' -DestinationPath '${zipPath}' -CompressionLevel Optimal -Force`,
    ], { stdio: 'inherit' });
    const size = fs.statSync(zipPath).size;
    console.log(`  zip：${zipPath}（${fmt(size)}）`);
  } catch (err) {
    console.error(`  ✗ 压缩失败：${err.message}`);
    console.error('    目录已经生成好了，可以自己右键压缩。');
  }
}

console.log('');
console.log('  把这个文件夹（或 zip）发给对方即可。');
console.log('  对方需要装 Node.js：https://nodejs.org/');
console.log('');
