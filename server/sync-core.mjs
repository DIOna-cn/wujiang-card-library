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
import { execFile, spawn } from 'node:child_process';

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

/**
 * 同步范围。默认是 `all`：除 .shap 工程档以外的一切（带技能卡图也在里面）。
 * 只有 `full` 才把 .shap 也带上。
 */
export const MODES = {
  data: ['data', 'legacy', 'doc'],
  'data+art': ['data', 'legacy', 'doc', 'portrait', 'art', 'audio', 'treasure', 'extra'],
  all: ['data', 'legacy', 'doc', 'portrait', 'art', 'audio', 'treasure', 'extra', 'cardfull', 'other'],
  full: ['data', 'legacy', 'doc', 'portrait', 'art', 'audio', 'treasure', 'extra', 'cardfull', 'shap', 'other'],
};

/** 默认范围：除 .shap 外的一切 */
export const DEFAULT_MODE = 'all';

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
  // 安装包不进仓库。用户为了装 git 下载的 Git-2.56.0-64-bit.exe 就这么被推上去过一次：
  // 单个文件 64 MB，比整套程序还大，而且对别人毫无用处。
  if (/\.(exe|msi)$/i.test(rel)) return false;
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
 * 找 git / 跑 git
 * ------------------------------------------------------------------ */

/** 「没找到 git」的统一说法；调用方用 includes('找不到 git') 识别 */
export const GIT_MISSING = '找不到 git 命令（这台电脑上可能没装 Git，或者服务是在装 Git 之前启动的）';

/**
 * 这台机器上的 git 在哪。
 *
 * 为什么要自己找：PATH 里没有 git 时，`execFile('git', …)` 只抛一句
 * `spawn git ENOENT` —— 既没说是「没装 git」，也没说该装什么；而它冒出来的位置是
 * 「首次拉取失败」，看着完全像网络问题，人就跑去查代理了（真发生过）。
 *
 * 比「没装」更常见的是另一种：Git for Windows 装了，但**服务是在装它之前启动的**，
 * 这个进程继承下来的 PATH 里没有它 —— 重启一次服务就好。为了连这种也兜住，
 * 下面把常见安装位置也试一遍。
 *
 * 设了环境变量 WUJIANG_GIT 就只用它：绿色版可以指定路径，自检里也可以拿它
 * 模拟「这台机器没有 git」。
 */
let gitBin = null;   // null = 还没找过；'' = 找过但没找到；字符串 = 可执行文件

/** 这个可执行文件真的是 git 吗（跑一次 --version 看） */
function probeGit(bin) {
  if (!bin) return Promise.resolve(false);
  return new Promise((resolve) => {
    execFile(bin, ['--version'], { encoding: 'utf8', timeout: 8000, windowsHide: true },
      (err, stdout) => resolve(!err && /git version/i.test(String(stdout))));
  });
}

export async function findGit({ refresh = false } = {}) {
  if (refresh) gitBin = null;
  if (gitBin) return gitBin;

  const forced = String(process.env.WUJIANG_GIT || '').trim();
  if (forced) {
    // 明确指定了就不再顺着 PATH 猜 —— 猜中了反而会掩盖配置写错的地方
    gitBin = (await probeGit(forced)) ? forced : '';
    return gitBin;
  }

  const candidates = ['git'];
  if (process.platform === 'win32') {
    const pf = process.env.ProgramFiles || 'C:\\Program Files';
    const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    candidates.push(
      path.join(pf, 'Git', 'cmd', 'git.exe'),
      path.join(pf86, 'Git', 'cmd', 'git.exe'),
      path.join(local, 'Programs', 'Git', 'cmd', 'git.exe'),
      path.join(pf, 'Git', 'bin', 'git.exe'),
      path.join(os.homedir(), 'scoop', 'shims', 'git.exe'),
      path.join(process.env.ChocolateyInstall || 'C:\\ProgramData\\chocolatey', 'bin', 'git.exe'),
    );
  }
  for (const c of candidates) {
    if (await probeGit(c)) { gitBin = c; return c; }
  }
  gitBin = '';
  return '';
}

/** 找到过就一直用；没找到则每次重找 —— 这样用户装完 git 不必重启服务 */
async function ensureGit() {
  return gitBin || findGit();
}

/** git 的报错原样抛出去容易被误读，ENOENT 尤其容易被当成网络问题 */
export function gitErrMessage(err, stderr = '', stdout = '') {
  if (err?.code === 'ENOENT') return GIT_MISSING;
  return String(stderr).trim() || String(stdout).trim() || err?.message || String(err);
}

/**
 * 跑一条 git 命令。
 * 传了 proxy 就带 -c http.proxy / https.proxy —— git 不读 Windows 系统代理，
 * 要显式告诉它。不传就走直连。
 * 同时关掉交互提示，避免服务器进程卡在等输入上。
 */
export async function git(args, { cwd, proxy = '', timeoutMs = 120000 } = {}) {
  const bin = await ensureGit();
  if (!bin) return { ok: false, code: 'ENOENT', stdout: '', stderr: '', message: GIT_MISSING };

  const full = [];
  if (proxy) full.push('-c', `http.proxy=${proxy}`, '-c', `https.proxy=${proxy}`);
  full.push(...args);

  return new Promise((resolve) => {
    execFile(bin, full, {
      cwd,
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
    }, (err, stdout = '', stderr = '') => {
      resolve({
        ok: !err,
        code: err?.code ?? 0,
        stdout: String(stdout),
        stderr: String(stderr),
        message: err ? gitErrMessage(err, stderr, stdout) : '',
      });
    });
  });
}

/** git 进度行的中英对照；表里没有的原样显示 */
const GIT_PHASE_TEXT = {
  'Enumerating objects': '枚举对象',
  'Counting objects': '统计对象',
  'Compressing objects': '压缩对象',
  'Writing objects': '发送对象',
  'Receiving objects': '接收对象',
  'Resolving deltas': '处理增量',
  'Updating files': '更新文件',
  'remote: Enumerating objects': '远端枚举对象',
  'remote: Counting objects': '远端统计对象',
  'remote: Compressing objects': '远端压缩对象',
};

/**
 * 从 git 的一行输出里认出进度。
 *
 *   Receiving objects:  45% (1234/2741), 12.3 MiB | 2.1 MiB/s
 *   remote: Compressing objects: 100% (3/3), done.
 *
 * 认不出就返回 null —— 调用方只对认出进度的行做处理，
 * 报错行（`fatal: unable to access …`）不会因为长得像就被当成进度。
 */
export function parseGitProgress(line) {
  const s = String(line || '').trim();
  // 带 `://` 的一律不是进度，是报错里夹着的 URL。
  // 这条挡在正则前面，是因为形如
  //   fatal: unable to access 'https://github.com/x/y.git': ...
  // 的行里既有冒号又有数字，光靠模式去认很容易误伤。
  if (s.includes('://')) return null;
  // 字符类里那个冒号是必须的：远端阶段的行长这样 ——
  //   remote: Compressing objects: 100% (3/3), done.
  // 有两个冒号，不允许跨过第一个就永远匹配不到。
  const m = s.match(/^([A-Za-z][A-Za-z :]*?):\s+(\d{1,3})%(?:\s*\((\d+)\/(\d+)\))?/);
  if (!m) return null;
  const percent = Number(m[2]);
  if (!Number.isFinite(percent)) return null;
  const label = m[1].trim();
  return {
    label,
    text: GIT_PHASE_TEXT[label] ?? label,
    percent: Math.max(0, Math.min(100, percent)),
    done: m[3] ? Number(m[3]) : 0,
    total: m[4] ? Number(m[4]) : 0,
    raw: s,
  };
}

/**
 * 跑一条 git 命令，并把 stderr 上的进度一行行读出来。
 *
 * 只有 push / fetch / pull 需要它：这几条命令会长时间往外吐进度，
 * 而 git() 用的 execFile 是**跑完才有输出**，期间什么都看不到。
 * 首次下载要把一百多 MB 拉下来，不看这个数进度条就只能干等。
 *
 * 非 tty 时 git 默认不出进度，所以调用方要显式带上 --progress。
 */
export async function gitStream(args, { cwd, proxy = '', timeoutMs = 600000, onProgress = null } = {}) {
  const bin = await ensureGit();
  if (!bin) return { ok: false, code: 'ENOENT', stdout: '', stderr: '', message: GIT_MISSING };

  const full = [];
  if (proxy) full.push('-c', `http.proxy=${proxy}`, '-c', `https.proxy=${proxy}`);
  full.push(...args);

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, full, {
        cwd,
        windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
      });
    } catch (err) {
      return resolve({ ok: false, code: err?.code ?? 'ERROR', stdout: '', stderr: '', message: err?.message || String(err) });
    }

    let stdout = '';
    let stderr = '';
    let timer = null;
    let settled = false;

    const finish = (r) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(r);
    };

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        try { child.kill(); } catch { /* 忽略 */ }
        finish({
          ok: false, code: 'ETIMEDOUT', stdout, stderr,
          message: `git 超过 ${Math.round(timeoutMs / 1000)} 秒没有响应，已中止`,
        });
      }, timeoutMs);
    }

    // 进度写在 stderr 上。git 用 \r 原地刷新，所以一"块"数据里可能塞了好几段，
    // 按 \r 和 \n 一起切开；最后那段可能不完整，留在 buf 里等下一次数据。
    let buf = '';
    child.stderr?.on('data', (chunk) => {
      const s = chunk.toString('utf8');
      stderr += s;
      if (!onProgress) return;
      buf += s;
      const segs = buf.split(/[\r\n]/);
      buf = segs.pop() ?? '';
      for (const seg of segs) {
        const p = parseGitProgress(seg);
        if (p) onProgress(p);
      }
    });
    child.stdout?.on('data', (chunk) => { stdout += chunk.toString('utf8'); });

    child.on('error', (err) => finish({
      ok: false, code: err?.code ?? 'ERROR', stdout, stderr,
      message: gitErrMessage(err, stderr, stdout),
    }));

    child.on('close', (code) => finish({
      ok: code === 0,
      code: code ?? 0,
      stdout,
      stderr,
      message: code === 0 ? '' : (String(stderr).trim() || String(stdout).trim() || `git 退出码 ${code}`),
    }));
  });
}

/** 连不上时给的建议：先分清是「没有 git」还是「网络没通」，别让人往错的方向查 */
export function fetchHint(msg, proxy = '') {
  if (String(msg || '').includes('找不到 git')) {
    return '这台电脑上没找到 git。装一个 Git for Windows（https://git-scm.com/download/win），'
      + '装完重启这个服务再试。';
  }
  return proxy ? '确认代理软件在运行。' : 'git 不读系统代理，可显式指定代理后重试。';
}

/** 工作副本是否已初始化 */
export async function isRepo(work) {
  return fs.existsSync(path.join(work, '.git'));
}

/**
 * 把代理写进工作副本的 local config；没有代理就**把它删掉**。
 *
 * 这里必须能删：早先只在「有代理」时写、没代理时什么都不做，于是上一次留下的
 * 代理会一直粘着 —— 代理软件一关，git 每次都去连那个死端口，报
 * 「Failed to connect ... via 127.0.0.1」，看着就像 github 连不上，
 * 而直连其实一直是好的。这个误判曾经被当成事实写进文档。
 *
 * 键本来就不存在时 `config --unset` 会返回非 0，那是正常的，不用管。
 */
async function applyProxyConfig(work, proxy) {
  for (const key of ['http.proxy', 'https.proxy']) {
    if (proxy) await git(['config', '--local', key, proxy], { cwd: work });
    else await git(['config', '--local', '--unset', key], { cwd: work });
  }
}

/** 像是「网络没连上」而不是「被远端拒绝」的错误 —— 只有这种才值得重试 */
const CONN_ERR = /could not connect|failed to connect|unable to access|timed out|connection (was )?reset|could not resolve|early eof|rpc failed/i;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * push，连接类失败时自动重试几次。
 *
 * 直连 github 是间歇性的：ls-remote 这种小请求常常秒过，push 要传数据，
 * 更容易被掐断（实测一次卡满 21 秒超时，紧接着重试 3.9 秒就成功了）。
 * 被拒（远端有别人的新提交）不算连接问题，原样返回，交给调用方走合并逻辑。
 *
 * 这里用 gitStream 而不是 git：push 是全过程里最慢、最看运气的一段，
 * 它自己会报 `Writing objects: 32% (500/1500)`，把那个数透出去，
 * 进度条才是真的在动。也因此不能带 -q（git 只在没有 --quiet 时才认 --progress）。
 */
async function pushWithRetry(work, branch, proxy, attempts = 3, onRetry = null, onProgress = null) {
  let last = null;
  for (let i = 1; i <= attempts; i++) {
    last = await gitStream(['push', '--progress', '-u', 'origin', branch], {
      cwd: work, proxy, timeoutMs: 300000, onProgress,
    });
    if (last.ok || i === attempts || !CONN_ERR.test(last.message || '')) return last;
    if (onRetry) onRetry(i);
    await sleep(i * 2000);
  }
  return last;
}

/**
 * 让工作副本「能跟 origin 说话」，但不改它的历史。
 *
 * 用 git -C 跑而不是先建目录：目录不存在时 git 会自己 new 一个，
 * 也就不会在 checkStatus（60 秒轮询一次）里凭空造出上百 MB 的工作副本。
 * 只在真正要上传/下载时才走 ensureRepo。
 */
export async function ensureRemoteOnly({ work, remote, branch = 'main', proxy = '' }) {
  if (!(await isRepo(work))) return { ready: false, created: false };

  // remote 可能变了（用户在网页上填了另一个仓库）
  if (remote) {
    const cur = (await git(['remote', 'get-url', 'origin'], { cwd: work })).stdout.trim();
    if (cur !== remote) {
      if (cur) await git(['remote', 'set-url', 'origin', remote], { cwd: work });
      else await git(['remote', 'add', 'origin', remote], { cwd: work });
    }
  }

  await applyProxyConfig(work, proxy);
  return { ready: true, created: false };
}

/** 把 mkdir 的错误码翻译成人话 */
function mkdirReason(err) {
  const code = err?.code || '';
  if (code === 'EPERM' || code === 'EACCES') return '没有权限，或上一级目录不允许创建子目录';
  if (code === 'ENOENT') return '上一级目录不存在';
  if (code === 'ENOTDIR') return '路径中间有个同名的文件，不是文件夹';
  if (code === 'EEXIST') return '同名文件已经存在';
  return err?.message || String(err);
}

/**
 * 建一个目录，失败时返回原因而不是抛。
 *
 * 这里堵了两个坑：
 *   1. work 是空串时**不能**用 path.resolve('') —— 那会变成「进程当前目录」，
 *      于是「没配路径」会悄悄变成「在启动目录里建一个 git 仓库」。
 *   2. Windows 上 mkdir 报的路径是**完整目标路径**（实测：建
 *      C:\Users\__x__\y 失败时报的就是整条 C:\Users\__x__\y，不是中间那一层），
 *      所以在 C:\Users 下建目录被拒时，报错看上去像是「要往 C:\Users\xxx 里写」。
 */
async function tryMkdir(dir) {
  const raw = String(dir ?? '').trim();
  if (!raw) return { ok: false, dir: '', reason: '没有配置路径' };
  const abs = path.resolve(raw);
  try {
    await fsp.mkdir(abs, { recursive: true });
    return { ok: true, dir: abs };
  } catch (e) {
    return { ok: false, dir: abs, reason: mkdirReason(e), code: e?.code || '' };
  }
}

/**
 * 挑一个能用的工作副本目录：配置的位置建不出来，就退回默认位置。
 *
 * 为什么必须回退：`.data\sync.json` 里的 work 是**绝对路径**，而它会跟着项目
 * 文件夹一起被拷来拷去（这个文件本身不进仓库，但整个目录复制会带上）。
 * 换一台机器、或者换成一个用户名的机器，那个路径就指向了别人的家目录 ——
 * Node 建不出来，报的却是光秃秃的
 *   EPERM: operation not permitted, mkdir 'C:\Users\someone'
 * 完全看不出「这是配置文件里一个属于上一台机器的路径」。
 */
async function pickWorkDir(work, fallbackWork) {
  const first = await tryMkdir(work);
  if (first.ok) return { ok: true, work: first.dir, usedFallback: false };

  if (fallbackWork) {
    const alt = await tryMkdir(fallbackWork);
    if (alt.ok && alt.dir !== first.dir) {
      return {
        ok: true, work: alt.dir, usedFallback: true,
        movedFrom: first.dir || '(空)', reason: first.reason,
      };
    }
  }

  return {
    ok: false, dir: first.dir, reason: first.reason,
    error: `工作副本目录建不起来：${first.dir || '(空)'}（${first.reason}）。`
      + '这个位置存在 .data\\sync.json 里，是从另一台机器带过来的绝对路径。'
      + '打开网页右上角的齿轮，把「git 工作副本位置」清空（改回默认位置）或填成本机可用的路径，再点下载。',
  };
}

/** 确保工作副本存在并配好（remote / 代理 / 行尾）—— 上传、下载时用 */
export async function ensureRepo({ work, remote, branch = 'main', proxy = '', projectName = '', fallbackWork = '' }) {
  const pick = await pickWorkDir(work, fallbackWork);
  if (!pick.ok) throw new Error(pick.error);

  const dir = pick.work;
  const created = !(await isRepo(dir));

  if (created) {
    // 这一步失败必须当场报出来。没有 git 时它只会静默失败，然后一路走到
    // 「首次拉取失败」，把「没装 git」说成网络问题 —— 那是把人往错的方向指。
    const init = await git(['init', '-b', branch], { cwd: dir });
    if (!init.ok) throw new Error(`初始化工作副本失败：${init.message}`);
    await git(['config', 'core.autocrlf', 'false'], { cwd: dir });
    await git(['config', 'core.quotepath', 'false'], { cwd: dir });
    if (remote) await git(['remote', 'add', 'origin', remote], { cwd: dir });
  }

  // remote 可能变了（用户在网页上填了另一个仓库）
  if (remote) {
    const cur = (await git(['remote', 'get-url', 'origin'], { cwd: dir })).stdout.trim();
    if (cur !== remote) {
      if (cur) await git(['remote', 'set-url', 'origin', remote], { cwd: dir });
      else await git(['remote', 'add', 'origin', remote], { cwd: dir });
    }
  }

  await applyProxyConfig(dir, proxy);

  return {
    created, work: dir,
    usedFallback: pick.usedFallback, movedFrom: pick.movedFrom, reason: pick.reason,
  };
}

/** 工作副本里有没有未提交的改动 */
export async function workIsDirty(work) {
  const r = await git(['status', '--porcelain'], { cwd: work });
  return { dirty: r.ok && r.stdout.trim().length > 0, detail: r.stdout.trim() };
}

/** 远端 main 的 sha（不下载对象，很快） */
export async function remoteHead({ work, branch = 'main', proxy = '', timeoutMs = 30000 }) {
  const r = await git(['ls-remote', 'origin', `refs/heads/${branch}`], { cwd: work, proxy, timeoutMs });
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
export async function buildWorkSet({ project, assets, mode = DEFAULT_MODE, projectName = '' }) {
  const ok = new Set(MODES[mode] ?? MODES[DEFAULT_MODE]);
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
 *
 * onProgress 报的是 { done, total, bytes, totalBytes }：文件数和字节数一起给，
 * 因为这两件事对不上的时候（比如一个 50 MB 的卡图）只有字节数看得出还在动。
 */
export async function syncToWork({ work, workSet, mode = DEFAULT_MODE, onProgress = () => {} }) {
  const copied = [];
  const removed = [];
  const report = throttled(onProgress);

  // 先量一遍总量：文件数 = 要清的 + 要写的；字节数只算要写的那些
  const existing = await walk(work);
  const items = await Promise.all([...workSet].map(async ([rel, src]) => {
    let size = 0;
    try { size = (await fsp.stat(src)).size; } catch { /* 读不到就不计入总量 */ }
    return { rel, src, size };
  }));
  const totalBytes = items.reduce((a, b) => a + b.size, 0);
  const total = existing.length + items.length;
  let done = 0;
  let bytes = 0;

  // 1) 先清理工作副本里多余的（素材与项目都算；.git* / 清单除外）
  for (const f of existing) {
    if (!f.rel.startsWith('.git/')
      && !['.gitattributes', '.gitignore', '.publish-manifest.json'].includes(f.rel)
      && !workSet.has(f.rel)) {
      await fsp.rm(f.abs, { force: true });
      removed.push(f.rel);
    }
    done++;
    report({ done, total, bytes, totalBytes, removed: removed.length, copied: copied.length });
  }

  // 2) 复制需要新增/更新的
  for (const it of items) {
    if (await copyIfChanged(it.src, path.join(work, it.rel))) copied.push(it.rel);
    done++;
    bytes += it.size;
    report({ done, total, bytes, totalBytes, removed: removed.length, copied: copied.length });
  }

  // 节流会把最后一次吞掉，收尾补一发，免得进度条永远差一格
  onProgress({ done, total, bytes, totalBytes, removed: removed.length, copied: copied.length });

  // 3) 清空目录 + 生成工作副本的 .gitignore
  await pruneEmpty(path.join(work, '素材'));

  const giPath = path.join(work, '.gitignore');
  // 这段文字要和 publish\sync-repo.mjs 里那一份**逐字一致**。两边都会生成
  // 工作副本的 .gitignore，措辞一旦不同，网页上传和命令行推送就会互相覆盖它，
  // 每次交替使用都抖出一个「.gitignore 变了」的无意义提交。
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
 * 把工作副本里的内容写回项目。
 *
 * 范围：「素材」下的一切（.shap 工程档除外）+ 数据文件 —— 图片也要，
 * 否则新拿到项目的人点「下载」只得到 武将.json，一张图都没有。
 * 项目代码（web/、server/、README 等）**不**写回：那会盖掉本地还没推上去的代码改动。
 * 只新增和更新，绝不删除 —— 远端少了个武将文件夹也不能让本地那份消失。
 */
export async function writeDataBack({ work, project, assets, onProgress = () => {} }) {
  const files = (await walk(work)).filter((f) =>
    !f.rel.startsWith('.git/') &&
    !RE_SHAP.test(f.rel) &&
    (f.rel.startsWith('素材/') || isDataFile(f.rel))
  );
  const updated = [];
  const added = [];
  const same = [];
  const report = throttled(onProgress);
  const total = files.length;

  // 用下标而不是自增计数器：下面有好几处 continue，计数容易和实际错开
  for (const [i, f] of files.entries()) {
    report({ done: i, total, updated: updated.length, added: added.length, current: f.rel });

    let dest;
    if (f.rel.startsWith('素材/')) dest = path.join(assets, f.rel.slice('素材/'.length));
    else if (f.rel.startsWith('.data/')) dest = path.join(project, f.rel);
    else continue;

    const existed = fs.existsSync(dest);
    let changed = true;
    if (existed) {
      // 先比大小再算哈希：写回范围现在含图片，几百 MB 全量哈希太慢
      try {
        const [a, b] = [await fsp.stat(dest), await fsp.stat(f.abs)];
        changed = a.size !== b.size || (await sha256(f.abs)) !== (await sha256(dest));
      } catch { changed = true; }
    }
    if (!changed) { same.push(f.rel); continue; }

    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.copyFile(f.abs, dest);
    (existed ? updated : added).push(f.rel);
  }

  onProgress({ done: total, total, updated: updated.length, added: added.length, current: '' });
  return { updated, added, same, total: files.length };
}

/** 本地数据与工作副本的差异（不联网，纯比内容） */
export async function diffLocalVsWork({ work, project, assets, onProgress = () => {} }) {
  // 范围和 writeDataBack 保持一致，否则「差在哪」会和实际会不会写回对不上
  const files = (await walk(work)).filter((f) =>
    !f.rel.startsWith('.git/') &&
    !RE_SHAP.test(f.rel) &&
    (f.rel.startsWith('素材/') || isDataFile(f.rel))
  );
  const diffs = [];
  const report = throttled(onProgress);
  const total = files.length;

  for (const [i, f] of files.entries()) {
    report({ done: i, total });
    let localSrc;
    if (f.rel.startsWith('素材/')) localSrc = path.join(assets, f.rel.slice('素材/'.length));
    else if (f.rel.startsWith('.data/')) localSrc = path.join(project, f.rel);
    else continue;
    if (!fs.existsSync(localSrc)) { diffs.push({ rel: f.rel, kind: '仅在副本' }); continue; }
    try {
      const [a, b] = [await fsp.stat(localSrc), await fsp.stat(f.abs)];
      if (a.size !== b.size || (await sha256(localSrc)) !== (await sha256(f.abs))) {
        diffs.push({ rel: f.rel, kind: '内容不同' });
      }
    } catch { diffs.push({ rel: f.rel, kind: '读取失败' }); }
  }

  onProgress({ done: total, total });
  return diffs;
}

/* ------------------------------------------------------------------ *
 * 进度
 *
 * 上传 / 下载要跑几十秒到几分钟，中间既有大量文件复制，也有说不准的联网等待。
 * 期间完全没有反馈的话，人只会以为卡死了，然后去点别的按钮 —— 那更糟。
 * 下面这套东西负责把「走到哪了」变成进度条和一个步骤清单。
 * ------------------------------------------------------------------ */

/**
 * 各阶段占进度条的份额（合计 100）。
 *
 * 不平均分：写文件那一段要复制一百多 MB，联网传输要等 github，这两段占大头；
 * 准备和收尾几乎瞬间完成，分多了反而是假的。数字不必精确到秒，
 * 进度条只要做到「看得出在往前走、不倒退」就够了。
 */
const PHASE_WEIGHT = {
  prepare: 6,     // 建 / 检查工作副本
  collect: 8,     // 扫出要同步的文件
  copy: 46,       // 按文件写进工作副本
  commit: 6,      // git add / commit
  merge: 10,      // 和远端分叉时先合并
  transfer: 16,   // push / pull（联网；阶段内部还有 git 自己的百分比）
  writeback: 6,   // 把远端的数据写回项目
  finish: 2,
};

/**
 * 进度累加器。
 *
 * 只保证两件事：**只增不减**、**没真正跑完就不显示 100%**。
 *
 * 为什么必须夹住：上传撞上分叉时会多走一轮 merge + transfer，权重加起来会超过
 * 100；不夹的话进度条能跑到 120% 再退回来，比没有进度条还糟。
 *
 * 回调签名是 onStep(text, info) —— 第一参数保持是字符串，和历史调用方兼容；
 * 新的东西（百分比 / 阶段 / 步骤清单）都挂在 info 上。
 */
export function makeProgress(onStep = () => {}) {
  const steps = [];
  let acc = 0;          // 已经走过的阶段权重之和
  let percent = 0;
  let phase = '';
  let detail = '';

  const emit = () => {
    try {
      onStep(steps[steps.length - 1] ?? '', { percent, phase, detail, steps: [...steps] });
    } catch { /* 回调出问题不该把同步本身带崩 */ }
  };

  /** 阶段内比例：没有量化数据时保持 0，进度条就停在阶段起点等文字更新 */
  const frac = (done, total) => (
    Number.isFinite(done) && Number.isFinite(total) && total > 0
      ? Math.max(0, Math.min(1, done / total))
      : 0
  );

  return {
    /** 记一步：text 进步骤清单，phase 决定进度条往前推到哪 */
    step(text, opt = {}) {
      if (opt.phase && opt.phase !== phase) {
        if (phase) acc += PHASE_WEIGHT[phase] ?? 0;
        phase = opt.phase;
      }
      const w = PHASE_WEIGHT[phase] ?? 0;
      percent = Math.max(percent, Math.min(95, Math.round(acc + w * frac(opt.done, opt.total))));
      detail = opt.detail ?? '';
      steps.push(text);
      emit();
    },

    /**
     * 阶段内推进。**不往清单里加行** —— 复制几百个文件如果一行一个，
     * 清单会被刷成一堵墙。这里只更新百分比和进度条旁边那行小字。
     */
    tick(opt = {}) {
      const w = PHASE_WEIGHT[phase] ?? 0;
      percent = Math.max(percent, Math.min(95, Math.round(acc + w * frac(opt.done, opt.total))));
      if (opt.detail !== undefined) detail = opt.detail;
      emit();
    },

    /** 收尾：这时候才可以显示 100% */
    done() {
      percent = 100;
      phase = 'finish';
      detail = '';
      emit();
    },

    get steps() { return steps; },
    get percent() { return percent; },
  };
}

/**
 * 按时间节流。
 *
 * 进度回调会构造整个步骤清单再交给 HTTP 那一层存下来，几百个文件挨个报一次
 * 纯属浪费 —— 而且前端最快 900 毫秒才轮询一次，报得再密也看不见。
 */
function throttled(fn, ms = 120) {
  let last = 0;
  return (arg) => {
    const now = Date.now();
    if (now - last < ms) return;
    last = now;
    fn(arg);
  };
}

/** 进度条旁边那行小字：文件数 + 字节数（字节数更能反映大卡图的搬运） */
export function fileDetail(p) {
  const bits = [`${p.done} / ${p.total} 个文件`];
  if (p.totalBytes > 0) bits.push(`${mb(p.bytes)} / ${mb(p.totalBytes)}`);
  return bits.join(' · ');
}

/** git 自己报的传输进度，例如「接收对象 45%（1234 / 2741）」 */
export function gitDetail(p) {
  return p.total > 0
    ? `${p.text} ${p.percent}%（${p.done} / ${p.total}）`
    : `${p.text} ${p.percent}%`;
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

/** push 被拒，是因为远端有本地还没有的提交（两边分叉了） */
export function isRejectedPush(msg) {
  return /non-fast-forward|fetch first|\[rejected\]|failed to push some refs|cannot lock ref/i.test(msg || '');
}

/** 合并时撞上了冲突 */
export function hasConflict(msg) {
  return /CONFLICT|Automatic merge failed|Merge conflict|needs merge/i.test(msg || '');
}

/**
 * 上传：项目 → 工作副本 → commit → push（远端领先时自动合并再推）
 * @returns 结果摘要，不抛异常（失败信息放在 error 里给网页显示）
 */
export async function pushAll({
  project, assets, work, mode = DEFAULT_MODE, remote, branch = 'main',
  proxy = '', projectName = '', message = '', fallbackWork = '', onStep = () => {},
}) {
  const P = makeProgress(onStep);
  const steps = P.steps;   // 返回给调用方的清单，和 P 内部是同一个数组

  P.step('准备工作副本…', { phase: 'prepare' });
  const prep = await ensureRepo({ work, remote, branch, proxy, projectName, fallbackWork });
  work = prep.work;   // 回退过的话，下面每一处 work 都跟着走
  if (prep.usedFallback) {
    P.step(`原定的工作副本位置用不了（${prep.reason}），改用 ${work}`, { phase: 'prepare' });
  }

  P.step('收集要同步的文件…', { phase: 'collect' });
  const workSet = await buildWorkSet({ project, assets, mode, projectName });

  P.step(`写入工作副本（共 ${workSet.size} 个文件）…`, { phase: 'copy' });
  const { copied, removed } = await syncToWork({
    work, workSet, mode,
    onProgress: (p) => P.tick({ done: p.done, total: p.total, detail: fileDetail(p) }),
  });

  P.step('提交…', { phase: 'commit' });
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

  // 合并前的 HEAD，用来列出「这次从远端带回来了哪些提交」
  const before = await localHead(work);

  P.step('推送到远端…', { phase: 'transfer' });
  // git 自己会报 Writing objects 的百分比，把它映射进 transfer 这一段
  const onTransfer = (g) => P.tick({ done: g.percent, total: 100, detail: gitDetail(g) });
  let p = await pushWithRetry(work, branch, proxy, 3,
    (i) => P.step(`第 ${i} 次没连上，${i * 2} 秒后重试…`, { phase: 'transfer' }),
    onTransfer);
  let merged = false;
  let incoming = [];
  let back = null;

  if (!p.ok && isRejectedPush(p.message)) {
    // 远端有别人推的内容，两边分叉了。直接推会被拒，硬推会顶掉对方的武将，
    // 所以先把对方那份合进来、再推上去 —— 这样双方的武将都留下。
    P.step('远端有别人的新内容，先合并…', { phase: 'merge' });
    const m = await gitStream(['pull', '--progress', '--no-rebase', '--no-edit', 'origin', branch], {
      cwd: work, proxy, timeoutMs: 300000, onProgress: onTransfer,
    });

    if (!m.ok) {
      // git 把 CONFLICT 打在 stdout、把 fetch 进度打在 stderr，
      // 只看其中一个就分不清「是冲突」还是「只是网络出错」
      const mergeOut = `${m.message}\n${m.stdout}`;
      if (hasConflict(mergeOut)) {
        // 别把工作副本丢在半合并状态：那样下次点任何按钮都是坏的。
        // abort 会退回合并前的提交，也就是本地那份改动，一点都不会丢。
        await git(['merge', '--abort'], { cwd: work });
        return {
          ok: false, conflict: true,
          error: '和远端撞车了：你们动了同一个文件的同一处，需要手工选一份。',
          hint: '你本地的改动都还在，没有被丢掉，可以再点上传重试。',
          detail: mergeOut.split('\n').filter((l) => /CONFLICT|error:/i.test(l)).slice(0, 8),
          steps, copied: copied.length, removed: removed.length, committed,
        };
      }
      return {
        ok: false,
        error: '合并失败：' + m.message,
        steps, copied: copied.length, removed: removed.length, committed,
      };
    }
    merged = true;

    const log = await git(['log', '--oneline', `${before}..HEAD`], { cwd: work });
    incoming = log.stdout.trim().split('\n').filter(Boolean).slice(0, 20);

    // 对方新建的武将是合并之后才出现在工作副本里的，写回项目才算真的「两边都有」
    P.step('把合并来的数据写回本地…', { phase: 'writeback' });
    back = await writeDataBack({
      work, project, assets,
      onProgress: (w) => P.tick({ done: w.done, total: w.total, detail: `${w.done} / ${w.total} 个数据文件` }),
    });

    P.step('再次推送到远端…', { phase: 'transfer' });
    p = await pushWithRetry(work, branch, proxy, 2, null, onTransfer);
  }

  if (!p.ok) {
    // 连接类报错不一定是真失败：核对远端 ref 再下结论
    const headNow = await localHead(work);
    const rh = await remoteHead({ work, branch, proxy });
    if (rh.ok && rh.sha === headNow) {
      P.step('推送时报了错，但远端已经是本地这个提交 —— 实际已成功', { phase: 'transfer' });
    } else {
      return {
        ok: false,
        error: '推送失败：' + p.message,
        hint: /找不到 git/.test(p.message)
          ? fetchHint(p.message)
          : (proxy
            ? '检查代理是否在运行；也可以确认仓库地址与权限。'
            : 'git 不读系统代理，可显式指定代理后重试。'),
        steps, copied: copied.length, removed: removed.length, committed,
      };
    }
  }

  const head = await localHead(work);
  const { ahead, behind } = await aheadBehind(work, branch);

  P.step('完成', { phase: 'finish' });
  P.done();
  return {
    ok: true, op: 'upload', steps, work,
    copied: copied.length, removed: removed.length, changes, committed,
    merged, incoming,
    added: back ? back.added.length : 0,
    updated: back ? back.updated.length : 0,
    localHead: head, remoteHead: head, ahead, behind,
  };
}

/**
 * 下载：远端 → 工作副本 → 数据写回项目
 */
export async function pullAll({
  project, assets, work, mode = DEFAULT_MODE, remote, branch = 'main',
  proxy = '', projectName = '', fallbackWork = '', onStep = () => {},
}) {
  const P = makeProgress(onStep);
  const steps = P.steps;

  P.step('准备工作副本…', { phase: 'prepare' });
  const prep = await ensureRepo({ work, remote, branch, proxy, projectName, fallbackWork });
  work = prep.work;   // 回退过的话，下面每一处 work 都跟着走
  if (prep.usedFallback) {
    P.step(`原定的工作副本位置用不了（${prep.reason}），改用 ${work}`, { phase: 'prepare' });
  }

  const dirty = await workIsDirty(work);
  if (dirty.dirty) {
    return {
      ok: false, work,
      error: '工作副本里有还没推上去的改动，先点「上传」把它们推上去，再下载。',
      detail: dirty.detail.split('\n').slice(0, 8),
      steps,
    };
  }

  const before = await localHead(work);
  const freshWork = !before;   // 全新工作副本：还没有任何本地提交

  P.step('从远端拉取…', { phase: 'transfer' });
  // 首次下载要拉一百多 MB，git 的 Receiving objects 百分比就是这里的进度
  const onTransfer = (g) => P.tick({ done: g.percent, total: 100, detail: gitDetail(g) });
  let r;
  if (freshWork) {
    // 空仓库直接 `git pull` 会因为"没有当前分支的上游"或不知道往哪合并而失败，
    // 所以先 fetch 再对齐到远端。这一步只动工作副本，不碰项目目录。
    P.step('工作副本是空的，正在取回远端内容…', { phase: 'transfer' });
    const f = await gitStream(['fetch', '--progress', 'origin', branch], {
      cwd: work, proxy, timeoutMs: 300000, onProgress: onTransfer,
    });
    if (!f.ok) {
      return {
        ok: false,
        error: '首次拉取失败：' + f.message,
        hint: fetchHint(f.message, proxy),
        steps,
      };
    }
    // fetch 只把对象取进 .git，铺成工作区里的文件是这一步做的事；
    // 一百多 MB 铺开也要一会儿，给一句话，否则这期间界面上什么都不动
    P.step('把取回的内容铺开…', { phase: 'transfer' });
    r = await git(['reset', '--hard', 'FETCH_HEAD'], { cwd: work });
  } else {
    // 用 merge 而不是 --ff-only：本地可能已经有自己提交好、但还没推上去的东西，
    // 这时 --ff-only 会直接失败，两边都同步不了，人就卡住了。
    // 双方改的不是同一个文件时 git 会自己合好；没有分叉时它就等同于快进。
    r = await gitStream(['pull', '--progress', '--no-rebase', '--no-edit', 'origin', branch], {
      cwd: work, proxy, timeoutMs: 300000, onProgress: onTransfer,
    });
  }
  if (!r.ok) {
    const mergeOut = `${r.message}\n${r.stdout}`;
    if (hasConflict(mergeOut)) {
      await git(['merge', '--abort'], { cwd: work });
      return {
        ok: false, conflict: true,
        error: '和远端撞车了：你们动了同一个文件的同一处，需要手工选一份。',
        hint: '你本地的改动都还在，没有被丢掉，可以再点下载重试。',
        detail: mergeOut.split('\n').filter((l) => /CONFLICT|error:/i.test(l)).slice(0, 8),
        steps,
      };
    }
    return {
      ok: false,
      error: '拉取失败：' + r.message,
      hint: fetchHint(r.message, proxy),
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

  P.step('把数据写回项目…', { phase: 'writeback' });
  const back = await writeDataBack({
    work, project, assets,
    onProgress: (w) => P.tick({ done: w.done, total: w.total, detail: `${w.done} / ${w.total} 个数据文件` }),
  });

  // 写回之后再比一遍本地和副本的差异。这一步要算哈希，文件多的时候能有几秒，
  // 期间进度条停着会像卡住 —— 所以它也报进度（比例落在 writeback 这一段里）
  const diffs = await diffLocalVsWork({
    work, project, assets,
    onProgress: (d) => P.tick({ done: d.done, total: d.total, detail: `核对 ${d.done} / ${d.total} 个文件` }),
  });

  // 合并之后本地可能反过来领先远端（自己那个提交还没推上去），
  // 网页得把这件事说出来，否则用户会以为已经同步完了
  const { ahead } = await aheadBehind(work, branch);

  P.step('完成', { phase: 'finish' });
  P.done();
  return {
    ok: true, op: 'download', steps, work, changed, commits, before, after,
    updated: back.updated, added: back.added, same: back.same,
    localDiff: diffs,
    ahead, needPush: ahead > 0,
  };
}

/**
 * 状态检查：远端有没有新东西 / 本地有没有没推的。
 * 用 `git ls-remote`（只取 ref，不下载对象），比 `git fetch` 快很多，适合轮询。
 */
export async function checkStatus({
  project, assets, work, mode = DEFAULT_MODE, remote, branch = 'main',
  proxy = '', projectName = '', onStep = () => {},
}) {
  const P = makeProgress(onStep);

  P.step('准备工作副本…', { phase: 'prepare' });
  // 只配 remote / 代理，不建目录、不动历史 —— 轮询很频繁，不能每次都造工作副本
  const { ready } = await ensureRemoteOnly({ work, remote, branch, proxy });

  if (!ready) {
    return {
      ok: true, reachable: true,
      initialized: false,
      localHead: '', remoteHead: '',
      hasRemoteUpdate: false, hasLocalChanges: false,
      localDiffCount: 0, localDiffSample: [],
      ahead: 0, behind: 0,
      work,
      hint: '还没建 git 工作副本。点「上传」或「下载」时会自动建（约 72 MB），之后这里就能显示同步状态了。',
    };
  }

  P.step('查询远端…', { phase: 'transfer' });
  const local = await localHead(work);
  // 只等 12 秒（默认 30 秒太久了）：这个接口一分钟轮询一次，这次没连上下次就补上了。
  // 与其让面板一直转，不如快点说「这次没连上」。真正值得重试的是 push。
  const rh = await remoteHead({ work, branch, proxy, timeoutMs: 12000 });

  if (!rh.ok) {
    return {
      ok: false, reachable: false, initialized: true, error: rh.message,
      localHead: local.slice(0, 7), remoteHead: '',
      hasRemoteUpdate: false, hasLocalChanges: false, ahead: 0, behind: 0,
    };
  }

  // 本地项目里有没有还没同步进工作副本的东西（只看数据文件，很快）
  P.step('核对本地数据…', { phase: 'writeback' });
  const diffs = await diffLocalVsWork({
    work, project, assets,
    onProgress: (d) => P.tick({ done: d.done, total: d.total, detail: `核对 ${d.done} / ${d.total} 个文件` }),
  });

  // 光比「两个 sha 相不相等」是不够的，得先分清是谁领先谁。
  //
  // 下载碰上分叉时会生成一个 merge commit，本地 HEAD 从此和远端 sha 永远不同。
  // 原来的写法（不相等就算「远端有新内容」）于是让面板一直挂着「远端有新内容」，
  // 其实远端那一笔早就合进来了 —— 再点多少次下载都不会消（实际踩到的就是这个）。
  //
  // 反过来的误导同样存在：本地有提交没推上去时两个 sha 也不相等，
  // 而面板会说「已是最新」。
  //
  // 所以这里问一句「远端那个提交，我这儿已经有了吗」，再数一下本地独有的提交。
  let remoteMerged = false;   // 远端当前这个提交，本地已经包含
  let aheadReal = 0;          // 本地有多少提交是远端没有的
  if (rh.sha && rh.sha !== local) {
    // 不是祖先、或者本地压根没有这个对象，都会返回非 0 —— 两种都算「远端确实有我没有的」
    const anc = await git(['merge-base', '--is-ancestor', rh.sha, 'HEAD'], { cwd: work });
    remoteMerged = anc.ok;
    if (remoteMerged) {
      // 用远端当前 sha 当基准，比读本地缓存的 refs/remotes/origin/* 准
      // —— 那个 ref 只在 fetch / pull 时才更新，轮询几十次它也不会动
      const cnt = await git(['rev-list', '--count', `${rh.sha}..HEAD`], { cwd: work });
      aheadReal = cnt.ok ? (Number(cnt.stdout.trim()) || 0) : 0;
    }
  }

  P.step('完成', { phase: 'finish' });
  P.done();

  return {
    ok: true, reachable: true, initialized: true,
    localHead: local.slice(0, 7),
    remoteHead: rh.sha.slice(0, 7),
    // 空仓库时本地 head 是空，此时远端有东西也算「有新内容」
    hasRemoteUpdate: !!rh.sha && rh.sha !== local && !remoteMerged,
    // 本地数据文件与工作副本不同 → 有没上传的改动
    hasLocalChanges: diffs.length > 0,
    localDiffCount: diffs.length,
    localDiffSample: diffs.slice(0, 8),
    ahead: aheadReal,
    // 只作形状保留：落后几个提交要沿远端历史数，本地没有那些对象就算不出来，
    // 所以这里只给「有没有落后」这个粗结论，精确值由 hasRemoteUpdate 表达
    behind: remoteMerged || !rh.sha ? 0 : 1,
    work,
  };
}
