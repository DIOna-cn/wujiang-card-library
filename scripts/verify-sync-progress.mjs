/**
 * 验证同步的进度显示。
 *
 * 分四层，越靠前越不依赖外部条件：
 *   1. 解析：git 吐出来的进度行认得出来，报错行不能被误认成进度
 *   2. 累加器：只增不减、没跑完不到 100%、合并后重推也不能倒退
 *   3. 本地复制：文件数 / 字节数进度是不是真的在报
 *   4. 界面：真在浏览器里点一次「检查」，看进度条和步骤清单有没有出来
 *
 * 服务没在跑时第 4 层跳过，前三层不用服务、不用联网，永远跑。
 *
 * 用法：
 *   node scripts/verify-sync-progress.mjs
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import * as core from '../server/sync-core.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.URL_BASE ?? 'http://127.0.0.1:3456';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const ok = (n, p, d = '') => { results.push(!!p); console.log(`${p ? '  ✓' : '  ✗'} ${n}${d ? `  — ${d}` : ''}`); };

/* ------------------------------------------------------------------ *
 * [1] git 进度行
 * ------------------------------------------------------------------ */
console.log('—— [1] 认出 git 的进度行 ——');

const p1 = core.parseGitProgress('Receiving objects:  45% (1234/2741), 12.3 MiB | 2.1 MiB/s');
ok('认识 Receiving objects', !!p1, p1?.label ?? '(没认出来)');
ok('百分比解析正确', p1?.percent === 45, String(p1?.percent));
ok('分子分母解析正确', p1?.done === 1234 && p1?.total === 2741, `${p1?.done} / ${p1?.total}`);
ok('翻成了中文', /接收对象/.test(p1?.text ?? ''), p1?.text ?? '');

const p2 = core.parseGitProgress('remote: Compressing objects: 100% (3/3), done.');
ok('认识 remote: 前缀的行', p2?.percent === 100, p2?.label ?? '(没认出来)');

const p3 = core.parseGitProgress('Writing objects:   8% (120/1500), 3.0 MiB | 1.2 MiB/s');
ok('认识 Writing objects', p3?.percent === 8, String(p3?.percent));

const p4 = core.parseGitProgress('Resolving deltas:  50% (100/200)');
ok('认识 Resolving deltas', p4?.percent === 50, String(p4?.percent));

// 下面这些也带冒号和数字，长得像进度，但一句都不能被当成进度 ——
// 真被当成进度的话，报错信息会变成进度条上跳动的数字，人就看不出出错了
const notProgress = [
  "fatal: unable to access 'https://github.com/x/y.git/': Failed to connect to github.com port 443 after 21086 ms: Could not connect to server",
  'To https://github.com/DIOna-cn/wujiang-card-library.git',
  'error: failed to push some refs to https://github.com/x/y.git',
  'remote: Total 2741 (delta 1234), reused 2000 (delta 1000)',
  'Enumerating objects: 2741',
  'Everything up-to-date',
  '',
];
const badHits = notProgress.filter((l) => core.parseGitProgress(l));
ok('报错行 / 非进度行不会被误认', badHits.length === 0, badHits.join(' | ') || '干净');

/* ------------------------------------------------------------------ *
 * [2] 进度累加器
 * ------------------------------------------------------------------ */
console.log('\n—— [2] 进度累加器 ——');

{
  const P = core.makeProgress(() => {});
  ok('刚开始是 0%', P.percent === 0, String(P.percent));

  P.step('准备…', { phase: 'prepare' });
  const a = P.percent;
  P.step('收集…', { phase: 'collect' });
  const b = P.percent;
  ok('进入新阶段，进度往前走', b > a, `${a}% → ${b}%`);

  P.step('写入…', { phase: 'copy' });
  const beforeTick = P.percent;
  P.tick({ done: 135, total: 270, detail: '135 / 270 个文件' });
  const afterTick = P.percent;
  ok('阶段内 tick 会把进度往前推', afterTick > beforeTick, `${beforeTick}% → ${afterTick}%`);
  ok('阶段内是按比例插值的，不是非 0 即满',
    afterTick > beforeTick && afterTick < 95, `${afterTick}%`);
  ok('tick 的明细透出来了', P.steps.length === 3, `清单 ${P.steps.length} 行（tick 没加行）`);

  P.tick({ done: 270, total: 270 });
  ok('某一段跑满也不显示 100%', P.percent <= 95, `${P.percent}%`);

  P.done();
  ok('done() 之后才是 100%', P.percent === 100, String(P.percent));
}

{
  // 上传撞上分叉时会多走一轮 merge + transfer，各段权重加起来会超过 100。
  // 不夹住的话进度条能跑到 120% 再退回来 —— 比没有进度条还让人摸不着头脑。
  const seq = [];
  const Q = core.makeProgress((t, i) => seq.push(i.percent));
  for (const ph of ['prepare', 'collect', 'copy', 'commit', 'merge', 'transfer', 'transfer', 'merge', 'transfer', 'writeback', 'finish']) {
    Q.step(`步骤 ${ph}`, { phase: ph });
    Q.tick({ done: 50, total: 100 });
    Q.tick({ done: 100, total: 100 });
  }
  let mono = true;
  for (let i = 1; i < seq.length; i++) if (seq[i] < seq[i - 1]) mono = false;
  ok('阶段走重复了也不倒退', mono, seq.join(' → '));
  ok('没跑完就不超过 95%', Math.max(...seq) <= 95, `最大 ${Math.max(...seq)}%`);
}

{
  const snap = [];
  const S = core.makeProgress((t, i) => snap.push(i.steps));
  S.step('一', { phase: 'prepare' });
  S.step('二', { phase: 'collect' });
  snap[0].push('被污染了');
  ok('给回调的清单是副本，改它不影响内部', S.steps.length === 2, `内部 ${S.steps.length} 行`);
  ok('清单内容对得上', S.steps.join(' / ') === '一 / 二', S.steps.join(' / '));
}

{
  const T = core.makeProgress(() => { throw new Error('回调里炸了'); });
  let threw = false;
  try { T.step('x', { phase: 'prepare' }); T.done(); } catch { threw = true; }
  ok('进度回调抛异常不会把同步带崩', !threw);
}

/* ------------------------------------------------------------------ *
 * [3] 进度条旁边那行小字
 * ------------------------------------------------------------------ */
console.log('\n—— [3] 明细行的文字 ——');
{
  const withBytes = core.fileDetail({ done: 13, total: 270, bytes: 5 * 1024 * 1024, totalBytes: 163 * 1024 * 1024 });
  ok('文件明细带文件数和字节数', withBytes === '13 / 270 个文件 · 5.00 MB / 163.00 MB', withBytes);

  const noBytes = core.fileDetail({ done: 1, total: 2, bytes: 0, totalBytes: 0 });
  ok('量不到字节时只报文件数', noBytes === '1 / 2 个文件', noBytes);

  const g1 = core.gitDetail(p1);
  ok('git 传输明细带中文阶段和百分比', g1 === '接收对象 45%（1234 / 2741）', g1);

  const g2 = core.gitDetail({ text: '接收对象', percent: 80, done: 0, total: 0 });
  ok('没有分子分母时只报百分比', g2 === '接收对象 80%', g2);
}

/* ------------------------------------------------------------------ *
 * [4] 文件复制 / 写回的进度
 * ------------------------------------------------------------------ */
console.log('\n—— [4] 本地复制的进度 ——');

const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'wujiang-progress-'));
try {
  const src = path.join(tmp, 'src');
  const work = path.join(tmp, 'work');
  await fsp.mkdir(src, { recursive: true });
  await fsp.mkdir(work, { recursive: true });

  const workSet = new Map();
  for (let i = 0; i < 12; i++) {
    const f = path.join(src, `f${i}.txt`);
    await fsp.writeFile(f, 'x'.repeat(1000));
    workSet.set(`f${i}.txt`, f);
  }
  const big = path.join(src, 'big.bin');
  const BIG = 200 * 1024;
  await fsp.writeFile(big, Buffer.alloc(BIG));
  workSet.set('big.bin', big);

  const ticks = [];
  await core.syncToWork({ work, workSet, onProgress: (p) => ticks.push({ ...p }) });

  ok('复制过程有进度回调', ticks.length > 0, `${ticks.length} 次`);
  const last = ticks.at(-1);
  ok('最后一次的「已完成」等于总数',
    last.done === last.total && last.total === workSet.size, `${last.done} / ${last.total}`);
  ok('总字节数算对了', last.totalBytes === 12 * 1000 + BIG, String(last.totalBytes));
  ok('字节进度走到了总量', last.bytes === last.totalBytes, `${last.bytes} / ${last.totalBytes}`);

  let mono = true;
  for (let i = 1; i < ticks.length; i++) if (ticks[i].done < ticks[i - 1].done) mono = false;
  ok('文件数进度单调不减', mono, ticks.map((t) => t.done).join(','));

  ok('文件确实复制过去了', fs.existsSync(path.join(work, 'big.bin')));

  // 写回：范围只认「素材/」和数据文件，所以得造一个真的
  await fsp.mkdir(path.join(work, '素材', '测试将'), { recursive: true });
  await fsp.writeFile(path.join(work, '素材', '测试将', '武将.json'), '{"name":"测试将"}');

  const assets = path.join(tmp, 'assets');
  const ticks2 = [];
  await core.writeDataBack({ work, project: tmp, assets, onProgress: (p) => ticks2.push({ ...p }) });

  ok('写回过程有进度回调', ticks2.length > 0, `${ticks2.length} 次`);
  const last2 = ticks2.at(-1);
  ok('写回的总数就是待写回的文件数', last2.total === 1 && last2.done === 1, `${last2.done} / ${last2.total}`);
  ok('写回真的落了盘', fs.existsSync(path.join(assets, '测试将', '武将.json')));
} finally {
  await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
}

/* ------------------------------------------------------------------ *
 * [5] 静态：轮询不能再自己撒手
 * ------------------------------------------------------------------ */
console.log('\n—— [5] 轮询会不会提前撒手 ——');

const appSrc = fs.readFileSync(path.join(ROOT, 'web', 'app.js'), 'utf8');
ok('轮询不再写死次数（原来 24 次 ≈ 21 秒就停）',
  !/pollFast\(\s*\d+\s*\)/.test(appSrc),
  (appSrc.match(/pollFast\([^)]*\)/g) ?? []).join(', '));
ok('轮询跟着「任务还在不在跑」走',
  /state\.sync\?\.busy && Date\.now\(\) < until/.test(appSrc));
ok('仍然留了兜底上限，不会无限轮询', /pollFast\(maxMs = /.test(appSrc));
ok('新任务开始时清掉了上一轮的残留',
  /percent: 0, detail: '', phase: ''/.test(appSrc));

const cssSrc = fs.readFileSync(path.join(ROOT, 'web', 'style.css'), 'utf8');
ok('旧的「来回扫」假进度条已经删掉',
  !/@keyframes sweep/.test(cssSrc) && !/\.sync-progress \.bar/.test(cssSrc));
ok('新进度条按真实百分比走', /\.sync-progress \.p-track i/.test(cssSrc));
ok('步骤清单有样式', /\.sync-steps/.test(cssSrc));

/* ------------------------------------------------------------------ *
 * [6] 界面：真点一次「检查」
 * ------------------------------------------------------------------ */
console.log('\n—— [6] 界面 ——');

const require = createRequire(import.meta.url);
let cdp = null;
try { cdp = require('E:/Deepseek/tools/cdp.cjs'); } catch { /* 没装就跳过 */ }

let reachable = false;
try {
  const r = await fetch(`${BASE}/api/sync/status`);
  reachable = r.ok;
} catch { /* 服务没在跑 */ }

if (!reachable) {
  console.log('跳过：连不上本地服务（双击 启动.cmd 后再跑一次）。');
} else if (!cdp) {
  console.log('跳过：找不到 cdp.cjs（无头浏览器工具）。');
} else {
  // 接口本身该带的字段
  const st = await (await fetch(`${BASE}/api/sync/status`)).json();
  ok('状态接口带了百分比', Number.isFinite(st.percent), String(st.percent));
  ok('状态接口带了步骤清单', Array.isArray(st.steps), `${st.steps?.length ?? '无'} 行`);
  ok('状态接口带了开始时刻（秒表要用）', 'startedAt' in st, String(st.startedAt));
  ok('状态接口带了明细行', 'detail' in st);
  ok('状态接口带了阶段', 'phase' in st);

  // 一份状态的外壳；里面的 status 每个用例各自换
  const fakeStatusBase = {
    busy: false, op: '', step: '', steps: [], percent: 0,
    detail: '', phase: '', startedAt: 0, endedAt: 0,
    error: '', hint: '', lastCheckAt: Date.now(),
    result: null,
    config: {
      remote: 'https://github.com/DIOna-cn/wujiang-card-library.git',
      branch: 'main', mode: 'all', proxy: '', work: '', autoCheckMs: 60000,
    },
    remote: { owner: 'DIOna-cn', repo: 'wujiang-card-library', branch: 'main' },
  };

  const profile = path.join(os.tmpdir(), `wujiang-verify-progress-${process.pid}`);
  fs.rmSync(profile, { recursive: true, force: true });
  const L = await cdp.launchChrome({ chrome: cdp.findChrome(), profileDir: profile, width: 1400, height: 950, timeout: 60000 });
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

  const clicked = await realClick('#syncBox [data-sync="check"]');
  ok('点到了「检查」', clicked);

  // 前端按下按钮就立刻进 busy 并重画，所以不用等服务端的检查跑完
  await sleep(500);
  const mid = JSON.parse(await ev(`JSON.stringify({
    hasTrack: !!document.querySelector('#syncBox .sync-progress .p-track'),
    barWidth: (document.querySelector('#syncBox .p-track i') || {}).style?.width || '',
    pct: (document.querySelector('#syncBox .p-pct') || {}).textContent || '',
    elapsed: (document.querySelector('#syncBox .p-elapsed') || {}).textContent || '',
    steps: [...document.querySelectorAll('#syncBox .sync-steps li')].map(x => x.className),
    stepText: (document.querySelector('#syncBox .p-step') || {}).textContent || '',
    subText: (document.querySelector('#syncBox .sync-line .sub') || {}).textContent || '',
    detail: (document.querySelector('#syncBox .p-detail') || {}).textContent || '',
  })`));

  ok('界面上出现了进度条', mid.hasTrack, mid.hasTrack ? `宽度 ${mid.barWidth}` : '没有 .p-track');
  ok('显示了百分比', /%/.test(mid.pct), mid.pct || '(空)');
  ok('显示了秒表', mid.elapsed.length > 0, mid.elapsed || '(空)');
  ok('出现了步骤清单', mid.steps.length > 0, `${mid.steps.length} 行`);
  ok('进行中的那一步标成 now', mid.steps.includes('now'), mid.steps.join(',') || '(空)');
  // 同一句话在状态行、进度区、清单里各写一遍，看着就乱
  ok('当前那一步没有重复显示',
    !(mid.stepText && mid.steps.length > 0) && mid.subText.length === 0,
    `状态行「${mid.subText}」/ 单独一行「${mid.stepText}」/ 清单 ${mid.steps.length} 行`);

  // 等它跑完，进度区要收掉
  let done = false;
  for (let i = 0; i < 40; i++) {
    await sleep(1000);
    const busy = await ev(`!!document.querySelector('#syncBox .sync-progress')`);
    if (!busy) { done = true; break; }
  }
  ok('跑完以后进度区收掉了', done);

  const leftover = await ev(`!!document.querySelector('#syncBox [data-elapsed]')`);
  ok('秒表也跟着停了（没有留下空转的定时器）', !leftover);

  // ---- 窄侧栏里「远端有新内容」被挤成一个「远」字 ----
  // .txt 原本是 flex:1（也就是 flex-basis:0），只能分到「容器宽 − sub 宽」那点
  // 空隙；而侧栏才 200 多像素，sub（「本地 06a9e5b → 远端 fc81fde」）自己就占
  // 160 多。这类「主要信息被次要信息挤掉」在窄栏里特别容易复发，钉一条。
  //
  // 触发渲染走 visibilitychange：面板在「页面重新可见」时会自己刷一次状态，
  // 只读 /api/sync/status —— 不真的发起同步，也不用等服务端忙完。
  const injectStatus = async (status) => {
    await ev(`(() => {
      const fake = ${JSON.stringify({ ...fakeStatusBase, status })};
      if (!window.__origFetch) window.__origFetch = window.fetch;
      const orig = window.__origFetch;
      window.fetch = function (url) {
        const u = typeof url === 'string' ? url : (url && url.url) || String(url);
        if (u.includes('/api/sync/status')) {
          return Promise.resolve(new Response(JSON.stringify(fake), {
            status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8' },
          }));
        }
        return orig.apply(this, arguments);
      };
      return true;
    })()`);
    await ev(`document.dispatchEvent(new Event('visibilitychange'))`);
    await sleep(600);
  };

  const measureLine = async () => JSON.parse(await ev(`JSON.stringify((() => {
    const line = document.querySelector('#syncBox .sync-line');
    const t = line && line.querySelector('.txt');
    const s = line && line.querySelector('.sub');
    return {
      txt: t ? t.textContent : '',
      txtClipped: t ? t.scrollWidth > t.clientWidth + 1 : null,
      sub: s ? s.textContent : '',
      subClipped: s ? s.scrollWidth > s.clientWidth + 1 : null,
      h: line ? line.getBoundingClientRect().height : 0,
    };
  })())`));

  await injectStatus({
    ok: true, reachable: true, initialized: true,
    localHead: '06a9e5b', remoteHead: 'fc81fde',
    hasRemoteUpdate: true, hasLocalChanges: false, localDiffCount: 0,
  });
  const crowded = await measureLine();

  await injectStatus({
    ok: true, reachable: true, initialized: true,
    localHead: '5d4c187', remoteHead: '5d4c187',
    hasRemoteUpdate: false, hasLocalChanges: false, localDiffCount: 0,
  });
  const roomy = await measureLine();

  ok('窄侧栏里主要信息没被挤掉（「远端有新内容」不该是「远…」）',
    crowded.txt === '远端有新内容' && crowded.txtClipped === false,
    `「${crowded.txt}」${crowded.txtClipped ? ' ← 被截断了' : ' 完整'}`);
  ok('次要信息也没被截断 —— 放不下时它自己换到第二行',
    crowded.subClipped === false,
    `「${crowded.sub}」${crowded.subClipped ? ' ← 被截断' : ' 完整'}`);
  ok('放不下时确实换成了两行',
    crowded.h > roomy.h + 8,
    `两行 ${Math.round(crowded.h)}px vs 一行 ${Math.round(roomy.h)}px`);
  ok('短的状态仍挤在一行里（不该平白高一行）',
    roomy.h < 24 && roomy.subClipped === false,
    `${Math.round(roomy.h)}px`);

  ok('无 JS 报错', errs.length === 0, errs.slice(0, 3).join(' | ') || '干净');

  try { b.close(); } catch { /* 忽略 */ }
  try { cdp.killProcessTree(L.pid); } catch { /* 忽略 */ }
  setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* 忽略 */ } }, 2500).unref?.();
}

const passed = results.filter(Boolean).length;
console.log(`\n通过 ${passed}/${results.length}`);
process.exit(passed === results.length ? 0 : 1);
