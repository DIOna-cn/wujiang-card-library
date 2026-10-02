#!/usr/bin/env node
/**
 * 迁移：把「素材\_待实现\<武将>」挪成「素材\<武将>」，
 * 并在 武将.json 里用 implemented 字段标注「是否已实现」。
 *
 * 为什么改：原先靠「放在 _待实现 目录下」表达未实现，代价是
 *   · 网页里这个武将的目录标识变成「_待实现/胡桃」，跟别的武将不是一个形状，
 *     .shap 导出、同步、图片 URL 等一切按目录名走的地方都要多认一层；
 *   · 新建武将时得先想「放哪个组」，而这跟「做没做完」其实是两件事。
 * 位置不该承载语义，所以改成平级放置 + json 里一个布尔字段。
 *
 * implemented 缺省为 true：只有明确标了 false 才算待实现，
 * 这样已有的 20 多个武将 json 一个都不用动。
 *
 * 用法：
 *   node scripts/migrate-pending.mjs --dry    只看会做什么，不动文件
 *   node scripts/migrate-pending.mjs          真的迁移
 *
 * 幂等：_待实现 不存在（或已经空/已删）时什么都不做，可反复运行。
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ASSETS = path.resolve(process.env.ASSETS || path.join(ROOT, '..', '素材'));
const PENDING = path.join(ASSETS, '_待实现');
const DATA_FILE = '武将.json';
const DRY = process.argv.includes('--dry');

/** implemented 紧跟在 isLord 后面，读起来跟其它布尔开关挨着 */
function withImplemented(data) {
  const out = {};
  let placed = false;
  for (const [k, v] of Object.entries(data)) {
    if (k === 'implemented') continue;      // 先摘掉，稍后在固定位置放回
    out[k] = v;
    if (k === 'isLord') { out.implemented = false; placed = true; }
  }
  if (!placed) out.implemented = false;
  return out;
}

async function main() {
  console.log('');
  console.log(`  素材目录   ${ASSETS}`);
  console.log(`  待实现目录 ${PENDING}`);
  console.log(`  模式       ${DRY ? '试运行（不动文件）' : '实际迁移'}`);
  console.log('');

  if (!fs.existsSync(PENDING)) {
    console.log('  ✓ 没有 _待实现 目录，无需迁移。');
    console.log('');
    return;
  }

  const names = fs.readdirSync(PENDING)
    .filter((n) => {
      try { return fs.statSync(path.join(PENDING, n)).isDirectory(); } catch { return false; }
    })
    .sort();

  if (!names.length) {
    console.log('  · _待实现 是空的。');
  }

  let moved = 0;
  let skipped = 0;

  for (const name of names) {
    const src = path.join(PENDING, name);
    const dst = path.join(ASSETS, name);

    if (fs.existsSync(dst)) {
      console.log(`  ! 跳过 ${name}：素材\\${name} 已经存在，不覆盖`);
      skipped++;
      continue;
    }

    if (DRY) {
      console.log(`  → 会移动「_待实现\\${name}」→「${name}」，并在 json 里写 implemented: false`);
      moved++;
      continue;
    }

    await fsp.rename(src, dst);
    console.log(`  ✓ 已移动 _待实现\\${name} → ${name}`);

    const jsonPath = path.join(dst, DATA_FILE);
    if (!fs.existsSync(jsonPath)) {
      console.log(`      · 没有 ${DATA_FILE}，跳过字段更新`);
      moved++;
      continue;
    }

    try {
      const raw = await fsp.readFile(jsonPath, 'utf8');
      const data = withImplemented(JSON.parse(raw.replace(/^\uFEFF/, '')));
      data.id = name;
      data.dir = name;
      await fsp.writeFile(jsonPath, JSON.stringify(data, null, 2) + '\n', 'utf8');
      console.log(`      · 已写 id/dir = ${name}，implemented = false`);
    } catch (err) {
      console.log(`      ! ${DATA_FILE} 更新失败：${err.message}`);
    }
    moved++;
  }

  // 空了就把壳删掉，免得 listCharacterDirs 每次还去遍历一个空目录
  if (!DRY) {
    let left = [];
    try { left = fs.readdirSync(PENDING); } catch { left = []; }
    if (!left.length) {
      await fsp.rmdir(PENDING);
      console.log('  ✓ 已删除空的 _待实现 目录');
    } else {
      console.log(`  · _待实现 里还剩 ${left.length} 项，保留目录`);
    }
  }

  console.log('');
  console.log(`  完成：移动 ${moved} 个，跳过 ${skipped} 个${DRY ? '（试运行，未落盘）' : ''}`);
  console.log('');
}

main().catch((err) => {
  console.error('\n  ✗ 迁移失败：' + err.message);
  console.error(err.stack);
  process.exit(1);
});
