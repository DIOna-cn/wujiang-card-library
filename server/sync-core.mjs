/**
 * 同步核心：把「项目 + 素材」与一个 git 工作副本对齐，并通过 git 与远端交换。
 *
 * ── 为什么核心逻辑放在 server\ 下，而不是 publish\ 里？
 *
 *   publish\ 是发布工具，不进 git 仓库；而网页上的「上传 / 下载 / 轮询」按钮
 *   在别人 clone 出来的副本里也要能用。所以核心逻辑必须住在仓库内，
 *   由 `server\server.mjs`（网页用）和 `publish\sync-repo.mjs`（命令行用，较慢）共用。
 *   规则只写一份，改一次两边都生效。
 *
 * ── 目录约定（clone 下来就是这个样子）
 *
 *   <根>\
 *     ├─ server\ web\ scripts\ …        ← 程序
 *     ├─ .data\tags.json + 原始描述备份\ ← 也属于内容
 *     └─ 素材\<武将>\武将.json + 立绘…    ← 数据与素材
 *
 *   git 工作副本是「根」之外的另一个目录，通过 --work 指定。
 *   网页同步时，工作副本默认在 %USERPROFILE%\<项目名>-git。
 *
 * ── 两个方向
 *
 *   push：项目 → 工作副本 → commit → push
 *   pull：git pull → 工作副本 → 只把「数据文件」写回项目（只增不删，保本地）
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';

/* ------------------------------------------------------------------ *
 * 收录规则：哪些文件进仓库
 * ------------------------------------------------------------------ */

/** 带技能卡图 */
const RE_CARD_FULL = /^新UI\./;
/** 无技能卡图 / 立绘（网页显示的主图） */
const RE_PORTRAIT = /^立绘/;
const RE_SHAP = /\.shap$/i;
const RE_AUDIO = /\.(mp3|wav|ogg|m4a)$/i;
const RE_IMAGE = /\.(png|jpe?g|webp|gif)$/i;
const RE_MD = /\.md$/i;

/** 三种范围，对应 --mode */
export const MODES = {
  data: ['data', 'legacy', 'doc'],
  'data+art': ['data', 'legacy', 'doc', 'portrait', 'art', 'audio', 'treasure', 'extra'],
  full: ['data', 'legacy', 'doc', 'portrait', 'art', 'audio', 'treasure', 'extra', 'cardfull', 'shap', 'other'],
};

/** 素材目录里的文件属于哪一类；返回 null 表示不进仓库 */
export function assetKind(rel) {
  const parts = rel.split('/');
  const name = parts[parts.length - 1];
  const folder = parts.length > 1 ? parts[parts.length - 2] : '';

  if (name === '武将.json') return 'data';
  if (name === '描述.txt') return 'legacy';
  if (folder === '原画') return 'art';
  if (folder === '宝物卡图') return 'treasure';
  if (RE_PORTRAIT.test(name)) return 'portrait';
  if (RE_AUDIO.test(name)) return 'audio';
  if (RE_MD.test(name)) return 'doc';
  if (RE_SHAP.test(name)) return 'shap';
  if (RE_CARD_FULL.test(name)) return 'cardfull';
  if (RE_IMAGE.test(name)) return 'extra';
  return 'other';
}

/** 项目里的文件是否进仓库 */
export function projectKeep(rel, projectName = '') {
  const parts = rel.split('/');
  const top = parts[0];
  if (top === '.data') {
    return rel === '.data/tags.json' || rel.startsWith('.data/原始描述备份/');
  }
  if (['_shots', 'publish', 'node_modules', '.git'].includes(top)) return false;
  if (rel === '.publish-manifest.json') return false;
  if (top === '推送到GitHub.cmd' || top === '从GitHub拉取.cmd') return false;
  if (/^\.git(ignore|attributes)$/.test(top)) return top === '.gitattributes';
  if (/\.(log|tmp)$/i.test(rel)) return false;
  if (rel === 'server.pid') return false;
  if (projectName && top === projectName) return false;
  return true;
}

/** 只有这些会被 pull 写回项目（图片素材本地本来就有，不用往回写） */
export function isDataFile(rel) {
  return /(^|\/)武将\.json$/.test(rel)
    || rel === '.data/tags.json'
    || /^\.data\/原始描述备份\//.test(rel);
}

/* ------------------------------------------------------------------ *
 * 基础工具
 * ------------------------------------------------------------------ */

export const sha256 = async (file) =>
  crypto.createHash('sha256').update(await fsp.readFile(file)).digest('hex');

export const toPosix = (p) => p.replace(/\\/g, '/');
export const mb = (b) => `${(b / 1024 / 1024).toFixed(2)} MB`;

/** 列目录（递归）。返回 [{ abs, rel }]，rel 一律用正斜杠 */
export async function walk(dir, base = dir, out = []) {
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) await walk(abs, base, out);
    else if (e.isFile()) out.push({ abs, rel: toPosix(path.relative(base, abs)) });
  }
  return out;
}

/** 内容一致就不重写（省 IO，也避免无意义的 mtime 变动） */
export async function copyIfChanged(src, dest) {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  try {
    if (fs.existsSync(dest)) {
      const [a, b] = await Promise.all([fsp.stat(src), fsp.stat(dest)]);
      if (a.size === b.size && (await sha256(src)) === (await sha256(dest))) return false;
    }
  } catch { /* 读不了就当需要复制 */ }
  await fsp.copyFile(src, dest);
  return true;
}

/** 清空目录里的空文件夹（素材下会残留删空了的武将目录） */
export async function pruneEmpty(dir) {
  if (!fs.existsSync(dir)) return;
  for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
    if (e.isDirectory()) await pruneEmpty(path.join(dir, e.name));
  }
  try {
    if ((await fsp.readdir(dir)).length === 0) await fsp.rmdir(dir);
  } catch { /* 忽略 */ }
}

/* ------------------------------------------------------------------ *
 * 远端地址 / 代理
 * ------------------------------------------------------------------ */

/** 从 git remote 读取 owner/repo@branch */
export function parseRemote(url, branch = 'main') {
  const m = String(url || '').match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?(?:\/)?$/);
  if (!m) return null;
  return { owner: m[1], repo: m[2], branch };
}

/** 读 Windows 系统代理（git 默认不读它） */
export async function readSystemProxy() {
  const run = (args) => new Promise((resolve) => {
    execFile('reg', args, { encoding: 'utf8' }, (err, stdout) => resolve(err ? '' : stdout));
  });
  const KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
  const [on, srv] = await Promise.all([
    run(['query', KEY, '/v', 'ProxyEnable']),
    run(['query', KEY, '/v', 'ProxyServer']),
  ]);
  if (!/ProxyEnable\s+REG_DWORD\s+0x1/i.test(on)) return '';
  const m = srv.match(/ProxyServer\s+REG_SZ\s+(\S+)/i);
  if (!m) return '';
  return m[1].match(/^https?:\/\//) ? m[1] : `http://${m[1]}`;
}

/** 探一下代理端口是否有人监听 */
export function probeProxy(proxyUrl, timeoutMs = 1200) {
  return new Promise((resolve) => {
    const m = String(proxyUrl || '').match(/:(\d+)/);
    if (!m) return resolve({ ok: false, reason: '没有可探测的端口' });
    const s = net.connect(Number(m[1]), '127.0.0.1');
    const done = (ok) => { try { s.destroy(); } catch { /* 忽略 */ } resolve({ ok, port: Number(m[1]) }); };
    s.setTimeout(timeoutMs);
    s.on('connect', () => done(true));
    s.on('error', () => done(false));
    s.on('timeout', () => done(false));
  });
}

/* ------------------------------------------------------------------ *
 * git 封装
 * ------------------------------------------------------------------ */

/**
 * 跑一条 git 命令。
 * 一律带 -c http.proxy / https.proxy：git 不读 Windows 系统代理，
 * 而本机 github.com 直连会被打断（Empty reply / Failed to connect）。
 * 同时关掉交互提示，避免服务器进程卡在等输入上。
 */
export function git(args, { cwd, proxy = '', timeoutMs = 120000 } = {}) {
  const full = [];
  if (proxy) full.push('-c', `http.proxy=${proxy}`, '-c', `https.proxy=${proxy}`);
  full.push(...args);

  return new Promise((resolve) => {
    execFile('git', full, {
      cwd,
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
    }, (err, stdout = '', stderr = '') => {
      resolve({
        ok: !err,
        code: err?.code ?? 0,
        stdout: String(stdout),
        stderr: String(stderr),
        message: err ? (String(stderr).trim() || String(stdout).trim() || err.message) : '',
      });
    });
  });
}

/** 工作副本是否已初始化 */
export async function isRepo(work) {
  return fs.existsSync(path.join(work, '.git'));
}

/** 确保工作副本存在并配好（remote / 代理 / 行尾） */
export async function ensureRepo({ work, remote, branch = 'main', proxy = '', projectName = '' }) {
  await fsp.mkdir(work, { recursive: true });
  const created = !(await isRepo(work));

  if (created) {
    await git(['init', '-b', branch], { cwd: work });
    await git(['config', 'core.autocrlf', 'false'], { cwd: work });
    await git(['config', 'core.quotepath', 'false'], { cwd: work });
    if (remote) await git(['remote', 'add', 'origin', remote], { cwd: work });
  }

  // remote 可能变了（用户在网页上填了另一个仓库）
  if (remote) {
    const cur = (await git(['remote', 'get-url', 'origin'], { cwd: work })).stdout.trim();
    if (cur !== remote) {
      if (cur) await git(['remote', 'set-url', 'origin', remote], { cwd: work });
      else await git(['remote', 'add', 'origin', remote], { cwd: work });
    }
  }

  if (proxy) {
    await git(['config', '--local', 'http.proxy', proxy], { cwd: work });
    await git(['config', '--local', 'https.proxy', proxy], { cwd: work });
  }

  return { created };
}

/** 工作副本里有没有未提交的改动 */
export async function workIsDirty(work) {
  const r = await git(['status', '--porcelain'], { cwd: work });
  return { dirty: r.ok && r.stdout.trim().length > 0, detail: r.stdout.trim() };
}

/** 远端 main 的 sha（不下载对象，很快） */
export async function remoteHead({ work, branch = 'main', proxy = '' }) {
  const r = await git(['ls-remote', 'origin', `refs/heads/${branch}`], { cwd: work, proxy, timeoutMs: 30000 });
  if (!r.ok) return { ok: false, sha: '', message: r.message };
  const sha = (r.stdout.trim().split(/\s+/)[0] || '');
  return { ok: true, sha };
}

/** 本地 HEAD 的 sha */
export async function localHead(work) {
  const r = await git(['rev-parse', 'HEAD'], { cwd: work });
  return r.ok ? r.stdout.trim() : '';
}

/** 本地领先/落后远端多少（基于本地已知的 origin ref，不发网络请求） */
export async function aheadBehind(work, branch = 'main') {
  const ref = `refs/remotes/origin/${branch}`;
  const has = await git(['rev-parse', '--verify', '--quiet', ref], { cwd: work });
  if (!has.ok) return { ahead: 0, behind: 0, known: false };
  const r = await git(['rev-list', '--left-right', '--count', `${ref}...HEAD`], { cwd: work });
  if (!r.ok) return { ahead: 0, behind: 0, known: false };
  const [behind, ahead] = r.stdout.trim().split(/\s+/).map(Number);
  return { ahead: ahead || 0, behind: behind || 0, known: true };
}

/* ------------------------------------------------------------------ *
 * 文件层面：项目 ↔ 工作副本
 * ------------------------------------------------------------------ */

/** 当前工作副本里应该有哪些文件（相对路径 → 绝对源路径） */
export async function buildWorkSet({ project, assets, mode = 'data+art', projectName = '' }) {
  const ok = new Set(MODES[mode] ?? MODES['data+art']);
  const set = new Map();

  // 项目文件
  for (const f of await walk(project)) {
    if (!projectKeep(f.rel, projectName)) continue;
    set.set(f.rel, f.abs);
  }
  // 素材文件
  if (fs.existsSync(assets)) {
    for (const f of await walk(assets)) {
      const kind = assetKind(f.rel);
      if (!kind || !ok.has(kind)) continue;
      set.set(`素材/${f.rel}`, f.abs);
    }
  }
  return set;
}

/**
 * 把项目按 workSet 同步到工作副本。
 * 会删掉「工作副本里有、workSet 里没有」的文件（git 那边需要真实的删除）。
 */
export async function syncToWork({ work, workSet, mode = 'data+art' }) {
  const copied = [];
  const removed = [];

  // 1) 先清理工作副本里多余的（素材与项目都算；.git* / 清单除外）
  const existing = await walk(work);
  for (const f of existing) {
    if (f.rel.startsWith('.git/')) continue;
    if (['.gitattributes', '.gitignore', '.publish-manifest.json'].includes(f.rel)) continue;
    if (!workSet.has(f.rel)) {
      await fsp.rm(f.abs, { force: true });
      removed.push(f.rel);
    }
  }

  // 2) 复制需要新增/更新的
  for (const [rel, src] of workSet) {
    if (await copyIfChanged(src, path.join(work, rel))) copied.push(rel);
  }

  // 3) 清空目录 + 生成工作副本的 .gitignore
  await pruneEmpty(path.join(work, '素材'));

  const giPath = path.join(work, '.gitignore');
  const giText = [
    '# 由同步逻辑生成，别手改 —— 改了下次同步会被覆盖回去',
    '',
    '# 运行痕迹',
    '.data/server.pid',
    '.data/回收站/',
    '.publish-manifest.json',
    '',
    '# 系统 / 编辑器',
    'Thumbs.db',
    'desktop.ini',
    '.DS_Store',
    '*.log',
    '',
  ].join('\n');
  try {
    if ((await fsp.readFile(giPath, 'utf8')) !== giText) await fsp.writeFile(giPath, giText, 'utf8');
  } catch {
    await fsp.writeFile(giPath, giText, 'utf8');
  }

  return { copied, removed, mode };
}

/**
 * 把工作副本里的「数据文件」写回项目。
 * 只新增和更新，绝不删除 —— 远端少了个武将文件夹也不能让本地那份消失。
 */
export async function writeDataBack({ work, project, assets }) {
  const files = (await walk(work)).filter((f) => isDataFile(f.rel) && !f.rel.startsWith('.git/'));
  const updated = [];
  const added = [];
  const same = [];

  for (const f of files) {
    let dest;
    if (f.rel.startsWith('素材/')) dest = path.join(assets, f.rel.slice('素材/'.length));
    else if (f.rel.startsWith('.data/')) dest = path.join(project, f.rel);
    else continue;

    const existed = fs.existsSync(dest);
    let changed = true;
    if (existed) {
      try { changed = (await sha256(f.abs)) !== (await sha256(dest)); } catch { changed = true; }
    }
    if (!changed) { same.push(f.rel); continue; }

    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.copyFile(f.abs, dest);
    (existed ? updated : added).push(f.rel);
  }

  return { updated, added, same, total: files.length };
}

/** 本地数据与工作副本的差异（不联网，纯比内容） */
export async function diffLocalVsWork({ work, project, assets }) {
  const files = (await walk(work)).filter((f) => isDataFile(f.rel) && !f.rel.startsWith('.git/'));
  const diffs = [];
  for (const f of files) {
    let localSrc;
    if (f.rel.startsWith('素材/')) localSrc = path.join(assets, f.rel.slice('素材/'.length));
    else if (f.rel.startsWith('.data/')) localSrc = path.join(project, f.rel);
    else continue;
    if (!fs.existsSync(localSrc)) { diffs.push({ rel: f.rel, kind: '仅在副本' }); continue; }
    try {
      if ((await sha256(localSrc)) !== (await sha256(f.abs))) diffs.push({ rel: f.rel, kind: '内容不同' });
    } catch { diffs.push({ rel: f.rel, kind: '读取失败' }); }
  }
  return diffs;
}

/* ------------------------------------------------------------------ *
 * 两条主流程
 * ------------------------------------------------------------------ */

/** 工作副本默认位置：%USERPROFILE%\<项目名>-git（Windows）或 ~/.<项目名>-git */
export function defaultWorkDir(project, projectName) {
  const name = projectName || path.basename(project);
  if (process.platform === 'win32') return path.join(os.homedir(), `${name}-git`);
  return path.join(os.homedir(), `.${name}-git`);
}

/**
 * 上传：项目 → 工作副本 → commit → push
 * @returns 结果摘要，不抛异常（失败信息放在 error 里给网页显示）
 */
export async function pushAll({
  project, assets, work, mode = 'data+art', remote, branch = 'main',
  proxy = '', projectName = '', message = '', onStep = () => {},
}) {
  const steps = [];
  const step = (s) => { steps.push(s); onStep(s); };

  step('准备 git 工作副本…');
  await ensureRepo({ work, remote, branch, proxy, projectName });

  step('收集要同步的文件…');
  const workSet = await buildWorkSet({ project, assets, mode, projectName });

  step(`同步文件到工作副本（${workSet.size} 个）…`);
  const { copied, removed } = await syncToWork({ work, workSet, mode });

  step('提交…');
  await git(['add', '-A'], { cwd: work });
  const status = await git(['status', '--porcelain'], { cwd: work });
  const changes = status.stdout.trim() ? status.stdout.trim().split('\n').length : 0;
  let committed = false;
  if (changes) {
    const msg = message || `网页同步 ${new Date().toLocaleString('zh-CN', { hour12: false })}（${changes} 个文件）`;
    const c = await git(['commit', '-q', '-m', msg], { cwd: work });
    if (!c.ok) {
      return { ok: false, error: '提交失败：' + c.message, steps, copied: copied.length, removed: removed.length };
    }
    committed = true;
  }

  step('推送到远端…');
  const p = await git(['push', '-q', '-u', 'origin', branch], { cwd: work, proxy, timeoutMs: 300000 });
  if (!p.ok) {
    // 连接类报错不一定是真失败：核对远端 ref 再下结论
    const head = await localHead(work);
    const rh = await remoteHead({ work, branch, proxy });
    if (rh.ok && rh.sha === head) {
      step('推送时报了错，但远端已经是本地这个提交 —— 实际已成功');
    } else {
      return {
        ok: false,
        error: '推送失败：' + p.message,
        hint: proxy
          ? '检查代理是否在运行；也可以确认仓库地址与权限。'
          : 'git 不读系统代理，可显式指定代理后重试。',
        steps, copied: copied.length, removed: removed.length, committed,
      };
    }
  }

  const head = await localHead(work);
  const { ahead, behind } = await aheadBehind(work, branch);

  step('完成');
  return {
    ok: true, steps,
    copied: copied.length, removed: removed.length, changes, committed,
    localHead: head, remoteHead: head, ahead, behind,
  };
}

/**
 * 下载：远端 → 工作副本 → 数据写回项目
 */
export async function pullAll({
  project, assets, work, mode = 'data+art', remote, branch = 'main',
  proxy = '', projectName = '', onStep = () => {},
}) {
  const steps = [];
  const step = (s) => { steps.push(s); onStep(s); };

  step('准备 git 工作副本…');
  await ensureRepo({ work, remote, branch, proxy, projectName });

  const dirty = await workIsDirty(work);
  if (dirty.dirty) {
    return {
      ok: false,
      error: '工作副本里有还没推上去的改动，先点「上传」把它们推上去，再下载。',
      detail: dirty.detail.split('\n').slice(0, 8),
      steps,
    };
  }

  const before = await localHead(work);

  step('从远端拉取…');
  const r = await git(['pull', '--ff-only', 'origin', branch], { cwd: work, proxy, timeoutMs: 300000 });
  if (!r.ok) {
    return {
      ok: false,
      error: '拉取失败：' + r.message,
      hint: proxy ? '确认代理软件在运行。' : 'git 不读系统代理，可显式指定代理后重试。',
      steps,
    };
  }

  const after = await localHead(work);
  const changed = before !== after;

  let commits = [];
  if (changed) {
    const log = await git(['log', '--oneline', `${before}..${after}`], { cwd: work });
    commits = log.stdout.trim().split('\n').filter(Boolean).slice(0, 20);
  }

  step('把数据写回项目…');
  const back = await writeDataBack({ work, project, assets });

  const diffs = await diffLocalVsWork({ work, project, assets });

  step('完成');
  return {
    ok: true, steps, changed, commits, before, after,
    updated: back.updated, added: back.added, same: back.same,
    localDiff: diffs,
  };
}

/**
 * 状态检查：远端有没有新东西 / 本地有没有没推的。
 * 用 `git ls-remote`（只取 ref，不下载对象），比 `git fetch` 快很多，适合轮询。
 */
export async function checkStatus({
  project, assets, work, mode = 'data+art', remote, branch = 'main',
  proxy = '', projectName = '',
}) {
  await ensureRepo({ work, remote, branch, proxy, projectName });

  const local = await localHead(work);
  const rh = await remoteHead({ work, branch, proxy });

  if (!rh.ok) {
    return {
      ok: false, reachable: false, error: rh.message,
      localHead: local.slice(0, 7), remoteHead: '',
      hasRemoteUpdate: false, hasLocalChanges: false, ahead: 0, behind: 0,
    };
  }

  // 本地项目里有没有还没同步进工作副本的东西（只看数据文件，很快）
  const diffs = await diffLocalVsWork({ work, project, assets });
  const { ahead, behind } = await aheadBehind(work, branch);

  return {
    ok: true, reachable: true,
    localHead: local.slice(0, 7),
    remoteHead: rh.sha.slice(0, 7),
    // 远端和我本地 HEAD 不同 → 远端有我不知道的东西
    hasRemoteUpdate: !!rh.sha && rh.sha !== local,
    // 本地数据文件与工作副本不同 → 有没上传的改动
    hasLocalChanges: diffs.length > 0,
    localDiffCount: diffs.length,
    localDiffSample: diffs.slice(0, 8),
    ahead, behind,
    work,
  };
}
