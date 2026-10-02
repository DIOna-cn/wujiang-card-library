/**
 * 验证「这台电脑上没有 git」时的表现。
 *
 * 照着一个真实故障写的。新电脑上点「下载」，弹出来的是：
 *
 *     首次拉取失败：spawn git ENOENT
 *     提示：git 不读系统代理，可显式指定代理后重试
 *
 * 用户根本没开代理，却被告知去查代理 —— 因为 `spawn git ENOENT` 是
 * 「找不到 git 这个程序」，跟网络毫无关系，但它冒出来的位置是「首次拉取失败」，
 * 于是代码就顺手给了一段网络建议。这组检查要保证两件事：
 *
 *   1. 找不到 git 时，说的是「找不到 git」并且告诉你去装
 *   2. 真的是网络问题时，原来的代理建议一点都不能少
 *
 * 用环境变量 WUJIANG_GIT 指向一个不存在的程序来模拟「没装 git」。
 *
 * 用法：
 *   node scripts\verify-git.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as syncCore from '../server/sync-core.mjs';

const results = [];
const ok = (n, p, d = '') => { results.push(p); console.log(`${p ? '  ✓' : '  ✗'} ${n}${d ? `  — ${d}` : ''}`); };

const TMP = path.join(os.tmpdir(), `wujiang-verify-git-${process.pid}`);
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

const origForced = process.env.WUJIANG_GIT;

try {
  /* ---------- 0. 前提：本机得有 git，否则做不了对照 ---------- */
  const bin = await syncCore.findGit({ refresh: true });
  if (!bin) {
    console.log('跳过：这台机器上没装 git（正是要模拟的情形，但没法做对照）。');
    process.exit(0);
  }
  console.log(`  · 本机 git：${bin}`);

  const v = await syncCore.git(['--version']);
  ok('有 git 时一切照常', v.ok && /git version/i.test(v.stdout), (v.stdout || v.message).trim());

  /* ---------- 1. 找不到 git：报错要说人话 ---------- */
  process.env.WUJIANG_GIT = path.join(TMP, 'no-such-git.exe');
  ok('指定一个不存在的 git → 如实说找不到', (await syncCore.findGit({ refresh: true })) === '');

  const r = await syncCore.git(['--version']);
  ok('git() 返回失败，而不是抛异常', r.ok === false && r.code === 'ENOENT');
  ok('直接说清了「找不到 git」', r.message.includes('找不到 git'), r.message);
  ok('不再把裸的 ENOENT 丢给用户', !/ENOENT/.test(r.message));

  const hint = syncCore.fetchHint(r.message, '');
  ok('建议是「去装 git」', /Git for Windows/.test(hint));
  ok('建议里不再提代理', !/代理/.test(hint), hint.slice(0, 42));

  const hintWithProxy = syncCore.fetchHint(r.message, 'http://127.0.0.1:7892');
  ok('即使配了代理，也不该往代理上引', !/代理/.test(hintWithProxy));

  /* ---------- 2. 真的是网络问题：原来的建议一个字都不能少 ---------- */
  const netHint = syncCore.fetchHint('Failed to connect to github.com port 443 after 21086 ms', '');
  ok('真网络故障仍然提示查代理', /代理/.test(netHint), netHint);

  /* ---------- 3. 端到端：没 git 时当场失败，别拖到「首次拉取」 ---------- */
  let err = null;
  try {
    await syncCore.ensureRepo({ work: path.join(TMP, 'work'), remote: 'https://example.invalid/x.git' });
  } catch (e) { err = e; }
  ok('ensureRepo 在准备阶段就失败（不再静默往下走）', !!err);
  ok('失败原因指向 git，而不是网络', /找不到 git/.test(err?.message || ''), err?.message?.slice(0, 46));

  /* ---------- 4. 单独看这个翻译函数 ---------- */
  ok('gitErrMessage 认得出 ENOENT', syncCore.gitErrMessage({ code: 'ENOENT' }) === syncCore.GIT_MISSING);
  ok('gitErrMessage 不会吞掉真正的 stderr',
    syncCore.gitErrMessage({ code: 128 }, 'fatal: 远端拒绝了这个推送') === 'fatal: 远端拒绝了这个推送');
} finally {
  if (origForced === undefined) delete process.env.WUJIANG_GIT;
  else process.env.WUJIANG_GIT = origForced;
  fs.rmSync(TMP, { recursive: true, force: true });
}

const pass = results.filter(Boolean).length;
console.log(`\n${pass}/${results.length} 通过`);
process.exit(pass === results.length ? 0 : 1);
