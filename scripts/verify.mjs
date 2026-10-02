/**
 * 无头验证 武将牌库 网页：
 *  1. 加载页面，收集所有 JS 报错 / 网络失败
 *  2. 检查卡图网格真的渲染出来了（数量、图片 src 是否 200）
 *  3. 打开一个详情抽屉，检查技能描述渲染
 *  4. 走一遍「编辑 → 改一个字段 → 保存 → 校验落盘」
 *
 * 用法：node scripts/_verify.mjs
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
// 浏览器临时 profile 放系统 temp，不要放项目 .data ——
// Chrome 会在这里留上百个文件且句柄释放慢，既占空间又容易被当成垃圾误清理。
const PROFILE = path.join(os.tmpdir(), `wujiang-verify-${process.pid}`);

const results = [];
const ok = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`${pass ? '  ✓' : '  ✗'} ${name}${detail ? `  — ${detail}` : ''}`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const chrome = cdp.findChrome();
  console.log(`浏览器: ${chrome}\n`);
  fs.rmSync(PROFILE, { recursive: true, force: true });
  const launched = await cdp.launchChrome({
    chrome,
    profileDir: PROFILE,
    timeout: 60000,
  });
  console.log(`DevTools: ${launched.wsUrl}\n`);

  const browser = new cdp.CDP(launched.wsUrl, { timeout: 30000 });
  await browser.connect();

  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });

  const send = (method, params) => browser.send(method, params, sessionId);

  // ---- 收集日志与错误 ----
  const consoleErrors = [];
  const failedRequests = [];
  browser.on('Runtime.consoleAPICalled', (p) => {
    if (p?.type === 'error') {
      consoleErrors.push((p.args ?? []).map((a) => cdp.describeRemoteObject(a)).join(' '));
    }
  });
  browser.on('Runtime.exceptionThrown', (p) => {
    const d = p?.exceptionDetails ?? {};
    consoleErrors.push(`[未捕获] ${d.exception?.description ?? d.text ?? JSON.stringify(p)}`);
  });
  // 注意：cdp.cjs 的 safeInvoke 只给回调传一个参数，所以这里只接一个
  browser.on('Network.loadingFailed', (p) => {
    if (p && !p.canceled) failedRequests.push(`${p.type} ${p.errorText} ${p.requestId}`);
  });

  await send('Runtime.enable');
  await send('Network.enable');
  await send('Page.enable');

  // ---- 打开页面 ----
  await send('Page.navigate', { url: URL_BASE });
  await sleep(3000);

  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', {
      expression: expr,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };

  /**
   * 取元素中心坐标 + 派发真实鼠标事件。
   *
   * 为什么不用 element.click()：侧栏在每次筛选后都会重建 DOM，
   * 脚本里提前抓到的元素引用会指向已脱离文档的旧节点，click() 静默失效。
   * 走 Input.dispatchMouseEvent 就是真实点击，和手点完全一致，不受重建影响。
   */
  const centerOf = async (selector, index = 0) => evaluate(`(() => {
    const el = [...document.querySelectorAll(${JSON.stringify(selector)})][${index}];
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);

  /**
   * 真实点击。
   * 必须先 scrollIntoView —— 网格很长，靠后的卡片 rect 会在视口外（y 上千），
   * 直接派发鼠标事件点不到任何东西，表现成「点了没反应」。
   */
  const realClick = async (sel, index = 0) => {
    const inView = await evaluate(`(() => {
      const el = [...document.querySelectorAll(${JSON.stringify(sel)})][${index}];
      if (!el) return false;
      el.scrollIntoView({ block: 'center', behavior: 'instant' });
      return true;
    })()`);
    if (!inView) return false;
    await sleep(150);
    const box = await centerOf(sel, index);
    if (!box) return false;
    for (const type of ['mousePressed', 'mouseReleased']) {
      await send('Input.dispatchMouseEvent', {
        type, x: box.x, y: box.y, button: 'left', clickCount: 1,
        buttons: type === 'mousePressed' ? 1 : 0,
      });
      await sleep(40);
    }
    await sleep(320);
    return true;
  };

  /** 清空所有筛选 chip */
  const clearFilters = async () => {
    for (let i = 0; i < 8; i++) {
      const okClick = await realClick('#activeFilters .filter-chip button', 0);
      if (!okClick) break;
    }
  };

  const filterSnapshot = () => evaluate(`JSON.stringify({
    originActive: [...document.querySelectorAll('#originTree .tag-row.active .label')].map(x => x.textContent.trim()),
    tagActive: [...document.querySelectorAll('#tagTree .tag-row.active .label')].map(x => x.textContent.trim()),
    chips: [...document.querySelectorAll('#activeFilters .filter-chip')].map(c => c.textContent.replace('✕','')),
    cards: document.querySelectorAll('#grid .card').length,
    drawerOpen: !document.querySelector('#drawer').hidden,
  })`);

  console.log('—— 页面加载 ——');

  const title = await evaluate('document.title');
  ok('页面标题', title === '武将牌库', title);

  // 诊断：浏览器侧实际拿到的数据长什么样
  const diag = await evaluate(`fetch('/api/characters').then(r => r.json()).then(d => {
    const c = d.characters.find(x => x.id.includes('蓬莱')) || d.characters[0];
    return {
      count: d.characters.length,
      tags: d.tags,
      sample: { id: c.id, name: c.name, hasJson: c.hasJson, dir: c.dir,
        card0: { displayImage: c.cards?.[0]?.displayImage, displayKind: c.cards?.[0]?.displayKind,
                 image: c.cards?.[0]?.image, imageExists: c.cards?.[0]?.imageExists,
                 cardImageExists: c.cards?.[0]?.cardImageExists, skillCount: c.cards?.[0]?.skills?.length } },
      kingdomSet: [...new Set(d.characters.map(x => x.kingdom))],
      tagSet: [...new Set(d.characters.flatMap(x => x.tags || []))],
    };
  })`);
  console.log('  [诊断] ' + JSON.stringify(diag, null, 2).split('\n').join('\n  '));

  const cardCount = await evaluate('document.querySelectorAll("#grid .card").length');
  ok('卡图网格渲染', cardCount >= 28, `${cardCount} 张卡片`);

  // ---- 图片是否真的加载成功（其余为 loading="lazy" 未进入视口，属预期）----
  const imgReport = await evaluate(`(async () => {
    const imgs = [...document.querySelectorAll('#grid .card-figure img')];
    // 把所有图片滚进视口，确保 lazy 的也真的去取图，才能验证 URL 全部有效
    for (const im of imgs) { im.loading = 'eager'; im.scrollIntoView(); }
    window.scrollTo(0, 0);
    await new Promise(r => setTimeout(r, 2500));
    let loaded = 0, broken = 0, pending = 0;
    const brokenSrc = [];
    for (const im of imgs) {
      if (im.complete && im.naturalWidth > 0) loaded++;
      else if (im.complete) { broken++; brokenSrc.push(im.getAttribute('src')); }
      else pending++;
    }
    return { total: imgs.length, loaded, broken, pending,
      placeholders: document.querySelectorAll('#grid .placeholder').length, brokenSrc: brokenSrc.slice(0, 5) };
  })()`);
  ok('卡图 <img> 全部加载成功', imgReport.broken === 0 && imgReport.loaded === imgReport.total,
    `${imgReport.loaded}/${imgReport.total} 张已加载，${imgReport.broken} 张失败，占位符 ${imgReport.placeholders} 个`);
  if (imgReport.brokenSrc.length) console.log('      失败:', imgReport.brokenSrc);

  // ---- 卡图容器比例必须是武将牌比例 ----
  const ratio = await evaluate(`(() => {
    const fig = document.querySelector('#grid .card-figure');
    if (!fig) return null;
    const r = fig.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height), ratio: +(r.width / r.height).toFixed(5) };
  })()`);
  const target = 1465 / 2055;
  ok('卡图显示比例 = 带技能武将牌比例（1465:2055）',
    ratio && Math.abs(ratio.ratio - target) < 0.005,
    ratio ? `${ratio.w}×${ratio.h}，比例 ${ratio.ratio}（目标 ${target.toFixed(5)}）` : '取不到');

  // ---- 侧栏 ----
  const side = await evaluate(`({
    origins: document.querySelectorAll('#originTree .tag-row').length,
    tags: document.querySelectorAll('#tagTree .tag-row').length,
    kingdoms: document.querySelectorAll('#kingdomTree .tag-row').length,
    stat: document.querySelector('#statLine').textContent.trim().replace(/\\s+/g,' '),
  })`);
  ok('侧栏原作 / 标签 / 势力三块', side.origins >= 3 && side.tags >= 1 && side.kingdoms >= 3,
    `原作 ${side.origins} 项、标签 ${side.tags} 项、势力 ${side.kingdoms} 项`);
  console.log(`      统计: ${side.stat}`);

  // ---- 原作与标签在卡片上要分开显示 ----
  const badge = await evaluate(`(() => {
    const card = [...document.querySelectorAll('#grid .card')].find(c => c.querySelector('.card-origin'));
    if (!card) return null;
    return {
      origin: card.querySelector('.card-origin')?.textContent.trim(),
      tags: [...card.querySelectorAll('.card-tags .tag-chip')].map(t => t.textContent.trim()),
    };
  })()`);
  ok('卡面上原作与标签分开渲染', !!badge && !!badge.origin,
    badge ? `原作「${badge.origin}」，标签 [${badge.tags.join(', ')}]` : '没找到带原作的卡片');

  // ---- 原作筛选必须是单选（真实鼠标点击）----
  await clearFilters();
  const originBefore = JSON.parse(await filterSnapshot());
  await realClick('#originTree .tag-row', 1);          // 第 1 个具体原作
  const originAfterA = JSON.parse(await filterSnapshot());
  await realClick('#originTree .tag-row', 2);          // 第 2 个具体原作，应替换
  const originAfterB = JSON.parse(await filterSnapshot());
  await realClick('#originTree .tag-row', 2);          // 再点同一个，应取消
  const originAfterC = JSON.parse(await filterSnapshot());
  await clearFilters();

  const originSingle = originAfterA.chips.length === 1 &&
    originAfterB.chips.length === 1 &&
    originAfterA.chips[0] !== originAfterB.chips[0] &&
    originAfterB.originActive.length === 1 &&
    // 和初始快照比，别写死数字 —— 以后新增武将不该让这条测试失败
    originAfterC.chips.length === 0 && originAfterC.cards === originBefore.cards;
  ok('原作筛选为单选（换一个会替换，再点取消）', originSingle,
    `${originAfterA.chips[0] ?? '—'}(${originAfterA.cards}张) → ${originAfterB.chips[0] ?? '—'}(${originAfterB.cards}张)` +
    ` → 取消(${originAfterC.cards}张)，初始 ${originBefore.cards} 张`);

  // ---- 标签是多选（真实鼠标点击）----
  await realClick('#tagTree .tag-row', 1);
  const tagOne = JSON.parse(await filterSnapshot());
  await realClick('#tagTree .tag-row', 2);
  const tagTwo = JSON.parse(await filterSnapshot());
  await realClick('#tagTree .tag-row', 1);
  await realClick('#tagTree .tag-row', 2);
  await clearFilters();
  ok('标签可多选（叠加）', tagOne.chips.length === 1 && tagTwo.chips.length === 2,
    `选 1 个 → ${tagOne.chips.length} 个 chip（${tagOne.cards}张）；再选 1 个 → ${tagTwo.chips.length} 个 chip（${tagTwo.cards}张）`);

  // ---- 卡片上的原作 / 标签小片可直接点筛选，且不该误开详情 ----
  await clearFilters();
  const chipTagText = await evaluate(`(() => {
    const c = document.querySelector('#grid .card .card-tags .tag-chip');
    return c ? c.textContent.trim() : '';
  })()`);
  let chipFilterOk = false;
  let chipNote = '页面上没有带标签的卡片';
  if (chipTagText) {
    // 找到那张卡片上的小片坐标（第一个出现的位置）
    const idx = await evaluate(`(() => {
      const all = [...document.querySelectorAll('#grid .card-tags .tag-chip')];
      return all.findIndex(c => c.textContent.trim() === ${JSON.stringify(chipTagText)});
    })()`);
    if (idx >= 0) {
      await realClick('#grid .card-tags .tag-chip', idx);
      const s = JSON.parse(await filterSnapshot());
      chipFilterOk = s.chips.length === 1 && !s.drawerOpen;
      chipNote = `点标签「${chipTagText}」→ chip=${s.chips.length}，抽屉未打开=${!s.drawerOpen}，${s.cards} 张`;
      await clearFilters();
    }
  }
  ok('卡片上的标签小片可点击筛选', chipFilterOk, chipNote);

  console.log('\n—— 详情抽屉 ——');

  // 清掉前面测试留下的筛选，再用真实鼠标点开辉夜（技能最多、含衍生技）
  await clearFilters();
  const pyeIndex = await evaluate(`[...document.querySelectorAll('#grid .card')].findIndex(c => c.dataset.id.includes('蓬莱山辉夜'))`);
  const opened = await evaluate(`[...document.querySelectorAll('#grid .card')].find(c => c.dataset.id.includes('蓬莱山辉夜'))?.dataset.id ?? '(未找到)'`);
  if (pyeIndex >= 0) await realClick('#grid .card', pyeIndex);
  await sleep(1800);

  const drawer = await evaluate(`({
    open: !document.querySelector('#drawer').hidden,
    name: document.querySelector('#dName').textContent,
    title: document.querySelector('#dTitle').textContent,
    kingdom: document.querySelector('#dKingdom').textContent,
    skillViews: document.querySelectorAll('#drawerBody .skill-view').length,
    hasPreview: !!document.querySelector('#drawerBody .card-preview img'),
    previewOk: (() => { const im = document.querySelector('#drawerBody .card-preview img'); return im ? (im.complete && im.naturalWidth>0) : false; })(),
    kwCount: document.querySelectorAll('#drawerBody .sv-desc .kw').length,
    cardRefCount: document.querySelectorAll('#drawerBody .sv-desc .card-name-ref').length,
    derivedViews: document.querySelectorAll('#drawerBody .skill-view.is-derived').length,
    derivedBadges: document.querySelectorAll('#drawerBody .derived-badge').length,
    originShown: (() => {
      const labels = [...document.querySelectorAll('#drawerBody .info-grid .field label')];
      const i = labels.findIndex(l => l.textContent.trim() === '原作');
      return i < 0 ? '' : labels[i].nextElementSibling?.textContent.trim();
    })(),
    assets: document.querySelectorAll('#drawerBody .asset').length,
    extras: document.querySelectorAll('#drawerBody .extra-item').length,
    firstDesc: (document.querySelector('#drawerBody .sv-desc')||{}).innerText || '',
  })`);
  ok('抽屉打开', drawer.open, `武将=${opened}，标题=${drawer.name} / ${drawer.title} / ${drawer.kingdom}，原作=${drawer.originShown || '（未标）'}`);
  ok('技能描述渲染', drawer.skillViews >= 1, `${drawer.skillViews} 条技能，关键词高亮 ${drawer.kwCount} 处，牌名高亮 ${drawer.cardRefCount} 处`);
  ok('衍生技有独立外观标识', drawer.derivedViews >= 3,
    `${drawer.derivedViews} 条技能带 .is-derived 样式，其中 ${drawer.derivedBadges} 个带「衍生」角标`);
  ok('详情卡图预览加载', drawer.hasPreview && drawer.previewOk, drawer.previewOk ? 'ok' : '图片未加载');
  ok('素材库列出', drawer.assets >= 1, `${drawer.assets} 个素材，神宝附加区 ${drawer.extras} 项`);
  if (drawer.firstDesc) console.log(`      首条描述: ${drawer.firstDesc.slice(0, 70).replace(/\n/g, ' ')}…`);

  console.log('\n—— 编辑 / 保存落盘 ——');

  // 进入编辑
  await evaluate(`document.querySelector('#btnCardEdit').click()`);
  await sleep(500);
  const editState = await evaluate(`({
    editing: !!document.querySelector('#drawerBody .skill-item'),
    fields: document.querySelectorAll('#drawerBody [data-field]').length,
    skillInputs: document.querySelectorAll('#drawerBody .skill-item').length,
    saveDisabled: document.querySelector('#btnSave').disabled,
  })`);
  ok('切到编辑态', editState.editing, `${editState.fields} 个字段、${editState.skillInputs} 条技能，保存按钮初始禁用=${editState.saveDisabled}`);

  // 记录原始值，改名加一个标记时间戳
  const stamp = `验证${Date.now() % 100000}`;
  const before = await evaluate(`document.querySelector('#drawerBody [data-field="legendId"]').value`);
  await evaluate(`(() => {
    const el = document.querySelector('#drawerBody [data-field="note"]');
    el.value = '（无头验证写入：${stamp}）';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await sleep(200);

  const dirtyState = await evaluate(`({
    dirty: document.querySelector('#saveState').classList.contains('dirty'),
    saveDisabled: document.querySelector('#btnSave').disabled,
  })`);
  ok('修改后标记为脏 / 保存可用', dirtyState.dirty && !dirtyState.saveDisabled, JSON.stringify(dirtyState));

  await evaluate(`document.querySelector('#btnSave').click()`);
  await sleep(1600);

  const afterSave = await evaluate(`({
    saveState: document.querySelector('#saveState').textContent,
    editing: !!document.querySelector('#drawerBody .skill-item'),
    noteShown: document.querySelector('#drawerBody').innerText.includes('${stamp}'),
  })`);
  ok('保存并回到查看态', !afterSave.editing && afterSave.noteShown,
    `状态="${afterSave.saveState}"，备注已显示=${afterSave.noteShown}`);

  // 直接从磁盘校验
  const notePath = 'E:/Deepseek/素材/蓬莱山辉夜/武将.json';
  const disk = JSON.parse(fs.readFileSync(notePath, 'utf8'));
  ok('磁盘上的 武将.json 已更新', disk.note.includes(stamp), `note 字段包含标记：${disk.note.includes(stamp)}`);

  // 复原
  disk.note = disk.note.replace(new RegExp(`\\n?（无头验证写入：${stamp}）`), '');
  fs.writeFileSync(notePath, JSON.stringify(disk, null, 2) + '\n', 'utf8');
  const restored = JSON.parse(fs.readFileSync(notePath, 'utf8'));
  ok('验证痕迹已复原', !restored.note.includes(stamp), `note 长度 ${restored.note.length}`);

  console.log('\n—— 搜索 / 筛选 ——');

  // 关掉抽屉、清空筛选，保证搜索是在全量上做
  await evaluate(`document.querySelector('#btnCloseDrawer').click()`);
  await sleep(400);
  await clearFilters();

  // 全量张数现算，别写死——武将数一直在长
  const totalCards = await evaluate(`document.querySelectorAll('#grid .card').length`);

  const setSearch = async (v) => {
    await evaluate(`(() => {
      const el = document.querySelector('#search');
      el.value = ${JSON.stringify(v)};
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await sleep(450);
  };

  await setSearch('辉夜');
  const searched = await evaluate(`JSON.stringify({
    n: document.querySelectorAll('#grid .card').length,
    names: [...document.querySelectorAll('#grid .card-name')].map(x => x.textContent),
  })`);
  const searchedObj = JSON.parse(searched);
  ok('搜索过滤', searchedObj.n >= 1 && searchedObj.n < totalCards,
    `"辉夜" → ${searchedObj.n} 张（${searchedObj.names.join('、')}）`);

  await setSearch('');

  // 点一个势力筛选（真实鼠标）
  const weiIndex = await evaluate(`[...document.querySelectorAll('#kingdomTree .tag-row')].findIndex(r => r.dataset.key === 'kingdom:wei')`);
  await realClick('#kingdomTree .tag-row', weiIndex >= 0 ? weiIndex : 1);
  const kingdomCount = await evaluate('document.querySelectorAll("#grid .card").length');
  ok('势力筛选', kingdomCount >= 1 && kingdomCount < totalCards, `kingdom:wei → ${kingdomCount} 张`);

  const clearChip = await evaluate(`document.querySelectorAll('#activeFilters .filter-chip').length`);
  ok('筛选 chip 显示', clearChip >= 1, `${clearChip} 个`);
  await clearFilters();

  // ---- 「只看待实现」----
  // 预期值从接口现算：implemented 是随时会改的数据，写死个数迟早假失败
  const pendList = await fetch(`${URL_BASE}api/characters`).then((r) => r.json()).catch(() => null);
  const pendIds = (pendList?.characters ?? []).filter((c) => c.implemented === false).map((c) => c.id);

  const togglePending = (on) => evaluate(`(() => {
    const el = document.querySelector('#onlyPending');
    el.checked = ${on};
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);

  ok('工具栏有「只看待实现」开关', await evaluate(`!!document.querySelector('#onlyPending')`));
  await togglePending(true);
  await sleep(450);
  const pendShown = JSON.parse(await evaluate(
    `JSON.stringify([...document.querySelectorAll('#grid .card')].map(c => c.dataset.id))`,
  ));
  ok('只看待实现：只剩标了 implemented:false 的武将',
    pendShown.length === pendIds.length && pendIds.every((id) => pendShown.includes(id)),
    `显示 ${pendShown.length} 位（应为 ${pendIds.length}）：${pendShown.join('、') || '（空）'}`);
  ok('只看待实现：出现可清除的 chip',
    await evaluate(`[...document.querySelectorAll('#activeFilters [data-clear]')].some(b => b.dataset.clear === '__pending__')`));
  await clearFilters();
  const afterClearObj = JSON.parse(await evaluate(`JSON.stringify({
    checked: document.querySelector('#onlyPending').checked,
    n: document.querySelectorAll('#grid .card').length,
  })`));
  ok('只看待实现：清掉 chip 后开关复位并恢复全量',
    afterClearObj.checked === false && afterClearObj.n === totalCards,
    `checked=${afterClearObj.checked}，${afterClearObj.n} / ${totalCards}`);

  // 视图切换
  await evaluate(`document.querySelector('.seg button[data-view="list"]').click()`);
  await sleep(300);
  const listView = await evaluate(`document.querySelector('#grid').classList.contains('list-view')`);
  ok('列表视图切换', listView, listView ? 'ok' : '未切换');

  // ---- 最终错误检查 ----
  console.log('\n—— 错误检查 ——');
  ok('无 JS 报错', consoleErrors.length === 0, consoleErrors.slice(0, 4).join(' | ') || '干净');
  const realFails = failedRequests.filter((f) => !/favicon/.test(f));
  ok('无请求失败', realFails.length === 0, realFails.slice(0, 4).join(' | ') || '干净');

  // 截图
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  const shotPath = path.join(__dirname, '..', '_shots', '武将牌库-验证.png');
  fs.mkdirSync(path.dirname(shotPath), { recursive: true });
  fs.writeFileSync(shotPath, Buffer.from(shot.data, 'base64'));
  console.log(`\n截图: ${shotPath}`);

  // 收尾：杀浏览器进程后，profile 目录常有句柄没释放，
  // 所以清理放到后台做，失败也不影响结论
  try { await browser.send('Target.closeTarget', { targetId }); } catch { /* 忽略 */ }
  try { browser.close(); } catch { /* 忽略 */ }
  try {
    if (launched.pid) cdp.killProcessTree(launched.pid);
    else cdp.killProcessTree(await cdp.getBrowserPid(launched.port).catch(() => 0));
  } catch { /* 忽略 */ }
  setTimeout(() => {
    try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }, 3000).unref?.();

  const passed = results.filter((r) => r.pass).length;
  console.log(`\n通过 ${passed}/${results.length}`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((err) => {
  console.error('\n验证脚本出错：', err);
  process.exit(2);
});
