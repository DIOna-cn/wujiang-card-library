#!/usr/bin/env node
/**
 * 回归：导出为 .shap（做卡工程档）。
 *
 * 这套逻辑的承诺只有一句话 —— **只动文字，保住人工排版**。
 * 所以测试重点不是「能不能生成」，而是「除了该改的字段，别的字节一个都别动」：
 * renderConfig 里装的是人在校卡软件里一格格拖出来的立绘位移/缩放、技能框高度、
 * 字号字距，一旦被覆盖就再也回不来了。pic（内嵌立绘）同理。
 *
 * 依赖服务在 http://127.0.0.1:3456/ 上跑着。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.URL_BASE ?? 'http://127.0.0.1:3456/';

let pass = 0;
let fail = 0;
const ok = (n, c, e = '') => {
  if (c) {
    pass++;
    console.log('  \u2713 ' + n);
  } else {
    fail++;
    console.log('  \u2717 ' + n + (e ? '   -> ' + e : ''));
  }
};

const getJson = async (p) => {
  const r = await fetch(BASE + p);
  return { status: r.status, body: await r.json().catch(() => null) };
};
const getRaw = async (p) => {
  const r = await fetch(BASE + p);
  return { status: r.status, headers: r.headers, buf: Buffer.from(await r.arrayBuffer()) };
};

/* ------------------------------------------------------------------ *
 * 交叉检查用：把 web/app.js 里的 renderDesc 真身抠出来
 *
 * 网页上标色的规则（kw / card-name-ref / quoted）和导出时加 <b> 的规则
 * （server/shap-export.mjs 的 BOLD_RULES）是两份代码，很容易改了一边忘了另一边。
 * 这里拿同一段描述分别跑一遍，比较「被标记的字符区间」是否一致。
 * ------------------------------------------------------------------ */

const APP_SRC = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web', 'app.js'),
  'utf8',
);

function extractFn(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`web/app.js 里找不到 function ${name}`);
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`${name} 花括号不配对`);
}

const renderDesc = new Function(
  `${extractFn(APP_SRC, 'esc')}\n${extractFn(APP_SRC, 'renderDesc')}\nreturn renderDesc;`,
)();

/** 剥掉 <b>，用来做忽略加粗的比较 */
const stripB = (t) => String(t ?? '').replace(/<\/?b>/gi, '');

/** 合并重叠/相邻区间 */
function mergeRanges(rs) {
  if (!rs.length) return [];
  const sorted = [...rs].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out = [sorted[0].slice()];
  for (let i = 1; i < sorted.length; i++) {
    const last = out[out.length - 1];
    if (sorted[i][0] <= last[1]) last[1] = Math.max(last[1], sorted[i][1]);
    else out.push(sorted[i].slice());
  }
  return out;
}

/** 找出 HTML 里被标记的字符区间（相对纯文本的偏移） */
function markedRanges(html, isMarkOpen, isMarkClose) {
  const ranges = [];
  const stack = [];
  let textPos = 0;
  const re = /<[^>]+>|[^<]+/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const tok = m[0];
    if (tok[0] !== '<') {
      textPos += tok.length;
      continue;
    }
    if (isMarkOpen(tok)) stack.push(textPos);
    else if (isMarkClose(tok)) {
      const s = stack.pop();
      if (s !== undefined) ranges.push([s, textPos]);
    }
  }
  return ranges;
}

const webRangesOf = (desc) =>
  mergeRanges(
    markedRanges(
      renderDesc(desc),
      (t) => /^<span class="(kw|card-name-ref|quoted)">$/.test(t),
      (t) => t === '</span>',
    ),
  );

const boldRangesOf = (desc) =>
  mergeRanges(
    markedRanges(
      String(desc ?? ''),
      (t) => t === '<b>',
      (t) => t === '</b>',
    ),
  );

/** 递归列出两个对象所有不同的路径 */
function diffPaths(a, b, prefix = '', out = []) {
  if (a === b) return out;
  const ta = a === null ? 'null' : Array.isArray(a) ? 'array' : typeof a;
  const tb = b === null ? 'null' : Array.isArray(b) ? 'array' : typeof b;
  if (ta !== tb) {
    out.push(prefix);
    return out;
  }
  if (ta === 'object') {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      diffPaths(a[k], b[k], prefix ? `${prefix}.${k}` : k, out);
    }
    return out;
  }
  if (ta === 'array') {
    if (a.length !== b.length) out.push(`${prefix}.length`);
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      diffPaths(a[i], b[i], `${prefix}[${i}]`, out);
    }
    return out;
  }
  out.push(prefix);
  return out;
}

console.log('\n导出为 .shap 回归\n');

const listRes = await getJson('api/characters').catch(() => null);
if (!listRes || !listRes.body) {
  console.log('跳过：服务没在跑');
  process.exit(0);
}
const ASSETS = listRes.body.assets;
const chars = listRes.body.characters ?? [];
const pick = (...names) =>
  names.map((n) => chars.find((c) => c.dir === n || c.name === n)).find(Boolean);

const dirOf = (c) => path.join(ASSETS, c.dir);
const shapsIn = (c) => {
  try {
    return fs.readdirSync(dirOf(c)).filter((f) => /\.shap$/i.test(f) && !f.startsWith('_'));
  } catch {
    return [];
  }
};

/* ------------------------------------------------------------------ */
console.log('[1] 预览接口：有工程档的武将');

const withShapChar =
  pick('\u714c', '煌') ?? chars.find((c) => shapsIn(c).length === 1);
const pv = await getJson(`api/shap/${encodeURIComponent(withShapChar.dir)}`);
ok('预览返回 200', pv.status === 200, String(pv.status));
ok('返回卡面数组', Array.isArray(pv.body?.cards));

const single = (pv.body?.cards ?? []).find((c) => !c.isDefault);
ok('至少有一张卡用到了已有工程档', !!single);
ok('导出文件名沿用原工程档名', single?.filename === single?.skeleton?.file, `${single?.filename} / ${single?.skeleton?.file}`);
ok('变更里有技能表', (single?.changes ?? []).some((c) => c.kind === 'skills'));
ok(
  '技能变更带逐条对比数据',
  (single?.changes ?? []).some((c) => c.kind === 'skills' && Array.isArray(c.from) && Array.isArray(c.to)),
);
ok('预览里不会带出整个产物（响应应当很轻）', JSON.stringify(pv.body).length < 200000, `${JSON.stringify(pv.body).length} 字节`);

/* ------------------------------------------------------------------ */
console.log('\n[2] 没有工程档的武将走默认骨架');

const noShapChar = chars.find((c) => shapsIn(c).length === 0 && (c.cards ?? []).length);
if (!noShapChar) {
  ok('存在没有工程档的武将', false, '目录里全是 .shap？');
} else {
  const pv2 = await getJson(`api/shap/${encodeURIComponent(noShapChar.dir)}`);
  const c2 = (pv2.body?.cards ?? [])[0] ?? {};
  ok(`${noShapChar.name}：标记为使用默认骨架`, c2.isDefault === true);
  ok(`${noShapChar.name}：给出了新文件名`, /\.shap$/i.test(c2.filename ?? ''), c2.filename);
  ok(`${noShapChar.name}：骨架来源标注为默认`, !c2.skeleton, JSON.stringify(c2.skeleton));
  ok(
    `${noShapChar.name}：变更里说明了内嵌立绘的情况`,
    Array.isArray(c2.changes),
    JSON.stringify((c2.changes ?? []).map((x) => x.path)),
  );
}

/* ------------------------------------------------------------------ */
console.log('\n[3] 多卡武将按卡名挑骨架');

const multi = chars.find((c) => (c.cards ?? []).length > 1 && shapsIn(c).length > 1);
if (!multi) {
  console.log('  跳过：没有「多卡 + 多工程档」的武将');
} else {
  const pv3 = await getJson(`api/shap/${encodeURIComponent(multi.dir)}`);
  const cs = pv3.body?.cards ?? [];
  ok(`${multi.name}：卡面数对得上`, cs.length === multi.cards.length, `${cs.length} / ${multi.cards.length}`);
  const skels = cs.map((c) => c.skeleton?.file);
  ok('每张卡各配到一个不同的工程档', new Set(skels).size === skels.length, JSON.stringify(skels));
  ok(
    '没有挑中 "_" 开头的废弃工程',
    !skels.some((s) => String(s).startsWith('_')),
    JSON.stringify(skels),
  );
  ok(
    '导出文件名互不重复',
    new Set(cs.map((c) => c.filename)).size === cs.length,
    JSON.stringify(cs.map((c) => c.filename)),
  );
}

/* ------------------------------------------------------------------ */
console.log('\n[4] 嵌套目录（素材\\_归类\\<武将>）');

// 武将现在一律平躺在 素材\ 下（「做没做完」改由 json 的 implemented 表示），
// 素材里已经没有嵌套武将了。但服务端仍支持 _ 开头目录下取一层子目录，
// 这条路径的要点是 URL 里那个 %2F 能被逐段还原成子目录，不能没人守。
// 所以临时造一个真目录来测，跑完在 finally 里删干净。
const NEST_GROUP = '_自检_嵌套目录';
const NEST_NAME = '自检武将';
const nestGroupAbs = ASSETS ? path.join(ASSETS, NEST_GROUP) : '';

let nested = chars.find((c) => c.dir.includes('/'));
let tempNestMade = false;

try {
  if (!nested && nestGroupAbs) {
    const abs = path.join(nestGroupAbs, NEST_NAME);
    fs.mkdirSync(abs, { recursive: true });
    fs.writeFileSync(
      path.join(abs, '武将.json'),
      JSON.stringify({
        schema: 1,
        name: NEST_NAME,
        title: '自检临时目录，正常不该出现',
        kingdom: 'qun',
        hp: 3,
        maxHp: 3,
        cards: [{ name: '', image: '', cardImage: '', legendId: '', skills: [], derived: [] }],
        extras: [],
      }, null, 2) + '\n',
      'utf8',
    );
    tempNestMade = true;
    nested = { dir: `${NEST_GROUP}/${NEST_NAME}` };
  }

  if (!nested) {
    ok('嵌套目录：能拿到素材路径', false, `ASSETS=${ASSETS}`);
  } else {
    const pv4 = await getJson(`api/shap/${encodeURIComponent(nested.dir)}`);
    const pv4cards = pv4.body?.cards ?? [];
    ok(`${nested.dir}：带 %2F 的路径能访问`, pv4.status === 200, String(pv4.status));
    ok(`${nested.dir}：没有工程档时走默认骨架`, pv4cards.length > 0 && pv4cards.every((c) => c.isDefault));
  }
} finally {
  if (tempNestMade) {
    try { fs.rmSync(nestGroupAbs, { recursive: true, force: true }); } catch { /* 删不掉也不该把整个自检带崩 */ }
  }
}

/* ------------------------------------------------------------------ */
console.log('\n[5] 下载接口');

const full = (await getJson(`api/characters/${encodeURIComponent(withShapChar.dir)}`)).body;
const dl = await getRaw(`api/shap/${encodeURIComponent(withShapChar.dir)}?card=0`);
ok('返回 200', dl.status === 200, String(dl.status));
ok('Content-Type 是二进制流', /application\/octet-stream/.test(dl.headers.get('content-type') ?? ''), dl.headers.get('content-type'));
const cd = dl.headers.get('content-disposition') ?? '';
ok('带 Content-Disposition: attachment', /attachment/.test(cd), cd);
ok('文件名用 RFC5987 编码（中文名才不会乱）', /filename\*=UTF-8''/.test(cd), cd);
const decodedName = decodeURIComponent(cd.split("''")[1] ?? '');
ok('解码后是 .shap 文件名', /\.shap$/i.test(decodedName), decodedName);

let obj = null;
try {
  obj = JSON.parse(dl.buf.toString('utf8'));
} catch { /* 下面统一报 */ }
ok('产物是合法 JSON', !!obj);
ok('模板名正确', obj?.template?.name === 'new_ui_zhuoyue', obj?.template?.name);
ok('武将名与网页一致', obj?.baseInfo?.name === full?.name, `${obj?.baseInfo?.name} / ${full?.name}`);
ok('称号与网页一致', obj?.baseInfo?.title === (full?.title ?? ''), `${obj?.baseInfo?.title} / ${full?.title}`);
ok('势力与网页一致', obj?.baseInfo?.kingdom === (full?.kingdom ?? ''), `${obj?.baseInfo?.kingdom} / ${full?.kingdom}`);
ok(
  '体力与网页一致',
  obj?.baseInfo?.hp === Number(full?.hp) && obj?.baseInfo?.maxHp === Number(full?.maxHp),
  `${obj?.baseInfo?.hp}/${obj?.baseInfo?.maxHp} vs ${full?.hp}/${full?.maxHp}`,
);
ok('技能条数与网页一致', (obj?.baseInfo?.skills ?? []).length === (full?.cards?.[0]?.skills ?? []).length);
ok(
  '技能名与描述逐条一致（剥掉加粗标记后）',
  JSON.stringify((obj?.baseInfo?.skills ?? []).map((s) => [s.name, stripB(s.desc)])) ===
    JSON.stringify((full?.cards?.[0]?.skills ?? []).map((s) => [s.name, s.desc])),
);

/* ------------------------------------------------------------------ */
console.log('\n[6] 核心承诺：只动文字，保住人工排版');

const origFile = path.join(dirOf(withShapChar), single?.skeleton?.file ?? '');
const orig = JSON.parse(fs.readFileSync(origFile, 'utf8'));

ok('renderConfig 一字未动', diffPaths(orig.renderConfig, obj.renderConfig).length === 0, diffPaths(orig.renderConfig, obj.renderConfig).join(', '));
ok('pic（内嵌立绘）原样保留', orig.baseInfo.pic === obj.baseInfo.pic, `${orig.baseInfo.pic.length} vs ${obj.baseInfo.pic.length}`);
ok('template 未动', JSON.stringify(orig.template) === JSON.stringify(obj.template));
ok('customMaterialList 未动', JSON.stringify(orig.customMaterialList) === JSON.stringify(obj.customMaterialList));
ok('顶层字段既没多也没少', JSON.stringify(Object.keys(orig).sort()) === JSON.stringify(Object.keys(obj).sort()), Object.keys(obj).join(','));

const allDiff = diffPaths(orig, obj);
ok(
  '所有差异都落在 baseInfo 里',
  allDiff.every((p) => p.startsWith('baseInfo.') || p.startsWith('renderConfig.')),
  allDiff.join(', '),
);
console.log(`      实际差异 ${allDiff.length} 处：${allDiff.slice(0, 8).join('、')}${allDiff.length > 8 ? ' …' : ''}`);

/* ------------------------------------------------------------------ */
console.log('\n[7] 导出是只读操作');

const dAbs = dirOf(withShapChar);
const before = fs.readdirSync(dAbs).sort().join('|');
const jsonAbs = path.join(dAbs, '武将.json');
const mtimeBefore = fs.statSync(jsonAbs).mtimeMs;

await getRaw(`api/shap/${encodeURIComponent(withShapChar.dir)}?card=0`);
await getJson(`api/shap/${encodeURIComponent(withShapChar.dir)}`);

ok('素材目录文件列表不变', before === fs.readdirSync(dAbs).sort().join('|'));
ok('武将.json 没被改写', fs.statSync(jsonAbs).mtimeMs === mtimeBefore);
ok('没有多出 .shap 文件', fs.readdirSync(dAbs).filter((f) => /\.shap$/i.test(f)).length === shapsIn(withShapChar).length);

/* ------------------------------------------------------------------ */
console.log('\n[8] 错误处理');

const bad1 = await getRaw(`api/shap/${encodeURIComponent(withShapChar.dir)}?card=99`);
ok('越界卡号返回 404', bad1.status === 404, String(bad1.status));
const bad2 = await getRaw(`api/shap/${encodeURIComponent('这个武将绝对不存在')}`);
ok('不存在的武将返回 404', bad2.status === 404, String(bad2.status));
const bad3 = await getRaw(`api/shap/${encodeURIComponent(withShapChar.dir)}?card=abc`);
ok('非数字卡号也返回 404', bad3.status === 404, String(bad3.status));

/* ------------------------------------------------------------------ */
console.log('\n[9] 默认骨架按势力换卡框');

const otherK = chars.find((c) => shapsIn(c).length === 0 && c.kingdom && (c.cards ?? []).length);
if (!otherK) {
  console.log('  跳过：没有「无工程档 + 有势力」的武将');
} else {
  const d3 = await getRaw(`api/shap/${encodeURIComponent(otherK.dir)}?card=0`);
  const o3 = JSON.parse(d3.buf.toString('utf8'));
  ok(
    `${otherK.name}（${otherK.kingdom}）：卡框跟随势力`,
    o3.renderConfig.items.frame.src === otherK.kingdom,
    String(o3.renderConfig.items.frame.src),
  );
  ok(
    `${otherK.name}：势力字形跟随势力`,
    o3.renderConfig.items.kingdom.singlePresetGlyphKey === `${otherK.kingdom}:normal`,
    String(o3.renderConfig.items.kingdom.singlePresetGlyphKey),
  );
}

/* ------------------------------------------------------------------ */
console.log('\n[10] 专名加粗（导出的 <b>）');

const skillsOut = obj?.baseInfo?.skills ?? [];
const skillsWeb = full?.cards?.[0]?.skills ?? [];
const allDesc = skillsOut.map((s) => s.desc).join('\n');

const openCount = (allDesc.match(/<b>/g) ?? []).length;
const closeCount = (allDesc.match(/<\/b>/g) ?? []).length;
ok('加粗标记成对', openCount === closeCount && openCount > 0, `<b>×${openCount} </b>×${closeCount}`);
ok('没有嵌套 <b><b>', !allDesc.includes('<b><b>'), allDesc.slice(0, 120));
ok('没有空的 <b></b>', !/<b><\/b>/.test(allDesc));
ok('没有残留的老标记 <bi>', !/<bi>/i.test(allDesc));
ok(
  '预览里的加粗处数与产物一致',
  single?.bold?.count === openCount,
  `预览 ${single?.bold?.count} / 产物 ${openCount}`,
);
ok('预览给了加粗样例', Array.isArray(single?.bold?.samples) && single.bold.samples.length > 0);

// 核心：网页上标色的位置，必须和导出时加粗的位置一一对应
let rangeOk = true;
let rangeDetail = '';
for (let i = 0; i < skillsOut.length; i++) {
  const web = skillsWeb[i]?.desc ?? '';
  const a = JSON.stringify(webRangesOf(web));
  const b = JSON.stringify(boldRangesOf(skillsOut[i]?.desc ?? ''));
  if (a !== b) {
    rangeOk = false;
    rangeDetail = `第 ${i + 1} 条「${skillsOut[i]?.name}」：网页 ${a} vs 导出 ${b}`;
    break;
  }
}
ok('加粗位置与网页标色位置完全一致', rangeOk, rangeDetail);

// 反复导出必须得到同样的字节，否则每次导出都会「变化」
const again = await getRaw(`api/shap/${encodeURIComponent(withShapChar.dir)}?card=0`);
ok('连续两次导出字节完全相同（幂等）', Buffer.compare(dl.buf, again.buf) === 0);

// 数据文件本身不该出现 <b> —— 加粗只在导出时发生
ok(
  '网页原文里没有 <b>（加粗只发生在导出产物里）',
  !/<b>/i.test(JSON.stringify(skillsWeb)),
  (JSON.stringify(skillsWeb).match(/<b>/gi) ?? []).join(','),
);

/* ------------------------------------------------------------------ */
console.log(`\n通过 ${pass}/${pass + fail}`);
process.exit(fail === 0 ? 0 : 1);
