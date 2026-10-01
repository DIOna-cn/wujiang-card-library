/**
 * 抓几个关键界面的截图，用来肉眼确认视觉效果。
 * 用法：node scripts/_shots.mjs
 */
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const cdp = require('E:/Deepseek/tools/cdp.cjs');
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const URL_BASE = process.env.URL_BASE ?? 'http://127.0.0.1:3456/';
const OUT = path.join(__dirname, '..', '_shots');
// 放系统 temp，理由同 verify.mjs
const PROFILE = path.join(os.tmpdir(), `wujiang-shots-${process.pid}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const W = Number(process.env.SHOT_W ?? 1400);
const H = Number(process.env.SHOT_H ?? 1000);

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  fs.rmSync(PROFILE, { recursive: true, force: true });

  const launched = await cdp.launchChrome({
    chrome: cdp.findChrome(),
    profileDir: PROFILE,
    width: W,
    height: H,
    timeout: 60000,
  });
  const browser = new cdp.CDP(launched.wsUrl, { timeout: 30000 });
  await browser.connect();
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
  const send = (m, p) => browser.send(m, p, sessionId);

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: W, height: H, deviceScaleFactor: 1, mobile: false,
  });

  await send('Page.navigate', { url: URL_BASE });
  await sleep(3500);

  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };

  const shoot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(OUT, `${name}.png`);
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    const kb = Math.round(fs.statSync(file).size / 1024);
    console.log(`  ${name}.png  (${kb} KB)`);
  };

  console.log('抓图中…');

  // 1. 主界面（卡图网格）
  await evaluate(`document.querySelector('#grid').scrollTop = 0`);
  await shoot('01-主界面');

  // 2. 列表视图
  await evaluate(`document.querySelector('.seg button[data-view="list"]').click()`);
  await sleep(700);
  await shoot('02-列表视图');
  await evaluate(`document.querySelector('.seg button[data-view="grid"]').click()`);
  await sleep(500);

  // 3. 详情抽屉（辉夜，技能最多、含衍生技）
  await evaluate(`(() => {
    const idx = [...document.querySelectorAll('#grid .card')].findIndex(c => c.dataset.id.includes('蓬莱山辉夜'));
    const el = [...document.querySelectorAll('#grid .card')][idx];
    if (el) el.scrollIntoView({ block: 'center', behavior: 'instant' });
    return idx;
  })()`);
  await sleep(400);
  const pyeBox = await evaluate(`(() => {
    const el = [...document.querySelectorAll('#grid .card')].find(c => c.dataset.id.includes('蓬莱山辉夜'));
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  if (pyeBox) {
    for (const type of ['mousePressed', 'mouseReleased']) {
      await send('Input.dispatchMouseEvent', { type, x: pyeBox.x, y: pyeBox.y, button: 'left', clickCount: 1, buttons: type === 'mousePressed' ? 1 : 0 });
      await sleep(50);
    }
  }
  await sleep(2000);
  await shoot('03-详情-查看');

  // 滚动到技能区（需能看到衍生技的缩进与配色）
  await evaluate(`(() => {
    const el = document.querySelector('#drawerBody .skill-view.is-derived');
    if (el) el.scrollIntoView({ block: 'start', behavior: 'instant' });
    return !!el;
  })()`);
  await sleep(700);
  await shoot('04-详情-技能与衍生技');

  // 滚到神宝
  await evaluate(`document.querySelector('#drawerBody').scrollTop = 99999`);
  await sleep(700);
  await shoot('05-详情-神宝与素材');

  // 4. 编辑态
  await evaluate(`document.querySelector('#drawerBody').scrollTop = 0; document.querySelector('#btnCardEdit').click()`);
  await sleep(900);
  await shoot('06-编辑态');

  await evaluate(`document.querySelector('#drawerBody').scrollTop = 520`);
  await sleep(600);
  await shoot('07-编辑态-技能');

  // 退出编辑
  await evaluate(`document.querySelector('#btnCardEdit').click()`);
  await sleep(700);

  // 5. 多卡面武将（结城理）
  await evaluate(`document.querySelector('#btnCloseDrawer').click()`);
  await sleep(600);
  await evaluate(`[...document.querySelectorAll('#grid .card')].find(c => c.dataset.id.includes('结城理')).click()`);
  await sleep(1800);
  await shoot('08-多卡面-结城理');
  await evaluate(`document.querySelector('#btnCloseDrawer').click()`);
  await sleep(500);

  // 6. 新建武将弹窗
  await evaluate(`document.querySelector('#btnNew').click()`);
  await sleep(800);
  await shoot('09-新建武将');
  await evaluate(`document.querySelector('[data-close-modal]').click()`);
  await sleep(400);

  // 7. 标签管理
  await evaluate(`document.querySelector('#btnEditTags').click()`);
  await sleep(800);
  await shoot('10-标签管理');
  await evaluate(`document.querySelector('[data-close-modal]').click()`);
  await sleep(400);

  // 8. 搜索
  await evaluate(`(() => { const el = document.querySelector('#search'); el.value='方舟'; el.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  await sleep(900);
  await shoot('11-搜索');

  // 9. 窄屏
  await evaluate(`(() => { const el = document.querySelector('#search'); el.value=''; el.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  await sleep(600);
  await send('Emulation.setDeviceMetricsOverride', { width: 560, height: 900, deviceScaleFactor: 1, mobile: true });
  await sleep(900);
  await shoot('12-窄屏');

  try { await browser.send('Target.closeTarget', { targetId }); } catch { /* 忽略 */ }
  try { browser.close(); } catch { /* 忽略 */ }
  try { if (launched.pid) cdp.killProcessTree(launched.pid); } catch { /* 忽略 */ }
  setTimeout(() => { try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch { /* 忽略 */ } }, 3000).unref?.();

  console.log(`\n输出目录: ${OUT}`);
  process.exit(0);
}

main().catch((err) => { console.error('抓图失败：', err); process.exit(1); });
