/**
 * 一次性迁移：把「原作」从 tags 里拆到独立的 origin 字段。
 *
 * 背景：早期把原作（明日方舟 / 东方Project / 原神 / 三国杀）和特性标签
 * （过牌 / 输出 / 减益…）混在同一个 tags 数组里。网页上要分开两块显示、
 * 而且原作是单选（一个武将只能有一个原作），所以拆成两个字段：
 *
 *   origin : 原作，单值
 *   tags   : 特性标签，多值
 *
 * 这个脚本只改 origin / tags 两个字段，**其它字段原样保留**（包括你在网页上
 * 写过的技能、备注）。重复运行是安全的（幂等）。
 *
 * 用法：
 *   node scripts/migrate-origin.mjs --dry     # 只看会改什么
 *   node scripts/migrate-origin.mjs           # 实际写入
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ORIGINS, splitOriginFromTags } from './import.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ASSETS = path.join(ROOT, '..', '素材');
const DRY = process.argv.includes('--dry');

/**
 * 没有编号（legendId）可推断原作的武将，按目录名补上。
 *
 * 依据：这批立绘都来自「明日方舟武将卡图」，且角色本身都是《明日方舟》干员。
 * 不确定的（锏 / 均1 / 均2）故意留空，由你自己在网页上填。
 */
const ORIGIN_BY_DIR = {
  安洁莉娜: '明日方舟',
  涤火杰西卡: '明日方舟',
  年: '明日方舟',
  夕: '明日方舟',
  黍: '明日方舟',
  颉: '明日方舟',
  重岳: '明日方舟',
  普瑞赛斯: '明日方舟',
};

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) walk(abs, out);
    else if (e.name === '武将.json') out.push(abs);
  }
  return out;
}

const files = fs.existsSync(ASSETS) ? walk(ASSETS) : [];
if (!files.length) {
  console.log(`没有找到 武将.json：${ASSETS}`);
  process.exit(1);
}

let changed = 0, skipped = 0;
const report = [];
const summary = [];   // { name, origin, tags }，用于最后的汇总（--dry 下也准）

for (const file of files) {
  const folder = path.basename(path.dirname(file));
  const raw = fs.readFileSync(file, 'utf8');
  const json = JSON.parse(raw.replace(/^\uFEFF/, ''));

  const beforeTags = Array.isArray(json.tags) ? json.tags : [];
  const beforeOrigin = json.origin ?? '';

  // 原作优先取已有 origin，其次按目录名补，最后从 tags 里挑
  const guess = beforeOrigin || ORIGIN_BY_DIR[folder] || '';
  const { origin, tags, extraOrigins } = splitOriginFromTags(beforeTags, guess);

  summary.push({ name: json.name || folder, origin, tags });

  const same = origin === beforeOrigin &&
    JSON.stringify(tags) === JSON.stringify(beforeTags.filter((t) => !ORIGINS.includes(t)));

  if (same) { skipped++; continue; }

  report.push({
    folder,
    origin: `${beforeOrigin || '（空）'} → ${origin || '（空）'}`,
    tags: `[${beforeTags.join(', ')}] → [${tags.join(', ')}]`,
    warn: extraOrigins.length ? `⚠ 原本还有别的原作：${extraOrigins.join(', ')}` : '',
  });

  if (DRY) continue;

  // 保持字段顺序：把 origin 插在 tags 前面，其余原样
  const next = {};
  for (const [k, v] of Object.entries(json)) {
    if (k === 'tags') {
      next.origin = origin;
      next.tags = tags;
    } else if (k === 'origin') {
      continue;   // 位置由上面的 tags 分支决定
    } else {
      next[k] = v;
    }
  }
  if (!('origin' in next)) { next.origin = origin; next.tags = tags; }

  fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n', 'utf8');
  changed++;
}

console.log(`\n素材目录：${ASSETS}`);
console.log(`共 ${files.length} 位武将${DRY ? '（--dry，未写文件）' : ''}\n`);

if (report.length) {
  for (const r of report) {
    console.log(`  ${r.folder}`);
    console.log(`      原作  ${r.origin}`);
    console.log(`      标签  ${r.tags}${r.warn ? '   ' + r.warn : ''}`);
  }
}

console.log(`\n${DRY ? '待修改' : '已修改'} ${report.length} 位${DRY ? '' : `，跳过 ${skipped} 位（无需改动）`}`);

// ---- 汇总 ----
const originCount = new Map();
const tagCount = new Map();
const noOrigin = [];
for (const s of summary) {
  if (s.origin) originCount.set(s.origin, (originCount.get(s.origin) ?? 0) + 1);
  else noOrigin.push(s.name);
  for (const t of s.tags) tagCount.set(t, (tagCount.get(t) ?? 0) + 1);
}

console.log('\n原作：');
for (const [o, n] of [...originCount.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${o}  ${n} 位`);
if (noOrigin.length) console.log(`  （未定）${noOrigin.length} 位：${noOrigin.join('、')}`);

console.log('\n特性标签：');
for (const [t, n] of [...tagCount.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${t}  ${n} 位`);
if (!tagCount.size) console.log('  （暂无）');
