/**
 * 验证「工作副本目录建不出来」时的表现。
 *
 * 这一组是照着一个真实故障写的：项目从一台机器拷到另一台，`.data\sync.json`
 * 里还留着上一台机器的**绝对路径**（work 这个字段本身不进仓库，但整个文件夹
 * 复制会带上）。在新机器上那个前缀可能属于一个根本不存在的用户，于是
 * `fsp.mkdir(work, {recursive: true})` 直接抛
 *
 *   EPERM: operation not permitted, mkdir 'C:\Users\someone'
 *
 * 光看这句话完全不知道发生了什么 —— 既看不出这是配置里的路径，也看不出该去哪改。
 * 现在的要求是：配置的位置用不了就**退回本机默认位置**把活儿干完，实在不行也得
 * 报一句人能看懂、能照做的话。
 *
 * 构造「建不出来」用的是 `父路径是个文件`（ENOTDIR），这样在任何机器上都能稳定
 * 复现，不依赖特定目录的权限。真实的 EPERM 走的是同一条代码路径。
 *
 * 用法：
 *   node scripts\verify-workdir.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as syncCore from '../server/sync-core.mjs';

const results = [];
const ok = (n, p, d = '') => { results.push(p); console.log(`${p ? '  ✓' : '  ✗'} ${n}${d ? `  — ${d}` : ''}`); };

const TMP = path.join(os.tmpdir(), `wujiang-verify-workdir-${process.pid}`);
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

// 一个文件挡在路径中间：以它为父级去建目录一定是建不出来的
const BLOCKER = path.join(TMP, 'blocker');
fs.writeFileSync(BLOCKER, 'x');
const BAD = path.join(BLOCKER, 'work');

const REMOTE = 'https://example.invalid/nope.git';
const base = { remote: REMOTE, branch: 'main', proxy: '' };

try {
  /* ---------- 1. 正常路径：不该有多余动作 ---------- */
  {
    const good = path.join(TMP, 'normal');
    const r = await syncCore.ensureRepo({ ...base, work: good });
    ok('正常路径直接用，不回退', r.usedFallback === false && r.work === path.resolve(good));
    ok('正常路径建出了 git 仓库', fs.existsSync(path.join(good, '.git')));
  }

  /* ---------- 2. 配置的位置建不出来 → 退回默认位置 ---------- */
  {
    const fallback = path.join(TMP, 'fallback');
    const r = await syncCore.ensureRepo({ ...base, work: BAD, fallbackWork: fallback });
    ok('坏路径 + 有默认位置 → 不报错，照常干', r.ok !== false && r.work === path.resolve(fallback));
    ok('标记出这次用了回退位置', r.usedFallback === true);
    ok('记下了原来那个坏路径', r.movedFrom === path.resolve(BAD), r.movedFrom);
    ok('给出了坏的原因（不是光秃秃的 errno）', typeof r.reason === 'string' && r.reason.length > 0, r.reason);
    ok('回退位置里真的建好了仓库', fs.existsSync(path.join(fallback, '.git')));
  }

  /* ---------- 3. 坏路径 + 没有默认位置 → 报一句能照做的话 ---------- */
  {
    let err = null;
    try { await syncCore.ensureRepo({ ...base, work: BAD }); } catch (e) { err = e; }
    ok('坏路径 + 无默认位置 → 抛错而不是静默', !!err);
    const msg = err?.message || '';
    ok('错误里带上了那个路径', msg.includes('blocker'), msg.slice(0, 60));
    ok('错误里指明了配置来源 .data\\sync.json', msg.includes('sync.json'));
    ok('错误里说了去哪改（齿轮 / 工作副本位置）', msg.includes('齿轮') && msg.includes('工作副本位置'));
    ok('错误是人话，不是裸的 EPERM/ENOTDIR', !/^(EPERM|ENOTDIR|EACCES)/.test(msg) && msg.startsWith('工作副本目录建不起来'));
  }

  /* ---------- 4. work 为空：绝不能在「进程当前目录」里建 git ---------- */
  {
    const cwdGit = path.join(process.cwd(), '.git');
    const hadGit = fs.existsSync(cwdGit);

    const fallback = path.join(TMP, 'empty-fallback');
    const r = await syncCore.ensureRepo({ ...base, work: '', fallbackWork: fallback });
    ok('work 为空 → 走默认位置', r.usedFallback === true && r.work === path.resolve(fallback));
    ok('work 为空时没有在进程当前目录建 .git', fs.existsSync(cwdGit) === hadGit, process.cwd());

    const blank = path.join(TMP, 'blank-fallback');
    const r2 = await syncCore.ensureRepo({ ...base, work: '   ', fallbackWork: blank });
    ok('work 是纯空格 → 同样按「没配」处理', r2.usedFallback === true && r2.work === path.resolve(blank));
  }

  /* ---------- 5. work 为空又没有默认位置：说清楚是「没配」 ---------- */
  {
    let err = null;
    try { await syncCore.ensureRepo({ ...base, work: '' }); } catch (e) { err = e; }
    ok('work 为空且无默认位置 → 抛错', !!err);
    ok('错误里说明是「没有配置路径」', /没有配置路径/.test(err?.message || ''), err?.message?.slice(0, 70));
  }

  /* ---------- 6. remote 会自动配上（回退之后也不能漏） ---------- */
  {
    const fallback = path.join(TMP, 'fallback');   // 第 2 组已经建好
    const url = await syncCore.git(['remote', 'get-url', 'origin'], { cwd: fallback });
    ok('回退出来的仓库也配好了 origin', url.ok && url.stdout.trim() === REMOTE, url.stdout.trim() || url.message);
  }

  /* ---------- 7. 服务端确实把默认位置传下去了 ---------- */
  {
    const src = fs.readFileSync(new URL('../server/server.mjs', import.meta.url), 'utf8');
    ok('server 往同步任务里传了 fallbackWork', /fallbackWork:\s*syncCore\.defaultWorkDir\(/.test(src));
    ok('回退之后会把新位置记进配置', /rememberWork/.test(src) && /saveSyncConfig\(\)/.test(src));
  }
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}

const pass = results.filter(Boolean).length;
console.log(`\n${pass}/${results.length} 通过`);
process.exit(pass === results.length ? 0 : 1);
