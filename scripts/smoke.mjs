#!/usr/bin/env node
/**
 * 前端冒烟测试：用 jsdom 真实加载 index.html + app.js，验证
 * 初始化、筛选、排序、虚拟滚动、灯箱、元数据保存全链路无运行时错误。
 *
 *   node scripts/smoke.mjs            # 需要服务已在 127.0.0.1:5173 运行
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');
const BASE = process.env.BASE_URL || 'http://127.0.0.1:5173';

// jsdom 是测试期依赖：优先项目本地，其次隔离 workspace，最后环境变量指定
const require = createRequire(import.meta.url);
const JSDOM_CANDIDATES = [
  'jsdom',
  path.join(os.homedir(), '.workbuddy/binaries/node/workspace/node_modules/jsdom'),
  process.env.JSDOM_PATH,
].filter(Boolean);

let JSDOM;
for (const c of JSDOM_CANDIDATES) {
  try {
    ({ JSDOM } = (await import(c.startsWith('/') || c.includes('node_modules') ? pathToFileUrl(c) : c)));
    break;
  } catch { /* 换下一个候选 */ }
}
if (!JSDOM) {
  console.error('❌ 需要 jsdom。安装方式：npm i -D jsdom  或  npm i -g jsdom');
  process.exit(2);
}

function pathToFileUrl(p) {
  return 'file://' + (p.endsWith('.js') ? p : require.resolve(p));
}

const errors = [];
let passed = 0;
let failed = 0;

function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; errors.push(name); console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

/** 把相对 URL 补成绝对地址，让 jsdom 能拿到真实数据 */
async function fetchWithBase(url, init) {
  const u = String(url).startsWith('http') ? String(url) : BASE + String(url);
  return fetch(u, init);
}

async function main() {
  console.log(`\n🧪 前端冒烟测试 (${BASE})\n`);

  // 前置：服务可用
  let index;
  try {
    const res = await fetch(`${BASE}/api/index`);
    index = await res.json();
  } catch (err) {
    console.error(`❌ 无法连接服务 ${BASE}：${err.message}`);
    console.error('   请先运行 npm run serve');
    process.exit(1);
  }
  check('服务可访问 & 索引存在', Array.isArray(index.photos), `total=${index.total}`);

  const html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');

  const dom = new JSDOM(html, {
    url: BASE + '/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    resources: undefined,
  });
  const { window } = dom;

  // --- 补齐 jsdom 缺失的浏览器 API ---
  window.IntersectionObserver = class {
    constructor(cb) { this.cb = cb; window.__io = this; }
    observe(el) { this.cb([{ isIntersecting: true, target: el }]); }
    unobserve() {}
    disconnect() {}
  };
  window.fetch = fetchWithBase;

  // jsdom 不做布局，手动给出可视尺寸
  Object.defineProperty(window.HTMLElement.prototype, 'clientWidth', { get() { return 1280; }, configurable: true });
  Object.defineProperty(window.HTMLElement.prototype, 'clientHeight', { get() { return 800; }, configurable: true });
  Object.defineProperty(window.HTMLElement.prototype, 'scrollIntoView', { value() {}, configurable: true });

  const consoleErrors = [];
  window.console.error = (...a) => consoleErrors.push(a.join(' '));
  window.addEventListener('error', (e) => consoleErrors.push(`window.onerror: ${e.message}`));
  window.addEventListener('unhandledrejection', (e) => consoleErrors.push(`unhandledrejection: ${e.reason}`));

  // --- 执行 app.js ---
  const appJs = fs.readFileSync(path.join(PUBLIC_DIR, 'app.js'), 'utf8');
  try {
    window.eval(appJs);
  } catch (err) {
    check('app.js 执行无异常', false, err.message);
  }

  // 等待异步 main() 完成
  await new Promise((r) => setTimeout(r, 900));

  check('app.js 执行无未捕获异常', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));

  const doc = window.document;
  const $ = (id) => doc.getElementById(id);

  // --- 1. 初始化渲染 ---
  check('载入遮罩已隐藏', $('loading').style.display === 'none');
  check('结果计数已渲染', /\d/.test($('resultCount').textContent), $('resultCount').textContent);
  const cards = doc.querySelectorAll('.card');
  check('网格已渲染卡片', cards.length > 0, `渲染 ${cards.length} 张`);
  check('虚拟滚动生效（未一次性渲染全部）', cards.length < index.total || index.total < 30,
    `渲染 ${cards.length} / 总数 ${index.total}`);

  // --- 2. 侧栏分面 ---
  const facets = doc.querySelectorAll('.facet');
  check('侧栏分面已生成', facets.length >= 8, `${facets.length} 个分组`);
  const filmOpts = [...doc.querySelectorAll('input[data-dim="filmModes"]')];
  check('胶片模拟选项已生成', filmOpts.length > 0, `${filmOpts.length} 种`);
  const lensOpts = [...doc.querySelectorAll('input[data-dim="lenses"]')];
  check('镜头选项已生成', lensOpts.length > 0, `${lensOpts.length} 支`);
  const ymOpts = [...doc.querySelectorAll('input[data-dim="yearMonth"]')];
  check('时间分组已生成', ymOpts.length > 0, `${ymOpts.length} 个月份`);

  // --- 3. 筛选：胶片模拟 ---
  const totalBefore = state_count($);
  const firstFilm = filmOpts[0];
  firstFilm.checked = true;
  firstFilm.dispatchEvent(new window.Event('change'));
  await tick(60);
  const afterFilm = state_count($);
  check('胶片模拟筛选生效', afterFilm < totalBefore && afterFilm > 0, `${totalBefore} → ${afterFilm}`);
  check('筛选条件 chip 已生成', doc.querySelectorAll('.chip').length > 0);

  // 清除
  firstFilm.checked = false;
  firstFilm.dispatchEvent(new window.Event('change'));
  await tick(60);
  check('取消筛选后数量还原', state_count($) === totalBefore, `${state_count($)} vs ${totalBefore}`);

  // --- 4. 搜索 ---
  const search = $('searchInput');
  const sampleName = index.photos[0].name;
  search.value = sampleName;
  search.dispatchEvent(new window.Event('input'));
  await tick(350);
  const searchCount = state_count($);
  check('关键词搜索生效', searchCount >= 1 && searchCount <= totalBefore, `命中 ${searchCount} 张`);
  $('searchClear').dispatchEvent(new window.MouseEvent('click'));
  await tick(350);
  check('清除搜索后还原', state_count($) === totalBefore);

  // --- 5. 排序 ---
  $('sortSelect').value = 'rating-desc';
  $('sortSelect').dispatchEvent(new window.Event('change'));
  await tick(80);
  check('切换排序不报错', consoleErrors.length === 0, consoleErrors[0] || '');

  // --- 6. 灯箱 ---
  await tick(60);
  doc.querySelector('.card').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await tick(150);
  check('灯箱已打开', $('lightbox').classList.contains('on'));
  check('灯箱索引已显示', /\d+\s*\/\s*\d+/.test($('lbIdx').textContent), $('lbIdx').textContent);
  check('灯箱 EXIF 面板已填充', $('exifGrid').querySelectorAll('dt').length > 3,
    `${$('exifGrid').querySelectorAll('dt').length} 行`);
  check('灯箱大图已设置 src', Boolean($('lbImg').getAttribute('src')), $('lbImg').getAttribute('src'));
  check('胶片条已渲染', $('lbFilmstrip').querySelectorAll('img').length > 0);

  // 键盘导航
  const before = $('lbIdx').textContent;
  doc.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  await tick(80);
  check('键盘 → 可切换照片', $('lbIdx').textContent !== before, `${before} → ${$('lbIdx').textContent}`);

  // --- 7. 打标签（真实写回服务端） ---
  const tagInput = $('tagInput');
  const testTag = `冒烟测试标签${Date.now() % 10000}`;
  tagInput.value = testTag;
  $('tagAdd').dispatchEvent(new window.MouseEvent('click'));
  await tick(400);
  const tagTexts = [...doc.querySelectorAll('#infoTags .tag-item')].map((e) => e.textContent.replace('✕', '').trim());
  check('标签已添加到 UI', tagTexts.includes(testTag), tagTexts.join(', '));

  const res = await fetch(`${BASE}/api/index`);
  const after = await res.json();
  const hasTag = after.photos.some((p) => (p.user?.tags || []).includes(testTag));
  check('标签已持久化到服务端', hasTag);
  check('全局标签库已更新', (after.tags || []).includes(testTag));

  // --- 8. 评分 ---
  doc.dispatchEvent(new window.KeyboardEvent('keydown', { key: '5', bubbles: true }));
  await tick(350);
  const res2 = await fetch(`${BASE}/api/index`);
  const after2 = await res2.json();
  check('评分已持久化', after2.photos.some((p) => (p.user?.rating || 0) === 5));

  // --- 9. 关闭灯箱 ---
  doc.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await tick(80);
  check('Esc 可关闭灯箱', !$('lightbox').classList.contains('on'));

  // --- 10. 多选模式 + 批量 ---
  $('selectModeBtn').dispatchEvent(new window.MouseEvent('click'));
  await tick(60);
  check('多选模式已激活', doc.body.classList.contains('select-mode'));
  $('selAll').dispatchEvent(new window.MouseEvent('click'));
  await tick(60);
  const selCount = Number($('selCount').textContent);
  check('全选生效', selCount > 0, `选中 ${selCount} 张`);

  const batchInput = $('batchTagInput');
  const batchTag = `批量${Date.now() % 10000}`;
  batchInput.value = batchTag;
  batchInput.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await tick(600);
  const res3 = await fetch(`${BASE}/api/index`);
  const after3 = await res3.json();
  const batchHit = after3.photos.filter((p) => (p.user?.tags || []).includes(batchTag)).length;
  check('批量打标签已生效', batchHit === selCount, `${batchHit}/${selCount}`);

  // --- 11. 主题切换 ---
  $('themeBtn').dispatchEvent(new window.MouseEvent('click'));
  await tick(60);
  check('主题切换生效', doc.documentElement.dataset.theme === 'dark');

  // --- 12. 空结果态 ---
  search.value = 'zzz-绝对不存在的关键字-zzz';
  search.dispatchEvent(new window.Event('input'));
  await tick(350);
  check('空结果显示空态', $('empty').classList.contains('on'));

  console.log(`\n${failed === 0 ? '✅' : '❌'} 通过 ${passed} 项，失败 ${failed} 项`);
  if (consoleErrors.length) {
    console.log(`\n控制台错误 (${consoleErrors.length}):`);
    consoleErrors.slice(0, 8).forEach((e) => console.log(`   - ${e}`));
  }
  dom.window.close();
  process.exit(failed === 0 ? 0 : 1);
}

function state_count($) {
  const m = /筛选出\s*<b>(\d+)<\/b>/.exec($('resultCount').innerHTML)
    || /共\s*<b>(\d+)<\/b>/.exec($('resultCount').innerHTML);
  return m ? Number(m[1]) : -1;
}

const tick = (ms) => new Promise((r) => setTimeout(r, ms));

main().catch((err) => {
  console.error('❌ 冒烟测试异常:', err);
  process.exit(1);
});
