#!/usr/bin/env node
/**
 * 回归：技能描述的渲染（web/app.js 里的 renderDesc）。
 *
 * 覆盖三件事：
 *  1. 引号括起来的内容要单独标色 —— 全角「」『』“”‘’ 和半角 ""，半角到这一步
 *     已经被 esc() 转成 &quot; 了，所以按实体匹配；
 *  2. 【牌名】与技能类型词的高亮不能被引号规则搅乱，两者可以同时出现在一句里；
 *  3. 描述里的 <> 必须被转义（不能变成真标签），作者写的 <b> 要能穿过转义活下来。
 *
 * 做法是从 web/app.js 里**抠出 esc / renderDesc 的真身**来跑，而不是抄一份逻辑 ——
 * 抄一份就等于没测到真代码。纯函数，不需要服务、不需要浏览器，跑得很快。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(__dirname, '..', 'web', 'app.js'), 'utf8');

/** 从源码里抠出一个函数声明（按花括号配平） */
function extract(name) {
  const start = SRC.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`web/app.js 里找不到 function ${name}`);
  const open = SRC.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}') {
      depth--;
      if (depth === 0) return SRC.slice(start, i + 1);
    }
  }
  throw new Error(`${name} 的花括号不配对`);
}

const renderDesc = new Function(
  `${extract('esc')}\n${extract('renderDesc')}\nreturn renderDesc;`,
)();

let pass = 0;
let fail = 0;
const ok = (n, c, extra = '') => {
  if (c) {
    pass++;
    console.log('  \u2713 ' + n);
  } else {
    fail++;
    console.log('  \u2717 ' + n + (extra ? '   -> ' + extra : ''));
  }
};
const quotedCount = (html) => (html.match(/class="quoted"/g) ?? []).length;

console.log('\n技能描述渲染 · 回归\n');

console.log('[1] 全角引号');
ok('「神宝」被标', renderDesc('获得「神宝」').includes('<span class="quoted">「神宝」</span>'));
ok('『面具』被标', renderDesc('叫做『面具』').includes('<span class="quoted">『面具』</span>'));
ok('“魂”被标', renderDesc('获得“魂”标记').includes('<span class="quoted">“魂”</span>'));
ok('‘单引号’被标', renderDesc('名为‘魉’').includes('<span class="quoted">‘魉’</span>'));
ok('一句里多个引号都标', quotedCount(renderDesc('“摄影车”与“故障机器人”')) === 2);

console.log('\n[2] 半角引号');
const half = renderDesc('称为"目"的东西');
ok('半角 "" 被标', half.includes('<span class="quoted">&quot;目&quot;</span>'), half);
ok('半角内容保持实体形态，没有还原成裸引号', !/[^&]quot;/.test(half.replace(/&quot;/g, '')), half);
ok('半角单引号不处理（免得误伤英文撇号）', quotedCount(renderDesc("it's a 杀")) === 0);

console.log('\n[3] 不该误伤的情况');
ok('落单的引号不匹配', quotedCount(renderDesc('只有一个「在前')) === 0);
ok('空引号不匹配', quotedCount(renderDesc('“”')) === 0);
ok('超过 40 字的长引号不匹配', quotedCount(renderDesc('“' + 'あ'.repeat(45) + '”')) === 0);
const mixed = renderDesc('“摄影”与【杀】');
ok('【牌名】和引号可以同时出现', mixed.includes('card-name-ref') && mixed.includes('quoted'), mixed);
const mixed2 = renderDesc('锁定技，“魂”');
ok('技能类型词和引号可以同时出现', mixed2.includes('<span class="kw">锁定技</span>') && mixed2.includes('quoted'));

console.log('\n[4] 安全性');
const evil = renderDesc('“<script>alert(1)</script>”');
ok('引号里的 <> 被转义，不会变成真标签', evil.includes('&lt;script&gt;') && !evil.includes('<script>'), evil);
const boldCase = renderDesc('<b>“魂”</b>');
ok('没有残留占位符 \\u0000', !boldCase.includes('\u0000'));
ok('<b> 能穿过转义活下来', boldCase.includes('<b>') && boldCase.includes('</b>'), boldCase);
ok('加粗与引号能共存', boldCase.includes('<b><span class="quoted">“魂”</span></b>'), boldCase);
ok('不成对的 <b> 也不会变成数字', !/\d/.test(renderDesc('<b>“魂”')), renderDesc('<b>“魂”'));

console.log('\n[5] 换行与空值');
ok('换行仍按行切分', (renderDesc('第一行\n第二行').match(/<div>/g) ?? []).length === 2);
ok('空字符串给占位', renderDesc('').includes('暂无描述'));
ok('null 不炸', renderDesc(null).includes('暂无描述'));

console.log(`\n通过 ${pass}/${pass + fail}`);
process.exit(fail === 0 ? 0 : 1);
