/**
 * 给指定武将的某些技能打上「衍生技」标记（derived: true）。
 *
 * 为什么单独做而不跑 import --force：
 * --force 会重新生成全部 武将.json，把你在网页上写过的内容（标签、技能改动）冲掉。
 * 这个脚本只动目标文件里目标技能的 derived 字段，其它一律不碰。
 *
 * 用法：node scripts/mark-derived.mjs [--dry]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = path.resolve(__dirname, '..', '..', '素材');
const DRY = process.argv.includes('--dry');

/** 武将目录 → 要标记为衍生技的技能名 */
const TARGETS = {
  蓬莱山辉夜: ['待宵', '须臾', '朝靄', '拂晓', '永夜归反 -破晓明星-', '永夜归反 -世间开明-'],
};

let total = 0;

for (const [folder, skillNames] of Object.entries(TARGETS)) {
  const file = path.join(ASSETS, folder, '武将.json');
  if (!fs.existsSync(file)) { console.log(`✗ 找不到 ${file}`); continue; }

  const json = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  const hit = [];

  for (const card of json.cards ?? []) {
    for (const s of card.skills ?? []) {
      if (skillNames.includes(s.name)) {
        if (s.derived !== true) hit.push(s.name);
        s.derived = true;
      }
    }
    // 同步 derived 数组（网页与服务端都认这个字段）
    const derived = (card.skills ?? []).filter((s) => s.derived).map((s) => s.name);
    card.derived = [...new Set([...(card.derived ?? []), ...derived])];
  }

  console.log(`${folder}：${hit.length ? '将标记 ' + hit.join('、') : '已经标记过了'}`);
  if (!DRY && hit.length) {
    fs.writeFileSync(file, JSON.stringify(json, null, 2) + '\n', 'utf8');
    total += hit.length;
  }
}

console.log(`\n${DRY ? '（--dry，未写文件）' : `共标记 ${total} 个技能`}`);
