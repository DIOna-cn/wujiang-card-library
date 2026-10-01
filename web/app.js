/* ==========================================================================
   武将牌库 · 前端
   单文件 SPA，无构建步骤。所有写操作都通过本地服务落盘到 素材\<武将>\武将.json
   ========================================================================== */

(() => {
  'use strict';

  /* ------------------------------ 常量 ------------------------------ */

  const KINGDOMS = [
    { code: 'wei', name: '魏' }, { code: 'shu', name: '蜀' }, { code: 'wu', name: '吴' },
    { code: 'qun', name: '群' }, { code: 'jin', name: '晋' }, { code: 'shen', name: '神' },
    { code: 'yao', name: '妖' }, { code: 'hun', name: '魂' },
  ];
  const KINGDOM_MAP = new Map(KINGDOMS.map((k) => [k.code, k.name]));
  const KINGDOM_CODE = new Map(KINGDOMS.map((k) => [k.name, k.code]));
  const IMG_RE = /\.(png|jpe?g|webp|gif|bmp)$/i;
  const AUDIO_RE = /\.(mp3|wav|ogg|m4a|flac)$/i;

  /* ------------------------------ 状态 ------------------------------ */

  const state = {
    characters: [],
    tags: [],            // 特性标签（过牌 / 输出 / 减益…）
    origins: [],         // 原作（明日方舟 / 东方Project / 原神…）
    originPresets: [],   // 已知原作的完整清单（下拉用）
    directoryTags: [],
    directoryOrigins: [],
    config: { siteTitle: '武将牌库', subtitle: '素材文件夹中的武将一览' },
    assets: '',

    filterTags: new Set(),
    filterOrigin: '',    // 原作是单选：一个武将只属于一个原作
    filterKingdom: '',
    keyword: '',
    onlyIncomplete: false,
    view: 'grid',

    /* ---- 远程同步 ---- */
    sync: null,          // 服务端的同步状态快照
    syncPolling: false,
    syncBusySelf: false, // 自己刚点过按钮（用来在完成后只提示一次）
    syncTimer: 0,

    currentId: '',
    editing: false,
    draft: null,
    dirty: false,
    activeCardIndex: 0,
  };

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  /* ------------------------------ 工具 ------------------------------ */

  function esc(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /** 素材图片 → 可访问 URL */
  function imgUrl(dir, file) {
    if (!file) return '';
    return `/api/image/${encodeURIComponent(`${dir}/${file}`)}`;
  }
  function fileUrl(dir, file) {
    if (!file) return '';
    return `/api/file/${encodeURIComponent(`${dir}/${file}`)}`;
  }

  /**
   * 技能描述渲染：
   *  · 保留作者写的 <b>（来自 .shap 或人工订正）
   *  · 把【杀】这类牌名、以及技能类型词自动高亮
   *  · 换行保留
   * 做法是先用占位符把 <b> 抠出来，转义后再把高亮包进去，避免嵌套破坏。
   */
  function renderDesc(text) {
    const raw = String(text ?? '');
    if (!raw) return '<span style="color:var(--fg-faint)">（暂无描述）</span>';

    const bolds = [];
    let s = raw.replace(/<\/?b>/gi, (m) => `\u0000${bolds.push(/^<b>/i.test(m))}\u0000`);

    s = esc(s);

    // 【杀】【闪】等牌名 —— 换成带 class 的 span，之后的关键词高亮不会再碰到它
    s = s.replace(/【([^】]{1,12})】/g, '<span class="card-name-ref">【$1】</span>');
    // 技能类型词
    s = s.replace(/(锁定技|持恒技|觉醒技|限定技|转换技|使命技|主公技|蓄力技|衍生技)/g, '<span class="kw">$1</span>');

    // 还原 <b>
    s = s.replace(/\u0000(true|false)\u0000/g, (m, isOpen) => (isOpen === 'true' ? '<b>' : '</b>'));

    return s
      .split('\n')
      .map((line) => (line.trim() ? `<div>${line}</div>` : '<div style="height:6px"></div>'))
      .join('');
  }

  function kingdomLabel(code) {
    return KINGDOM_MAP.get(code) ?? (code || '');
  }
  function kingdomClass(code) {
    return KINGDOM_MAP.has(code) ? `k-${code}` : '';
  }

  /** 体力显示：3/3、2/6+1（护甲） */
  function hpLabel(c) {
    const hp = c.hp ?? 0;
    const max = c.maxHp ?? 0;
    let s = hp === max ? `${max}` : `${hp}/${max}`;
    if (c.shield) s += `+${c.shield}`;
    return s;
  }

  function toast(msg, kind = '') {
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.textContent = msg;
    $('#toastWrap').appendChild(el);
    setTimeout(() => {
      el.style.transition = 'opacity .3s, transform .3s';
      el.style.opacity = '0';
      el.style.transform = 'translateY(6px)';
      setTimeout(() => el.remove(), 320);
    }, kind === 'err' ? 5200 : 2600);
  }

  /* ------------------------------ API ------------------------------ */

  async function api(path, options = {}) {
    const res = await fetch(path, {
      headers: { 'Content-Type': 'application/json' },
      ...options,
    });
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
    if (!res.ok) throw new Error(data.error || `请求失败（${res.status}）`);
    return data;
  }

  /* ------------------------------ 载入 ------------------------------ */

  async function loadAll(showToast = false) {
    try {
      const data = await api('/api/characters');
      // 列表版标记为未取全量，避免「还没拉到 cards 就进编辑」
      state.characters = (data.characters ?? []).map((c) => ({ ...c, loadedFull: false }));
      state.tags = data.tags ?? [];
      state.origins = data.origins ?? [];
      state.originPresets = data.originPresets ?? state.origins;
      state.directoryTags = data.directoryTags ?? [];
      state.directoryOrigins = data.directoryOrigins ?? [];
      state.config = data.config ?? state.config;
      state.assets = data.assets ?? '';
      // 列表接口顺带带了同步状态，省一次请求
      if (data.sync) state.sync = data.sync;
      applyConfig();
      renderSidebar();
      renderGrid();
      renderSyncBox();
      if (showToast) toast(`已重新扫描：${state.characters.length} 位武将`, 'ok');
    } catch (err) {
      toast(`读取失败：${err.message}`, 'err');
    }
  }

  async function reloadOne(id, { keepEditing = true } = {}) {
    try {
      const fresh = await api(`/api/characters/${encodeURIComponent(id)}`);
      const i = state.characters.findIndex((c) => c.id === id);
      if (i >= 0) state.characters[i] = { ...state.characters[i], ...fresh };
      else state.characters.push(fresh);
      renderSidebar();
      renderGrid();
      if (keepEditing && state.currentId === id && state.editing) {
        // 编辑中不覆盖草稿
      }
      return fresh;
    } catch (err) {
      toast(`刷新失败：${err.message}`, 'err');
      return null;
    }
  }

  function applyConfig() {
    document.title = state.config.siteTitle || '武将牌库';
    $('#siteTitle').textContent = state.config.siteTitle || '武将牌库';
    $('#siteSubtitle').textContent = state.config.subtitle || '';
  }

  /* ------------------------------ 筛选 ------------------------------ */

  function isIncomplete(c) {
    if (!c.hasJson) return true;
    if (!c.cards?.length) return true;
    if (c.cards.some((card) => card.displayKind === 'placeholder')) return true;
    if (!c.cards.some((card) => (card.skills ?? []).length)) return true;
    return false;
  }

  function visibleCharacters() {
    const kw = state.keyword.trim().toLowerCase();
    return state.characters.filter((c) => {
      if (state.filterOrigin && c.origin !== state.filterOrigin) return false;
      if (state.filterKingdom && c.kingdom !== state.filterKingdom) return false;
      if (state.filterTags.size) {
        const own = new Set(c.tags ?? []);
        for (const t of state.filterTags) if (!own.has(t)) return false;
      }
      if (state.onlyIncomplete && !isIncomplete(c)) return false;
      if (kw) {
        const hay = [
          c.name, c.title, c.legendId, c.note, c.origin,
          ...(c.tags ?? []),
          ...(c.cards ?? []).flatMap((card) => [
            card.name, card.legendId,
            ...(card.skills ?? []).flatMap((s) => [s.name, s.desc]),
          ]),
        ].join(' ').toLowerCase();
        if (!hay.includes(kw)) return false;
      }
      return true;
    }).sort((a, b) => {
      // 有正式描述的排前面，其余保持素材文件夹里的原始顺序
      const d = (b.hasJson ? 1 : 0) - (a.hasJson ? 1 : 0);
      return d;
    });
  }

  /* ------------------------------ 侧栏 ------------------------------ */

  function renderSidebar() {
    // ---- 原作（单选：一个武将只属于一个原作）----
    const oCounts = new Map();
    for (const c of state.characters) {
      if (c.origin) oCounts.set(c.origin, (oCounts.get(c.origin) ?? 0) + 1);
    }
    const originList = [...state.origins];
    for (const o of oCounts.keys()) if (!originList.includes(o)) originList.push(o);

    $('#originTree').innerHTML = [
      rowHtml('origin:', '全部原作', state.characters.length, !state.filterOrigin),
      ...originList.map((o) => rowHtml(`origin:${o}`, o, oCounts.get(o) ?? 0, state.filterOrigin === o)),
    ].join('');

    // ---- 特性标签（多选）----
    const counts = new Map();
    for (const c of state.characters) {
      for (const t of c.tags ?? []) counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    for (const t of state.tags) if (!counts.has(t)) counts.set(t, 0);

    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh'));
    $('#tagTree').innerHTML = sorted.length
      ? [
        rowHtml('tag:', '全部标签', state.characters.length, !state.filterTags.size),
        ...sorted.map(([t, n]) => rowHtml(`tag:${t}`, t, n, state.filterTags.has(t))),
      ].join('')
      : '<div class="side-empty">还没有标签</div>';

    // ---- 势力 ----
    const kCounts = new Map();
    for (const c of state.characters) {
      if (c.kingdom) kCounts.set(c.kingdom, (kCounts.get(c.kingdom) ?? 0) + 1);
    }
    $('#kingdomTree').innerHTML = [
      rowHtml('kingdom:', '全部势力', state.characters.length, !state.filterKingdom),
      ...[...kCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([code, n]) => rowHtml(`kingdom:${code}`, kingdomLabel(code), n, state.filterKingdom === code, kingdomClass(code))),
    ].join('');

    // 统计里带上原作的覆盖情况
    const noOrigin = state.characters.filter((c) => !c.origin).length;
    $('#statLine').innerHTML =
      `共 <b>${state.characters.length}</b> 位武将 · <b>${state.characters.reduce((a, c) => a + (c.cards?.length ?? 0), 0)}</b> 张卡面` +
      `<br>待补 <b>${state.characters.filter(isIncomplete).length}</b> 位` +
      (noOrigin ? ` · 未标原作 <b>${noOrigin}</b> 位` : '');

    renderActiveFilters();
  }

  function rowHtml(key, label, count, active, cls = '') {
    return `<button class="tag-row${active ? ' active' : ''}" data-key="${esc(key)}">
      <span class="dot ${cls}"></span>
      <span class="label">${esc(label)}</span>
      <span class="count">${count}</span>
    </button>`;
  }

  function renderActiveFilters() {
    const chips = [];
    if (state.filterOrigin) chips.push(chip(`原作：${state.filterOrigin}`, `origin:${state.filterOrigin}`));
    for (const t of state.filterTags) chips.push(chip(`标签：${t}`, `tag:${t}`));
    if (state.filterKingdom) chips.push(chip(`势力：${kingdomLabel(state.filterKingdom)}`, `kingdom:${state.filterKingdom}`));
    if (state.keyword) chips.push(chip(`搜索：${state.keyword}`, '__kw__'));
    if (state.onlyIncomplete) chips.push(chip('只看待补', '__incomplete__'));
    $('#activeFilters').innerHTML = chips.join('');
  }

  function chip(label, key) {
    return `<span class="filter-chip">${esc(label)}<button data-clear="${esc(key)}" title="清除">✕</button></span>`;
  }

  /* ------------------------------ 卡图网格 ------------------------------ */

  function renderGrid() {
    const list = visibleCharacters();
    const grid = $('#grid');
    grid.classList.toggle('list-view', state.view === 'list');
    grid.innerHTML = list.map(cardHtml).join('');

    const empty = $('#empty');
    if (!list.length) {
      empty.hidden = false;
      empty.innerHTML = `<div class="big">🀄</div>
        <div>没有符合条件的武将</div>
        <div style="font-size:12.5px">试试清掉筛选条件，或者点右上角「新建武将」</div>`;
    } else {
      empty.hidden = true;
    }

    $('#searchHint').textContent = list.length === state.characters.length
      ? `${list.length} 位`
      : `${list.length} / ${state.characters.length}`;
  }

  function cardHtml(c) {
    const cards = c.cards ?? [];
    const first = cards[0] ?? {};
    const multi = cards.length > 1;

    let figure;
    if (first.displayImage) {
      const kindLabel = first.displayKind === 'plain' ? '' : '<span class="card-badge warn">带技能卡图</span>';
      figure = `<img src="${esc(imgUrl(c.dir, first.displayImage))}" alt="${esc(c.name)}" loading="lazy" decoding="async">${kindLabel}`;
    } else {
      const hint = c.hasJson ? '把不带技能的卡图放进<br>该武将文件夹即可' : '还没有描述文件';
      figure = `<div class="placeholder">
          <div class="ph-mark">🀄</div>
          <div class="ph-name">${esc(c.name)}</div>
          <div class="ph-hint">${hint}</div>
        </div>`;
    }

    const skills = (first.skills ?? []).slice(0, 4);
    const moreSkills = (first.skills ?? []).length - skills.length;

    const subParts = [];
    if (c.kingdom) subParts.push(`<span class="${kingdomClass(c.kingdom)}">${esc(kingdomLabel(c.kingdom))}</span>`);
    subParts.push(`<span>${esc(hpLabel(c))} 血</span>`);
    if (first.legendId || c.legendId) subParts.push(`<span class="id">${esc(first.legendId || c.legendId)}</span>`);

    return `<button class="card" data-id="${esc(c.id)}">
      <div class="card-figure">
        ${figure}
        ${multi ? `<span class="card-badge multi">${cards.length} 张牌</span>` : ''}
      </div>
      <div class="card-meta">
        <div class="card-name-row">
          <span class="card-name">${esc(c.name)}</span>
          ${c.title ? `<span class="card-title">${esc(c.title)}</span>` : ''}
        </div>
        <div class="card-sub">${subParts.join('<span class="sep">·</span>')}</div>

        ${c.origin ? `<div class="card-origin" data-filter-origin="${esc(c.origin)}" title="按原作筛选：${esc(c.origin)}">
          <span class="origin-mark"></span>${esc(c.origin)}
        </div>` : ''}

        ${skills.length ? `<div class="card-skills">
          ${skills.map((s) => `<span class="skill-pill${s.derived ? ' derived' : ''}"${s.derived ? ' title="衍生技"' : ''}>${s.derived ? '<i class="derived-dot"></i>' : ''}${esc(s.name)}</span>`).join('')}
          ${moreSkills > 0 ? `<span class="skill-pill">+${moreSkills}</span>` : ''}
        </div>` : `<div class="card-skills"><span class="skill-pill" style="border-style:dashed">暂无技能</span></div>`}

        ${(c.tags ?? []).length ? `<div class="card-tags">
          ${(c.tags ?? []).map((t) => `<span class="tag-chip" data-filter-tag="${esc(t)}" title="按标签筛选：${esc(t)}">${esc(t)}</span>`).join('')}
        </div>` : ''}
      </div>
    </button>`;
  }

  /* ------------------------------ 详情抽屉 ------------------------------ */

  function currentCharacter() {
    return state.characters.find((c) => c.id === state.currentId) ?? null;
  }

  async function openDrawer(id) {
    state.currentId = id;
    state.editing = false;
    state.dirty = false;
    state.activeCardIndex = 0;
    state.draft = null;
    $('#drawer').hidden = false;
    $('#drawerMask').hidden = false;
    $('#drawerBody').scrollTop = 0;

    // 列表接口为提速不带卡片主图/素材库，先把完整数据取回来再渲染。
    // 这一步不能省：编辑是基于 state 里的对象做深拷贝的，
    // 若此刻还是列表版数据，一存就会把 cards 写空。
    const full = await fetchFull(id);
    renderDrawer();
    if (full && !full.cards?.length) {
      toast('这个文件夹里还没有 \(武将.json\)，点右上角「编辑」开始编写');
    }
  }

  /** 取单个武将的完整数据并合并进 state */
  async function fetchFull(id) {
    try {
      const full = await api(`/api/characters/${encodeURIComponent(id)}`);
      const i = state.characters.findIndex((c) => c.id === id);
      full.loadedFull = true;
      if (i >= 0) state.characters[i] = { ...state.characters[i], ...full };
      else state.characters.push(full);
      return full;
    } catch (err) {
      toast(`读取详情失败：${err.message}`, 'err');
      return null;
    }
  }

  function closeDrawer() {
    if (state.dirty && !confirm('有未保存的修改，确定关闭吗？')) return;
    $('#drawer').hidden = true;
    $('#drawerMask').hidden = true;
    state.currentId = '';
    state.draft = null;
    state.dirty = false;
    state.editing = false;
  }

  async function startEdit() {
    const c = currentCharacter();
    if (!c) return;
    // 还没有全量数据就先取一次：编辑是对 state 里对象的深拷贝，
    // 若基于列表版数据，一保存就会把 cards 写空、毁掉描述文件。
    if (!c.loadedFull) {
      const full = await fetchFull(c.id);
      if (!full) { toast('拿不到完整数据，先不进入编辑', 'err'); return; }
    }
    const fresh = currentCharacter();
    state.draft = JSON.parse(JSON.stringify(fresh));
    state.draft.cards = (state.draft.cards ?? []).map((card) => ({
      ...card,
      skills: (card.skills ?? []).map((s) => ({ ...s, desc: s.desc ?? '' })),
    }));
    if (!state.draft.cards.length) {
      state.draft.cards = [{ name: '', image: '', cardImage: '', legendId: '', skills: [], derived: [] }];
    }
    // 保证编号在顶层字段里可见可编辑
    if (!state.draft.legendId && state.draft.cards[0]?.legendId) {
      state.draft.legendId = state.draft.cards[0].legendId;
    }
    state.editing = true;
    state.dirty = false;
    state.activeCardIndex = 0;
    renderDrawer();
    updateSaveBar();
  }

  function cancelEdit() {
    if (state.dirty && !confirm('放弃未保存的修改？')) return;
    state.editing = false;
    state.draft = null;
    state.dirty = false;
    renderDrawer();
    updateSaveBar();
  }

  function markDirty() {
    if (!state.dirty) {
      state.dirty = true;
      updateSaveBar();
    }
  }

  function updateSaveBar() {
    const el = $('#saveState');
    $('#btnSave').disabled = !state.editing || !state.dirty;
    $('#btnRevert').disabled = !state.editing || !state.dirty;
    if (!state.editing) {
      el.textContent = '';
      el.className = 'save-state';
    } else if (state.dirty) {
      el.textContent = '有未保存的修改';
      el.className = 'save-state dirty';
    } else {
      el.textContent = '已是最新';
      el.className = 'save-state';
    }
  }

  function renderDrawer() {
    const c = state.editing ? state.draft : currentCharacter();
    if (!c) return;

    $('#dName').textContent = c.name || '（未命名）';
    $('#dTitle').textContent = c.title || '';
    $('#dKingdom').textContent = kingdomLabel(c.kingdom);
    $('#dKingdom').className = `chip kingdom ${kingdomClass(c.kingdom)}`;
    $('#btnCardEdit').textContent = state.editing ? '完成编辑' : '编辑';
    $('#btnCardEdit').hidden = false;
    $('#btnCardDelete').hidden = state.editing;

    $('#drawerBody').innerHTML = state.editing ? editBodyHtml(c) : viewBodyHtml(c);
    updateSaveBar();
  }

  /* --------------------------- 查看态 --------------------------- */

  function viewBodyHtml(c) {
    const cards = c.cards ?? [];
    const active = cards[state.activeCardIndex] ?? cards[0] ?? {};
    const parts = [];

    if (c.error) parts.push(`<div class="warn-box">读取这个文件夹时出错：${esc(c.error)}</div>`);
    if (!c.hasJson) {
      parts.push(`<div class="warn-box">这个文件夹里还没有 <code>武将.json</code>。点右上角「编辑」就能开始编写，保存后会自动生成。</div>`);
    }
    if (c.parseError) {
      parts.push(`<div class="warn-box"><code>武将.json</code> 解析失败：${esc(c.parseError)}<br>请用「编辑」重新保存一份，或直接修文件。</div>`);
    }

    // 卡面切换
    if (cards.length > 1) {
      parts.push(`<div class="card-tabs">${
        cards.map((card, i) => `<button class="card-tab${i === state.activeCardIndex ? ' active' : ''}" data-card-tab="${i}">
          ${esc(card.name || `卡面 ${i + 1}`)}${card.displayKind === 'placeholder' ? ' ⚠' : ''}
        </button>`).join('')
      }</div>`);
    }

    parts.push(`<div class="section">
      <div class="card-preview-row">
        <div class="card-preview">${previewInner(c.dir, active)}</div>
        <div class="info-grid">
          ${infoField('称号', c.title || '—')}
          ${infoField('原作', c.origin || '（未标）')}
          ${infoField('势力', kingdomLabel(c.kingdom) || '—')}
          ${infoField('体力', `${hpLabel(c)}${c.shield ? `（护甲 ${c.shield}）` : ''}`)}
          ${infoField('性别', c.gender || '—')}
          ${infoField('编号', active.legendId || c.legendId || '—')}
          <div class="field wide"><label>标签</label><div class="readonly-value">
            ${(c.tags ?? []).length
              ? (c.tags ?? []).map((t) => `<span class="tag-chip">${esc(t)}</span>`).join('')
              : '—'}
          </div></div>
        </div>
      </div>
    </div>`);

    // 技能
    const skills = active.skills ?? [];
    parts.push(`<div class="section">
      <div class="section-head"><h3>技能（${skills.length}）</h3><div class="rule"></div></div>
      ${skills.length ? skills.map((s) => `
        <div class="skill-view${s.derived ? ' is-derived' : ''}">
          <div class="sv-name">
            ${s.derived ? '<span class="derived-badge" title="衍生技：不在武将技能表里，由其他技能获得">衍生</span>' : ''}
            <span class="sv-name-text">${esc(s.name)}</span>
          </div>
          <div class="sv-desc">${renderDesc(s.desc)}</div>
          ${s.fixNote ? `<div class="fix-note">订正记录：${esc(s.fixNote)}</div>` : ''}
        </div>`).join('')
        : '<div class="note-box">这一面还没有技能。点右上角「编辑」添加。</div>'}
    </div>`);

    // 引文 / 版权
    if (c.quote) {
      parts.push(`<div class="section">
        <div class="section-head"><h3>引文</h3><div class="rule"></div></div>
        <div class="note-box">${esc(c.quote)}</div>
      </div>`);
    }

    // 备注
    if (c.note) {
      parts.push(`<div class="section">
        <div class="section-head"><h3>备注</h3><div class="rule"></div></div>
        <div class="note-box">${esc(c.note)}</div>
      </div>`);
    }

    // 附加内容（神宝等）
    for (const extra of c.extras ?? []) {
      if (!extra.items?.length) continue;
      parts.push(`<div class="section">
        <div class="section-head"><h3>${esc(extra.title)}</h3><div class="rule"></div></div>
        ${extra.note ? `<div class="note-box" style="margin-bottom:10px">${esc(extra.note)}</div>` : ''}
        <div class="extra-grid">
          ${extra.items.map((it) => `
            <div class="extra-item">
              <div class="extra-figure">
                ${it.image
                  ? `<img src="${esc(imgUrl(c.dir, it.image))}" alt="${esc(it.upgradedName)}" loading="lazy">`
                  : '<div class="placeholder"><div class="ph-hint">无卡图</div></div>'}
                ${it.icon ? `<img class="icon-overlay" src="${esc(imgUrl(c.dir, it.icon))}" alt="${esc(it.name)}" loading="lazy">` : ''}
              </div>
              <div class="extra-body">
                <div class="extra-name">${esc(it.name)}</div>
                ${it.upgradedName ? `<div class="extra-up">→ ${esc(it.upgradedName)}${it.suit ? ` · ${esc(it.suit)}` : ''}</div>` : ''}
                ${it.desc ? `<div class="extra-desc">${renderDesc(it.desc)}</div>` : ''}
              </div>
            </div>`).join('')}
        </div>
      </div>`);
    }

    // 素材库
    const images = (c.gallery ?? []).filter((g) => g.kind !== 'audio');
    const audios = (c.gallery ?? []).filter((g) => g.kind === 'audio');
    parts.push(`<div class="section">
      <div class="section-head"><h3>图片素材（${images.length}）</h3><div class="rule"></div>
        <button class="icon-btn" data-upload="1" title="上传图片到该武将文件夹">⬆</button>
      </div>
      ${images.length ? `<div class="asset-grid">${images.map((g) => assetHtml(c, g)).join('')}</div>`
        : '<div class="note-box">这个文件夹里还没有图片。</div>'}
    </div>`);

    if (audios.length) {
      parts.push(`<div class="section">
        <div class="section-head"><h3>语音（${audios.length}）</h3><div class="rule"></div></div>
        <div class="note-box" style="padding:0">
          ${(c.sounds ?? []).map((g) => `<div class="sound-row">
            <span class="sname">${esc(g.name)} <span style="color:var(--fg-faint)">×${g.files.length}</span></span>
            ${g.files.slice(0, 3).map((f) => `<button data-audio="${esc(f)}">▶ ${esc(shortName(f))}</button>`).join('')}
          </div>`).join('')}
        </div>
      </div>`);
    }

    parts.push(`<div class="section">
      <div class="section-head"><h3>位置</h3><div class="rule"></div></div>
      <div class="note-box" style="font-family:var(--mono);font-size:11.5px">${esc(`${state.assets}\\${c.dir}\\武将.json`)}</div>
    </div>`);

    return parts.join('');
  }

  function shortName(f) {
    return String(f).replace(/\.[^.]+$/, '');
  }

  function infoField(label, value) {
    return `<div class="field"><label>${esc(label)}</label><div class="readonly-value">${esc(value)}</div></div>`;
  }

  function previewInner(dir, card) {
    if (!card?.displayImage) {
      return `<div class="placeholder">
        <div class="ph-mark">🀄</div>
        <div class="ph-hint">没有可用卡图<br>（会把带技能卡图暂时顶上）</div>
      </div>`;
    }
    return `<img src="${esc(imgUrl(dir, card.displayImage))}" alt="${esc(card.name || '')}">`;
  }

  function assetHtml(c, g) {
    const isAudio = g.kind === 'audio';
    if (isAudio) {
      return `<div class="asset audio" title="${esc(g.file)}">
        <span class="asset-kind">语音</span>
        <span style="font-size:20px">♪</span>
        <span class="asset-label">${esc(shortName(g.file))}</span>
      </div>`;
    }
    const kindLabel = g.kind === 'card' ? '带技能卡图' : g.kind === 'portrait' ? '立绘' : '图标';
    return `<div class="asset" data-asset="${esc(g.file)}" title="${esc(g.file)}">
      <img src="${esc(imgUrl(c.dir, g.file))}" alt="${esc(g.file)}" loading="lazy">
      <span class="asset-kind">${kindLabel}</span>
      ${state.editing ? '<button class="asset-use" data-use-image="1">设为主图</button>' : ''}
      <div class="asset-label">${esc(shortName(g.file))}</div>
    </div>`;
  }

  /* --------------------------- 编辑态 --------------------------- */

  function editBodyHtml(c) {
    const active = c.cards[state.activeCardIndex] ?? c.cards[0];

    const parts = [];

    // 卡面切换 + 增删
    parts.push(`<div class="section">
      <div class="section-head"><h3>卡面（${c.cards.length}）</h3><div class="rule"></div>
        <button class="icon-btn" data-add-card="1" title="加一张卡面（一个武将多张武将牌时用）">＋</button>
      </div>
      <div class="card-tabs">
        ${c.cards.map((card, i) => `<button class="card-tab${i === state.activeCardIndex ? ' active' : ''}" data-card-tab="${i}">
          ${esc(card.name || `卡面 ${i + 1}`)}
        </button>`).join('')}
      </div>
      ${c.cards.length > 1 ? `<div style="display:flex;gap:8px;align-items:center;margin-bottom:12px">
        <div class="field" style="flex:1"><label>当前卡面名称</label>
          <input data-card-field="name" value="${esc(active.name ?? '')}" placeholder="如 面具① / 觉醒后"></div>
        <button class="ghost-btn danger" data-del-card="1" style="align-self:flex-end">删除这张卡面</button>
      </div>` : ''}
    </div>`);

    // 基本信息
    parts.push(`<div class="section">
      <div class="section-head"><h3>基本信息</h3><div class="rule"></div></div>
      <div class="form-grid">
        <div class="field"><label>武将名 *</label><input data-field="name" value="${esc(c.name ?? '')}"></div>
        <div class="field"><label>称号</label><input data-field="title" value="${esc(c.title ?? '')}"></div>
        <div class="field"><label>势力</label>
          <select data-field="kingdom">
            <option value="">—</option>
            ${KINGDOMS.map((k) => `<option value="${k.code}"${c.kingdom === k.code ? ' selected' : ''}>${k.name}</option>`).join('')}
          </select>
        </div>
        <div class="field"><label>编号</label><input data-field="legendId" value="${esc(c.legendId ?? '')}" placeholder="如 ARK 012"></div>
        <div class="field"><label>体力</label><input type="number" data-field="hp" value="${esc(c.hp ?? 3)}"></div>
        <div class="field"><label>体力上限</label><input type="number" data-field="maxHp" value="${esc(c.maxHp ?? 3)}"></div>
        <div class="field"><label>护甲</label><input type="number" data-field="shield" value="${esc(c.shield ?? 0)}"></div>
        <div class="field"><label>性别</label>
          <select data-field="gender">
            <option value=""${!c.gender ? ' selected' : ''}>—</option>
            <option value="男"${c.gender === '男' ? ' selected' : ''}>男</option>
            <option value="女"${c.gender === '女' ? ' selected' : ''}>女</option>
          </select>
        </div>
        <div class="field wide"><label>引文（卡面底部的角色台词）</label>
          <textarea data-field="quote" rows="2">${esc(c.quote ?? '')}</textarea></div>
        <div class="field wide"><label>备注（设计思路、实现说明等，只在这里显示，不影响卡面）</label>
          <textarea data-field="note" rows="3">${esc(c.note ?? '')}</textarea></div>
        <div class="field wide">
          <label>原作（一个武将只能属于一个原作）</label>
          <input data-field="origin" list="originSuggestions" value="${esc(c.origin ?? '')}"
                 placeholder="如 明日方舟 / 东方Project / 原神 / 三国杀 / 原创，留空表示未定">
          <datalist id="originSuggestions">
            ${originChoices(c.origin).map((o) => `<option value="${esc(o)}">`).join('')}
          </datalist>
        </div>
        <div class="field wide">
          <label>标签（玩法特性，可以多个：过牌 / 输出 / 增益 / 减益…）</label>
          ${tagEditorHtml(c.tags ?? [])}
        </div>
      </div>
    </div>`);

    // 当前卡面的图
    parts.push(`<div class="section">
      <div class="section-head"><h3>卡图（卡面 ${state.activeCardIndex + 1}）</h3><div class="rule"></div></div>
      <div class="card-preview-row">
        <div class="card-preview">${previewInner(c.dir, {
          displayImage: active.image || active.cardImage,
          displayKind: active.image ? 'plain' : 'card',
        })}</div>
        <div style="flex:1;min-width:240px">
          <div class="field" style="margin-bottom:10px">
            <label>无技能卡图（显示用的主图）</label>
            <input data-card-field="image" value="${esc(active.image ?? '')}" placeholder="如 立绘.png">
          </div>
          <div class="field" style="margin-bottom:10px">
            <label>带技能卡图（备查 / 主图缺失时顶上）</label>
            <input data-card-field="cardImage" value="${esc(active.cardImage ?? '')}" placeholder="如 新UI.卡名.武将.png">
          </div>
          <div class="field">
            <label>本卡面编号</label>
            <input data-card-field="legendId" value="${esc(active.legendId ?? '')}">
          </div>
          <p style="margin:10px 0 0;font-size:11.5px;color:var(--fg-faint);line-height:1.6">
            小提示：在下方「图片素材」里把鼠标移到任意图片上，点「设为主图」就能一键填好。
          </p>
        </div>
      </div>
    </div>`);

    // 技能编辑
    parts.push(`<div class="section">
      <div class="section-head"><h3>技能（${active.skills.length}）</h3><div class="rule"></div>
        <button class="icon-btn" data-add-skill="1" title="添加技能">＋</button>
      </div>
      <div class="skill-list">
        ${active.skills.map((s, i) => `
          <div class="skill-item" data-skill-index="${i}">
            <div class="skill-item-head">
              <input class="skill-name-input" data-skill-field="name" value="${esc(s.name)}" placeholder="技能名">
              <label class="checkbox-row" title="标记为衍生技（不在武将技能表里，由其他技能获得）">
                <input type="checkbox" data-skill-field="derived"${s.derived ? ' checked' : ''}>衍生技
              </label>
              <span class="grow"></span>
              <button class="icon-btn" data-skill-move="-1" title="上移">↑</button>
              <button class="icon-btn" data-skill-move="1" title="下移">↓</button>
              <button class="icon-btn" data-del-skill="${i}" title="删除">✕</button>
            </div>
            <div class="skill-item-body">
              <textarea data-skill-field="desc" placeholder="技能描述。直接写原文即可：
· 换行会保留
· 【杀】【闪】会自动高亮
· 想手动加粗某段，用 <b>…</b>">${esc(s.desc)}</textarea>
              ${s.fixNote ? `<div class="fix-note">订正记录：${esc(s.fixNote)}</div>` : ''}
            </div>
          </div>`).join('') || '<div class="note-box">还没有技能，点上面的 ＋ 添加。</div>'}
      </div>
    </div>`);

    // 图片素材
    const images = (c.gallery ?? []).filter((g) => g.kind !== 'audio');
    parts.push(`<div class="section">
      <div class="section-head"><h3>图片素材（${images.length}）</h3><div class="rule"></div>
        <button class="icon-btn" data-upload="1" title="上传图片到该武将文件夹">⬆</button>
      </div>
      <div class="asset-grid">${images.map((g) => assetHtml(c, g)).join('')}</div>
    </div>`);

    return parts.join('');
  }

  /** 原作下拉候选：已知预设 + 数据里已出现的，去重 */
  function originChoices(current = '') {
    const list = [];
    for (const o of [...(state.originPresets ?? []), ...(state.origins ?? [])]) {
      if (o && !list.includes(o)) list.push(o);
    }
    if (current && !list.includes(current)) list.push(current);
    return list;
  }

  function tagEditorHtml(tags) {
    const known = state.tags.filter((t) => !tags.includes(t));
    return `<div class="tag-editor" id="tagEditor">
      ${tags.map((t) => `<span class="tag-pill">${esc(t)}<button data-del-tag="${esc(t)}">✕</button></span>`).join('')}
      <input class="tag-add-input" id="tagAddInput" list="tagSuggest" placeholder="+ 加标签，回车">
      <datalist id="tagSuggest">${known.map((t) => `<option value="${esc(t)}">`).join('')}</datalist>
    </div>`;
  }

  /* ================================================================
     远程同步：上传 / 下载 / 轮询
     ================================================================ */

  /** 把服务端返回的 sync 状态存下来，并只重画侧栏那一小块（不整页重渲染，免得闪） */
  function applySync(data) {
    if (!data) return;
    state.sync = data;
    renderSyncBox();
  }

  function renderSyncBox() {
    const box = $('#syncBox');
    if (!box) return;
    const s = state.sync;
    if (!s) {
      box.innerHTML = '<div class="sync-line"><span class="dot"></span><span class="txt">读取同步状态…</span></div>';
      return;
    }

    const st = s.status || null;
    const cfg = s.config || {};
    const repo = (() => {
      const m = String(cfg.remote || '').match(/github\.com[/:]([^/]+)\/([^/.]+)/);
      return m ? { owner: m[1], repo: m[2], url: `https://github.com/${m[1]}/${m[2]}` } : null;
    })();

    // ---- 状态行 ----
    let cls = '';
    let txt = '';
    let sub = '';
    if (s.busy) {
      cls = 'busy';
      txt = s.op === 'upload' ? '正在上传…' : s.op === 'download' ? '正在下载…' : '正在检查…';
      sub = s.step || '';
    } else if (s.error) {
      cls = 'err';
      txt = '同步出错';
    } else if (!st) {
      cls = '';
      txt = '还没检查过';
    } else if (st.initialized === false) {
      // 工作副本还没建（clone 出来的新副本就是这样）。点上传/下载会建，约 72 MB。
      cls = '';
      txt = '还没建同步副本';
      sub = '点上传或下载即可';
    } else if (!st.reachable) {
      cls = 'err';
      txt = '连不上远端';
    } else if (st.hasRemoteUpdate) {
      cls = 'warn';
      txt = '远端有新内容';
      sub = `本地 ${st.localHead} → 远端 ${st.remoteHead}`;
    } else if (st.hasLocalChanges) {
      cls = 'warn';
      txt = `有 ${st.localDiffCount} 处改动未上传`;
    } else {
      cls = 'ok';
      txt = '已是最新';
      sub = st.localHead ? st.localHead : '';
    }

    const parts = [];

    parts.push(`<div class="sync-line ${cls}">
      <span class="dot"></span>
      <span class="txt" title="${esc(txt)}">${esc(txt)}</span>
      ${sub ? `<span class="sub">${esc(sub)}</span>` : ''}
    </div>`);

    if (repo) {
      parts.push(`<div class="sync-repo" title="${esc(cfg.remote)}">
        <a href="${esc(repo.url)}" target="_blank" rel="noreferrer">${esc(repo.owner)}/${esc(repo.repo)}</a>
        @${esc(cfg.branch || 'main')}
      </div>`);
    }

    // ---- 三个按钮 ----
    // 注意 hot 要拼进 class 里，不能当独立属性写 —— 否则会生成 `hot=""` 这种空属性，
    // class 里没有 hot，样式永远不生效（这个 bug 实际出现过一次）。
    const dis = s.busy ? ' disabled' : '';
    const hot = (st && st.hasRemoteUpdate && !s.busy) ? ' hot' : '';
    parts.push(`<div class="sync-actions">
      <button class="sync-btn" data-sync="check"${dis} title="检查远端有没有新内容">
        <span class="ic">⟳</span>检查
      </button>
      <button class="sync-btn${hot}" data-sync="download"${dis} title="把远端的更新拉下来">
        <span class="ic">↓</span>下载
      </button>
      <button class="sync-btn" data-sync="upload"${dis} title="把你在这里的改动推上去">
        <span class="ic">↑</span>上传
      </button>
    </div>`);

    // ---- 进度 ----
    if (s.busy) {
      parts.push(`<div class="sync-progress"><div class="bar"></div>${esc(s.step || '处理中…')}</div>`);
    }

    // ---- 错误 / 提示 ----
    if (s.error) {
      parts.push(`<div class="sync-msg err">${esc(s.error)}
        ${s.hint ? `<div style="margin-top:4px">${esc(s.hint)}</div>` : ''}</div>`);
    } else if (s.result) {
      const r = s.result;
      if (s.op === '' && r.ok) {
        if (r.updated || r.added || r.changed) {
          const bits = [];
          if (r.updated?.length) bits.push(`更新 ${r.updated.length} 个`);
          if (r.added?.length) bits.push(`新增 ${r.added.length} 个`);
          if (r.copied && !r.updated) bits.push(`同步 ${r.copied} 个文件`);
          if (!bits.length && r.changed) bits.push('远端有新提交');
          if (!bits.length) bits.push('已是最新');
          const sample = [...(r.added ?? []), ...(r.updated ?? [])].slice(0, 5);
          parts.push(`<div class="sync-msg ok">${esc(bits.join('，'))}
            ${sample.length ? `<ul>${sample.map((x) => `<li class="mono">${esc(x)}</li>`).join('')}</ul>` : ''}
            ${(r.updated?.length ?? 0) + (r.added?.length ?? 0) > 5
              ? `<div style="margin-top:3px">…</div>` : ''}</div>`);
        } else if (r.localDiff?.length) {
          parts.push(`<div class="sync-msg warn">本地有 ${r.localDiff.length} 个数据文件和远端不同，建议点「上传」推上去。</div>`);
        }
      }
    }

    // ---- 上次检查时间 ----
    if (s.lastCheckAt) {
      const ago = Math.round((Date.now() - s.lastCheckAt) / 1000);
      const label = ago < 60 ? `${ago} 秒前` : ago < 3600 ? `${Math.round(ago / 60)} 分钟前` : `${Math.round(ago / 3600)} 小时前`;
      parts.push(`<div class="sync-repo" style="text-align:right">上次检查 ${label}</div>`);
    }

    box.innerHTML = parts.join('');
  }

  /** 拉一次状态（默认静默：不弹 toast） */
  async function refreshSync({ quiet = true } = {}) {
    try {
      const r = await api('/api/sync/status');
      const wasBusy = state.sync?.busy;
      applySync(r);
      // 任务刚跑完：刷新武将数据，并提示一次
      if (wasBusy && !r.busy && state.syncBusySelf) {
        state.syncBusySelf = false;
        await loadAll();
        if (r.error) {
          // 冲突这类错误，该怎么办写在 hint 里，别只报错不给出路
          const hint = r.result?.hint ? `（${r.result.hint}）` : '';
          toast(r.error + hint, 'err');
        } else if (r.result?.ok && r.result.op === 'download') {
          const up = r.result.updated?.length ?? 0;
          const add = r.result.added?.length ?? 0;
          let msg = `已下载：更新 ${up} 个、新增 ${add} 个数据文件`;
          // 本地自己那份还没推上去，说清楚，否则会以为两边都齐了
          if (r.result.needPush) {
            msg += `；本地还有 ${r.result.ahead} 个提交没上传，点「上传」推上去`;
          }
          toast(msg, 'ok');
        } else if (r.result?.ok && r.result.op === 'upload') {
          if (r.result.merged) {
            const n = r.result.incoming?.length ?? 0;
            const g = r.result.added ?? 0;
            toast(
              `对方也有新内容：已合并 ${n} 个提交、带回 ${g} 个武将，两边的改动都在，并已推上去`,
              'ok'
            );
          } else if (r.result.copied) {
            toast(`已上传（${r.result.copied} 个文件变动）`, 'ok');
          } else {
            toast('已上传，远端已是最新', 'ok');
          }
        }
      }
    } catch {
      /* 服务可能刚重启，静默 */
    }
  }

  /** 点按钮触发一个同步动作 */
  async function triggerSync(op) {
    const label = op === 'upload' ? '上传' : op === 'download' ? '下载' : '检查';
    try {
      state.syncBusySelf = true;
      const r = await api(`/api/sync/${op}`, { method: 'POST' });
      if (r.busy) { toast('已经有一个同步任务在跑'); return; }
      state.sync = { ...(state.sync ?? {}), busy: true, op, step: '正在开始…' };
      renderSyncBox();
      // 立刻开始快轮询
      pollFast(24);
    } catch (err) {
      state.syncBusySelf = false;
      toast(`${label}失败：${err.message}`, 'err');
    }
  }

  /** 密集轮询一段时间（同步任务进行中） */
  function pollFast(times) {
    clearTimeout(state.syncTimer);
    let n = 0;
    const tick = async () => {
      await refreshSync();
      n++;
      if (state.sync?.busy && n < times) {
        state.syncTimer = setTimeout(tick, 900);
      } else {
        scheduleSyncPoll();
      }
    };
    state.syncTimer = setTimeout(tick, 700);
  }

  /** 常态轮询：按服务端配置的间隔（默认 60 秒），页面隐藏时不跑 */
  function scheduleSyncPoll() {
    clearTimeout(state.syncTimer);
    const ms = Math.max(15000, Number(state.sync?.config?.autoCheckMs) || 60000);
    state.syncTimer = setTimeout(async () => {
      if (!document.hidden) {
        const before = state.sync?.status?.remoteHead;
        // 常态轮询走一次真正的远端检查，才能发现"别人推了新东西"
        try { await api('/api/sync/check', { method: 'POST' }); } catch { /* 忽略 */ }
        state.syncBusySelf = false;
        await new Promise((r) => setTimeout(r, 1200));
        await refreshSync();
        const after = state.sync?.status?.remoteHead;
        if (after && before && after !== before) {
          toast('远端有新内容，点侧栏「下载」可以拉下来', 'ok');
        }
      }
      scheduleSyncPoll();
    }, ms);
  }

  /** 同步设置弹窗 */
  function syncSettingsModal() {
    const cfg = state.sync?.config ?? {};
    openModal(`
      <h3>同步设置</h3>
      <p class="modal-sub">
        网页通过本机服务调用 git 与远端交换。这里配的就是它用的地址与范围。
      </p>
      <div class="form-grid">
        <div class="field wide"><label>仓库地址（HTTPS）</label>
          <input id="syRemote" value="${esc(cfg.remote ?? '')}" placeholder="https://github.com/<用户名>/<仓库>.git"></div>
        <div class="field"><label>分支</label>
          <input id="syBranch" value="${esc(cfg.branch ?? 'main')}"></div>
        <div class="field"><label>同步范围</label>
          <select id="syMode">
            <option value="data"${cfg.mode === 'data' ? ' selected' : ''}>仅数据（约 0.1 MB）</option>
            <option value="data+art"${cfg.mode === 'data+art' ? ' selected' : ''}>数据+立绘+原画+语音（约 72 MB）</option>
            <option value="full"${cfg.mode === 'full' ? ' selected' : ''}>全部，含 .shap（约 208 MB）</option>
          </select>
        </div>
        <div class="field"><label>轮询间隔（秒）</label>
          <input id="syInterval" type="number" min="15" value="${esc(Math.round((cfg.autoCheckMs ?? 60000) / 1000))}"></div>
        <div class="field wide"><label>代理（git 不读 Windows 系统代理，留空则直连）</label>
          <input id="syProxy" value="${esc(cfg.proxy ?? '')}" placeholder="http://127.0.0.1:7892"></div>
        <div class="field wide"><label>git 工作副本位置</label>
          <input id="syWork" value="${esc(cfg.work ?? '')}"></div>
      </div>
      <p class="modal-sub" style="margin:12px 0 0">
        提示：这台机器上 github.com 直连会被打断，需要挂着代理并在上面填对端口。
        改完保存后点一次「检查」验证是否连得上。
      </p>
      <div class="modal-foot">
        <button class="ghost-btn" data-close-modal="1">取消</button>
        <button class="primary-btn" id="sySave">保存</button>
      </div>
    `);

    $('#sySave').addEventListener('click', async () => {
      const body = {
        remote: $('#syRemote').value.trim(),
        branch: $('#syBranch').value.trim() || 'main',
        mode: $('#syMode').value,
        proxy: $('#syProxy').value.trim(),
        work: $('#syWork').value.trim(),
        autoCheckMs: Math.max(15000, (Number($('#syInterval').value) || 60) * 1000),
      };
      try {
        const r = await api('/api/sync/config', { method: 'PUT', body: JSON.stringify(body) });
        closeModal();
        applySync({ ...(state.sync ?? {}), config: r.config });
        scheduleSyncPoll();
        toast('同步设置已保存', 'ok');
        triggerSync('check');
      } catch (err) {
        toast(`保存失败：${err.message}`, 'err');
      }
    });
  }

  /** 同步面板的事件（按钮在侧栏，事件委托到 #syncBox） */
  function bindSyncEvents() {
    const box = $('#syncBox');
    if (box) {
      box.addEventListener('click', (e) => {
        const b = e.target.closest('[data-sync]');
        if (b) triggerSync(b.dataset.sync);
      });
    }
    const gear = $('#btnSyncSettings');
    if (gear) gear.addEventListener('click', syncSettingsModal);

    // 页面重新可见时立刻刷一次（切回来就能看到最新状态）
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) refreshSync();
    });
  }

  /* --------------------------- 保存 --------------------------- */

  async function saveDraft() {
    if (!state.draft) return;
    const c = state.draft;
    if (!String(c.name ?? '').trim()) {
      toast('武将名不能为空', 'err');
      return;
    }
    // 把「当前卡面」的表单值收进草稿
    syncActiveCardFromDom();
    if (!(c.cards ?? []).length) {
      c.cards = [{ name: '', image: '', cardImage: '', legendId: '', skills: [], derived: [] }];
    }
    // 兜底防线：已有描述文件却没解析出任何卡面，说明拿到的是残缺数据，宁可拒存
    const original = currentCharacter();
    if (original?.hasJson && !(original.cards ?? []).length && !(c.cards ?? []).some((x) => x.image || x.cardImage || x.skills?.length)) {
      toast('数据不完整，已取消保存（请刷新页面重试）', 'err');
      return;
    }

    $('#btnSave').disabled = true;
    const el = $('#saveState');
    el.textContent = '保存中…';
    el.className = 'save-state';

    try {
      const res = await api(`/api/characters/${encodeURIComponent(state.currentId)}`, {
        method: 'PUT',
        body: JSON.stringify(c),
      });
      const fresh = res.character;
      const i = state.characters.findIndex((x) => x.id === state.currentId);
      if (i >= 0) state.characters[i] = { ...state.characters[i], ...fresh };

      state.editing = false;
      state.draft = null;
      state.dirty = false;
      renderSidebar();
      renderGrid();
      renderDrawer();
      el.textContent = '已保存';
      el.className = 'save-state ok';
      toast('已保存到 武将.json', 'ok');
    } catch (err) {
      el.textContent = '保存失败';
      el.className = 'save-state err';
      toast(`保存失败：${err.message}`, 'err');
      updateSaveBar();
    }
  }

  /* --------------------------- 表单双向绑定 --------------------------- */

  function bindDrawerEvents() {
    const body = $('#drawerBody');

    // 统一 input 事件
    body.addEventListener('input', (e) => {
      const t = e.target;
      if (!state.editing || !state.draft) return;

      // 顶层字段
      const field = t.dataset.field;
      if (field) {
        let v = t.value;
        if (t.type === 'number') v = Number(v);
        state.draft[field] = v;
        if (field === 'name') {
          $('#dName').textContent = v || '（未命名）';
        }
        if (field === 'title') $('#dTitle').textContent = v;
        if (field === 'kingdom') {
          $('#dKingdom').textContent = kingdomLabel(v);
          $('#dKingdom').className = `chip kingdom ${kingdomClass(v)}`;
        }
        markDirty();
        return;
      }

      // 卡面字段
      const cardField = t.dataset.cardField;
      if (cardField) {
        const card = state.draft.cards[state.activeCardIndex];
        if (card) {
          card[cardField] = t.value;
          if (cardField === 'image' || cardField === 'cardImage') refreshPreview();
          markDirty();
        }
        return;
      }

      // 技能字段
      const skillField = t.dataset.skillField;
      if (skillField) {
        const item = t.closest('[data-skill-index]');
        const idx = Number(item?.dataset.skillIndex);
        const skill = state.draft.cards[state.activeCardIndex]?.skills?.[idx];
        if (skill) {
          skill[skillField] = t.type === 'checkbox' ? t.checked : t.value;
          if (skillField === 'derived') syncDerivedList();
          markDirty();
        }
      }
    });

    // 标签输入回车
    body.addEventListener('keydown', (e) => {
      const t = e.target;
      if (t.id === 'tagAddInput' && e.key === 'Enter') {
        e.preventDefault();
        const v = t.value.trim();
        if (!v || !state.draft) return;
        if (!Array.isArray(state.draft.tags)) state.draft.tags = [];
        if (!state.draft.tags.includes(v)) state.draft.tags.push(v);
        renderDrawer();
        markDirty();
        setTimeout(() => $('#tagAddInput')?.focus(), 0);
      }
    });

    // 点击类操作
    body.addEventListener('click', async (e) => {
      const t = e.target;

      // 卡面切换
      const tab = t.closest('[data-card-tab]');
      if (tab) {
        if (state.editing) syncActiveCardFromDom();
        state.activeCardIndex = Number(tab.dataset.cardTab);
        renderDrawer();
        return;
      }

      if (t.closest('[data-add-card]')) {
        if (state.editing) syncActiveCardFromDom();
        state.draft.cards.push({ name: `卡面 ${state.draft.cards.length + 1}`, image: '', cardImage: '', legendId: '', skills: [], derived: [] });
        state.activeCardIndex = state.draft.cards.length - 1;
        renderDrawer();
        markDirty();
        return;
      }

      if (t.closest('[data-del-card]')) {
        if (state.draft.cards.length <= 1) { toast('至少要留一张卡面', 'err'); return; }
        if (!confirm('删除当前卡面？')) return;
        state.draft.cards.splice(state.activeCardIndex, 1);
        state.activeCardIndex = Math.max(0, state.activeCardIndex - 1);
        renderDrawer();
        markDirty();
        return;
      }

      if (t.closest('[data-add-skill]')) {
        const card = state.draft.cards[state.activeCardIndex];
        card.skills.push({ name: '', desc: '' });
        renderDrawer();
        markDirty();
        // 聚焦到新技能名
        const items = $$('.skill-item', $('#drawerBody'));
        items[items.length - 1]?.querySelector('[data-skill-field="name"]')?.focus();
        return;
      }

      const del = t.closest('[data-del-skill]');
      if (del) {
        const idx = Number(del.dataset.delSkill);
        const card = state.draft.cards[state.activeCardIndex];
        if (!confirm(`删除技能「${card.skills[idx]?.name || '(未命名)'}」？`)) return;
        card.skills.splice(idx, 1);
        syncDerivedList();
        renderDrawer();
        markDirty();
        return;
      }

      const mv = t.closest('[data-skill-move]');
      if (mv) {
        const item = mv.closest('[data-skill-index]');
        const idx = Number(item.dataset.skillIndex);
        const dir = Number(mv.dataset.skillMove);
        const card = state.draft.cards[state.activeCardIndex];
        const next = idx + dir;
        if (next < 0 || next >= card.skills.length) return;
        syncActiveCardFromDom();
        [card.skills[idx], card.skills[next]] = [card.skills[next], card.skills[idx]];
        renderDrawer();
        markDirty();
        return;
      }

      const dt = t.closest('[data-del-tag]');
      if (dt) {
        state.draft.tags = (state.draft.tags ?? []).filter((x) => x !== dt.dataset.delTag);
        syncDerivedList();
        renderDrawer();
        markDirty();
        return;
      }

      // 设为主图
      const use = t.closest('[data-use-image]');
      if (use) {
        const asset = use.closest('[data-asset]');
        const file = asset?.dataset.asset;
        if (file && state.editing) {
          const card = state.draft.cards[state.activeCardIndex];
          const isCardArt = /^新UI\./.test(file) || /-原画\./.test(file);
          if (isCardArt) card.cardImage = file;
          else card.image = file;
          renderDrawer();
          markDirty();
          toast(`已设为主图：${file}`, 'ok');
        } else if (file) {
          toast('先点「编辑」才能改主图');
        }
        return;
      }

      // 播放语音
      const au = t.closest('[data-audio]');
      if (au) {
        const c = currentCharacter();
        new Audio(fileUrl(c.dir, au.dataset.audio)).play().catch(() => toast('播放失败', 'err'));
        return;
      }

      // 上传图片
      if (t.closest('[data-upload]')) {
        pickAndUpload();
        return;
      }

      // 点击素材图片放大
      const asset = t.closest('[data-asset]');
      if (asset && !state.editing) {
        const c = currentCharacter();
        showImageModal(imgUrl(c.dir, asset.dataset.asset), asset.dataset.asset);
      }
    });
  }

  /** 把「当前卡面」输入框里的值同步回草稿（切卡面 / 保存前调用） */
  function syncActiveCardFromDom() {
    if (!state.editing || !state.draft) return;
    const card = state.draft.cards[state.activeCardIndex];
    if (!card) return;
    const body = $('#drawerBody');
    for (const el of $$('[data-card-field]', body)) {
      card[el.dataset.cardField] = el.value;
    }
    for (const item of $$('[data-skill-index]', body)) {
      const idx = Number(item.dataset.skillIndex);
      const skill = card.skills[idx];
      if (!skill) continue;
      for (const el of $$('[data-skill-field]', item)) {
        skill[el.dataset.skillField] = el.type === 'checkbox' ? el.checked : el.value;
      }
    }
  }

  function syncDerivedList() { /* derived 数组由服务端按技能上的标记重建，这里无需处理 */ }

  function refreshPreview() {
    const c = state.draft;
    const card = c.cards[state.activeCardIndex];
    const box = $('.card-preview', $('#drawerBody'));
    if (!box || !card) return;
    const img = card.image || card.cardImage;
    if (!img) {
      box.innerHTML = `<div class="placeholder"><div class="ph-mark">🀄</div><div class="ph-hint">没有可用卡图</div></div>`;
    } else {
      box.innerHTML = `<img src="${esc(imgUrl(c.dir, img))}?t=${Date.now()}" alt="">`;
    }
  }

  /* --------------------------- 上传图片 --------------------------- */

  function pickAndUpload() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.multiple = true;
    input.addEventListener('change', async () => {
      const files = [...(input.files ?? [])];
      if (!files.length) return;
      const c = currentCharacter();
      if (!c) return;
      for (const f of files) {
        try {
          const dataUrl = await new Promise((resolve, reject) => {
            const r = new FileReader();
            r.onload = () => resolve(r.result);
            r.onerror = () => reject(new Error('读取文件失败'));
            r.readAsDataURL(f);
          });
          await api(`/api/upload/${encodeURIComponent(c.dir)}`, {
            method: 'POST',
            body: JSON.stringify({ filename: f.name, dataUrl }),
          });
          toast(`已上传：${f.name}`, 'ok');
        } catch (err) {
          toast(`上传失败 ${f.name}：${err.message}`, 'err');
        }
      }
      await reloadOne(c.id);
      renderDrawer();
    });
    input.click();
  }

  function showImageModal(src, label) {
    openModal(`
      <h3>${esc(label)}</h3>
      <p class="modal-sub">素材原图</p>
      <img src="${esc(src)}" style="max-width:100%;border-radius:var(--r-md);display:block">
      <div class="modal-foot">
        <a class="ghost-btn" href="${esc(src)}?download=1" download style="text-decoration:none">下载</a>
        <button class="primary-btn" data-close-modal="1">关闭</button>
      </div>
    `);
  }

  /* --------------------------- 弹窗 --------------------------- */

  function openModal(html) {
    $('#modal').innerHTML = html;
    $('#modalMask').hidden = false;
  }
  function closeModal() {
    $('#modalMask').hidden = true;
    $('#modal').innerHTML = '';
  }

  function newCharacterModal() {
    const groups = ['', '_待实现'];
    openModal(`
      <h3>新建武将</h3>
      <p class="modal-sub">会在 素材\\ 下新建一个文件夹，并写入 武将.json</p>
      <div class="form-grid">
        <div class="field"><label>武将名 *</label><input id="nName" placeholder="如 胡桃"></div>
        <div class="field"><label>称号</label><input id="nTitle" placeholder="如 往生堂主"></div>
        <div class="field"><label>势力</label>
          <select id="nKingdom"><option value="">—</option>
            ${KINGDOMS.map((k) => `<option value="${k.code}">${k.name}</option>`).join('')}
          </select>
        </div>
        <div class="field"><label>编号</label><input id="nLegendId" placeholder="如 ARK 013"></div>
        <div class="field"><label>体力</label><input id="nHp" type="number" value="3"></div>
        <div class="field"><label>体力上限</label><input id="nMaxHp" type="number" value="3"></div>
        <div class="field"><label>护甲</label><input id="nShield" type="number" value="0"></div>
        <div class="field"><label>性别</label>
          <select id="nGender"><option value="">—</option><option>男</option><option>女</option></select>
        </div>
        <div class="field"><label>文件夹名（默认用武将名）</label><input id="nDir" placeholder="留空 = 用武将名"></div>
        <div class="field"><label>放在</label>
          <select id="nGroup">${groups.map((g) => `<option value="${g}">${g || '素材根目录'}</option>`).join('')}</select>
        </div>
        <div class="field wide"><label>原作（只能一个，可留空）</label>
          <input id="nOrigin" list="newOriginSuggest" placeholder="如 明日方舟 / 东方Project / 原神 / 三国杀 / 原创">
          <datalist id="newOriginSuggest">${originChoices().map((o) => `<option value="${esc(o)}">`).join('')}</datalist>
        </div>
        <div class="field wide"><label>标签（玩法特性，逗号分隔，可多个）</label><input id="nTags" placeholder="如 过牌, 输出, 减益"></div>
      </div>
      <div class="modal-foot">
        <button class="ghost-btn" data-close-modal="1">取消</button>
        <button class="primary-btn" id="nCreate">创建</button>
      </div>
    `);

    // 武将名 → 文件夹名 自动跟随
    const nameEl = $('#nName');
    const dirEl = $('#nDir');
    let dirTouched = false;
    dirEl.addEventListener('input', () => { dirTouched = true; });
    nameEl.addEventListener('input', () => {
      if (!dirTouched) dirEl.value = nameEl.value.trim();
    });
    nameEl.focus();

    $('#nCreate').addEventListener('click', async () => {
      const name = $('#nName').value.trim();
      if (!name) { toast('武将名不能为空', 'err'); return; }
      const hp = Number($('#nHp').value) || 3;
      const body = {
        name,
        title: $('#nTitle').value.trim(),
        kingdom: $('#nKingdom').value,
        legendId: $('#nLegendId').value.trim(),
        hp,
        maxHp: Number($('#nMaxHp').value) || hp,
        shield: Number($('#nShield').value) || 0,
        gender: $('#nGender').value,
        dir: $('#nDir').value.trim() || name,
        group: $('#nGroup').value,
        origin: $('#nOrigin').value.trim(),
        tags: $('#nTags').value.split(/[,，、\s]+/).map((s) => s.trim()).filter(Boolean),
      };
      try {
        const res = await api('/api/characters', { method: 'POST', body: JSON.stringify(body) });
        closeModal();
        await loadAll();
        toast(`已创建「${res.character.name}」`, 'ok');
        openDrawer(res.character.id);
        startEdit();
      } catch (err) {
        toast(`创建失败：${err.message}`, 'err');
      }
    });
  }

  /**
   * 管理「原作」与「标签」两张表。
   * 这里维护的是清单本身；给某个武将挂原作/标签请在他的详情里编辑。
   * 改名会同步更新所有武将（原作改的是 origin 字段，标签改的是 tags 数组）。
   */
  function tagManageModal() {
    const tagCounts = new Map();
    const originCounts = new Map();
    for (const c of state.characters) {
      for (const t of c.tags ?? []) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
      if (c.origin) originCounts.set(c.origin, (originCounts.get(c.origin) ?? 0) + 1);
    }

    const originAll = [...new Set([...(state.directoryOrigins ?? []), ...(state.originPresets ?? []), ...originCounts.keys()])];
    const tagAll = [...new Set([...(state.directoryTags ?? []), ...tagCounts.keys()])];

    const rowHtmlFor = (v, n, kind) => `<div class="tag-manage-row" data-kind="${kind}">
      <input value="${esc(v)}" data-tag-orig="${esc(v)}">
      <span class="count">${n} 位</span>
      <button class="icon-btn" data-tag-del="${esc(v)}" title="从清单里移除（不会改武将数据）">✕</button>
    </div>`;

    openModal(`
      <h3>管理原作与标签</h3>
      <p class="modal-sub">
        这里维护的是两张清单本身，给某个武将挂原作 / 标签请到他的详情里编辑。改名会同步更新所有武将。<br>
        原作是单选：一个武将只能属于一个原作。
      </p>

      <div class="side-head" style="padding-left:0"><span>原作</span></div>
      <div class="tag-manage-list" id="originManageList">
        ${originAll.map((o) => rowHtmlFor(o, originCounts.get(o) ?? 0, 'origin')).join('') || '<div class="note-box">还没有原作。</div>'}
      </div>
      <div style="display:flex;gap:8px;margin-bottom:18px">
        <input class="tag-add-input" id="newOriginInput" placeholder="新原作名" style="flex:1;border-radius:var(--r-sm)">
        <button class="ghost-btn" id="addOriginBtn">添加</button>
      </div>

      <div class="side-head" style="padding-left:0"><span>标签</span></div>
      <div class="tag-manage-list" id="tagManageList">
        ${tagAll.map((t) => rowHtmlFor(t, tagCounts.get(t) ?? 0, 'tag')).join('') || '<div class="note-box">还没有标签。</div>'}
      </div>
      <div style="display:flex;gap:8px">
        <input class="tag-add-input" id="newTagInput" placeholder="新标签名" style="flex:1;border-radius:var(--r-sm)">
        <button class="ghost-btn" id="addTagBtn">添加</button>
      </div>

      <div class="modal-foot">
        <button class="ghost-btn" data-close-modal="1">取消</button>
        <button class="primary-btn" id="saveTagsBtn">保存</button>
      </div>
    `);

    const bindAdd = (inputSel, btnSel, listSel) => {
      $(btnSel).addEventListener('click', () => {
        const v = $(inputSel).value.trim();
        if (!v) return;
        const list = $(listSel);
        const dup = [...list.querySelectorAll('input')].some((i) => i.value.trim() === v);
        if (dup) { toast('这个已经在清单里了'); return; }
        const ph = list.querySelector('.note-box');
        if (ph) ph.remove();
        list.insertAdjacentHTML('beforeend', rowHtmlFor(v, 0, listSel === '#originManageList' ? 'origin' : 'tag'));
        $(inputSel).value = '';
      });
    };
    bindAdd('#newOriginInput', '#addOriginBtn', '#originManageList');
    bindAdd('#newTagInput', '#addTagBtn', '#tagManageList');

    $('#modal').addEventListener('click', (e) => {
      const del = e.target.closest('[data-tag-del]');
      if (del) del.closest('.tag-manage-row').remove();
    });

    $('#saveTagsBtn').addEventListener('click', async () => {
      const collect = (sel) => {
        const out = [];
        const renames = [];
        for (const r of $$(`${sel} .tag-manage-row`)) {
          const input = r.querySelector('input');
          const orig = input?.dataset.tagOrig ?? '';
          const next = input.value.trim();
          if (!next) continue;
          out.push(next);
          if (orig && orig !== next) renames.push([orig, next]);
        }
        return { list: [...new Set(out)], renames };
      };

      const originPart = collect('#originManageList');
      const tagPart = collect('#tagManageList');

      try {
        // 原作改名：写 origin 字段
        for (const [from, to] of originPart.renames) {
          for (const c of state.characters.filter((x) => x.origin === from)) {
            await api(`/api/characters/${encodeURIComponent(c.id)}`, {
              method: 'PUT',
              body: JSON.stringify({ ...c, origin: to }),
            });
          }
        }
        // 标签改名：写 tags 数组
        for (const [from, to] of tagPart.renames) {
          for (const c of state.characters.filter((x) => (x.tags ?? []).includes(from))) {
            const tags = (c.tags ?? []).map((t) => (t === from ? to : t));
            await api(`/api/characters/${encodeURIComponent(c.id)}`, {
              method: 'PUT',
              body: JSON.stringify({ ...c, tags }),
            });
          }
        }
        await api('/api/tags', {
          method: 'PUT',
          body: JSON.stringify({ tags: tagPart.list, origins: originPart.list }),
        });
        closeModal();
        await loadAll();
        toast('原作与标签清单已保存', 'ok');
      } catch (err) {
        toast(`保存失败：${err.message}`, 'err');
      }
    });
  }

  /* --------------------------- 删除武将 --------------------------- */

  async function deleteCharacter() {
    const c = currentCharacter();
    if (!c) return;
    if (!confirm(`把「${c.name}」整个文件夹移到回收站？\n\n位置：.data\\回收站\\\n（可以从那里还原）`)) return;
    try {
      await api(`/api/characters/${encodeURIComponent(c.id)}`, { method: 'DELETE' });
      const dir = c.dir;
      state.characters = state.characters.filter((x) => x.id !== c.id);
      closeDrawer();
      renderSidebar();
      renderGrid();
      toast(`已移入回收站：${dir}`, 'ok');
    } catch (err) {
      toast(`删除失败：${err.message}`, 'err');
    }
  }

  /* --------------------------- 事件绑定 --------------------------- */

  function bindGlobalEvents() {
    // 侧栏点击
    $('#sidebar').addEventListener('click', (e) => {
      const row = e.target.closest('.tag-row');
      if (!row) return;
      const key = row.dataset.key;
      if (key === 'tag:') {
        // 「全部标签」= 清空标签筛选（不动原作/势力）
        state.filterTags.clear();
      } else if (key === 'origin:') {
        state.filterOrigin = '';          // 全部原作
      } else if (key === 'kingdom:') {
        state.filterKingdom = '';
      } else if (key.startsWith('origin:')) {
        // 原作单选：点已选中的取消，点别的直接替换
        const o = key.slice(7);
        state.filterOrigin = state.filterOrigin === o ? '' : o;
      } else if (key.startsWith('tag:')) {
        const t = key.slice(4);
        if (state.filterTags.has(t)) state.filterTags.delete(t);
        else state.filterTags.add(t);
      } else if (key.startsWith('kingdom:')) {
        const k = key.slice(8);
        state.filterKingdom = state.filterKingdom === k ? '' : k;
      }
      renderSidebar();
      renderGrid();
    });

    // 清除筛选 chip
    $('#activeFilters').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-clear]');
      if (!btn) return;
      const key = btn.dataset.clear;
      if (key === '__kw__') { state.keyword = ''; $('#search').value = ''; }
      else if (key === '__incomplete__') { state.onlyIncomplete = false; $('#onlyIncomplete').checked = false; }
      else if (key.startsWith('origin:')) state.filterOrigin = '';
      else if (key.startsWith('tag:')) state.filterTags.delete(key.slice(4));
      else if (key.startsWith('kingdom:')) state.filterKingdom = '';
      renderSidebar();
      renderGrid();
    });

    // 搜索
    let searchTimer;
    $('#search').addEventListener('input', (e) => {
      clearTimeout(searchTimer);
      const v = e.target.value;
      searchTimer = setTimeout(() => {
        state.keyword = v;
        renderSidebar();
        renderGrid();
      }, 130);
    });

    // 只看待补
    $('#onlyIncomplete').addEventListener('change', (e) => {
      state.onlyIncomplete = e.target.checked;
      renderSidebar();
      renderGrid();
    });

    // 视图切换
    $$('.seg button').forEach((b) => b.addEventListener('click', () => {
      $$('.seg button').forEach((x) => x.classList.toggle('active', x === b));
      state.view = b.dataset.view;
      renderGrid();
    }));

    // 卡片点击：点原作 / 标签小片是「按它筛选」，点别处才打开详情
    $('#grid').addEventListener('click', (e) => {
      const tagChip = e.target.closest('[data-filter-tag]');
      if (tagChip) {
        const t = tagChip.dataset.filterTag;
        if (state.filterTags.has(t)) state.filterTags.delete(t);
        else state.filterTags.add(t);
        renderSidebar();
        renderGrid();
        return;
      }

      const originChip = e.target.closest('[data-filter-origin]');
      if (originChip) {
        const o = originChip.dataset.filterOrigin;
        state.filterOrigin = state.filterOrigin === o ? '' : o;
        renderSidebar();
        renderGrid();
        return;
      }

      const card = e.target.closest('.card');
      if (card) openDrawer(card.dataset.id);
    });

    // 抽屉按钮
    $('#btnCloseDrawer').addEventListener('click', closeDrawer);
    $('#drawerMask').addEventListener('click', closeDrawer);
    $('#btnCardEdit').addEventListener('click', () => {
      if (state.editing) {
        if (state.dirty) saveDraft();
        else cancelEdit();
      } else startEdit();
    });
    $('#btnCardDelete').addEventListener('click', deleteCharacter);
    $('#btnSave').addEventListener('click', saveDraft);
    $('#btnRevert').addEventListener('click', cancelEdit);

    // 顶部
    $('#btnNew').addEventListener('click', newCharacterModal);
    $('#btnEditTags').addEventListener('click', tagManageModal);
    $('#btnReload').addEventListener('click', () => loadAll(true));
    $('#btnMenu').addEventListener('click', () => $('#sidebar').classList.toggle('open'));

    // 弹窗
    $('#modalMask').addEventListener('click', (e) => {
      if (e.target === $('#modalMask') || e.target.closest('[data-close-modal]')) closeModal();
    });

    // 快捷键
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (!$('#modalMask').hidden) closeModal();
        else if (!$('#drawer').hidden) closeDrawer();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (state.editing && state.dirty) saveDraft();
        return;
      }
      // 「/」聚焦搜索
      if (e.key === '/' && !/input|textarea|select/i.test(e.target.tagName)) {
        e.preventDefault();
        $('#search').focus();
      }
    });

    // 关窗前提醒
    window.addEventListener('beforeunload', (e) => {
      if (state.dirty) { e.preventDefault(); e.returnValue = ''; }
    });

    bindDrawerEvents();
    bindSyncEvents();

    // 素材变化时自动刷新（服务端写完文件后 mtime 会变）
    window.addEventListener('focus', async () => {
      if (state.dirty || state.editing) return;
      try {
        const data = await api('/api/characters');
        const changed = data.characters.length !== state.characters.length ||
          data.characters.some((c, i) => c.mtime !== state.characters[i]?.mtime);
        if (changed) {
          state.characters = (data.characters ?? []).map((c) => ({ ...c, loadedFull: false }));
          state.tags = data.tags ?? [];
          state.origins = data.origins ?? [];
          state.originPresets = data.originPresets ?? state.origins;
          state.directoryTags = data.directoryTags ?? [];
          state.directoryOrigins = data.directoryOrigins ?? [];
          renderSidebar();
          renderGrid();
        }
      } catch { /* 服务可能已停 */ }
    });
  }

  /* ------------------------------ 启动 ------------------------------ */

  async function boot() {
    bindGlobalEvents();
    bindSyncEvents();
    await loadAll();
    // 支持 #武将 / #tag 之类的深链（可选）
    const hash = decodeURIComponent(location.hash.replace(/^#/, ''));
    if (hash && state.characters.some((c) => c.id === hash)) openDrawer(hash);

    // 首屏先拉一次实时状态，然后开始常态轮询
    refreshSync();
    scheduleSyncPoll();
  }

  boot();
})();
