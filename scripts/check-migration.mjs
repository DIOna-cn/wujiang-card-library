/**
 * 迁移安全审查：逐条列出 描述.txt 与 武将.json 的技能描述差异，
 * 只报「文字确实不一致」的，方便人工确认是否有信息丢失。
 *
 * 素材目录里的 描述.txt 已经统一成 武将.json 并删除，
 * 所以这里优先读 素材\ 下的（如果还有），否则读 .data\原始描述备份\。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// import.mjs 只在「被直接执行」时才跑导入流程，所以这里 import 不会产生多余输出
import { parseDescTxt } from './import.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ASSETS = path.join(ROOT, '..', '素材');
const BACKUP = path.join(ROOT, '.data', '原始描述备份');

const norm = (s) => String(s ?? '')
  .replace(/<b>|<\/b>/gi, '')
  .replace(/\s+/g, '')
  .replace(/[（(]/g, '(').replace(/[）)]/g, ')')
  .replace(/[。．.]+$/g, '')
  .replace(/[""]/g, '"').replace(/['']/g, "'")
  .replace(/[\u200b-\u200f\ufeff]/g, '');

/** 找最像的那条 JSON 技能（按名字） */
function matchSkill(descSkill, jsonSkills) {
  const a = norm(descSkill.name);
  let best = null;
  let bestScore = 0;
  for (const js of jsonSkills) {
    const b = norm(js.name);
    let score = 0;
    if (a === b) score = 100;
    else if (a.includes(b) || b.includes(a)) score = 80;
    else if (a.split(/[:：]/)[0] === b.split(/[:：]/)[0]) score = 70;
    if (score > bestScore) { bestScore = score; best = js; }
  }
  return bestScore >= 70 ? best : null;
}

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) walk(abs, out);
    else if (e.name === '描述.txt') out.push(abs);
  }
  return out;
}

/**
 * 收集待比对的 [{ 武将目录, txt 路径 }]。
 * 素材目录里已经没有 描述.txt 了，改从备份里按「A__B__描述.txt」还原出武将目录名。
 */
function collectPairs() {
  const live = walk(ASSETS);
  if (live.length) {
    console.log('（数据来源：素材目录下仍然存在的 描述.txt）\n');
    return live.map((txt) => ({ dir: path.dirname(txt), folder: path.basename(path.dirname(txt)), txt }));
  }

  const files = fs.existsSync(BACKUP) ? fs.readdirSync(BACKUP).filter((f) => f.endsWith('描述.txt')) : [];
  if (!files.length) {
    console.log(`没有找到可核对的 描述.txt，也没有备份目录：${BACKUP}`);
    process.exit(0);
  }
  console.log(`（数据来源：迁移备份 ${BACKUP}）\n`);
  return files.map((f) => {
    const folder = f.replace(/__描述\.txt$/, '').split('__').pop();
    return { dir: path.join(ASSETS, folder), folder, txt: path.join(BACKUP, f) };
  });
}

let identical = 0, reworded = 0, lost = 0, extra = 0;

for (const { dir, folder, txt: txtPath } of collectPairs()) {
  const jsonPath = path.join(dir, '武将.json');
  if (!fs.existsSync(jsonPath)) { console.log(`✗ ${folder}：缺 武将.json`); continue; }

  const desc = parseDescTxt(fs.readFileSync(txtPath, 'utf8'), folder);
  const json = JSON.parse(fs.readFileSync(jsonPath, 'utf8').replace(/^\uFEFF/, ''));
  const jsonSkills = (json.cards ?? []).flatMap((c) => c.skills ?? []);
  const extrasBlob = norm((json.extras ?? []).map((g) => g.items.map((i) => `${i.name}${i.upgradedName}${i.desc}`).join('')).join(''));
  const extrasNames = (json.extras ?? []).flatMap((g) => (g.items ?? []).map((i) => norm(i.name)));

  const diffs = [];
  for (const s of desc.skills) {
    const hit = matchSkill(s, jsonSkills);
    const nd = norm(s.desc);
    if (!hit) {
      // 神宝那几行被归到 extras（神宝区）里了，按名字或描述片段都算已迁移
      const nName = norm(s.name);
      if (extrasNames.some((en) => en === nName || en.includes(nName) || nName.includes(en))) continue;
      if (extrasBlob && nd.slice(0, 20) && extrasBlob.includes(nd.slice(0, 20))) continue;
      diffs.push({ kind: '缺技能', name: s.name, txt: s.desc, json: '（JSON 里没有同名技能）' });
      continue;
    }
    const nj = norm(hit.desc);
    if (nj === nd) continue;
    // 长文本里截取首段做包含判断，避免整段措辞微调就报差异
    const same = (nj.length > 25 && nd.includes(nj.slice(0, 25))) ||
                 (nd.length > 25 && nj.includes(nd.slice(0, 25)));
    if (same) { reworded++; continue; }

    // 描述.txt 有、JSON 没有的片段（按 12 字窗口切，找出真正缺的）
    const missingBits = [];
    for (let i = 0; i + 12 <= nd.length; i += 6) {
      const win = nd.slice(i, i + 12);
      if (!nj.includes(win)) missingBits.push(win);
    }
    if (missingBits.length) {
      diffs.push({ kind: '描述不一致', name: s.name, txt: s.desc, json: hit.desc });
    } else {
      reworded++;
    }
  }

  if (diffs.length) {
    lost += diffs.length;
    console.log(`\n── ${folder} ──`);
    for (const d of diffs) {
      console.log(`  [${d.kind}] ${d.name}`);
      console.log(`     描述.txt : ${d.txt.replace(/\n/g, ' ⏎ ').slice(0, 150)}`);
      console.log(`     武将.json: ${String(d.json).replace(/\n/g, ' ⏎ ').slice(0, 150)}`);
    }
  } else {
    identical++;
  }
}

console.log(`\n完全一致/仅措辞微调：${identical} 个武将；措辞微调条目：${reworded}；需要人工确认：${lost} 条`);
