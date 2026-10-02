#!/usr/bin/env node
/**
 * 删除素材里的 <b> 和 </b> 标记。
 *
 * 两个安全措施：
 *  1) 在**字节层面**做（只在 Buffer 里找 ASCII 序列 3C 62 3E / 3C 2F 62 3E），
 *     所以不管文件是 UTF-8 还是 GBK 都不会把中文弄坏，也不会重写 BOM。
 *  2) 只处理文本类扩展名（json / txt / shap / md）。图片、语音一律跳过 ——
 *     二进制里碰巧出现 3C 62 3E 的话，删掉会直接把文件弄坏。
 *
 *   node scripts\clean-bold-tags.mjs                 # 预览（不改任何文件）
 *   node scripts\clean-bold-tags.mjs --apply         # 真的删
 *   node scripts\clean-bold-tags.mjs --apply --skip-shap
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.resolve(__dirname, '..');

const argv = process.argv.slice(2);
const argOf = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const APPLY = argv.includes('--apply');
const SKIP_SHAP = argv.includes('--skip-shap');
const DIR = path.resolve(argOf('--dir', path.resolve(PROJECT, '..', '素材')));

/** 改之前先把原文件备份一份（默认开；--no-backup 可关，备份放在不进仓库的 .data 下） */
const BACKUP_DIR = argv.includes('--no-backup')
  ? ''
  : path.resolve(argOf('--backup-dir', path.resolve(PROJECT, '.data', 'b标签清理备份')));

/** 只碰这些扩展名 */
const TEXT_EXT = /\.(json|txt|shap|md)$/i;

const OPEN = Buffer.from('<b>', 'latin1');
const CLOSE = Buffer.from('</b>', 'latin1');

const countBuf = (buf, pat) => {
  let n = 0;
  let i = 0;
  while ((i = buf.indexOf(pat, i)) !== -1) { n++; i += pat.length; }
  return n;
};

const stripBuf = (buf, pat) => {
  const parts = [];
  let i = 0;
  let last = 0;
  while ((i = buf.indexOf(pat, i)) !== -1) {
    parts.push(buf.subarray(last, i));
    i += pat.length;
    last = i;
  }
  if (!parts.length) return buf;
  parts.push(buf.subarray(last));
  return Buffer.concat(parts);
};

async function walk(dir, out = []) {
  const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) await walk(abs, out);
    else out.push(abs);
  }
  return out;
}

const all = await walk(DIR);
const files = all.filter((f) => TEXT_EXT.test(f));

let totalOpen = 0;
let totalClose = 0;
let touched = 0;
let delta = 0;
const rows = [];

for (const abs of files) {
  const rel = path.relative(DIR, abs).replace(/\\/g, '/');
  if (SKIP_SHAP && /\.shap$/i.test(rel)) continue;
  let buf;
  try { buf = await fsp.readFile(abs); } catch { continue; }
  const o = countBuf(buf, OPEN);
  const c = countBuf(buf, CLOSE);
  if (!o && !c) continue;
  rows.push({ rel, n: o + c, o, c });
  totalOpen += o;
  totalClose += c;
  touched++;
  if (APPLY) {
    if (BACKUP_DIR) {
      const dest = path.join(BACKUP_DIR, ...rel.split('/'));
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.copyFile(abs, dest);
    }
    const out = stripBuf(stripBuf(buf, OPEN), CLOSE);
    await fsp.writeFile(abs, out);
    delta += out.length - buf.length;
  }
}

rows.sort((a, b) => b.n - a.n);
const kindOf = (rel) => (/\.shap$/i.test(rel) ? 'shap' : /宝物卡图/.test(rel) ? '神宝' : '武将json');
const byKind = {};
for (const r of rows) byKind[kindOf(r.rel)] = (byKind[kindOf(r.rel)] ?? 0) + r.n;

console.log(`目录：${DIR}`);
console.log(`扫了 ${all.length} 个文件，其中文本类 ${files.length} 个（图片、语音已跳过）`);
console.log('');
for (const r of rows) console.log(`  ${String(r.n).padStart(4)} 处  ${r.rel}`);
console.log('');
console.log('分类小计：');
for (const [k, v] of Object.entries(byKind)) {
  const label = k === 'shap' ? '做卡工程 .shap' : k === '神宝' ? '神宝卡图 json' : '武将.json';
  console.log(`  ${label.padEnd(16)} ${v} 处`);
}
console.log('');
console.log(`涉及文件 ${touched} 个；<b> ${totalOpen} 处，</b> ${totalClose} 处，共 ${totalOpen + totalClose} 处`);
if (APPLY) {
  console.log(`\n已修改，文件合计减少 ${Math.abs(delta)} 字节。`);
  if (BACKUP_DIR) console.log(`改前的原文件已备份到：${BACKUP_DIR}`);
}
else console.log('\n这只是预览，没有改动任何文件。确认后加 --apply 执行。');
