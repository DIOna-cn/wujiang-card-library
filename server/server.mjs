#!/usr/bin/env node
/**
 * 武将牌库 · 本地服务
 *
 * 只监听 127.0.0.1，零依赖（仅用 Node 内置模块）。
 * 职责：
 *   1. 扫描 素材\ 目录，把每个武将文件夹里的 武将.json 汇总成卡组
 *   2. 提供素材图片（浏览器无法直接读本地文件）
 *   3. 把网页里的编辑写回 武将.json —— 这是「经由网页编辑描述文件」的落盘通道
 *
 * 用法：
 *   node server/server.mjs [--port 3456] [--assets "E:\Deepseek\素材"]
 */

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import url from 'node:url';
import { fileURLToPath } from 'node:url';
import * as syncCore from './sync-core.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const PORT = Number(argOf('--port', process.env.PORT ?? 3456));
const HOST = '127.0.0.1';
const WEB = path.join(ROOT, 'web');
const DATA = path.join(ROOT, '.data');
const RECYCLE = path.join(DATA, '回收站');
const DATA_FILE = '武将.json';
const PROJECT_NAME = path.basename(ROOT);

/**
 * 找素材目录。
 *
 * 默认约定是「武将牌库\ 和 素材\ 平级」，但别人拿到这份东西时未必摆成那样
 * （可能把 素材 放进项目里、也可能整个嵌在更深的目录），所以多试几个位置，
 * 都找不到就明确报错并画出示意的目录结构——比让人对着「0 位武将」发呆好。
 */
function resolveAssets() {
  const explicit = argOf('--assets', process.env.ASSETS ?? '');
  if (explicit) {
    const abs = path.resolve(explicit);
    if (!fs.existsSync(abs)) {
      console.error(`\n  ✗ --assets 指定的目录不存在：${abs}\n`);
      process.exit(1);
    }
    return abs;
  }

  const candidates = [
    path.join(ROOT, '..', '素材'),   // 约定：与项目平级（默认）
    path.join(ROOT, '素材'),         // 放在项目里面
    path.join(ROOT, '..', '..', '素材'),
    path.join(ROOT, '..', '..', '..', '素材'),
  ];
  for (const c of candidates) {
    const abs = path.resolve(c);
    // 光有目录还不够，得确实像个素材目录（至少有一个武将文件夹）
    try {
      if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) return abs;
    } catch { /* 没权限就当没有 */ }
  }

  // 都没找到：报清楚，别静默跑成一个空站
  console.error('');
  console.error('  ✗ 找不到「素材」文件夹。');
  console.error('');
  console.error('    期望的目录结构（素材 与 武将牌库 平级）：');
  console.error('      某个文件夹\\');
  console.error('        ├─ 武将牌库\\        ← 本项目');
  console.error('        └─ 素材\\            ← 武将卡图与 武将.json');
  console.error('');
  console.error('    你现在的结构是：');
  console.error(`      本项目      ${ROOT}`);
  console.error(`      项目上一级  ${path.resolve(ROOT, '..')}`);
  console.error('        里面的文件夹：' + (() => {
    try {
      return fs.readdirSync(path.resolve(ROOT, '..'), { withFileTypes: true })
        .filter((e) => e.isDirectory()).map((e) => e.name).slice(0, 20).join('、');
    } catch { return '（读不到）'; }
  })());
  console.error('');
  console.error('    两种解决办法：');
  console.error('      1) 把「素材」文件夹放到「武将牌库」的同一级（推荐）');
  console.error('      2) 或者启动时指明位置：');
  console.error('         node server\\server.mjs --assets "D:\\某处\\素材"');
  console.error('');
  process.exit(1);
}

const ASSETS = resolveAssets();

fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(RECYCLE, { recursive: true });

/* ------------------------------------------------------------------ *
 * 同步（网页上的「上传 / 下载 / 轮询」）
 *
 * 网页没法直接跑 git，所以这些动作都由服务端代做，前端只负责点按钮、看进度。
 *
 * 状态是内存里的一份对象，前端轮询 GET /api/sync/status 读它 ——
 * 比在 HTTP 连接上挂 SSE/长轮询简单得多，也不会因为一次操作要几十秒而超时。
 * ------------------------------------------------------------------ */

const SYNC_CONFIG_FILE = path.join(DATA, 'sync.json');

/** 默认仓库地址。对应 DIOna-cn/wujiang-card-library。 */
const DEFAULT_REMOTE = process.env.WUJIANG_REMOTE || 'https://github.com/DIOna-cn/wujiang-card-library.git';

const syncConfig = {
  remote: DEFAULT_REMOTE,
  branch: 'main',
  mode: 'data+art',
  work: syncCore.defaultWorkDir(ROOT, PROJECT_NAME),
  proxy: '',               // 启动时自动从系统代理读；读不到就空着
  autoCheckMs: 60000,      // 网页多久轮询一次
  ...(await readJson(SYNC_CONFIG_FILE).catch(() => ({}))),
};

const syncState = {
  lastCheckAt: 0,
  busy: false,
  op: '',                  // '' | 'check' | 'upload' | 'download'
  step: '',
  steps: [],
  error: '',
  hint: '',
  result: null,
  lastStatus: null,        // checkStatus 的结果
};

async function saveSyncConfig() {
  await writeFileAtomic(SYNC_CONFIG_FILE, JSON.stringify(syncConfig, null, 2) + '\n');
}

// 启动时把系统代理读进配置（git 不读系统代理，必须显式传给 git）
(async () => {
  try {
    const sys = await syncCore.readSystemProxy();
    if (sys) {
      if (syncConfig.proxy !== sys) {
        syncConfig.proxy = sys;
        await saveSyncConfig();
      }
      console.log(`  代理       ${sys}（从 Windows 系统代理读到）`);
    } else {
      console.log('  代理       未检测到系统代理（git 需要走代理时可在页面上填）');
    }
  } catch { /* 忽略 */ }
})();

/** 从 remote 地址解析出 owner/repo@branch（页面上要显示"在跟哪个仓库同步"） */
function parseRemoteInfo(remote, branch) {
  return syncCore.parseRemote(remote, branch);
}

/** 串行队列：一次只跑一个同步任务，避免两个按钮同时点把工作副本搅乱 */
let syncChain = Promise.resolve();
function queueSync(op) {
  const run = async () => {
    syncState.busy = true;
    syncState.op = op;
    syncState.steps = [];
    syncState.step = '';
    syncState.error = '';
    syncState.hint = '';
    syncState.result = null;
    const onStep = (s) => { syncState.step = s; syncState.steps.push(s); };

    const common = {
      project: ROOT,
      assets: ASSETS,
      work: syncConfig.work,
      mode: syncConfig.mode,
      remote: syncConfig.remote,
      branch: syncConfig.branch,
      proxy: syncConfig.proxy,
      projectName: PROJECT_NAME,
      onStep,
    };

    try {
      if (op === 'check') {
        syncState.lastStatus = await syncCore.checkStatus(common);
        syncState.lastCheckAt = Date.now();
        if (!syncState.lastStatus.reachable) {
          syncState.error = '连不上远端：' + (syncState.lastStatus.error || '');
          syncState.hint = syncConfig.proxy
            ? '确认代理软件在运行，且端口与系统代理一致。'
            : 'git 不读 Windows 系统代理，可在下面填代理地址。';
        }
      } else if (op === 'upload') {
        const r = await syncCore.pushAll(common);
        syncState.result = r;
        if (!r.ok) { syncState.error = r.error; syncState.hint = r.hint || ''; }
        // 上传完顺手刷一次状态
        syncState.lastStatus = await syncCore.checkStatus(common);
        syncState.lastCheckAt = Date.now();
      } else if (op === 'download') {
        const r = await syncCore.pullAll(common);
        syncState.result = r;
        if (!r.ok) { syncState.error = r.error; syncState.hint = r.hint || ''; }
        syncState.lastStatus = await syncCore.checkStatus(common);
        syncState.lastCheckAt = Date.now();
      }
    } catch (err) {
      syncState.error = err.message;
    } finally {
      syncState.busy = false;
      syncState.op = '';
      syncState.step = '';
    }
  };
  syncChain = syncChain.then(run, run);
  return syncChain;
}

/* ------------------------------------------------------------------ *
 * 工具
 * ------------------------------------------------------------------ */

/** 隐藏字符（零宽空格等）在各武将目录里确实存在，统一清掉再比较 */
const stripHidden = (s) => String(s).replace(/[\u200b-\u200f\ufeff\u2060]/g, '');

/**
 * 把任意输入解析成一个位于 ASSETS 内的绝对路径；越界返回 null。
 *
 * 要注意素材里的一个坑：`立绘.png`、`立绘.jpg` 这类文件名里**真的含零宽空格**
 * （U+200B），数据里存的是清洗后的名字，所以不能直接把清洗后的名字拼成路径
 * ——那样文件根本不存在。做法是逐级进目录、按清洗后的名字匹配真实条目名。
 */
function resolveInsideAssets(rel) {
  if (typeof rel !== 'string' || !rel) return null;
  let decoded;
  try { decoded = decodeURIComponent(rel); } catch { return null; }

  // 逐段规范：正常段入栈，「..」弹栈；栈空时遇到「..」说明越界
  const rawParts = stripHidden(decoded).replace(/\\/g, '/').split('/');
  const parts = [];
  for (const p of rawParts) {
    if (!p || p === '.') continue;
    if (p.includes('\0')) return null;
    if (p === '..') {
      if (!parts.length) return null;
      parts.pop();
      continue;
    }
    parts.push(p);
  }
  if (!parts.length) return null;

  let cur = ASSETS;
  for (const part of parts) {
    let entries;
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { return null; }
    const hit = entries.find((e) => stripHidden(e.name) === part);
    if (!hit) return null;
    cur = path.join(cur, hit.name);
  }
  const relToAssets = path.relative(ASSETS, cur);
  if (relToAssets.startsWith('..') || path.isAbsolute(relToAssets)) return null;
  return cur;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.flac': 'audio/flac',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp']);
const AUDIO_EXT = new Set(['.mp3', '.wav', '.ogg', '.m4a', '.flac']);

function mimeOf(p) {
  return MIME[path.extname(p).toLowerCase()] ?? 'application/octet-stream';
}

function send(res, status, body, headers = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': buf.length,
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(buf);
}

function sendJson(res, status, obj) {
  send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8' });
}

async function readBody(req, limitBytes = 80 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) throw new Error('请求体过大');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  return JSON.parse(raw);
}

/** 原子写：先写 .tmp 再 rename，避免写一半断电留下坏文件 */
async function writeFileAtomic(file, content) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fsp.writeFile(tmp, content, 'utf8');
  await fsp.rename(tmp, file);
}

/**
 * 读 JSON，顺手剥掉 UTF-8 BOM。
 * 这件事必须做：Windows 上用 `Set-Content -Encoding UTF8`、记事本另存
 * 都会在文件头写入 EF BB BF，而 JSON.parse 遇到 BOM 会直接抛
 * "Unexpected token '\uFEFF'"，导致整个武将读不出来。
 */
async function readJson(file) {
  const raw = await fsp.readFile(file, 'utf8');
  return JSON.parse(raw.replace(/^\uFEFF/, ''));
}

/** 读目录，但保留原始文件名（隐藏字符）与清洗后的名字 */
async function readDirEntries(dir) {
  const out = [];
  for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    let size = 0;
    try { if (e.isFile()) size = (await fsp.stat(abs)).size; } catch { /* ignore */ }
    out.push({ raw: e.name, clean: stripHidden(e.name), abs, isDir: e.isDirectory(), size });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 扫描武将
 * ------------------------------------------------------------------ */

/** 一个武将文件夹 → 归一化后的数据对象 */
async function loadCharacter(dirAbs, dirRel, fallbackKey) {
  const files = await readDirEntries(dirAbs);
  const jsonFile = files.find((f) => f.clean === DATA_FILE);

  let data = null;
  let parseError = '';
  if (jsonFile) {
    try {
      const raw = await fsp.readFile(jsonFile.abs, 'utf8');
      data = JSON.parse(raw.replace(/^\uFEFF/, ''));
    } catch (err) {
      parseError = err.message;
    }
  }

  if (!data) {
    // 没有 武将.json 的文件夹也展示出来（标为「未建描述」），方便在网页里补
    data = {
      schema: 1,
      name: fallbackKey,
      title: '',
      kingdom: '',
      hp: 3,
      maxHp: 3,
      shield: 0,
      legendId: '',
      tags: [],
      note: '',
      cards: [],
      extras: [],
    };
  }

  const images = files.filter((f) => !f.isDir && IMAGE_EXT.has(path.extname(f.clean).toLowerCase()));
  const audios = files.filter((f) => !f.isDir && AUDIO_EXT.has(path.extname(f.clean).toLowerCase()));

  const char = { ...data };
  char.schema = char.schema ?? 1;
  char.id = fallbackKey;
  char.dir = dirRel.replace(/\\/g, '/');
  char.hasJson = !!jsonFile;
  char.parseError = parseError;
  char.mtime = jsonFile ? (await fsp.stat(jsonFile.abs)).mtimeMs : 0;

  // 卡片主图：确认文件真的存在，不存在就退回带技能卡图 / 留空（网页显示占位符）
  char.cards = Array.isArray(char.cards) ? char.cards : [];
  const byClean = new Map(files.map((f) => [f.clean, f]));
  for (const card of char.cards) {
    card.image = card.image ?? '';
    card.cardImage = card.cardImage ?? '';
    card.skills = Array.isArray(card.skills) ? card.skills : [];
    card.derived = Array.isArray(card.derived) ? card.derived : [];

    // 「立绘.png」这类真实文件名里含零宽空格，数据里存的是清洗名。
    // 这里把显示用的字段换回真实文件名，前端才能拼出能取到图的 URL。
    const imgEntry = byClean.get(stripHidden(card.image));
    if (imgEntry) card.image = imgEntry.raw;
    const cardEntry = byClean.get(stripHidden(card.cardImage));
    if (cardEntry) card.cardImage = cardEntry.raw;

    card.imageExists = !!imgEntry;
    card.cardImageExists = !!cardEntry;
    // 主图缺失时，先用带技能卡图顶上，仍然缺就是占位符
    card.displayImage = card.imageExists ? card.image : (card.cardImageExists ? card.cardImage : '');
    card.displayKind = card.imageExists ? 'plain' : (card.cardImageExists ? 'full' : 'placeholder');
  }

  // 附加内容（神宝等）里的图同样要确认存在并换回真实名
  for (const extra of Array.isArray(char.extras) ? char.extras : []) {
    for (const it of Array.isArray(extra.items) ? extra.items : []) {
      const base = it.image ? path.basename(String(it.image)) : '';
      const iconEntry = byClean.get(stripHidden(it.icon));
      if (iconEntry) it.icon = iconEntry.raw;

      if (!base) { it.image = ''; continue; }
      // 神宝卡图在 ../宝物卡图/ 下
      const direct = resolveInsideAssets(`${dirRel}/${base}`);
      const treasure = resolveInsideAssets(`宝物卡图/${base}`);
      if (direct && fs.existsSync(direct)) it.image = base;
      else if (treasure && fs.existsSync(treasure)) it.image = path.posix.join('..', '宝物卡图', path.basename(treasure));
      else it.image = '';
    }
  }

  // 素材库（图片 + 语音）
  char.gallery = [
    ...images.map((f) => {
      const isCard = /^新UI\./.test(f.clean) || /-原画\./.test(f.clean);
      const isPortrait = /^立绘/.test(f.clean);
      return {
        file: f.raw,
        kind: isCard ? 'card' : (isPortrait ? 'portrait' : 'icon'),
        size: f.size,
      };
    }),
    ...audios.map((f) => ({ file: f.raw, kind: 'audio', size: f.size })),
  ];

  // 语音分组（按去掉序号后的名字）
  const soundMap = new Map();
  for (const f of audios) {
    const base = f.clean.replace(/\.[^.]+$/, '')
      .replace(/[\s_]*\(\d+\)$/, '')
      .replace(/[\s_]*(cn_)?\d+$/i, '')
      .replace(/[\s_]*\(\d+\)$/, '')
      .trim();
    if (!soundMap.has(base)) soundMap.set(base, []);
    soundMap.get(base).push(f.raw);
  }
  char.sounds = [...soundMap.entries()].map(([name, list]) => ({ name, files: list }));

  return char;
}

/** 列出素材目录下所有武将文件夹（下划线开头的归类目录只取一层子目录） */
async function listCharacterDirs() {
  const out = [];
  if (!fs.existsSync(ASSETS)) return out;
  const entries = await readDirEntries(ASSETS);
  for (const e of entries) {
    if (!e.isDir) continue;
    if (e.clean === '原画' || e.clean === '宝物卡图' || e.clean === '_待整理') continue;
    if (/^_/.test(e.clean)) {
      for (const sub of await readDirEntries(e.abs)) {
        if (!sub.isDir) continue;
        out.push({ key: `${e.clean}/${sub.clean}`, abs: sub.abs, rel: path.join(e.clean, sub.clean) });
      }
      continue;
    }
    out.push({ key: e.clean, abs: e.abs, rel: e.clean });
  }
  return out;
}

async function loadAll({ withGallery = true } = {}) {
  const dirs = await listCharacterDirs();
  const chars = [];
  for (const d of dirs) {
    try {
      const c = await loadCharacter(d.abs, d.rel, d.key);
      if (!withGallery) {
        c.gallery = [];
        c.sounds = [];
      }
      chars.push(c);
    } catch (err) {
      chars.push({ id: d.key, dir: d.rel.replace(/\\/g, '/'), name: d.key, error: err.message, cards: [], gallery: [], sounds: [] });
    }
  }
  return chars;
}

/* ------------------------------------------------------------------ *
 * 原作 与 标签
 * ------------------------------------------------------------------ */

const TAGS_FILE = path.join(DATA, 'tags.json');

/**
 * 已知原作。一个武将只属于一个原作，所以它单独用 origin 字段存，
 * 不跟特性标签混在一起。历史数据里可能还把原作写在 tags 里，
 * 读写时都用这张表挑出来。
 */
const ORIGINS = ['明日方舟', '东方Project', '原神', '崩坏星穹铁道', '三国杀', '原创'];

/** 把标签数组拆成 { origin, tags } */
function splitOriginFromTags(list, fallbackOrigin = '') {
  const origins = [];
  const tags = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const t = String(raw ?? '').trim();
    if (!t) continue;
    if (ORIGINS.includes(t)) { if (!origins.includes(t)) origins.push(t); }
    else if (!tags.includes(t)) tags.push(t);
  }
  return { origin: fallbackOrigin || origins[0] || '', tags };
}

/** 标签表：分别记 特性标签 与 原作（原作也允许手填不在表里的） */
async function loadTagFile() {
  try {
    const j = await readJson(TAGS_FILE);
    if (Array.isArray(j)) return { tags: j, origins: [] };
    return {
      tags: Array.isArray(j.tags) ? j.tags : [],
      origins: Array.isArray(j.origins) ? j.origins : [],
    };
  } catch { /* 首次运行还没有 */ }
  return { tags: [], origins: [] };
}

async function saveTagFile(next) {
  await writeFileAtomic(TAGS_FILE, JSON.stringify({
    tags: [...new Set((next.tags ?? []).map((t) => String(t).trim()).filter(Boolean))],
    origins: [...new Set((next.origins ?? []).map((t) => String(t).trim()).filter(Boolean))],
  }, null, 2) + '\n');
}

/** 站点配置（主标题等） */
const CONFIG_FILE = path.join(DATA, 'config.json');

async function loadConfig() {
  try {
    return await readJson(CONFIG_FILE);
  } catch {
    return { siteTitle: '武将牌库', subtitle: '素材文件夹中的武将一览' };
  }
}

async function saveConfig(cfg) {
  await writeFileAtomic(CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n');
}

/* ------------------------------------------------------------------ *
 * 路由
 * ------------------------------------------------------------------ */

/**
 * 归一化从网页提交过来的武将数据：只保留已知字段 + 原样保留未知字段。
 *
 * 图片字段一律存「清洗后的名字」（去掉零宽空格等）：数据层保持干净，
 * 读取时再由 loadCharacter 换回磁盘上的真实文件名。
 */
function normalizeIncoming(body, existing = {}) {
  const str = (v, d = '') => (typeof v === 'string' ? v : (v == null ? d : String(v)));
  const cleanName = (v) => stripHidden(str(v)).trim();
  const num = (v, d = 0) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : d;
  };
  const arr = (v) => (Array.isArray(v) ? v : []);

  const cards = arr(body.cards).map((c) => {
    const skills = arr(c.skills)
      .map((s) => {
        const out = { name: str(s?.name).trim(), desc: str(s?.desc) };
        if (s?.derived) out.derived = true;
        if (s?.fixNote) out.fixNote = str(s.fixNote);
        return out;
      })
      .filter((s) => s.name || s.desc);

    const card = {
      name: str(c?.name),
      image: cleanName(c?.image),
      cardImage: cleanName(c?.cardImage),
      legendId: str(c?.legendId),
      skills,
      derived: arr(c?.derived).map((x) => str(x)),
    };
    if (c?.note) card.note = str(c.note);
    return card;
  });

  const extras = arr(body.extras).map((g) => ({
    title: str(g?.title),
    kind: str(g?.kind, 'treasure'),
    note: str(g?.note),
    items: arr(g?.items).map((it) => ({
      name: str(it?.name),
      upgradedName: str(it?.upgradedName),
      image: cleanName(it?.image),
      icon: cleanName(it?.icon),
      suit: str(it?.suit),
      desc: str(it?.desc),
    })),
  }));

  return {
    ...existing,                       // 保留 source 等未知字段
    schema: 1,
    name: str(body.name, existing.name ?? ''),
    title: str(body.title, existing.title ?? ''),
    kingdom: str(body.kingdom, existing.kingdom ?? ''),
    hp: num(body.hp, existing.hp ?? 3),
    maxHp: num(body.maxHp, existing.maxHp ?? 3),
    shield: num(body.shield, existing.shield ?? 0),
    gender: str(body.gender, existing.gender ?? ''),
    quality: str(body.quality, existing.quality ?? 'epic'),
    legendId: str(body.legendId, existing.legendId ?? ''),
    quote: str(body.quote, existing.quote ?? ''),
    copyright: str(body.copyright, existing.copyright ?? ''),
    isLord: !!body.isLord,
    // 原作单值；若网页仍把原作塞在 tags 里（旧数据），这里自动挑出来分开存
    ...(() => {
      const split = splitOriginFromTags(body.tags, str(body.origin, existing.origin ?? '').trim());
      return { origin: split.origin, tags: split.tags };
    })(),
    note: str(body.note, existing.note ?? ''),
    cards,
    extras,
    // id/dir 由服务端按文件夹定位，不接受网页改写
    id: existing.id,
    dir: existing.dir,
    updatedAt: new Date().toISOString(),
  };
}

/** 找到某个武将的目录与 json 路径；越界或不存在返回 null */
function locateCharacter(dirRel) {
  const abs = resolveInsideAssets(dirRel);
  if (!abs) return null;
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) return null;
  return { abs, json: path.join(abs, DATA_FILE) };
}

async function handleApi(req, res, pathname, query) {
  const method = req.method.toUpperCase();

  /* ---------- 站点配置 ---------- */
  if (pathname === '/api/config') {
    if (method === 'GET') return sendJson(res, 200, await loadConfig());
    if (method === 'PUT') {
      const body = await readBody(req);
      const cfg = { ...(await loadConfig()), ...body };
      await saveConfig(cfg);
      return sendJson(res, 200, cfg);
    }
  }

  /* ---------- 武将列表 ---------- */
  if (pathname === '/api/characters' && method === 'GET') {
    const [chars, tagFile, config] = await Promise.all([
      loadAll({ withGallery: false }),
      loadTagFile(),
      loadConfig(),
    ]);

    // 侧栏要用的集合：把「标签表里维护的」和「武将数据里实际用到的」合并。
    // 原作固定排在最前，且按 ORIGINS 的顺序，方便阅读。
    const usedTags = new Set(tagFile.tags);
    const usedOrigins = new Set(tagFile.origins);
    for (const c of chars) {
      for (const t of (c.tags ?? [])) usedTags.add(t);
      if (c.origin) usedOrigins.add(c.origin);
    }
    const originOrder = (o) => {
      const i = ORIGINS.indexOf(o);
      return i < 0 ? ORIGINS.length : i;
    };

    return sendJson(res, 200, {
      assets: ASSETS,
      config,
      tags: [...usedTags],
      origins: [...usedOrigins].sort((a, b) => originOrder(a) - originOrder(b) || a.localeCompare(b, 'zh')),
      originPresets: ORIGINS,
      directoryTags: tagFile.tags,
      directoryOrigins: tagFile.origins,
      characters: chars,
      // 顺带把同步状态带上，省得前端为了画那几个按钮再多发一次请求
      sync: {
        busy: syncState.busy,
        op: syncState.op,
        step: syncState.step,
        error: syncState.error,
        hint: syncState.hint,
        lastCheckAt: syncState.lastCheckAt,
        status: syncState.lastStatus,
        result: syncState.result,
        config: syncConfig,
      },
    });
  }

  /* ---------- 单个武将 ---------- */
  const mChar = pathname.match(/^\/api\/characters\/(.+)$/);
  if (mChar) {
    const dirRel = decodeURIComponent(mChar[1]);
    const loc = locateCharacter(dirRel);
    if (!loc) return sendJson(res, 404, { error: `找不到武将目录：${dirRel}` });

    if (method === 'GET') {
      const c = await loadCharacter(loc.abs, dirRel, dirRel);
      return sendJson(res, 200, c);
    }

    if (method === 'PUT') {
      const body = await readBody(req);
      let existing = {};
      if (fs.existsSync(loc.json)) {
        try { existing = await readJson(loc.json); } catch { /* 坏文件就整体覆盖 */ }
      }
      const next = normalizeIncoming(body, { ...existing, id: dirRel, dir: dirRel.replace(/\\/g, '/') });
      await writeFileAtomic(loc.json, JSON.stringify(next, null, 2) + '\n');
      const saved = await loadCharacter(loc.abs, dirRel, dirRel);
      return sendJson(res, 200, { ok: true, character: saved });
    }

    if (method === 'DELETE') {
      if (!fs.existsSync(loc.abs)) return sendJson(res, 404, { error: '目录不存在' });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const target = path.join(RECYCLE, `${path.basename(loc.abs)}__${stamp}`);
      await fsp.rename(loc.abs, target);
      return sendJson(res, 200, { ok: true, movedTo: target });
    }
  }

  /* ---------- 新建武将 ---------- */
  if (pathname === '/api/characters' && method === 'POST') {
    const body = await readBody(req);
    const name = String(body.name ?? '').trim();
    if (!name) return sendJson(res, 400, { error: '武将名不能为空' });

    // 目录名：用户可指定，否则用武将名；重名自动加后缀
    let base = String(body.dir ?? name).trim().replace(/[\\/:*?"<>|]/g, '_') || name;
    if (/^_/.test(base)) base = base.replace(/^_+/, '');
    let dirName = base;
    let n = 1;
    while (fs.existsSync(path.join(ASSETS, dirName))) dirName = `${base}(${++n})`;
    if (dirName !== base && n === 2) dirName = `${base}(2)`;

    const group = String(body.group ?? '').trim();   // 例如 _待实现
    const parent = group ? path.join(ASSETS, group.replace(/[\\/:*?"<>|]/g, '_')) : ASSETS;
    await fsp.mkdir(path.join(parent, dirName), { recursive: true });

    const dirRel = group ? `${path.basename(parent)}/${dirName}` : dirName;
    const char = normalizeIncoming({
      name,
      title: body.title ?? '',
      kingdom: body.kingdom ?? '',
      hp: body.hp ?? 3,
      maxHp: body.maxHp ?? body.hp ?? 3,
      shield: body.shield ?? 0,
      legendId: body.legendId ?? '',
      origin: body.origin ?? '',        // 忘了传这个，新建时填的原作会被丢掉
      tags: body.tags ?? [],
      note: body.note ?? '',
      cards: [{ name: '', image: '', cardImage: '', legendId: body.legendId ?? '', skills: [], derived: [] }],
      extras: [],
    }, { id: dirRel, dir: dirRel, source: { createdAt: new Date().toISOString(), createdBy: 'web' } });

    await writeFileAtomic(path.join(parent, dirName, DATA_FILE), JSON.stringify(char, null, 2) + '\n');
    const saved = await loadCharacter(path.join(parent, dirName), dirRel, dirRel);
    return sendJson(res, 201, { ok: true, character: saved });
  }

  /* ---------- 远端同步（上传 / 下载 / 轮询） ---------- */
  if (pathname === '/api/sync/status' && method === 'GET') {
    return sendJson(res, 200, {
      config: syncConfig,
      busy: syncState.busy,
      op: syncState.op,
      step: syncState.step,
      steps: syncState.steps,
      error: syncState.error,
      hint: syncState.hint,
      lastCheckAt: syncState.lastCheckAt,
      status: syncState.lastStatus,
      result: syncState.result,
      remote: parseRemoteInfo(syncConfig.remote, syncConfig.branch),
    });
  }

  if (pathname === '/api/sync/config' && method === 'PUT') {
    const body = await readBody(req);
    for (const k of ['remote', 'branch', 'mode', 'work', 'proxy']) {
      if (typeof body[k] === 'string') syncConfig[k] = body[k].trim();
    }
    if (Number.isFinite(Number(body.autoCheckMs)) && Number(body.autoCheckMs) >= 10000) {
      syncConfig.autoCheckMs = Number(body.autoCheckMs);
    }
    await saveSyncConfig();
    return sendJson(res, 200, { ok: true, config: syncConfig });
  }

  const mSync = pathname.match(/^\/api\/sync\/(check|upload|download)$/);
  if (mSync && method === 'POST') {
    if (syncState.busy) {
      return sendJson(res, 409, { error: '已经有一个同步任务在跑了，稍等一下。', busy: true });
    }
    const op = mSync[1];
    // 不 await：任务在后台跑，前端轮询 /api/sync/status 看进度
    queueSync(op);
    return sendJson(res, 202, { ok: true, started: op });
  }

  /* ---------- 原作 与 标签表 ---------- */
  if (pathname === '/api/tags') {
    if (method === 'GET') {
      const f = await loadTagFile();
      return sendJson(res, 200, { tags: f.tags, origins: f.origins, originPresets: ORIGINS });
    }
    if (method === 'PUT') {
      const body = await readBody(req);
      const next = {
        tags: body.tags ?? [],
        origins: body.origins ?? [],
      };
      await saveTagFile(next);
      const f = await loadTagFile();
      return sendJson(res, 200, { tags: f.tags, origins: f.origins });
    }
  }

  /* ---------- 上传图片到某个武将目录 ---------- */
  const mUpload = pathname.match(/^\/api\/upload\/(.+)$/);
  if (mUpload && method === 'POST') {
    const dirRel = decodeURIComponent(mUpload[1]);
    const loc = locateCharacter(dirRel);
    if (!loc) return sendJson(res, 404, { error: '武将目录不存在' });

    const body = await readBody(req);
    const { filename, dataUrl } = body;
    const m = /^data:([^;]+);base64,(.+)$/s.exec(String(dataUrl ?? ''));
    if (!m) return sendJson(res, 400, { error: '需要 dataUrl 形式的图片数据' });

    let ext = (MIME[`.${String(filename).split('.').pop().toLowerCase()}`] ? `.${String(filename).split('.').pop().toLowerCase()}` : '') ||
      (m[1].includes('png') ? '.png' : m[1].includes('webp') ? '.webp' : m[1].includes('gif') ? '.gif' : '.jpg');

    let saveName = String(filename ?? `上传${Date.now()}${ext}`).replace(/[\\/:*?"<>|]/g, '_');
    if (!path.extname(saveName)) saveName += ext;
    let target = path.join(loc.abs, saveName);
    let i = 1;
    while (fs.existsSync(target)) {
      const e = path.extname(saveName);
      target = path.join(loc.abs, `${path.basename(saveName, e)}(${++i})${e}`);
    }
    const buf = Buffer.from(m[2], 'base64');
    await fsp.writeFile(target, buf);
    return sendJson(res, 201, { ok: true, file: path.basename(target), size: buf.length });
  }

  /* ---------- 素材图片 / 语音 ---------- */
  const mImage = pathname.match(/^\/api\/(image|file)\/(.+)$/);
  if (mImage && method === 'GET') {
    const abs = resolveInsideAssets(decodeURIComponent(mImage[2]));
    if (!abs) return send(res, 400, '非法路径');
    let st;
    try { st = await fsp.stat(abs); } catch { return send(res, 404, '文件不存在'); }
    if (!st.isFile()) return send(res, 404, '不是文件');

    const etag = `W/"${st.size}-${Math.round(st.mtimeMs)}"`;
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { ETag: etag });
      return res.end();
    }
    // 图片体积大，给浏览器缓存，靠 ETag 失效
    const cache = mImage[1] === 'image' ? 'public, max-age=86400' : 'no-store';
    const stream = fs.createReadStream(abs);
    res.writeHead(200, {
      'Content-Type': mimeOf(abs),
      'Content-Length': st.size,
      ETag: etag,
      'Cache-Control': cache,
      ...(query.download !== undefined
        ? { 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(abs))}` }
        : {}),
    });
    stream.pipe(res);
    return undefined;
  }

  return sendJson(res, 404, { error: `未知接口：${method} ${pathname}` });
}

/* ------------------------------------------------------------------ *
 * 静态文件 + 启动
 * ------------------------------------------------------------------ */

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  let pathname = decodeURIComponent(parsed.pathname);

  try {
    if (pathname.startsWith('/api/')) {
      return await handleApi(req, res, pathname, parsed.query);
    }

    // 静态资源：web/ 目录
    if (pathname === '/' || pathname === '') pathname = '/index.html';
    const abs = path.resolve(WEB, '.' + pathname);
    if (!path.relative(WEB, abs).startsWith('..') && fs.existsSync(abs) && fs.statSync(abs).isFile()) {
      const st = fs.statSync(abs);
      const etag = `W/"${st.size}-${Math.round(st.mtimeMs)}"`;
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, { ETag: etag });
        return res.end();
      }
      res.writeHead(200, {
        'Content-Type': mimeOf(abs),
        'Content-Length': st.size,
        ETag: etag,
        'Cache-Control': pathname === '/index.html' ? 'no-store' : 'no-cache',
      });
      return fs.createReadStream(abs).pipe(res);
    }

    return send(res, 404, '未找到：' + pathname);
  } catch (err) {
    console.error(`[错误] ${req.method} ${req.url} — ${err.message}`);
    if (!res.headersSent) sendJson(res, 500, { error: err.message });
    else res.end();
  }
});

/**
 * PID 登记文件。
 *
 * 停止脚本靠它精确找到本服务进程。
 * 之前靠「扫描命令行里含 server.mjs + 武将牌库」来定位，
 * 结果把别的进程（命令行里恰好带着这段文本的）也杀掉了 —— 不可靠。
 * 改成自己写 PID，停止脚本读它 + 二次校验命令行，才不会误伤。
 */
const PID_FILE = path.join(DATA, 'server.pid');

function writePidFile() {
  try {
    fs.writeFileSync(PID_FILE, JSON.stringify({
      pid: process.pid,
      port: PORT,
      assets: ASSETS,
      startedAt: new Date().toISOString(),
    }, null, 2) + '\n', 'utf8');
  } catch (err) {
    console.warn(`  （写 PID 文件失败，不影响使用：${err.message}）`);
  }
}

function removePidFile() {
  try {
    // 只在确实是自己的时候删，避免删掉后来者的登记
    const j = JSON.parse(fs.readFileSync(PID_FILE, 'utf8'));
    if (j.pid === process.pid) fs.rmSync(PID_FILE, { force: true });
  } catch { /* 没有就算了 */ }
}

let shuttingDown = false;
function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n  正在停止（${reason}）…`);
  removePidFile();
  server.close(() => process.exit(0));
  // 有长连接挂着时兜底
  setTimeout(() => process.exit(0), 1200).unref();
}

server.listen(PORT, HOST, async () => {
  writePidFile();
  // 统计一下当前认到的武将数（含 _待实现\ 下的，所以用 listCharacterDirs 而不是直接读根目录）
  let countText = '（读不到素材目录）';
  try {
    const dirs = await listCharacterDirs();
    const withJson = dirs.filter((d) => fs.existsSync(path.join(d.abs, DATA_FILE))).length;
    countText = `${withJson} 位（另有 ${dirs.length - withJson} 个文件夹还没建描述）`.replace('（另有 0 个文件夹还没建描述）', '');
  } catch { /* 保持默认文案 */ }

  console.log('');
  console.log('  武将牌库 · 本地服务已启动');
  console.log('  ─────────────────────────────────');
  console.log(`  网页地址   http://${HOST}:${PORT}/`);
  console.log(`  素材目录   ${ASSETS}`);
  console.log(`  当前武将   ${countText}`);
  console.log(`  进程 PID   ${process.pid}`);
  console.log('');
  console.log('  按 Ctrl+C 停止');
  console.log('');
});

process.on('SIGINT', () => shutdown('Ctrl+C'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGHUP', () => shutdown('SIGHUP'));
process.on('exit', removePidFile);
