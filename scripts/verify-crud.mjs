/**
 * 单独验证「新建武将 → 写入文件 → 编辑改名 → 删除进回收站」这条链路。
 * 用临时武将，跑完自动清理。
 */
import fs from 'node:fs';
import path from 'node:path';

const BASE = 'http://127.0.0.1:3456';
const ASSETS = 'E:\\Deepseek\\素材';
const RECYCLE = 'E:\\Deepseek\\武将牌库\\.data\\回收站';
const NAME = `__自检临时武将${Date.now() % 100000}`;

const results = [];
const ok = (n, p, d = '') => { results.push(p); console.log(`${p ? '  ✓' : '  ✗'} ${n}${d ? `  — ${d}` : ''}`); };

const api = async (p, opt = {}) => {
  const r = await fetch(BASE + p, { headers: { 'Content-Type': 'application/json' }, ...opt });
  const t = await r.text();
  let j; try { j = t ? JSON.parse(t) : {}; } catch { j = { raw: t }; }
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
};

console.log('—— 新建武将 ——');
const created = await api('/api/characters', {
  method: 'POST',
  body: JSON.stringify({
    name: NAME, title: '自检称号', kingdom: 'qun',
    hp: 4, maxHp: 4, shield: 1, legendId: 'TEST 001',
    gender: '女', origin: '原创', tags: ['自检'], implemented: false,
    note: '这条是自检生成的',
  }),
});
const id = created.character.id;
const dir = created.character.dir;
const jsonPath = path.join(ASSETS, ...dir.split('/'), '武将.json');
ok('接口返回了新武将', !!id, `id=${id}`);
ok('文件夹已创建', fs.existsSync(path.dirname(jsonPath)), path.dirname(jsonPath));
ok('武将.json 已写入', fs.existsSync(jsonPath));

const disk = JSON.parse(fs.readFileSync(jsonPath, 'utf8').replace(/^\uFEFF/, ''));
ok('字段落盘正确', disk.name === NAME && disk.kingdom === 'qun' && disk.hp === 4 && disk.shield === 1,
  `name=${disk.name} kingdom=${disk.kingdom} hp=${disk.hp} shield=${disk.shield}`);
ok('原作单独落在 origin 字段（没混进 tags）', disk.origin === '原创' && Array.isArray(disk.tags) && !disk.tags.includes('原创'),
  `origin=${disk.origin}  tags=[${disk.tags.join(',')}]`);
ok('初始带一张空卡面', Array.isArray(disk.cards) && disk.cards.length === 1, `cards=${disk.cards?.length}`);
ok('待实现标记落盘', disk.implemented === false, `implemented=${disk.implemented}`);

console.log('\n—— 编辑：加技能 + 改体力 ——');
const full = await api(`/api/characters/${encodeURIComponent(id)}`);
full.hp = 3;
// 模拟老数据：字段整个不存在的武将（素材里二十多个都没写过 implemented），
// 服务端必须当成「已实现」，而不是把 undefined 原样写回去
delete full.implemented;
full.cards[0].skills = [
  { name: '测试技', desc: '出牌阶段限一次，你可以对【杀】的目标造成1点伤害。\n第二行文本。' },
  { name: '衍生', desc: '锁定技。', derived: true },
];
full.cards[0].cards = undefined;
const updated = await api(`/api/characters/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(full) });
const disk2 = JSON.parse(fs.readFileSync(jsonPath, 'utf8').replace(/^\uFEFF/, ''));
ok('体力改动落盘', disk2.hp === 3, `hp=${disk2.hp}`);
ok('网页没传 implemented 时沿用磁盘旧值（不会改个技能就把标记弄丢）',
  disk2.implemented === false, `implemented=${disk2.implemented}`);
ok('技能落盘（含换行与衍生标记）',
  disk2.cards[0].skills.length === 2 &&
  disk2.cards[0].skills[0].desc.includes('\n') &&
  disk2.cards[0].skills[1].derived === true,
  `skills=${disk2.cards[0].skills.map((s) => s.name + (s.derived ? '(衍生)' : '')).join('/')}`);

console.log('\n—— 待实现标记 ——');
full.implemented = false;
await api(`/api/characters/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(full) });
const disk3 = JSON.parse(fs.readFileSync(jsonPath, 'utf8').replace(/^\uFEFF/, ''));
ok('改成待实现后落盘', disk3.implemented === false, `implemented=${disk3.implemented}`);

// 真·老数据：文件里压根没有 implemented 这个键（素材里二十多个武将全是这样）。
// 这是整套设计成立的关键——不写字段 = 已实现，所以旧文件一个都不用动。
const legacy = JSON.parse(fs.readFileSync(jsonPath, 'utf8').replace(/^\uFEFF/, ''));
delete legacy.implemented;
fs.writeFileSync(jsonPath, JSON.stringify(legacy, null, 2) + '\n', 'utf8');
const legacyRead = await api(`/api/characters/${encodeURIComponent(id)}`);
ok('文件里没有 implemented 这一项时，读取视为已实现',
  legacyRead.implemented === true, `implemented=${legacyRead.implemented}`);

// 放回「待实现」，后面查列表那几条还要用它
legacyRead.implemented = false;
await api(`/api/characters/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(legacyRead) });

console.log('\n—— 标签与原作表 ——');
// 先记下现状，测完原样放回（绝不能让自检改坏你的清单）
const before = await api('/api/tags');
const tagsRes = await api('/api/tags', {
  method: 'PUT',
  body: JSON.stringify({ tags: ['自检', '明日方舟', '东方Project'], origins: ['原创', '明日方舟'] }),
});
ok('标签与原作表可写入',
  tagsRes.tags.length === 3 && tagsRes.origins.length === 2,
  `tags=[${tagsRes.tags.join(',')}] origins=[${tagsRes.origins.join(',')}]`);
const listAfter = await api('/api/characters');
ok('新武将出现在列表里', listAfter.characters.some((c) => c.id === id));
ok('列表接口把 implemented 一并交给前端（卡片外框靠它决定）',
  listAfter.characters.find((c) => c.id === id)?.implemented === false,
  `implemented=${listAfter.characters.find((c) => c.id === id)?.implemented}`);
ok('列表里带上了标签与原作',
  listAfter.characters.find((c) => c.id === id)?.tags?.includes('自检') &&
  listAfter.characters.find((c) => c.id === id)?.origin === '原创');

console.log('\n—— 删除进回收站 ——');
await api(`/api/characters/${encodeURIComponent(id)}`, { method: 'DELETE' });
ok('文件夹已移走', !fs.existsSync(path.dirname(jsonPath)));
const inRecycle = fs.existsSync(RECYCLE) && fs.readdirSync(RECYCLE).some((n) => n.includes('自检临时武将'));
ok('回收站里能找到', inRecycle, inRecycle ? fs.readdirSync(RECYCLE).filter((n) => n.includes('自检临时武将')).join(', ') : '没找到');

// 清理回收站里的自检残留
for (const n of fs.existsSync(RECYCLE) ? fs.readdirSync(RECYCLE) : []) {
  if (n.includes('自检临时武将')) fs.rmSync(path.join(RECYCLE, n), { recursive: true, force: true });
}
// 恢复标签表原样（不能用硬编码，否则会覆盖你在网页上加的标签）
await api('/api/tags', {
  method: 'PUT',
  body: JSON.stringify({ tags: before.tags, origins: before.origins }),
});
const after = await api('/api/tags');
ok('标签表已还原',
  JSON.stringify(after.tags) === JSON.stringify(before.tags) &&
  JSON.stringify(after.origins) === JSON.stringify(before.origins),
  `tags=[${after.tags.join(',')}] origins=[${after.origins.join(',')}]`);
ok('自检残留已清理', !fs.existsSync(path.dirname(jsonPath)));

const passed = results.filter(Boolean).length;
console.log(`\n通过 ${passed}/${results.length}`);
process.exit(passed === results.length ? 0 : 1);
