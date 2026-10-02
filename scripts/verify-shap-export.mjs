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
console.log('\n[4] 嵌套目录');

const nested = chars.find((c) => c.dir.includes('/'));
if (!nested) {
  console.log('  跳过：没有嵌套目录的武将');
} else {
  const pv4 = await getJson(`api/shap/${encodeURIComponent(nested.dir)}`);
  ok(`${nested.dir}：能访问`, pv4.status === 200, String(pv4.status));
  ok(`${nested.dir}：认得自己的工程档`, (pv4.body?.cards ?? []).some((c) => !c.isDefault));
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
  '技能名与描述逐条一致',
  JSON.stringify((obj?.baseInfo?.skills ?? []).map((s) => [s.name, s.desc])) ===
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
console.log(`\n通过 ${pass}/${pass + fail}`);
process.exit(fail === 0 ? 0 : 1);
