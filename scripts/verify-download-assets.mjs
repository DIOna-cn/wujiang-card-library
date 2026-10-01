#!/usr/bin/env node
/**
 * 验证「下载」会把素材内容写回本地。
 *
 * 以前的 writeDataBack 只写 武将.json / tags.json / 原始描述备份，
 * 于是新拿到项目的人点「下载」只能得到文字，一张图都没有。
 * 现在范围是「素材下的一切（.shap 除外）+ 数据文件」，项目代码仍然不写回。
 *
 * 纯文件系统操作：不涉及 git、不联网、不碰真实素材。
 */

import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { writeDataBack, MODES, DEFAULT_MODE } from '../server/sync-core.mjs';

let pass = 0;
let fail = 0;
const ok = (n, c, e = '') => {
  if (c) { pass++; console.log('  \u2713 ' + n); }
  else { fail++; console.log('  \u2717 ' + n + (e ? '   -> ' + e : '')); }
};

const exists = async (p) => { try { await fsp.access(p); return true; } catch { return false; } };
const readText = (p) => fsp.readFile(p, 'utf8');

const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'wj-dl-'));
const work = path.join(tmp, 'work');
const project = path.join(tmp, 'project');
const assets = path.join(tmp, 'assets');

/** 在 work 里造一个文件 */
async function put(rel, body) {
  const abs = path.join(work, ...rel.split('/'));
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, body);
}

try {
  console.log('\n[1] 范围定义');
  ok('默认范围是 all', DEFAULT_MODE === 'all', DEFAULT_MODE);
  ok('all 含带技能卡图（cardfull）', MODES.all.includes('cardfull'));
  ok('all 不含 .shap 工程档', !MODES.all.includes('shap'));
  ok('full 仍然含 .shap（保留老行为）', MODES.full.includes('shap'));

  console.log('\n[2] 造一个工作副本的内容');
  await fsp.mkdir(project, { recursive: true });
  await fsp.mkdir(assets, { recursive: true });
  await put('素材/测试武将/武将.json', '{"name":"测试武将"}');
  await put('素材/测试武将/立绘.png', 'PNG-立绘-内容');
  await put('素材/测试武将/语音.mp3', 'MP3-语音-内容');
  await put('素材/测试武将/神宝卡图/风花节.png', 'PNG-神宝卡图-内容');
  await put('素材/测试武将/原画/草稿.png', 'PNG-原画-内容');
  await put('素材/测试武将/新UI.带技能卡图.png', 'PNG-带技能卡图-内容');
  await put('素材/测试武将/工程.shap', 'SHAP-工程档-内容');
  await put('.data/tags.json', '{"tags":[]}');
  await put('.data/原始描述备份/旧描述.txt', '旧描述内容');
  await put('.data/sync.json', '{"proxy":"x"}');
  await put('web/app.js', 'console.log("远端代码")');
  await put('README.md', '# 远端说明');
  await put('.git/config', '[core]');
  ok('工作副本已就绪', await exists(path.join(work, '素材', '测试武将', '立绘.png')));

  console.log('\n[3] 执行写回');
  const r1 = await writeDataBack({ work, project, assets });
  const A = (...p) => path.join(assets, ...p);
  const P = (...p) => path.join(project, ...p);

  console.log('\n  应该写回的：');
  ok('武将.json', await exists(A('测试武将', '武将.json')));
  ok('立绘.png ← 以前不会下来', await exists(A('测试武将', '立绘.png')));
  ok('语音.mp3 ← 以前不会下来', await exists(A('测试武将', '语音.mp3')));
  ok('神宝卡图/风花节.png', await exists(A('测试武将', '神宝卡图', '风花节.png')));
  ok('原画/草稿.png', await exists(A('测试武将', '原画', '草稿.png')));
  ok('新UI.带技能卡图.png ← 这次新加的重点', await exists(A('测试武将', '新UI.带技能卡图.png')));
  ok('.data/tags.json', await exists(P('.data', 'tags.json')));
  ok('.data/原始描述备份/旧描述.txt', await exists(P('.data', '原始描述备份', '旧描述.txt')));

  console.log('\n  不该写回的：');
  ok('.shap 工程档不写回', !(await exists(A('测试武将', '工程.shap'))));
  ok('项目代码 web/app.js 不写回', !(await exists(P('web', 'app.js'))));
  ok('README.md 不写回', !(await exists(P('README.md'))));
  ok('.data/sync.json 不写回', !(await exists(P('.data', 'sync.json'))));
  ok('.git 里的东西不写回', !(await exists(P('.git'))));

  console.log('\n[4] 内容必须逐字节一致');
  ok('图片内容一致', (await readText(A('测试武将', '立绘.png'))) === 'PNG-立绘-内容');
  ok('卡图内容一致', (await readText(A('测试武将', '新UI.带技能卡图.png'))) === 'PNG-带技能卡图-内容');

  console.log('\n[5] 再跑一次：应当全部「本来一致」，不重复写');
  const r2 = await writeDataBack({ work, project, assets });
  ok('第二次没有新增', r2.added.length === 0, r2.added.join(', '));
  ok('第二次没有更新', r2.updated.length === 0, r2.updated.join(', '));
  ok('第二次全部判定为一致', r2.same.length === r2.total, `${r2.same.length}/${r2.total}`);

  console.log('\n[6] 远端改了图：本地那份要被覆盖（这是选定的策略）');
  await fsp.writeFile(A('测试武将', '立绘.png'), '本地自己改的旧图');
  await put('素材/测试武将/立绘.png', 'PNG-远端的新图');
  const r3 = await writeDataBack({ work, project, assets });
  ok('识别出立绘有变化', r3.updated.some((x) => x.endsWith('立绘.png')), r3.updated.join(', '));
  ok('本地被远端版本覆盖', (await readText(A('测试武将', '立绘.png'))) === 'PNG-远端的新图');

  console.log('\n[7] 远端删掉的文件，本地不能跟着删（只增不删）');
  await fsp.rm(path.join(work, '素材', '测试武将', '语音.mp3'), { force: true });
  await writeDataBack({ work, project, assets });
  ok('本地那份语音还在', await exists(A('测试武将', '语音.mp3')));
} finally {
  await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
}

console.log(`\n下载素材验证：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail ? 1 : 0);
