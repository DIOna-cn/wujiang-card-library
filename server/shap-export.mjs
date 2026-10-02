/**
 * 武将牌库 · 导出为 .shap（做卡工程档）
 *
 * 方向跟 scripts/import.mjs 相反：那边是 .shap → 武将.json 的迁移，
 * 这边是把网页上编辑好的内容写回 .shap，好直接丢进做卡软件出卡图。
 *
 * 为什么不能凭空生成：
 *   .shap 是纯文本 JSON，模板固定（new_ui_zhuoyue），格式本身很好造。
 *   但 renderConfig 里装的是人工在校卡软件里一格一格拖出来的排版 ——
 *   立绘的位移与缩放、技能框的高度、字号字距。这些信息 武将.json 里根本没有，
 *   也推不出来。比如煌的立绘是 x=-67.34 / scale=2.35（放大裁切成胸像），
 *   塔露拉的是 x=4.75 / scale=1（原样摆放）。凭空生成等于把人工排版全丢掉。
 *
 * 所以做法是「借骨架」：
 *   1) 该武将已有 .shap  → 拿它当底，只覆盖文字字段，立绘与排版原样保留
 *   2) 没有 .shap        → 借用 server/shap-default.json，并按势力换掉卡框
 *      （势力影响 renderConfig 里的 frame.src 与 kingdom.singlePresetGlyphKey）
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 默认骨架。由 scripts 从塔露拉那份工程提取，理由见文件顶部说明。 */
const DEFAULT_SKELETON_FILE = path.join(__dirname, 'shap-default.json');

/** 扩展名 → data URL 的 MIME */
const IMAGE_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
};

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const stemOf = (file) => file.replace(/\.shap$/i, '');

/** 去掉 Windows 文件名里的非法字符，供新建文件名使用 */
function legalName(s) {
  return String(s ?? '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 目录里可用的 .shap。
 * 排除 "_" 开头的 —— 那些是 import.mjs 里明确忽略的重复/废弃工程
 * （例如 结城理 的 _重复工程_面具①.结城理.shap，比正式的那份旧）。
 */
export function listShapFiles(dirAbs) {
  let names;
  try {
    names = fs.readdirSync(dirAbs);
  } catch {
    return [];
  }
  return names
    .filter((n) => /\.shap$/i.test(n) && !n.startsWith('_'))
    .map((n) => ({ file: n, abs: path.join(dirAbs, n) }))
    .sort((a, b) => a.file.localeCompare(b.file, 'zh'));
}

/**
 * 给某张卡挑骨架。返回 null 表示没有可用骨架（要退回默认骨架）。
 *
 * 顺序：卡名匹配 → 目录唯一 → source.shap → 第一个
 * 为什么卡名优先：结城理有三张卡（面具①②③）对应三个工程档，
 * 而 武将.json 的 source.shap 指的偏偏是那个"重复工程"，按它挑会挑错。
 */
export function pickSkeleton(dirAbs, { card = {}, sourceShap = '' } = {}) {
  const all = listShapFiles(dirAbs);
  const cardName = String(card.name ?? '').trim();

  // 1) 卡名匹配：文件名以「卡名.」开头，或某个 "." 分段正好等于卡名
  if (cardName) {
    const hit = all.find((s) => {
      const st = stemOf(s.file);
      return st === cardName || st.startsWith(`${cardName}.`) || st.split('.').includes(cardName);
    });
    if (hit) return { ...hit, from: `按卡名「${cardName}」匹配`, byName: true };
  }

  // 2) 目录里只有一个工程档，那就是它
  if (all.length === 1) return { ...all[0], from: '目录里唯一的工程档', byName: false };

  // 3) 武将.json 里记录的来源
  const src = String(sourceShap ?? '').trim();
  if (src) {
    const hit = all.find((x) => x.file === src);
    if (hit) return { ...hit, from: '武将.json 记录的来源工程档', byName: false };
  }

  // 4) 兜底：排序后的第一个
  if (all.length) return { ...all[0], from: '目录里的第一个工程档', byName: false };

  return null;
}

/** 读默认骨架（每次返回新对象，调用方可以随便改） */
export function loadDefaultSkeleton() {
  return JSON.parse(fs.readFileSync(DEFAULT_SKELETON_FILE, 'utf8'));
}

/** 把素材图片读成 data URL；读不到就返回空并给出提示 */
function imageDataUrl(dirAbs, file) {
  const name = String(file ?? '').trim();
  if (!name) return { url: '', warning: '' };
  const abs = path.join(dirAbs, name);
  let buf;
  try {
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      return { url: '', warning: `立绘「${name}」在武将目录里没找到` };
    }
    buf = fs.readFileSync(abs);
  } catch (err) {
    return { url: '', warning: `立绘「${name}」读取失败：${err.message}` };
  }
  const mime = IMAGE_MIME[path.extname(name).toLowerCase()] ?? 'image/png';
  return { url: `data:${mime};base64,${buf.toString('base64')}`, warning: '' };
}

/** 卡上的技能表 → 干净的两字段数组 */
function normSkills(card) {
  return (card.skills ?? [])
    .map((s) => ({ name: String(s?.name ?? ''), desc: String(s?.desc ?? '') }))
    .filter((s) => s.name || s.desc);
}

/**
 * 网页上会标色的三类内容 —— 技能类型词、【牌名】、引号里的专名。
 *
 * 这三条必须和 web/app.js 的 renderDesc 保持一致，否则网页上看到的高亮
 * 和导出的加粗会对不上（scripts/verify-shap-export.mjs 的 [10] 有交叉检查盯着）。
 */
const BOLD_RULES = [
  /(锁定技|持恒技|觉醒技|限定技|转换技|使命技|主公技|蓄力技|衍生技)/g,
  /【[^】]{1,12}】/g,
  /(「[^」]{1,40}」|『[^』]{1,40}』|“[^”]{1,40}”|‘[^’]{1,40}’|"[^"]{1,40}")/g,
];

/** 剥掉 <b>，用来做「语义上有没有改」的比较 */
const stripBold = (t) => String(t ?? '').replace(/<\/?b>/gi, '');

/**
 * 给标色内容左右包上 <b></b>，让做卡软件里也能加粗。
 *
 * 三点讲究：
 *  1. 先把历史遗留的 <b> 剥掉再按当前规则来一遍 —— 反复导出不会越包越多层，
 *     也不会留下「手工加粗」和「自动加粗」混杂的中间态；
 *  2. 三类匹配到的区间要合并重叠，避免出现 <b><b>…</b></b>；
 *  3. 不成对的引号、空引号、超长的不动，和网页上的判断完全一致。
 */
function boldifySpans(text) {
  const src = String(text ?? '');
  if (!src) return { text: '', count: 0 };

  const clean = stripBold(src);
  const spans = [];
  for (const re of BOLD_RULES) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(clean)) !== null) {
      if (m[0].length === 0) {
        re.lastIndex++;
        continue;
      }
      spans.push([m.index, m.index + m[0].length]);
    }
  }
  if (!spans.length) return { text: clean, count: 0 };

  spans.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged = [spans[0].slice()];
  for (let i = 1; i < spans.length; i++) {
    const last = merged[merged.length - 1];
    if (spans[i][0] <= last[1]) last[1] = Math.max(last[1], spans[i][1]);
    else merged.push(spans[i].slice());
  }

  let out = '';
  let cursor = 0;
  for (const [s0, e0] of merged) {
    out += clean.slice(cursor, s0) + '<b>' + clean.slice(s0, e0) + '</b>';
    cursor = e0;
  }
  out += clean.slice(cursor);
  return { text: out, count: merged.length };
}

/** 生成导出文件名 */
function exportFileName({ character, card, index, skeleton, multiCard }) {
  const who = legalName(character.name || character.dir || '武将') || '武将';

  // 骨架就是这张卡自己的（按卡名匹配到），沿用它的文件名，放回素材目录正好覆盖原件
  if (skeleton && skeleton.byName) return skeleton.file;

  // 单卡武将：沿用骨架名，同样是为了覆盖原件
  if (skeleton && !multiCard) return skeleton.file;

  // 多卡共用同一个骨架（比如塔露拉的觉醒前/觉醒后只有一个工程档）：
  // 必须靠卡名区分，否则两个文件会重名
  const tag = legalName(card.name || character.title || who) || who;
  return `${tag}.${who}.shap`;
}

/**
 * 生成一张卡的 .shap。
 *
 * 返回：
 *   {
 *     ok, index, cardName, filename, skeleton: {file, from, byName} | null,
 *     isDefault, changes: [...], warnings: [...], obj
 *   }
 * changes 是给前端画「哪些字段被覆盖」用的，结构 {label, path, from, to, kind}。
 */
export function buildCardShap({ character = {}, card = {}, index = 0, dirAbs = '' } = {}) {
  const multiCard = (character.cards ?? []).length > 1;
  const skeleton = pickSkeleton(dirAbs, {
    card,
    sourceShap: character.source?.shap ?? '',
  });
  const isDefault = !skeleton;

  let raw;
  try {
    raw = isDefault ? loadDefaultSkeleton() : JSON.parse(fs.readFileSync(skeleton.abs, 'utf8'));
  } catch (err) {
    return {
      ok: false,
      index,
      cardName: String(card.name ?? ''),
      error: `读不到骨架：${err.message}`,
      changes: [],
      warnings: [],
    };
  }

  // 深拷贝，别把默认骨架或磁盘上的对象改脏
  const obj = JSON.parse(JSON.stringify(raw));
  const bi = obj.baseInfo ?? (obj.baseInfo = {});
  const changes = [];
  const warnings = [];

  const put = (label, key, value) => {
    const from = bi[key];
    if (JSON.stringify(from) === JSON.stringify(value)) return;
    bi[key] = value;
    changes.push({ label, path: `baseInfo.${key}`, from, to: value });
  };

  const kingdom = String(character.kingdom ?? '').trim();

  put('武将名', 'name', String(character.name ?? ''));
  put('称号', 'title', String(character.title ?? ''));
  if (kingdom) put('势力', 'kingdom', kingdom);
  put('体力', 'hp', num(character.hp));
  put('体力上限', 'maxHp', num(character.maxHp));
  put('护甲', 'shield', num(character.shield));
  put('稀有度', 'quality', String(character.quality ?? 'epic'));
  put('编号', 'legendId', String(card.legendId || character.legendId || ''));
  put('台词', 'quote', String(character.quote ?? ''));
  put('版权', 'copyright', String(character.copyright ?? ''));
  put('主公标记', 'masterFlag', !!character.isLord);

  // ---- 技能表 ----
  // .shap 里的衍生技就是普通条目（煌的沸腾/爆裂在工程档里看不出是衍生），
  // 所以这里不做区分，原样写进去。
  //
  // 网页上会标色的三类内容，写进工程档时换成 <b></b> 包起来。判断「有没有改过」
  // 用的是剥掉 <b> 的原文，免得上次导出留下的加粗被当成一次新修改而反复刷屏。
  const skills = normSkills(card);
  const beforeSkills = (bi.skills ?? []).map((s) => ({
    name: String(s?.name ?? ''),
    desc: stripBold(String(s?.desc ?? '')),
  }));

  let boldCount = 0;
  const boldSamples = [];
  bi.skills = skills.map((s) => {
    const r = boldifySpans(s.desc);
    boldCount += r.count;
    for (const m of r.text.matchAll(/<b>([^<]{1,40})<\/b>/g)) {
      if (boldSamples.length < 8 && !boldSamples.includes(m[1])) boldSamples.push(m[1]);
    }
    return { name: s.name, desc: r.text };
  });

  if (JSON.stringify(beforeSkills) !== JSON.stringify(skills)) {
    changes.push({
      label: '技能表',
      path: 'baseInfo.skills',
      from: beforeSkills,
      to: skills,
      kind: 'skills',
    });
  }

  // ---- 立绘 ----
  // 有骨架时保留骨架里的 pic：那是校卡软件里已经摆好位置的图，
  // 而「摆在哪」正是我们要保住的东西。只有默认骨架才现读立绘内嵌。
  if (isDefault) {
    const img = imageDataUrl(dirAbs, card.image);
    if (img.warning) warnings.push(img.warning);
    if (img.url) {
      bi.pic = img.url;
      changes.push({
        label: '内嵌立绘',
        path: 'baseInfo.pic',
        from: '',
        to: `${card.image}（${(img.url.length / 1024 / 1024).toFixed(1)} MB base64）`,
        kind: 'info',
      });
    }
  }

  // ---- 势力 → 卡框 ----
  // renderConfig 里只有这两个字段随势力变化，其余差异都是人工排版。
  const items = obj.renderConfig?.items;
  if (items && kingdom) {
    const frame = items.frame ?? (items.frame = {});
    if (frame.src !== kingdom) {
      changes.push({
        label: '卡框势力',
        path: 'renderConfig.items.frame.src',
        from: frame.src,
        to: kingdom,
      });
      frame.src = kingdom;
    }
    const kd = items.kingdom ?? (items.kingdom = {});
    const glyph = `${kingdom}:normal`;
    if (kd.singlePresetGlyphKey !== glyph) {
      changes.push({
        label: '势力字形',
        path: 'renderConfig.items.kingdom.singlePresetGlyphKey',
        from: kd.singlePresetGlyphKey,
        to: glyph,
      });
      kd.singlePresetGlyphKey = glyph;
    }
  } else if (isDefault && !kingdom) {
    // 默认骨架自带 shu 的框，势力空着就只能沿用；做卡软件总得有个框可画
    warnings.push('这个武将还没填势力，卡框沿用了默认骨架的「shu」；补上势力再导一次即可');
  }

  return {
    ok: true,
    index,
    cardName: String(card.name ?? ''),
    filename: exportFileName({ character, card, index, skeleton, multiCard }),
    skeleton: skeleton ? { file: skeleton.file, from: skeleton.from, byName: !!skeleton.byName } : null,
    isDefault,
    changes,
    warnings,
    bold: { count: boldCount, samples: boldSamples },
    obj,
  };
}

/** 生成一个武将的全部卡 */
export function buildCharacterShap({ character = {}, dirAbs = '' } = {}) {
  const cards = (character.cards ?? []).length
    ? character.cards
    : [{ name: '', skills: [] }];
  return cards.map((card, index) => buildCardShap({ character, card, index, dirAbs }));
}

/** 序列化成 .shap 字节（2 空格缩进、UTF-8 无 BOM、末尾不补换行 —— 与原文件一致） */
export function serializeShap(obj) {
  return Buffer.from(JSON.stringify(obj, null, 2), 'utf8');
}

/** 预览用：把 changes 收拾干净（obj 太大，不能塞进 JSON 响应） */
export function toPreview(result) {
  const { obj, ...rest } = result;
  return rest;
}
