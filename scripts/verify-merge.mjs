#!/usr/bin/env node
/**
 * 验证「两个人各自新建了武将」时的合并行为。
 *
 * 场景：我建了 A、他建了 B。谁先推谁成功，后推的那个不能卡死 ——
 * 必须自动合并成「两边都有 A 和 B」。
 *
 * 全程用一个本地 bare 仓库当远端：不联网、不碰真实素材目录、几秒跑完。
 */

import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pushAll, pullAll, checkStatus } from '../server/sync-core.mjs';

let pass = 0;
let fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log('  \u2713 ' + name); }
  else { fail++; console.log('  \u2717 ' + name + (extra ? '   -> ' + extra : '')); }
}

const git = (args, cwd) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'wj-merge-'));
const bare = path.join(tmp, 'remote.git');
const mine = path.join(tmp, 'mine');
const him = path.join(tmp, 'him');
const proj = path.join(tmp, 'proj');
const assets = path.join(tmp, 'assets');

// 远端用 file:// 形式（Windows 路径要转正斜杠）
const remoteUrl = 'file:///' + bare.replace(/\\/g, '/');

const exists = async (p) => { try { await fsp.access(p); return true; } catch { return false; } };

/** 在某个素材目录里造一个武将 */
async function makeGeneral(root, name, body = null) {
  const dir = path.join(root, name);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(
    path.join(dir, '武将.json'),
    JSON.stringify(body ?? { name, cards: [], skills: [] }, null, 2),
    'utf8'
  );
}

/** 远端 refs/heads/main 上有哪些武将目录（直接读 bare 仓库） */
function remoteGenerals() {
  let out = '';
  try {
    out = execFileSync(
      'git',
      // core.quotepath=false：否则中文目录名会被输出成 \347\264... 的转义串
      ['--git-dir', bare, '-c', 'core.quotepath=false',
        'ls-tree', '-d', '--name-only', 'refs/heads/main', '素材/'],
      { encoding: 'utf8' }
    ).trim();
  } catch {
    return [];
  }
  return out ? out.split('\n').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean) : [];
}

/* 「他」那边的动作 */
const himPull = () => git(['pull', '-q', '--no-rebase', '--no-edit', 'origin', 'main'], him);
const himCommitPush = (msg) => {
  git(['add', '-A'], him);
  git(['commit', '-q', '-m', msg], him);
  git(['push', '-q'], him);
};

const has = (names, n) => names.some((x) => x.endsWith('/' + n) || x === n);

try {
  await fsp.mkdir(proj, { recursive: true });

  console.log('\n[1] 建一个本地 bare 仓库当「远端」，他先放一份基础内容上去');
  // 必须指定 -b main：否则 bare 的 HEAD 指向 master，
  // clone 出来会是个空仓库，历史也就互不相关了
  git(['init', '--bare', '-b', 'main', bare], tmp);
  git(['init', '-b', 'main', him], tmp);
  await makeGeneral(path.join(him, '素材'), '基础武将');
  git(['add', '-A'], him);
  git(['commit', '-q', '-m', '基础内容'], him);
  git(['remote', 'add', 'origin', remoteUrl], him);
  git(['push', '-q', '-u', 'origin', 'main'], him);
  ok('远端已经有基础内容', has(remoteGenerals(), '基础武将'));

  console.log('\n[2] 我把这份素材 clone 成工作副本（此刻还不知道他会新建 B）');
  git(['clone', '-q', remoteUrl, mine], tmp);
  // 我本地当然也有同一份基础素材
  await makeGeneral(assets, '基础武将');
  ok('我的工作副本就绪', await exists(path.join(mine, '.git')));

  console.log('\n[3] 他在他那份里新建了「他新建的B」，并且推上去了');
  await makeGeneral(path.join(him, '素材'), '他新建的B');
  himCommitPush('他新建了 B');
  ok('远端此刻有他建的 B', has(remoteGenerals(), '他新建的B'));
  ok('远端此刻还没有我建的 A', !has(remoteGenerals(), '我新建的A'));

  console.log('\n[4] 我这边新建了「我新建的A」—— 两边都没有对方的东西，分叉了');
  await makeGeneral(assets, '我新建的A');

  const res = await pushAll({
    project: proj, assets, work: mine, mode: 'data',
    remote: remoteUrl, branch: 'main', proxy: '',
  });

  ok('上传成功，没有因为「远端领先」而卡住', res.ok === true, res.error || '');
  ok('识别出是分叉，并自动做了合并', res.merged === true);

  const names = remoteGenerals();
  ok('远端现在有我建的 A', has(names, '我新建的A'), names.join(', '));
  ok('远端现在也有他建的 B', has(names, '他新建的B'), names.join(', '));
  ok('我的素材目录里出现了他建的 B', await exists(path.join(assets, '他新建的B', '武将.json')));
  ok('我的素材目录里当然还有我建的 A', await exists(path.join(assets, '我新建的A', '武将.json')));
  ok('合并结果里能看到对方带回来的提交', (res.incoming?.length ?? 0) >= 1, String(res.incoming?.length));

  console.log('\n[5] 再点一次上传：应该什么都不用做');
  const res2 = await pushAll({
    project: proj, assets, work: mine, mode: 'data',
    remote: remoteUrl, branch: 'main', proxy: '',
  });
  ok('第二次上传成功且没有多余改动', res2.ok === true && res2.changes === 0, `${res2.error || ''} changes=${res2.changes}`);
  ok('第二次不需要再合并', res2.merged === false);

  console.log('\n[6] 分叉时点「下载」也要能合并（以前 --ff-only 会直接失败）');
  // 我在工作副本里留一个「已提交但没推上去」的改动
  await fsp.writeFile(path.join(mine, '我的未推送.txt'), '我的改动', 'utf8');
  git(['add', '-A'], mine);
  git(['commit', '-q', '-m', '我的未推送改动'], mine);
  // 他那边又建了一个 D 推上去（先跟上我刚推的 A，否则他自己的 push 也会被拒）
  himPull();
  await makeGeneral(path.join(him, '素材'), '他新建的D');
  himCommitPush('他新建了 D');

  // 下载之前：两边是真的分叉了，这时必须报「远端有新内容」
  const stBefore = await checkStatus({
    project: proj, assets, work: mine, mode: 'data',
    remote: remoteUrl, branch: 'main', proxy: '',
  });
  ok('下载前确实报「远端有新内容」', stBefore.hasRemoteUpdate === true,
    `local=${stBefore.localHead} remote=${stBefore.remoteHead}`);

  const pr = await pullAll({
    project: proj, assets, work: mine, mode: 'data',
    remote: remoteUrl, branch: 'main', proxy: '',
  });
  ok('下载成功合并且没有报错', pr.ok === true, pr.error || '');
  ok('下载后提示「本地还有没推上去的提交」', pr.needPush === true, 'ahead=' + String(pr.ahead));
  ok('下载把他新建的 D 带回了本地素材', await exists(path.join(assets, '他新建的D', '武将.json')));
  ok('我原先建的两个武将没有丢', (await exists(path.join(assets, '我新建的A', '武将.json')))
    && (await exists(path.join(assets, '他新建的B', '武将.json'))));

  console.log('\n[6b] 下载合出 merge commit 之后，那句「远端有新内容」必须消掉');
  // 这是实际踩到的问题：分叉下载会生成一个 merge commit，本地 HEAD 和远端 sha
  // 从此永远不同。旧判断只看「两个 sha 相不相等」，于是那句「远端有新内容」
  // 点多少次下载都消不掉 —— 人只会以为下载根本没成功。
  const stAfter = await checkStatus({
    project: proj, assets, work: mine, mode: 'data',
    remote: remoteUrl, branch: 'main', proxy: '',
  });
  ok('下载后不再说「远端有新内容」', stAfter.hasRemoteUpdate === false,
    `local=${stAfter.localHead} remote=${stAfter.remoteHead}`);
  ok('而是改成说清楚「本地有 N 个提交没上传」', stAfter.ahead >= 1, 'ahead=' + String(stAfter.ahead));

  console.log('\n[7] 两边改同一个文件的同一处：必须报冲突，而且不能丢数据');
  himPull();   // 他先同步到最新，手上才有 A 这个文件
  await fsp.writeFile(
    path.join(assets, '我新建的A', '武将.json'),
    JSON.stringify({ name: '我新建的A', who: '我改的' }, null, 2),
    'utf8'
  );
  await fsp.writeFile(
    path.join(him, '素材', '我新建的A', '武将.json'),
    JSON.stringify({ name: '我新建的A', who: '他改的' }, null, 2),
    'utf8'
  );
  himCommitPush('他改了 A');

  const cr = await pushAll({
    project: proj, assets, work: mine, mode: 'data',
    remote: remoteUrl, branch: 'main', proxy: '',
  });
  ok('识别为冲突并明确报出来', cr.ok === false && cr.conflict === true, cr.error || 'ok=' + cr.ok);
  const myFile = await fsp.readFile(path.join(assets, '我新建的A', '武将.json'), 'utf8');
  ok('冲突时我本地的改动没有被丢掉', myFile.includes('我改的'));
  const st = git(['status', '--porcelain'], mine);
  ok('冲突后工作副本没有留在半合并状态', !/^(UU|AA|AU|UA|DU|UD)/m.test(st), st.replace(/\n/g, ' | '));
} finally {
  await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
}

console.log(`\n合并验证：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail ? 1 : 0);
