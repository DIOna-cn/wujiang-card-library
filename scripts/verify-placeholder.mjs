#!/usr/bin/env node
/**
 * 回归：没有卡图的武将，详情页必须能正常编辑。
 *
 * 曾经的 bug：.card-preview 少了 position:relative，而里面的 .placeholder
 * 是 absolute + inset:0，于是它一路上溯到 position:fixed 的 .drawer 铺满整个抽屉。
 * 表现：无卡图武将的详情页一片空白，只剩一句「没有可用卡图」，
 * 表单和「设为主图」按钮全被盖住 —— 等于既不能编辑、也不能指定卡图。
 *
 * 依赖服务在 http://127.0.0.1:3456/ 上跑着。
 */

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let cdp;
try {
  cdp = require('E:/Deepseek/tools/cdp.cjs');
} catch {
  console.log('跳过：找不到 E:/Deepseek/tools/cdp.cjs');
  process.exit(0);
}

const BASE = process.env.URL_BASE ?? 'http://127.0.0.1:3456/';
const PROFILE = path.join(os.tmpdir(), `wj-placeholder-${process.pid}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
const ok = (n, c, e = '') => {
  if (c) { pass++; console.log('  \u2713 ' + n); }
  else { fail++; console.log('  \u2717 ' + n + (e ? '   -> ' + e : '')); }
};

// ---------- 找一个没有卡图的武将 ----------
const raw = await (await fetch(BASE + 'api/characters')).json().catch(() => null);
if (!raw) {
  console.log('跳过：服务没在跑');
  process.exit(0);
}
const arr = raw.characters ?? raw;
const noImg = arr.filter((c) => {
  const card = (c.cards ?? [])[0] ?? {};
  return !card.image && !card.cardImage;
});
console.log(`共 ${arr.length} 位武将，其中「没有指定卡图」的 ${noImg.length} 位`);
if (!noImg.length) {
  console.log('跳过：没有无卡图的武将可供测试');
  process.exit(0);
}
// 列表接口不一定带 gallery，逐个查详情，优先挑「有图片但没指定卡图」的 ——
// 只有这种才测得到「设为主图」。都没查到就退回第一个。
let target = noImg[0];
let targetHasAssets = false;
for (const c of noImg) {
  const d = await (await fetch(`${BASE}api/characters/${encodeURIComponent(c.dir)}`)).json().catch(() => null);
  if ((d?.gallery ?? []).some((g) => g.kind !== 'audio')) { target = c; targetHasAssets = true; break; }
}
console.log(`用「${target.name}」(${target.dir}) 做样本，文件夹里有图片：${targetHasAssets ? '是' : '否'}\n`);

// ---------- 打开浏览器 ----------
fs.rmSync(PROFILE, { recursive: true, force: true });
const launched = await cdp.launchChrome({
  chrome: cdp.findChrome(), profileDir: PROFILE, width: 1400, height: 1000, timeout: 60000,
});
const browser = new cdp.CDP(launched.wsUrl, { timeout: 30000 });
await browser.connect();
const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
const send = (m, p) => browser.send(m, p, sessionId);

const errs = [];
await send('Runtime.enable');
await send('Page.enable');
await send('Page.addScriptToEvaluateOnNewDocument', {
  source: `window.__errs = [];
    window.addEventListener('error', (e) => window.__errs.push(String(e.message) + ' @' + e.lineno));
    window.addEventListener('unhandledrejection', (e) => window.__errs.push('rejection: ' + String(e.reason)));`,
});
await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: BASE });
await sleep(3500);

const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) return { __exception: r.exceptionDetails.exception?.description ?? r.exceptionDetails.text };
  return r.result.value;
};

// ---------- 打开这个武将 ----------
const clicked = await evaluate(`(() => {
  const el = [...document.querySelectorAll('[data-id]')].find(c => c.dataset.id === ${JSON.stringify(target.dir)});
  if (!el) return 'not found';
  el.scrollIntoView({ block: 'center', behavior: 'instant' });
  el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  return 'ok';
})()`);
ok('能打开该武将的详情', clicked === 'ok', String(clicked));
await sleep(900);

// ---------- 查看态：占位符不能铺满整个抽屉 ----------
const viewCheck = await evaluate(`(() => {
  const body = document.querySelector('#drawerBody');
  const ph = body && body.querySelector('.placeholder');
  const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { w: Math.round(b.width), h: Math.round(b.height) }; };
  const mid = document.elementFromPoint(1040, 400);
  return {
    hasPh: !!ph,
    phRect: r(ph),
    previewRect: r(document.querySelector('.card-preview')),
    bodyRect: r(body),
    covered: mid ? !!(mid.closest && mid.closest('.placeholder')) : false,
    midTag: mid ? mid.tagName + '.' + String(mid.className || '').slice(0, 24) : 'null',
    sections: body ? body.children.length : 0,
  };
})()`);

ok('卡图区渲染了占位符', viewCheck.hasPh === true);
ok('占位符尺寸 = 卡图框尺寸（没有溢出）',
  viewCheck.phRect && viewCheck.previewRect
  && Math.abs(viewCheck.phRect.w - viewCheck.previewRect.w) <= 2
  && Math.abs(viewCheck.phRect.h - viewCheck.previewRect.h) <= 2,
  `占位符 ${JSON.stringify(viewCheck.phRect)} vs 卡图框 ${JSON.stringify(viewCheck.previewRect)}`);
ok('占位符没有盖住整个抽屉',
  viewCheck.phRect && viewCheck.bodyRect && viewCheck.phRect.h < viewCheck.bodyRect.h * 0.6,
  `占位符高 ${viewCheck.phRect?.h} / 抽屉高 ${viewCheck.bodyRect?.h}`);
ok('抽屉中部的点击目标不是占位符', viewCheck.covered === false, '命中了 ' + viewCheck.midTag);
ok('详情有多个内容区块', viewCheck.sections >= 3, '只有 ' + viewCheck.sections + ' 个');

// ---------- 编辑态：表单和「设为主图」都要在 ----------
await evaluate(`(() => { const b = document.querySelector('#btnCardEdit'); if (b) b.dispatchEvent(new MouseEvent('click', { bubbles: true })); return 'ok'; })()`);
await sleep(900);

const editCheck = await evaluate(`(() => {
  const body = document.querySelector('#drawerBody');
  const fields = [...document.querySelectorAll('#drawerBody [data-field], #drawerBody [data-card-field]')];
  const use = document.querySelector('.asset-use');
  const mid = document.elementFromPoint(1040, 400);
  const vis = (el) => { if (!el) return false; const b = el.getBoundingClientRect(); const s = getComputedStyle(el); return b.width > 0 && b.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  return {
    fieldCount: fields.length,
    nameVisible: vis(document.querySelector('#drawerBody [data-field="name"]')),
    imgInputVisible: vis(document.querySelector('#drawerBody [data-card-field="image"]')),
    cardImgInputVisible: vis(document.querySelector('#drawerBody [data-card-field="cardImage"]')),
    hasUseBtn: !!use,
    useVisible: vis(use),
    coveredMid: mid ? !!(mid.closest && mid.closest('.placeholder')) : false,
  };
})()`);

ok('编辑态表单字段齐全（≥10）', editCheck.fieldCount >= 10, '只有 ' + editCheck.fieldCount + ' 个');
ok('「武将名」输入框可见', editCheck.nameVisible === true);
ok('「无技能卡图」输入框可见', editCheck.imgInputVisible === true);
ok('「带技能卡图」输入框可见', editCheck.cardImgInputVisible === true);
if (targetHasAssets) {
  ok('「设为主图」按钮存在', editCheck.hasUseBtn === true);
  ok('「设为主图」按钮可见（没被占位符盖住）', editCheck.useVisible === true);
} else {
  console.log('  · 样本文件夹里没有图片，跳过「设为主图」检查');
}
ok('编辑态抽屉中部没有被占位符覆盖', editCheck.coveredMid === false);

// ---------- 真的能一键指定卡图吗 ----------
if (editCheck.hasUseBtn && targetHasAssets) {
  const set = await evaluate(`(() => {
    const b = document.querySelector('.asset-use');
    b.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return 'ok';
  })()`);
  await sleep(500);
  const after = await evaluate(`(() => {
    const g = (s) => { const e = document.querySelector(s); return e ? e.value : null; };
    return { image: g('#drawerBody [data-card-field="image"]'), cardImage: g('#drawerBody [data-card-field="cardImage"]') };
  })()`);
  ok('点「设为主图」后主图字段被填上', !!after.image, JSON.stringify(after));
  console.log(`      主图字段 = ${JSON.stringify(after.image)}，备查字段 = ${JSON.stringify(after.cardImage)}`);
}

const jsErrs = await evaluate('window.__errs');
ok('没有 JS 报错', Array.isArray(jsErrs) && jsErrs.length === 0, JSON.stringify(jsErrs));

await browser.send('Browser.close').catch(() => {});
await sleep(800);
try { fs.rmSync(PROFILE, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* 清不掉无所谓，在 temp 里 */ }

console.log(`\n无卡图详情页回归：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail ? 1 : 0);
