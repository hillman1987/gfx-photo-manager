/* GFX 照片库 — 前端主逻辑（零依赖原生 JS） */
'use strict';

/* ========================= 常量 ========================= */

const GAP = 12;
const MIN_CARD_W = 200;
const MAX_CARD_W = 300;
const META_H = 70;          // 卡片底部信息区高度
const BUFFER_ROWS = 2;      // 虚拟滚动上下缓冲行
const STORE_KEY = 'gfx-lib-prefs';

// 常用城市中心点：用于把 GPS 坐标粗略归到城市（距离 < 60km 命中）
const CITIES = [
  ['东京', 35.6762, 139.6503], ['大阪', 34.6937, 135.5023], ['京都', 35.0116, 135.7681],
  ['福冈', 33.5904, 130.4017], ['北海道·札幌', 43.0618, 141.3545], ['横滨', 35.4478, 139.6425],
  ['名古屋', 35.1815, 136.9066], ['神户', 34.6901, 135.1956], ['冲绳·那霸', 26.2124, 127.6809],
  ['首尔', 37.5665, 126.9780], ['釜山', 35.1796, 129.0756], ['曼谷', 13.7563, 100.5018],
  ['新加坡', 1.3521, 103.8198], ['中国香港', 22.3193, 114.1694], ['中国澳门', 22.1987, 113.5439],
  ['台北', 25.0330, 121.5654], ['北京', 39.9042, 116.4074], ['上海', 31.2304, 121.4737],
  ['广州', 23.1291, 113.2644], ['深圳', 22.5431, 114.0579], ['杭州', 30.2741, 120.1551],
  ['成都', 30.5728, 104.0668], ['重庆', 29.5630, 106.5516], ['西安', 34.3416, 108.9398],
  ['南京', 32.0603, 118.7969], ['苏州', 31.2989, 120.5853], ['青岛', 36.0671, 120.3826],
  ['厦门', 24.4798, 118.0894], ['三亚', 18.2528, 109.5119], ['昆明', 25.0389, 102.7183],
  ['大理', 25.6065, 100.2676], ['丽江', 26.8721, 100.2299], ['拉萨', 29.6520, 91.1721],
  ['巴黎', 48.8566, 2.3522], ['伦敦', 51.5074, -0.1278], ['米兰', 45.4642, 9.1900],
  ['罗马', 41.9028, 12.4964], ['巴塞罗那', 41.3851, 2.1734], ['柏林', 52.5200, 13.4050],
  ['阿姆斯特丹', 52.3676, 4.9041], ['苏黎世', 47.3769, 8.5417], ['纽约', 40.7128, -74.0060],
  ['旧金山', 37.7749, -122.4194], ['洛杉矶', 34.0522, -118.2437], ['温哥华', 49.2827, -123.1207],
  ['悉尼', -33.8688, 151.2093], ['奥克兰', -36.8485, 174.7633], ['迪拜', 25.2048, 55.2708],
  ['伊斯坦布尔', 41.0082, 28.9784], ['开普敦', -33.9249, 18.4241],
];

/* ========================= 状态 ========================= */

const state = {
  photos: [],
  allTags: [],
  filtered: [],
  sort: 'date-desc',
  selectMode: false,
  selection: new Set(),
  showInfoPanel: true,
  lightbox: { open: false, index: -1 },
  cardW: 240,
  cardH: 250,
  cols: 4,
  rendered: new Map(),   // index -> element
  filters: {
    keyword: '',
    tags: [],
    tagMode: 'or',
    filmModes: [],
    lenses: [],
    cameras: [],
    dynamicRange: [],
    rating: 0,
    favorite: false,
    hasRaw: null,
    hasGps: null,
    iso: [null, null],
    aperture: [null, null],
    yearMonth: null,
    location: null,
  },
};

/* ========================= 工具 ========================= */

const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function fmtDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return `${fmtDate(iso)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function fmtBytes(n) {
  if (!n) return '—';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0, v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
}

function ymOf(iso) {
  if (!iso) return '未知日期';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '未知日期' : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function locationOf(p) {
  if (p.exif?.locationName) return p.exif.locationName;
  const g = p.exif?.gps;
  if (!g) return null;
  let best = null, bestD = Infinity;
  for (const [name, lat, lon] of CITIES) {
    const d = Math.hypot((g.lat - lat), (g.lon - lon) * Math.cos((g.lat * Math.PI) / 180));
    if (d < bestD) { bestD = d; best = name; }
  }
  if (best && bestD * 111 < 60) return best;
  return `${g.lat.toFixed(2)}, ${g.lon.toFixed(2)}`;
}

function starSvg(filled, size = 13) {
  const f = filled ? 'currentColor' : 'none';
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="${f}" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M12 2.6l2.9 5.9 6.5.9-4.7 4.6 1.1 6.5-5.8-3-5.8 3 1.1-6.5L2.6 9.4l6.5-.9z"/></svg>`;
}

function heartSvg(filled, size = 15) {
  const f = filled ? 'currentColor' : 'none';
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="${f}" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M20.8 4.6a5.5 5.5 0 00-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 00-7.8 7.8l1 1.1L12 21.2l7.8-7.7 1-1.1a5.5 5.5 0 000-7.8z"/></svg>`;
}

function toast(msg, type = '') {
  const host = $('toastHost');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  host.appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .25s, transform .25s';
    el.style.opacity = '0';
    el.style.transform = 'translateY(6px)';
    setTimeout(() => el.remove(), 250);
  }, 1900);
}

/* ========================= 数据加载 ========================= */

async function loadData() {
  const res = await fetch('/api/index');
  if (!res.ok) throw new Error(`索引加载失败 (${res.status})`);
  const data = await res.json();
  state.photos = data.photos || [];
  state.allTags = data.tags || [];
  state.generatedAt = data.generatedAt || null;
  if (data.generatedAt) {
    const d = new Date(data.generatedAt);
    $('libInfo').textContent = `${state.photos.length} 张 · 索引 ${fmtDateTime(data.generatedAt)}`;
  }
  if (data.total === 0) {
    $('emptyTitle').textContent = '照片库是空的';
    $('emptyDesc').innerHTML =
      '在项目目录执行 <code>npm run scan</code> 扫描照片，然后刷新本页。<br>扫描前请先编辑 <code>config.json</code> 设置照片目录。';
  }
}

/* ========================= 筛选 ========================= */

/** 单张照片是否通过筛选（skip 用于分面计数时忽略某个维度） */
function match(p, skip) {
  const f = state.filters;

  if (skip !== 'keyword' && f.keyword) {
    const k = f.keyword.toLowerCase();
    const hay = [p.name, p.exif?.lens, p.exif?.camera, p.exif?.filmMode, p.user?.note,
      locationOf(p), ...(p.user?.tags || [])].filter(Boolean).join(' ').toLowerCase();
    if (!hay.includes(k)) return false;
  }

  if (skip !== 'tags' && f.tags.length) {
    const t = p.user?.tags || [];
    const hit = f.tagMode === 'and'
      ? f.tags.every((x) => t.includes(x))
      : f.tags.some((x) => t.includes(x));
    if (!hit) return false;
  }

  if (skip !== 'filmModes' && f.filmModes.length && !f.filmModes.includes(p.exif?.filmMode || '未知')) return false;
  if (skip !== 'lenses' && f.lenses.length && !f.lenses.includes(p.exif?.lens || '未知镜头')) return false;
  if (skip !== 'cameras' && f.cameras.length && !f.cameras.includes(p.exif?.camera || '未知机身')) return false;
  if (skip !== 'dynamicRange' && f.dynamicRange.length && !f.dynamicRange.includes(p.exif?.dynamicRange || '未知')) return false;

  if (skip !== 'rating' && f.rating > 0 && (p.user?.rating || 0) < f.rating) return false;
  if (skip !== 'favorite' && f.favorite && !p.user?.favorite) return false;

  if (skip !== 'hasRaw') {
    if (f.hasRaw === true && !p.hasRaw) return false;
    if (f.hasRaw === false && p.hasRaw) return false;
  }
  if (skip !== 'hasGps') {
    const g = Boolean(p.exif?.gps);
    if (f.hasGps === true && !g) return false;
    if (f.hasGps === false && g) return false;
  }

  if (skip !== 'iso') {
    const iso = p.exif?.iso;
    if (f.iso[0] != null && (iso == null || iso < f.iso[0])) return false;
    if (f.iso[1] != null && (iso == null || iso > f.iso[1])) return false;
  }
  if (skip !== 'aperture') {
    const ap = p.exif?.fNumber;
    if (f.aperture[0] != null && (ap == null || ap < f.aperture[0])) return false;
    if (f.aperture[1] != null && (ap == null || ap > f.aperture[1])) return false;
  }

  if (skip !== 'yearMonth' && f.yearMonth) {
    if (ymOf(p.exif?.date) !== f.yearMonth) return false;
  }
  if (skip !== 'location' && f.location) {
    const loc = locationOf(p);
    if (f.location === '（无位置信息）') { if (loc) return false; }
    else if (loc !== f.location) return false;
  }
  return true;
}

function sortPhotos(list) {
  const s = state.sort;
  const num = (v) => (v == null ? -Infinity : Number(v));
  const cmp = {
    'date-desc': (a, b) => String(b.exif?.date || '').localeCompare(String(a.exif?.date || '')),
    'date-asc': (a, b) => String(a.exif?.date || '').localeCompare(String(b.exif?.date || '')),
    'name-asc': (a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }),
    'name-desc': (a, b) => b.name.localeCompare(a.name, 'en', { numeric: true }),
    'rating-desc': (a, b) => (b.user?.rating || 0) - (a.user?.rating || 0) || String(b.exif?.date || '').localeCompare(String(a.exif?.date || '')),
    'iso-desc': (a, b) => num(b.exif?.iso) - num(a.exif?.iso),
    'iso-asc': (a, b) => num(a.exif?.iso) - num(b.exif?.iso),
    'focal-asc': (a, b) => num(a.exif?.focalLength) - num(b.exif?.focalLength),
  }[s];
  return [...list].sort(cmp || cmp['date-desc']);
}

function applyFilters() {
  state.filtered = sortPhotos(state.photos.filter((p) => match(p)));
  renderFacets();
  renderChips();
  renderGrid();
  updateCounts();
}

function updateCounts() {
  const n = state.filtered.length;
  const total = state.photos.length;
  $('resultCount').innerHTML = n === total
    ? `共 <b>${total}</b> 张照片`
    : `筛选出 <b>${n}</b> / ${total} 张`;
  $('resetBtn').style.display = hasActiveFilters() ? '' : 'none';
  $('empty').classList.toggle('on', n === 0);
}

function hasActiveFilters() {
  const f = state.filters;
  return Boolean(
    f.keyword || f.tags.length || f.filmModes.length || f.lenses.length || f.cameras.length ||
    f.dynamicRange.length || f.rating || f.favorite || f.hasRaw !== null || f.hasGps !== null ||
    f.iso[0] != null || f.iso[1] != null || f.aperture[0] != null || f.aperture[1] != null ||
    f.yearMonth || f.location
  );
}

function resetFilters() {
  state.filters = {
    keyword: '', tags: [], tagMode: 'or', filmModes: [], lenses: [], cameras: [], dynamicRange: [],
    rating: 0, favorite: false, hasRaw: null, hasGps: null, iso: [null, null],
    aperture: [null, null], yearMonth: null, location: null,
  };
  $('searchInput').value = '';
  $('searchWrap').classList.remove('has-value');
  applyFilters();
  savePrefs();
}

/* ========================= 分面侧栏 ========================= */

/** 统计某维度各取值的数量（忽略该维度自身的筛选） */
function facetCounts(dim, valueOf) {
  const counts = new Map();
  for (const p of state.photos) {
    if (!match(p, dim)) continue;
    const v = valueOf(p);
    if (v == null) continue;
    counts.set(v, (counts.get(v) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]), 'zh'));
}

function renderFacets() {
  const f = state.filters;
  const sidebar = $('sidebar');
  const scrollTop = sidebar.scrollTop;
  const collapsed = new Set(
    [...sidebar.querySelectorAll('.facet.collapsed')].map((el) => el.dataset.key)
  );

  const facet = (key, title, bodyHtml, activeCount) => `
    <div class="facet ${collapsed.has(key) ? 'collapsed' : ''}" data-key="${key}">
      <div class="facet-head">
        <span class="caret"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg></span>
        <span>${esc(title)}</span>
        ${activeCount ? `<span class="count active">${activeCount}</span>` : ''}
      </div>
      <div class="facet-body">${bodyHtml}</div>
    </div>`;

  const checkList = (dim, values, selected) => {
    if (!values.length) return '<div class="opt empty">无可用选项</div>';
    return values.map(([v, n]) => `
      <label class="opt ${selected.includes(v) ? 'checked' : ''}">
        <input type="checkbox" data-dim="${dim}" value="${esc(v)}" ${selected.includes(v) ? 'checked' : ''}>
        <span class="label" title="${esc(v)}">${esc(v)}</span>
        <span class="n">${n}</span>
      </label>`).join('');
  };

  // 快速筛选
  const quick = `
    <label class="opt ${f.favorite ? 'checked' : ''}">
      <input type="checkbox" data-quick="favorite" ${f.favorite ? 'checked' : ''}>
      <span class="label">只看收藏</span>
      <span class="n">${state.photos.filter((p) => p.user?.favorite).length}</span>
    </label>
    <label class="opt ${f.hasRaw === true ? 'checked' : ''}">
      <input type="checkbox" data-quick="hasRaw" ${f.hasRaw === true ? 'checked' : ''}>
      <span class="label">有 RAW 原片</span>
      <span class="n">${state.photos.filter((p) => p.hasRaw).length}</span>
    </label>
    <label class="opt ${f.hasRaw === false ? 'checked' : ''}">
      <input type="checkbox" data-quick="noRaw" ${f.hasRaw === false ? 'checked' : ''}>
      <span class="label">仅 JPEG</span>
      <span class="n">${state.photos.filter((p) => !p.hasRaw).length}</span>
    </label>
    <label class="opt ${f.hasGps === true ? 'checked' : ''}">
      <input type="checkbox" data-quick="hasGps" ${f.hasGps === true ? 'checked' : ''}>
      <span class="label">带 GPS 定位</span>
      <span class="n">${state.photos.filter((p) => p.exif?.gps).length}</span>
    </label>`;

  // 评分
  const starsHtml = [5, 4, 3, 2, 1].map((n) => `
    <button data-rating="${n}" class="${f.rating === n ? 'on' : ''}" title="≥${n} 星">${starSvg(true, 15)}</button>`).join('');

  // ISO / 光圈
  const isoVals = [...new Set(state.photos.map((p) => p.exif?.iso).filter((v) => v != null))].sort((a, b) => a - b);
  const apVals = [...new Set(state.photos.map((p) => p.exif?.fNumber).filter((v) => v != null))].sort((a, b) => a - b);
  const selOpts = (vals, cur) => `<option value="">不限</option>` +
    vals.map((v) => `<option value="${v}" ${cur === v ? 'selected' : ''}>${v}</option>`).join('');

  const paramsHtml = `
    <div class="range-row">
      <div class="row"><span>ISO</span>
        <select data-range="iso-min">${selOpts(isoVals, f.iso[0])}</select>
        <select data-range="iso-max">${selOpts(isoVals, f.iso[1])}</select>
      </div>
      <div class="row"><span>光圈</span>
        <select data-range="ap-min">${selOpts(apVals, f.aperture[0])}</select>
        <select data-range="ap-max">${selOpts(apVals, f.aperture[1])}</select>
      </div>
    </div>`;

  // 标签
  const tagCounts = facetCounts('tags', (p) => null)
    .length ? [] : (() => {
      const counts = new Map();
      for (const p of state.photos) {
        if (!match(p, 'tags')) continue;
        for (const t of p.user?.tags || []) counts.set(t, (counts.get(t) || 0) + 1);
      }
      return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh'));
    })();
  const tagsHtml = tagCounts.length
    ? `<div style="padding:0 8px 6px;display:flex;gap:4px;align-items:center">
         <button class="swatch ${f.tagMode === 'or' ? 'on' : ''}" data-tagmode="or">任一</button>
         <button class="swatch ${f.tagMode === 'and' ? 'on' : ''}" data-tagmode="and">同时满足</button>
       </div>` + checkList('tags', tagCounts, f.tags)
    : '<div class="opt empty">还没有标签，点开照片即可添加</div>';

  const html = [
    facet('quick', '快速筛选', quick, (f.favorite ? 1 : 0) + (f.hasRaw !== null ? 1 : 0) + (f.hasGps !== null ? 1 : 0)),
    facet('tags', '标签', tagsHtml, f.tags.length),
    facet('film', '胶片模拟', checkList('filmModes', facetCounts('filmModes', (p) => p.exif?.filmMode || '未知'), f.filmModes), f.filmModes.length),
    facet('lens', '镜头', checkList('lenses', facetCounts('lenses', (p) => p.exif?.lens || '未知镜头'), f.lenses), f.lenses.length),
    facet('camera', '机身', checkList('cameras', facetCounts('cameras', (p) => p.exif?.camera || '未知机身'), f.cameras), f.cameras.length),
    facet('rating', '评分', `<div class="stars-filter">${starsHtml}</div>
      ${f.rating ? `<div style="padding:0 8px"><button class="swatch" data-rating="0">清除评分筛选</button></div>` : ''}`, f.rating ? 1 : 0),
    facet('params', '拍摄参数', paramsHtml, (f.iso[0] != null || f.iso[1] != null || f.aperture[0] != null || f.aperture[1] != null) ? 1 : 0),
    facet('dr', '动态范围', checkList('dynamicRange', facetCounts('dynamicRange', (p) => p.exif?.dynamicRange || '未知'), f.dynamicRange), f.dynamicRange.length),
    facet('time', '拍摄时间', checkList('yearMonth', facetCounts('yearMonth', (p) => ymOf(p.exif?.date)), f.yearMonth ? [f.yearMonth] : []), f.yearMonth ? 1 : 0),
    facet('loc', '拍摄地点', checkList('location',
      [...facetCounts('location', (p) => locationOf(p) || '（无位置信息）')], f.location ? [f.location] : []), f.location ? 1 : 0),
  ].join('');

  sidebar.innerHTML = html;
  sidebar.scrollTop = scrollTop;
  bindFacetEvents();
}

function bindFacetEvents() {
  const sidebar = $('sidebar');

  sidebar.querySelectorAll('.facet-head').forEach((h) => {
    h.addEventListener('click', () => h.parentElement.classList.toggle('collapsed'));
  });

  sidebar.querySelectorAll('input[type=checkbox][data-dim]').forEach((cb) => {
    cb.addEventListener('change', () => {
      const dim = cb.dataset.dim;
      const val = cb.value;
      const arr = state.filters[dim];
      if (cb.checked) {
        // 时间/地点为单选
        if (dim === 'yearMonth') state.filters.yearMonth = val;
        else if (dim === 'location') state.filters.location = val;
        else if (!arr.includes(val)) arr.push(val);
      } else {
        if (dim === 'yearMonth') state.filters.yearMonth = null;
        else if (dim === 'location') state.filters.location = null;
        else {
          const i = arr.indexOf(val);
          if (i >= 0) arr.splice(i, 1);
        }
      }
      applyFilters();
      savePrefs();
    });
  });

  sidebar.querySelectorAll('input[data-quick]').forEach((cb) => {
    cb.addEventListener('change', () => {
      const k = cb.dataset.quick;
      if (k === 'favorite') state.filters.favorite = cb.checked;
      if (k === 'hasRaw') state.filters.hasRaw = cb.checked ? true : null;
      if (k === 'noRaw') state.filters.hasRaw = cb.checked ? false : null;
      if (k === 'hasGps') state.filters.hasGps = cb.checked ? true : null;
      applyFilters();
      savePrefs();
    });
  });

  sidebar.querySelectorAll('[data-rating]').forEach((b) => {
    b.addEventListener('click', () => {
      state.filters.rating = Number(b.dataset.rating);
      applyFilters();
      savePrefs();
    });
  });

  sidebar.querySelectorAll('[data-tagmode]').forEach((b) => {
    b.addEventListener('click', () => {
      state.filters.tagMode = b.dataset.tagmode;
      applyFilters();
      savePrefs();
    });
  });

  sidebar.querySelectorAll('select[data-range]').forEach((s) => {
    s.addEventListener('change', () => {
      const [key, side] = s.dataset.range.split('-');
      const v = s.value === '' ? null : Number(s.value);
      if (key === 'iso') state.filters.iso[side === 'min' ? 0 : 1] = v;
      else state.filters.aperture[side === 'min' ? 0 : 1] = v;
      // 保证 min <= max
      const arr = key === 'iso' ? state.filters.iso : state.filters.aperture;
      if (arr[0] != null && arr[1] != null && arr[0] > arr[1]) arr.reverse();
      applyFilters();
      savePrefs();
    });
  });
}

/* ========================= 已选条件 chips ========================= */

function renderChips() {
  const f = state.filters;
  const chips = [];
  const add = (text, onClear) => chips.push({ text, onClear });

  if (f.keyword) add(`关键词：${f.keyword}`, () => { f.keyword = ''; $('searchInput').value = ''; $('searchWrap').classList.remove('has-value'); });
  if (f.favorite) add('只看收藏', () => { f.favorite = false; });
  if (f.hasRaw === true) add('有 RAW', () => { f.hasRaw = null; });
  if (f.hasRaw === false) add('仅 JPEG', () => { f.hasRaw = null; });
  if (f.hasGps === true) add('带 GPS', () => { f.hasGps = null; });
  if (f.rating) add(`≥${f.rating} 星`, () => { f.rating = 0; });
  if (f.yearMonth) add(`时间：${f.yearMonth}`, () => { f.yearMonth = null; });
  if (f.location) add(`地点：${f.location}`, () => { f.location = null; });
  f.tags.forEach((t) => add(`标签：${t}`, () => { f.tags = f.tags.filter((x) => x !== t); }));
  f.filmModes.forEach((t) => add(`胶片：${t}`, () => { f.filmModes = f.filmModes.filter((x) => x !== t); }));
  f.lenses.forEach((t) => add(`镜头：${t}`, () => { f.lenses = f.lenses.filter((x) => x !== t); }));
  f.cameras.forEach((t) => add(`机身：${t}`, () => { f.cameras = f.cameras.filter((x) => x !== t); }));
  f.dynamicRange.forEach((t) => add(`动态范围：${t}`, () => { f.dynamicRange = f.dynamicRange.filter((x) => x !== t); }));
  if (f.iso[0] != null || f.iso[1] != null) add(`ISO ${f.iso[0] ?? '∞'}–${f.iso[1] ?? '∞'}`, () => { f.iso = [null, null]; });
  if (f.aperture[0] != null || f.aperture[1] != null) add(`光圈 f/${f.aperture[0] ?? '∞'}–f/${f.aperture[1] ?? '∞'}`, () => { f.aperture = [null, null]; });

  const host = $('chips');
  host.innerHTML = '';
  for (const c of chips) {
    const el = document.createElement('span');
    el.className = 'chip';
    el.innerHTML = `${esc(c.text)}<button title="移除">✕</button>`;
    el.querySelector('button').addEventListener('click', () => {
      c.onClear();
      applyFilters();
      savePrefs();
    });
    host.appendChild(el);
  }
}

/* ========================= 虚拟滚动网格 ========================= */

let imgObserver = null;

function ensureObserver() {
  if (imgObserver) return imgObserver;
  imgObserver = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) {
        const img = e.target;
        const src = img.dataset.src;
        if (src && img.src !== src) {
          img.src = src;
          img.addEventListener('load', () => img.classList.add('loaded'), { once: true });
          img.addEventListener('error', () => {
            img.classList.add('loaded');
            img.parentElement.querySelector('.ph').textContent = '无预览';
          }, { once: true });
        }
        imgObserver.unobserve(img);
      }
    }
  }, { rootMargin: '300px 0px' });
  return imgObserver;
}

function computeLayout() {
  const vp = $('viewport');
  const style = getComputedStyle(vp);
  const padL = parseFloat(style.paddingLeft) || 16;
  const padR = parseFloat(style.paddingRight) || 16;
  const avail = vp.clientWidth - padL - padR;
  const cols = Math.max(1, Math.floor((avail + GAP) / (MIN_CARD_W + GAP)));
  let cardW = (avail - (cols - 1) * GAP) / cols;
  cardW = Math.min(cardW, MAX_CARD_W);
  const thumbH = Math.round(cardW * 0.75);
  state.cols = cols;
  state.cardW = cardW;
  state.cardH = thumbH + META_H;
  return { cols, cardW, cardH: state.cardH, thumbH };
}

function renderGrid() {
  const { cardW, cardH, thumbH } = computeLayout();
  const list = state.filtered;
  const rows = Math.ceil(list.length / state.cols);
  const spacer = $('spacer');

  spacer.style.height = `${rows * cardH + Math.max(0, rows - 1) * GAP}px`;

  // 清空既有卡片
  for (const el of state.rendered.values()) el.remove();
  state.rendered.clear();

  updateVisible();
}

function updateVisible() {
  const vp = $('viewport');
  const list = state.filtered;
  const { cols, cardW, cardH } = state;
  const rowH = cardH + GAP;
  const scrollTop = vp.scrollTop;
  const viewH = vp.clientHeight;

  const startRow = Math.max(0, Math.floor(scrollTop / rowH) - BUFFER_ROWS);
  const endRow = Math.min(
    Math.ceil(list.length / cols) - 1,
    Math.floor((scrollTop + viewH) / rowH) + BUFFER_ROWS
  );

  const need = new Set();
  for (let r = startRow; r <= endRow; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      if (i < list.length) need.add(i);
    }
  }

  // 移除不在可视区的
  for (const [i, el] of state.rendered) {
    if (!need.has(i)) { el.remove(); state.rendered.delete(i); }
  }

  // 新增
  const frag = document.createDocumentFragment();
  for (const i of need) {
    if (state.rendered.has(i)) continue;
    const el = buildCard(list[i], i);
    const r = Math.floor(i / cols);
    const c = i % cols;
    el.style.width = `${cardW}px`;
    el.style.height = `${cardH}px`;
    el.style.transform = `translate(${c * (cardW + GAP)}px, ${r * rowH}px)`;
    el.style.left = '0';
    el.style.top = '0';
    frag.appendChild(el);
    state.rendered.set(i, el);
  }
  $('spacer').appendChild(frag);
}

function buildCard(p, index) {
  const el = document.createElement('div');
  el.className = 'card';
  el.dataset.index = String(index);
  el.dataset.id = p.id;
  if (state.selection.has(p.id)) el.classList.add('selected');

  const e = p.exif || {};
  const rating = p.user?.rating || 0;
  const tags = p.user?.tags || [];

  const metaParts = [
    e.focalLength ? `${e.focalLength}mm` : null,
    e.fNumber ? `f/${e.fNumber}` : null,
    e.shutterLabel || null,
    e.iso ? `ISO ${e.iso}` : null,
  ].filter(Boolean).join(' · ');

  const stars = [1, 2, 3, 4, 5]
    .map((n) => `<span class="${n <= rating ? '' : 'off'}">${starSvg(n <= rating, 11)}</span>`).join('');

  el.innerHTML = `
    <div class="thumb-box" style="height:${Math.round(state.cardW * 0.75)}px">
      <div class="ph">载入中…</div>
      <img data-src="${esc(p.thumb)}" alt="${esc(p.name)}" loading="lazy" decoding="async">
      <div class="badges">
        ${p.hasRaw ? '<span class="badge raw">RAW</span>' : ''}
        ${e.filmMode ? `<span class="badge film">${esc(e.filmMode.split(' ')[0])}</span>` : ''}
      </div>
      <button class="fav ${p.user?.favorite ? 'on' : ''}" data-act="fav" title="收藏">${heartSvg(p.user?.favorite)}</button>
      <div class="check">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>
      </div>
    </div>
    <div class="meta">
      <div class="name">${esc(p.name)}</div>
      <div class="sub">${esc(metaParts || fmtDate(e.date))}</div>
      <div class="foot">
        <div class="stars">${stars}</div>
        <div class="tag-dots">${tags.slice(0, 4).map(() => '<span class="dot"></span>').join('')}</div>
        <div class="sub" style="margin:0 0 0 auto">${esc(fmtDate(e.date))}</div>
      </div>
    </div>`;

  const img = el.querySelector('img');
  ensureObserver().observe(img);

  el.addEventListener('click', (ev) => {
    if (ev.target.closest('[data-act="fav"]')) {
      ev.stopPropagation();
      toggleFavorite(p, !p.user?.favorite);
      return;
    }
    if (state.selectMode) {
      toggleSelect(p.id);
      return;
    }
    openLightbox(index);
  });

  return el;
}

/* ========================= 多选 ========================= */

function toggleSelectMode(on) {
  state.selectMode = on ?? !state.selectMode;
  document.body.classList.toggle('select-mode', state.selectMode);
  $('selectModeBtn').classList.toggle('active', state.selectMode);
  $('selectionBar').classList.toggle('on', state.selectMode);
  if (!state.selectMode) {
    state.selection.clear();
    for (const el of state.rendered.values()) el.classList.remove('selected');
  }
  updateSelCount();
}

function toggleSelect(id) {
  if (state.selection.has(id)) state.selection.delete(id);
  else state.selection.add(id);
  for (const [i, el] of state.rendered) {
    if (state.filtered[i]?.id === id) el.classList.toggle('selected', state.selection.has(id));
  }
  updateSelCount();
}

function updateSelCount() {
  $('selCount').textContent = String(state.selection.size);
}

/* ========================= 灯箱 ========================= */

function openLightbox(index) {
  state.lightbox = { open: true, index };
  $('lightbox').classList.add('on');
  renderLightbox();
}

function closeLightbox() {
  state.lightbox.open = false;
  $('lightbox').classList.remove('on');
  $('lbImg').removeAttribute('src');
}

function navLightbox(delta) {
  const n = state.filtered.length;
  if (!n) return;
  const i = (state.lightbox.index + delta + n) % n;
  state.lightbox.index = i;
  renderLightbox();
}

function renderLightbox() {
  const list = state.filtered;
  const i = state.lightbox.index;
  const p = list[i];
  if (!p) return;
  const e = p.exif || {};

  $('lbIdx').textContent = `${i + 1} / ${list.length}`;
  // 优先加载 JPEG 原图；只有 RAW 时退回缩略图（浏览器无法解码 RAF）
  const fullSrc = p.files?.jpg ? `/api/file?path=${encodeURIComponent(p.files.jpg)}` : null;
  const img = $('lbImg');
  img.onerror = () => { img.onerror = null; img.src = p.thumb; };
  img.src = fullSrc || p.thumb;
  img.alt = p.name;

  $('lbPrev').disabled = list.length <= 1;
  $('lbNext').disabled = list.length <= 1;

  $('lbFav').classList.toggle('active', Boolean(p.user?.favorite));
  $('infoFav').classList.toggle('on', Boolean(p.user?.favorite));
  $('infoFavText').textContent = p.user?.favorite ? '已收藏' : '收藏';
  $('infoName').textContent = p.name;
  $('infoPath').textContent = p.files?.raw || p.files?.jpg || p.dir || '';

  const rating = p.user?.rating || 0;
  $('infoStars').innerHTML = [1, 2, 3, 4, 5]
    .map((n) => `<button data-star="${n}" class="${n <= rating ? 'on' : ''}" title="${n} 星">${starSvg(n <= rating, 20)}</button>`)
    .join('');
  $('infoRatingHint').textContent = rating ? `${rating} 星` : '未评分';

  renderInfoTags(p);
  renderExif(p);

  $('noteArea').value = p.user?.note || '';

  // 胶片条
  const strip = $('lbFilmstrip');
  const half = 20;
  const from = Math.max(0, i - half);
  const to = Math.min(list.length, i + half + 1);
  strip.innerHTML = list.slice(from, to).map((q, k) =>
    `<img src="${esc(q.thumb)}" data-i="${from + k}" class="${from + k === i ? 'cur' : ''}" alt="">`
  ).join('');
  const cur = strip.querySelector('.cur');
  if (cur) cur.scrollIntoView({ block: 'nearest', inline: 'center' });
}

function renderExif(p) {
  const e = p.exif || {};
  const rows = [
    ['拍摄时间', fmtDateTime(e.date)],
    ['机身', e.camera],
    ['镜头', e.lens],
    ['胶片模拟', e.filmMode ? `<span class="film-pill">${esc(e.filmMode)}</span>` : null],
    ['焦距', e.focalLength ? `${e.focalLength}mm${e.focalLength35 ? `（等效 ${e.focalLength35}mm）` : ''}` : null],
    ['光圈', e.fNumber ? `f/${e.fNumber}` : null],
    ['快门', e.shutterLabel || (e.shutter ? `1/${Math.round(1 / e.shutter)}` : null)],
    ['ISO', e.iso],
    ['曝光补偿', e.exposureComp != null ? `${e.exposureComp > 0 ? '+' : ''}${e.exposureComp} EV` : null],
    ['动态范围', e.dynamicRange],
    ['色彩空间', e.colorSpace],
    ['白平衡', e.whiteBalance],
    ['测光模式', e.meteringMode],
    ['像素尺寸', e.width && e.height ? `${e.width} × ${e.height}` : null],
    ['位置', locationOf(p)],
    ['GPS', e.gps ? `${e.gps.lat.toFixed(5)}, ${e.gps.lon.toFixed(5)}` : null],
  ];

  $('exifGrid').innerHTML = rows
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`)
    .join('') || '<dt>—</dt><dd>无 EXIF 数据</dd>';

  const fileRows = [
    ['RAW 原片', p.hasRaw ? '有' : '无'],
    ['JPEG', p.hasJpg ? '有' : '无'],
    ['RAW 大小', p.rawSize ? fmtBytes(p.rawSize) : null],
    ['JPEG 大小', p.jpgSize ? fmtBytes(p.jpgSize) : null],
    ['合计', p.size ? fmtBytes(p.size) : null],
    ['所在目录', `<span class="mono">${esc(p.dir || '—')}</span>`],
  ];
  $('fileGrid').innerHTML = fileRows
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`)
    .join('');
}

function renderInfoTags(p) {
  const tags = p.user?.tags || [];
  $('infoTags').innerHTML = tags.length
    ? tags.map((t) => `<span class="tag-item">${esc(t)}<button data-rm="${esc(t)}" title="移除">✕</button></span>`).join('')
    : '<span style="font-size:12px;color:#8b95a3">暂无标签</span>';

  $('infoTags').querySelectorAll('[data-rm]').forEach((b) => {
    b.addEventListener('click', () => {
      const t = b.dataset.rm;
      saveMeta(p, { tags: tags.filter((x) => x !== t) });
    });
  });

  const suggest = state.allTags.filter((t) => !tags.includes(t)).slice(0, 12);
  $('tagSuggest').innerHTML = suggest.length
    ? suggest.map((t) => `<button data-add="${esc(t)}">+ ${esc(t)}</button>`).join('')
    : '';
  $('tagSuggest').querySelectorAll('[data-add]').forEach((b) => {
    b.addEventListener('click', () => {
      saveMeta(p, { tags: [...tags, b.dataset.add] });
    });
  });
}

/* ========================= 元数据写回 ========================= */

async function persistMeta(id, payload) {
  const res = await fetch('/api/meta', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, ...payload }),
  });
  if (!res.ok) throw new Error((await res.json()).error || '保存失败');
  return res.json();
}

function patchPhoto(id, patch) {
  const p = state.photos.find((x) => x.id === id);
  if (!p) return null;
  p.user = { tags: [], rating: 0, favorite: false, note: '', ...(p.user || {}), ...patch };
  return p;
}

async function saveMeta(p, patch, opts = {}) {
  const prev = { ...(p.user || {}) };
  patchPhoto(p.id, patch);
  if (patch.tags) {
    for (const t of patch.tags) if (!state.allTags.includes(t)) state.allTags.push(t);
  }
  // 乐观更新 UI
  refreshCardById(p.id);
  if (state.lightbox.open && state.filtered[state.lightbox.index]?.id === p.id) {
    renderInfoTags(p);
    $('infoStars').innerHTML = [1, 2, 3, 4, 5]
      .map((n) => `<button data-star="${n}" class="${n <= (p.user.rating || 0) ? 'on' : ''}">${starSvg(n <= (p.user.rating || 0), 20)}</button>`)
      .join('');
    $('infoRatingHint').textContent = p.user.rating ? `${p.user.rating} 星` : '未评分';
    $('lbFav').classList.toggle('active', p.user.favorite);
    $('infoFav').classList.toggle('on', p.user.favorite);
    $('infoFavText').textContent = p.user.favorite ? '已收藏' : '收藏';
  }
  if (opts.rerender !== false) {
    renderFacets();
    updateCounts();
  }

  try {
    const data = await persistMeta(p.id, {
      tags: p.user.tags,
      rating: p.user.rating,
      favorite: p.user.favorite,
      note: p.user.note,
    });
    if (data.tags) state.allTags = data.tags;
  } catch (err) {
    patchPhoto(p.id, prev); // 回滚
    refreshCardById(p.id);
    toast(`保存失败：${err.message}`, 'err');
  }
}

const saveNote = debounce((p, text) => {
  if ((p.user?.note || '') === text) return;
  saveMeta(p, { note: text }, { rerender: false });
}, 700);

function refreshCardById(id) {
  for (const [i, el] of state.rendered) {
    if (state.filtered[i]?.id !== id) continue;
    const fresh = buildCard(state.filtered[i], i);
    const r = Math.floor(i / state.cols);
    const c = i % state.cols;
    fresh.style.width = `${state.cardW}px`;
    fresh.style.height = `${state.cardH}px`;
    fresh.style.left = '0';
    fresh.style.top = '0';
    fresh.style.transform = `translate(${c * (state.cardW + GAP)}px, ${r * (state.cardH + GAP)}px)`;
    el.replaceWith(fresh);
    state.rendered.set(i, fresh);
  }
}

function toggleFavorite(p, value) {
  saveMeta(p, { favorite: value });
}

/* ========================= 偏好持久化 ========================= */

function savePrefs() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({
      sort: state.sort,
      theme: document.documentElement.dataset.theme,
      showInfoPanel: state.showInfoPanel,
      filters: state.filters,
    }));
  } catch { /* 忽略 */ }
}

function loadPrefs() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return;
    const p = JSON.parse(raw);
    if (p.sort) state.sort = p.sort;
    if (p.theme) document.documentElement.dataset.theme = p.theme;
    if (typeof p.showInfoPanel === 'boolean') state.showInfoPanel = p.showInfoPanel;
    if (p.filters) Object.assign(state.filters, p.filters);
  } catch { /* 忽略 */ }
}

/* ========================= 事件绑定 ========================= */

function bindGlobalEvents() {
  // 搜索
  const onSearch = debounce(() => {
    state.filters.keyword = $('searchInput').value.trim();
    $('searchWrap').classList.toggle('has-value', Boolean(state.filters.keyword));
    applyFilters();
    savePrefs();
  }, 220);
  $('searchInput').addEventListener('input', onSearch);
  $('searchClear').addEventListener('click', () => {
    $('searchInput').value = '';
    state.filters.keyword = '';
    $('searchWrap').classList.remove('has-value');
    applyFilters();
    savePrefs();
  });

  $('sortSelect').addEventListener('change', (e) => {
    state.sort = e.target.value;
    applyFilters();
    savePrefs();
  });

  $('resetBtn').addEventListener('click', resetFilters);
  $('selectModeBtn').addEventListener('click', () => toggleSelectMode());
  $('rescanBtn').addEventListener('click', () => startRescan(false));
  $('rescanBtn').addEventListener('contextmenu', (e) => { e.preventDefault(); startRescan(true); });
  $('themeBtn').addEventListener('click', toggleTheme);
  $('helpBtn').addEventListener('click', () => $('helpModal').classList.add('on'));
  $('helpClose').addEventListener('click', () => $('helpModal').classList.remove('on'));
  $('helpModal').addEventListener('click', (e) => {
    if (e.target === $('helpModal')) $('helpModal').classList.remove('on');
  });

  // 网格滚动
  const vp = $('viewport');
  let raf = 0;
  vp.addEventListener('scroll', () => {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; updateVisible(); });
  }, { passive: true });

  let resizeT = 0;
  window.addEventListener('resize', () => {
    clearTimeout(resizeT);
    resizeT = setTimeout(() => { renderGrid(); }, 120);
  });

  // 灯箱
  $('lbClose').addEventListener('click', closeLightbox);
  $('lbPrev').addEventListener('click', () => navLightbox(-1));
  $('lbNext').addEventListener('click', () => navLightbox(1));
  $('lbImgWrap').addEventListener('click', (e) => {
    if (e.target === $('lbImgWrap')) closeLightbox();
  });
  $('lbFav').addEventListener('click', () => {
    const p = state.filtered[state.lightbox.index];
    if (p) toggleFavorite(p, !p.user?.favorite);
  });
  $('infoFav').addEventListener('click', () => {
    const p = state.filtered[state.lightbox.index];
    if (p) toggleFavorite(p, !p.user?.favorite);
  });
  $('lbInfoToggle').addEventListener('click', () => {
    state.showInfoPanel = !state.showInfoPanel;
    $('lbStage').classList.toggle('no-info', !state.showInfoPanel);
    savePrefs();
  });
  $('lbReveal').addEventListener('click', () => {
    const p = state.filtered[state.lightbox.index];
    if (p) revealFile(p.files?.raw || p.files?.jpg);
  });
  $('lbOpen').addEventListener('click', () => {
    const p = state.filtered[state.lightbox.index];
    if (p) openFile(p.hasJpg ? p.files.jpg : p.files.raw);
  });
  $('lbFilmstrip').addEventListener('click', (e) => {
    const img = e.target.closest('img');
    if (!img) return;
    state.lightbox.index = Number(img.dataset.i);
    renderLightbox();
  });

  // 评分
  $('infoStars').addEventListener('click', (e) => {
    const b = e.target.closest('[data-star]');
    if (!b) return;
    const p = state.filtered[state.lightbox.index];
    if (!p) return;
    const n = Number(b.dataset.star);
    saveMeta(p, { rating: p.user?.rating === n ? 0 : n });
  });

  // 标签
  const addTag = () => {
    const input = $('tagInput');
    const t = input.value.trim();
    if (!t) return;
    const p = state.filtered[state.lightbox.index];
    if (!p) return;
    const tags = p.user?.tags || [];
    input.value = '';
    if (tags.includes(t)) { toast('标签已存在'); return; }
    saveMeta(p, { tags: [...tags, t] });
  };
  $('tagAdd').addEventListener('click', addTag);
  $('tagInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); addTag(); }
    e.stopPropagation();
  });

  // 备注
  $('noteArea').addEventListener('input', (e) => {
    const p = state.filtered[state.lightbox.index];
    if (p) saveNote(p, e.target.value);
  });

  // 批量操作
  $('selAll').addEventListener('click', () => {
    for (const p of state.filtered) state.selection.add(p.id);
    for (const [i, el] of state.rendered) el.classList.add('selected');
    updateSelCount();
  });
  $('selNone').addEventListener('click', () => {
    state.selection.clear();
    for (const el of state.rendered.values()) el.classList.remove('selected');
    updateSelCount();
  });
  $('batchTagInput').addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter') return;
    e.stopPropagation();
    const t = e.target.value.trim();
    if (!t) return;
    await batchUpdate({ addTags: [t] });
    e.target.value = '';
  });
  $('batchRating').addEventListener('change', async (e) => {
    if (e.target.value === '') return;
    await batchUpdate({ rating: Number(e.target.value) });
    e.target.value = '';
  });
  $('batchFav').addEventListener('click', () => batchUpdate({ favorite: true }));
  $('batchUnfav').addEventListener('click', () => batchUpdate({ favorite: false }));

  // 键盘
  document.addEventListener('keydown', onKeydown);
}

function toggleTheme() {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  $('themeIcon').innerHTML = next === 'dark'
    ? '<circle cx="12" cy="12" r="4.2"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'
    : '<path d="M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z"/>';
  savePrefs();
}

async function revealFile(file) {
  if (!file) return;
  try {
    const res = await fetch('/api/reveal', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file }),
    });
    if (!res.ok) throw new Error((await res.json()).error || '失败');
  } catch (err) {
    toast(`无法定位：${err.message}`, 'err');
  }
}

async function openFile(file) {
  if (!file) return;
  try {
    const res = await fetch('/api/open', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file }),
    });
    if (!res.ok) throw new Error((await res.json()).error || '失败');
  } catch (err) {
    toast(`无法打开：${err.message}`, 'err');
  }
}

async function batchUpdate(payload) {
  const ids = [...state.selection];
  if (!ids.length) { toast('请先选择照片', 'err'); return; }
  try {
    const res = await fetch('/api/batch-meta', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids, ...payload }),
    });
    if (!res.ok) throw new Error((await res.json()).error || '失败');
    const data = await res.json();
    if (data.tags) state.allTags = data.tags;

    for (const id of ids) {
      const p = state.photos.find((x) => x.id === id);
      if (!p) continue;
      const u = p.user || {};
      if (payload.addTags) u.tags = [...new Set([...(u.tags || []), ...payload.addTags])];
      if (payload.removeTags) u.tags = (u.tags || []).filter((t) => !payload.removeTags.includes(t));
      if (payload.rating != null) u.rating = payload.rating;
      if (payload.favorite != null) u.favorite = payload.favorite;
      p.user = u;
      refreshCardById(id);
    }
    renderFacets();
    updateCounts();
    if (state.lightbox.open) renderLightbox();
    toast(`已更新 ${ids.length} 张照片`, 'ok');
  } catch (err) {
    toast(`批量更新失败：${err.message}`, 'err');
  }
}

/* ========================= 重新扫描 ========================= */

async function startRescan(force = false) {
  const btn = $('rescanBtn');
  if (btn.disabled) return;
  btn.disabled = true;
  btn.classList.add('busy');
  const origTitle = btn.title;

  try {
    const res = await fetch('/api/rescan', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ force }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      if (res.status === 409) toast(err.error || '已有扫描任务在进行中', 'err');
      else toast('扫描启动失败', 'err');
      return;
    }
    toast(force ? '开始全量重建索引…' : '开始扫描新增照片…');

    // 轮询进度，展示扫描日志最后一行
    let lastLog = '';
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    let guard = 0;
    while (guard++ < 600) {
      await sleep(800);
      const sr = await fetch('/api/scan-status');
      const s = await sr.json();
      const line = s.log?.length ? s.log[s.log.length - 1].trim() : '';
      if (line && line !== lastLog) {
        lastLog = line;
        btn.title = line.slice(0, 80);
      }
      if (!s.running) break;
    }

    const sr = await fetch('/api/scan-status');
    const s = await sr.json();
    if (s.result?.ok) toast('扫描完成', 'ok');
    else toast('扫描结束（有错误，可看服务日志）', 'err');

    // 刷新索引与视图
    await loadData();
    applyFilters();
  } catch (err) {
    toast(`扫描出错：${err.message}`, 'err');
  } finally {
    btn.classList.remove('busy');
    btn.disabled = false;
    btn.title = origTitle;
  }
}

function onKeydown(e) {
  const inField = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);

  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    $('searchInput').focus();
    $('searchInput').select();
    return;
  }
  if (e.key === 'Escape') {
    if ($('helpModal').classList.contains('on')) { $('helpModal').classList.remove('on'); return; }
    if (state.lightbox.open) { closeLightbox(); return; }
    if (state.selectMode) toggleSelectMode(false);
    return;
  }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a' && state.selectMode && !inField) {
    e.preventDefault();
    $('selAll').click();
    return;
  }
  if (!state.lightbox.open || inField) return;

  if (e.key === 'ArrowLeft') { e.preventDefault(); navLightbox(-1); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); navLightbox(1); }
  else if (e.key.toLowerCase() === 'f') {
    const p = state.filtered[state.lightbox.index];
    if (p) toggleFavorite(p, !p.user?.favorite);
  } else if (e.key.toLowerCase() === 'i') {
    $('lbInfoToggle').click();
  } else if (e.key.toLowerCase() === 't') {
    e.preventDefault();
    $('tagInput').focus();
  } else if (/^[0-5]$/.test(e.key)) {
    const p = state.filtered[state.lightbox.index];
    if (p) saveMeta(p, { rating: Number(e.key) });
  }
}

/* ========================= 启动 ========================= */

async function main() {
  loadPrefs();
  $('sortSelect').value = state.sort;
  $('lbStage').classList.toggle('no-info', !state.showInfoPanel);
  if (document.documentElement.dataset.theme === 'dark') {
    $('themeIcon').innerHTML = '<circle cx="12" cy="12" r="4.2"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>';
  }
  $('searchInput').value = state.filters.keyword || '';
  $('searchWrap').classList.toggle('has-value', Boolean(state.filters.keyword));

  try {
    await loadData();
  } catch (err) {
    $('loading').innerHTML = `<div style="text-align:center;padding:24px">
      <div style="font-size:15px;color:var(--text);margin-bottom:8px">无法载入照片索引</div>
      <div style="font-size:13px;color:var(--text-3);line-height:1.7">${esc(err.message)}<br><br>
      请在项目目录执行 <code>npm run scan</code> 生成索引，再执行 <code>npm run serve</code> 启动服务。</div></div>`;
    return;
  }

  bindGlobalEvents();
  applyFilters();
  $('loading').style.display = 'none';

  // 自动检测索引变化（配合 ./gfx watch 监听模式，无需手动刷新）
  setInterval(async () => {
    try {
      const r = await fetch('/api/index', { cache: 'no-store' });
      const d = await r.json();
      if (d.generatedAt && d.generatedAt !== state.generatedAt) {
        await loadData();
        applyFilters();
      }
    } catch { /* 轮询失败静默忽略 */ }
  }, 30000);
}

main();
