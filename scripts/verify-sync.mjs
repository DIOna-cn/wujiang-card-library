/**
 * 验证网页上的「远程同步」面板：渲染、三个按钮、设置弹窗、轮询。
 *
 * 用真实鼠标事件（Input.dispatchMouseEvent）并先 scrollIntoView ——
 * 元素 rect 可能在视口外，直接按坐标点会点到空处，表现成"点了没反应"。
 *
 * 用法：
 *   node scripts/verify-sync.mjs
 * 前置：本地服务在跑（双击 启动.cmd），且网络/代理可用时才能验证到远端状态。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// cdp.cjs 是这台机器上的无头浏览器工具；找不到就跳过（不是所有人都装了）
let cdp;
try {
  cdp = require('E:/Deepseek/tools/cdp.cjs');
} catch {
  console.log('跳过：找不到 cdp.cjs（无头浏览器工具）。');
  process.exit(0);
}

const BASE = process.env.URL_BASE ?? 'http://127.0.0.1:3456';
const PROFILE = path.join(os.tmpdir(), `wujiang-verify-sync-${process.pid}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const ok = (n, p, d = '') => { results.push(p); console.log(`${p ? '  ✓' : '  ✗'} ${n}${d ? `  — ${d}` : ''}`); };

const api = async (p, opt = {}) => {
  const r = await fetch(BASE + p, { headers: { 'Content-Type': 'application/json' }, ...opt });
  const t = await r.text();
  try { return JSON.parse(t); } catch { return { raw: t }; }
};

// 服务在跑吗
try {
  const s = await api('/api/sync/status');
  if (!s || typeof s !== 'object') throw new Error('bad response');
} catch (err) {
  console.log(`跳过：连不上本地服务 ${BASE}（${err.message}）`);
  process.exit(0);
}

fs.rmSync(PROFILE, { recursive: true, force: true });
const L = await cdp.launchChrome({ chrome: cdp.findChrome(), profileDir: PROFILE, width: 1400, height: 950, timeout: 60000 });
const b = new cdp.CDP(L.wsUrl, { timeout: 30000 });
await b.connect();
const { targetId } = await b.send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await b.send('Target.attachToTarget', { targetId, flatten: true });
const send = (m, p) => b.send(m, p, sessionId);

const errs = [];
await send('Runtime.enable');
b.on('Runtime.exceptionThrown', (p) => errs.push(p?.exceptionDetails?.exception?.description || p?.exceptionDetails?.text));
b.on('Runtime.consoleAPICalled', (p) => { if (p?.type === 'error') errs.push('console.error: ' + (p.args || []).map((a) => cdp.describeRemoteObject(a)).join(' ')); });
await send('Page.enable');
await send('Page.navigate', { url: `${BASE}/` });
await sleep(5000);

const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) return '【异常】' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};

/** 真实点击：先滚进视口，再派发鼠标事件 */
async function realClick(selector) {
  const inView = await ev(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return false;
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    return true;
  })()`);
  if (!inView) return false;
  await sleep(250);
  const pos = await ev(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, inView: r.top >= -2 && r.bottom <= innerHeight + 2 };
  })()`);
  if (!pos || !pos.inView) return false;
  for (const type of ['mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', {
      type, x: pos.x, y: pos.y, button: 'left', clickCount: 1, buttons: type === 'mousePressed' ? 1 : 0,
    });
    await sleep(50);
  }
  await sleep(300);
  return true;
}

console.log('—— 同步面板 ——');
const text = await ev(`document.querySelector('#syncBox').innerText`);
const btnsRaw = await ev(`JSON.stringify([...document.querySelectorAll('#syncBox [data-sync]')].map(x => ({ op: x.dataset.sync, disabled: x.disabled })))`);
const repoLine = await ev(`(document.querySelector('#syncBox .sync-repo') || {}).innerText || ''`);

ok('面板已渲染', !!text && text.length > 0, String(text).replace(/\n/g, ' / ').slice(0, 90));
ok('显示了仓库链接', /github\.com|wujiang/.test(repoLine) || /@main/.test(repoLine), repoLine.trim().slice(0, 60));

const btns = JSON.parse(btnsRaw);
ok('检查 / 下载 / 上传 三个按钮都在',
  btns.length === 3 && ['check', 'download', 'upload'].every((o) => btns.some((x) => x.op === o)),
  btns.map((x) => x.op).join(', '));

// 面板要在侧栏靠上的位置（不能被标签列表挤到看不见）
const posInfo = await ev(`(() => {
  const box = document.querySelector('#syncBox').getBoundingClientRect();
  return { top: Math.round(box.top), inFirstScreen: box.top < innerHeight * 0.5 };
})()`);
ok('面板位置靠上、首屏可见', posInfo.inFirstScreen, `距顶部 ${posInfo.top}px`);

console.log('\n—— 点「检查」 ——');
const clicked = await realClick('#syncBox [data-sync="check"]');
ok('按钮可点击', clicked);
await sleep(1500);
const during = await ev(`document.querySelector('#syncBox').innerText`);
console.log('      进行中：' + String(during).replace(/\n/g, ' / ').slice(0, 100));

let finished = false;
for (let i = 0; i < 25; i++) {
  await sleep(1000);
  const t = await ev(`document.querySelector('#syncBox').innerText`);
  if (!/正在检查/.test(String(t))) { finished = true; break; }
}
const after = await ev(`document.querySelector('#syncBox').innerText`);
ok('检查跑完并回到正常态', finished, String(after).replace(/\n/g, ' / ').slice(0, 100));

const status = await api('/api/sync/status');
ok('服务端记录了检查结果', !!status.status, status.status
  ? `local=${status.status.localHead} remote=${status.status.remoteHead} 可连=${status.status.reachable}`
  : '（无）');
if (status.status && !status.status.reachable) {
  console.log('      注：当前连不上远端（代理没开？），面板会显示「连不上远端」。');
}

console.log('\n—— 同步设置 ——');
await realClick('#btnSyncSettings');
await sleep(600);
const modalRaw = await ev(`JSON.stringify({
  open: !document.querySelector('#modalMask').hidden,
  title: (document.querySelector('#modal h3') || {}).textContent || '',
  fields: [...document.querySelectorAll('#modal input, #modal select')].map(x => x.id).filter(Boolean),
  remote: (document.querySelector('#syRemote') || {}).value || '',
  proxy: (document.querySelector('#syProxy') || {}).value || '',
  mode: (document.querySelector('#syMode') || {}).value || '',
})`);
const m = JSON.parse(modalRaw);
ok('设置弹窗打开', m.open && /同步设置/.test(m.title), m.title);
ok('设置项齐全（仓库/分支/范围/间隔/代理/工作副本）',
  ['syRemote', 'syBranch', 'syMode', 'syInterval', 'syProxy', 'syWork'].every((f) => m.fields.includes(f)),
  m.fields.join(', '));
ok('读到了当前配置', !!m.remote && !!m.mode, `remote=…${m.remote.slice(-28)} mode=${m.mode} proxy=${m.proxy}`);

await realClick('#modal [data-close-modal]');
await sleep(400);

console.log('\n—— 错误检查 ——');
ok('无 JS 报错', errs.length === 0, errs.slice(0, 3).join(' | ') || '干净');

try { b.close(); } catch { /* 忽略 */ }
try { cdp.killProcessTree(L.pid); } catch { /* 忽略 */ }
setTimeout(() => { try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch { /* 忽略 */ } }, 2500).unref?.();

const passed = results.filter(Boolean).length;
console.log(`\n通过 ${passed}/${results.length}`);
process.exit(passed === results.length ? 0 : 1);
