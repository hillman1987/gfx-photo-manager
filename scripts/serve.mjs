#!/usr/bin/env node
/**
 * 本地静态服务 + 元数据写回 API
 *  GET  /                      前端页面
 *  GET  /api/index             照片索引（索引与用户数据已合并）
 *  POST /api/meta              保存标签/评分/收藏/备注
 *  POST /api/reveal            在 Finder 中定位文件
 *  POST /api/open              用系统默认程序打开文件
 */
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import {
  PUBLIC_DIR,
  INDEX_FILE,
  USERDATA_FILE,
  DATA_DIR,
  PROJECT_ROOT,
  loadConfig,
  USERDATA_FILE as UD,
} from './lib/config.mjs';

const execFileAsync = promisify(execFile);
const PORT = Number(process.env.PORT || 5173);
const HOST = process.env.HOST || '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// ── 扫描任务（子进程执行，全局单飞防并发）──────────────────────────
// sharp 解码是 CPU 密集的，放在主进程会卡住所有 HTTP 请求。
const SCAN_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'scan.mjs');
let scanTask = {
  running: false,
  force: false,
  startedAt: null,
  finishedAt: null,
  log: [],
  result: null,
};

function pushLog(line) {
  const s = String(line).trimEnd();
  if (!s) return;
  scanTask.log.push(s);
  if (scanTask.log.length > 200) scanTask.log.shift();
}

// ── watch 监听模式（WATCH=1 或 --watch 开启）────────────────────
const WATCH = process.env.WATCH === '1' || process.argv.includes('--watch');
let watchTimer = null;
let pendingRescan = false; // 扫描进行中又检测到变动，完成后补扫

function startWatcher() {
  const config = loadConfig();
  const roots = (config.roots || []).filter((r) => {
    try { return fs.existsSync(r); } catch { return false; }
  });
  if (roots.length === 0) {
    console.log('⚠  watch：无有效扫描目录，监听未启动');
    return;
  }
  // debounce 合并批量导入产生的大量事件
  const schedule = () => {
    if (watchTimer) return;
    watchTimer = setTimeout(() => {
      watchTimer = null;
      if (scanTask.running) {
        pendingRescan = true;
        return;
      }
      console.log('[watch] 检测到目录变动，自动增量扫描…');
      startScan(false);
    }, 3000);
  };
  for (const r of roots) {
    try {
      const w = fs.watch(r, { recursive: true }, schedule);
      w.on('error', () => { /* 目录被删等，静默忽略 */ });
      console.log(`[watch] 监听目录: ${r}`);
    } catch (err) {
      console.error(`[watch] 监听失败 ${r}: ${err.message}`);
    }
  }
  console.log('[watch] 目录变动后 3 秒自动增量扫描');
}

function startScan(force = false) {
  if (scanTask.running) return { ok: false, error: '已有扫描任务在进行中' };
  scanTask = {
    running: true,
    force,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    log: [],
    result: null,
  };
  const child = spawn(process.execPath, [SCAN_SCRIPT, ...(force ? ['--force'] : [])], {
    cwd: PROJECT_ROOT,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => pushLog(d.toString()));
  child.stderr.on('data', (d) => pushLog(d.toString()));
  // 子进程被杀（如手动停止）也要复位状态，否则后续永远无法再扫描
  const settle = (code) => {
    scanTask.running = false;
    scanTask.finishedAt = new Date().toISOString();
    scanTask.result = { exitCode: code, ok: code === 0 };
    // watch 模式下，扫描期间又有新变动 → 完成后自动补扫一次
    if (pendingRescan) {
      pendingRescan = false;
      setImmediate(() => startScan(false));
    }
  };
  child.on('error', (err) => {
    pushLog(`扫描进程启动失败: ${err.message}`);
    settle(1);
  });
  child.on('close', settle);
  return { ok: true, force };
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJsonAtomic(file, data) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await fsp.rename(tmp, file);
}

/** 合并索引 + 用户数据（标签/评分/收藏/备注） */
async function buildPayload() {
  const index = await readJson(INDEX_FILE, { photos: [], generatedAt: null, roots: [] });
  const userdata = await readJson(USERDATA_FILE, { photos: {}, tags: [] });
  const photos = index.photos.map((p) => {
    const ud = userdata.photos[p.id] || {};
    return {
      ...p,
      user: {
        tags: ud.tags || [],
        rating: ud.rating || 0,
        favorite: Boolean(ud.favorite),
        note: ud.note || '',
      },
    };
  });
  return {
    generatedAt: index.generatedAt,
    roots: index.roots || [],
    total: photos.length,
    tags: userdata.tags || [],
    photos,
  };
}

/**
 * 构建允许对外读取的原图路径集合（只来自索引，避免任意文件读取）
 * 索引文件变更时自动刷新缓存
 */
const fileCache = { mtimeMs: 0, allowed: new Set() };
async function getAllowedFiles() {
  let stat;
  try {
    stat = await fsp.stat(INDEX_FILE);
  } catch {
    return new Set();
  }
  if (stat.mtimeMs === fileCache.mtimeMs) return fileCache.allowed;
  const index = await readJson(INDEX_FILE, { photos: [] });
  const allowed = new Set();
  for (const p of index.photos || []) {
    if (p.files?.jpg) allowed.add(path.resolve(p.files.jpg));
    if (p.files?.raw) allowed.add(path.resolve(p.files.raw));
  }
  fileCache.mtimeMs = stat.mtimeMs;
  fileCache.allowed = allowed;
  return allowed;
}

function sendJson(res, code, body) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': buf.length,
    'Cache-Control': 'no-store',
  });
  res.end(buf);
}

async function readBody(req, limit = 2 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new Error('请求体过大');
    chunks.push(c);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

/** 路径穿越防护：解析后必须落在允许根目录内 */
function resolveSafe(target, root) {
  const resolved = path.resolve(target);
  const rel = path.relative(root, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return resolved;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = decodeURIComponent(url.pathname);

  try {
    if (pathname === '/api/index' && req.method === 'GET') {
      return sendJson(res, 200, await buildPayload());
    }

    if (pathname === '/api/meta' && req.method === 'POST') {
      const body = await readBody(req);
      const { id, tags, rating, favorite, note } = body || {};
      if (typeof id !== 'string' || !/^[a-f0-9]{16}$/.test(id)) {
        return sendJson(res, 400, { error: '非法照片 ID' });
      }
      const ud = await readJson(USERDATA_FILE, { photos: {}, tags: [] });
      const prev = ud.photos[id] || {};
      ud.photos[id] = {
        tags: Array.isArray(tags) ? [...new Set(tags.map((t) => String(t).trim()).filter(Boolean))].slice(0, 30) : prev.tags || [],
        rating: Number.isFinite(rating) ? Math.max(0, Math.min(5, Math.round(rating))) : prev.rating || 0,
        favorite: typeof favorite === 'boolean' ? favorite : Boolean(prev.favorite),
        note: typeof note === 'string' ? note.slice(0, 2000) : prev.note || '',
        updatedAt: new Date().toISOString(),
      };
      // 汇总全局标签库
      const tagSet = new Set(ud.tags || []);
      for (const t of ud.photos[id].tags) tagSet.add(t);
      ud.tags = [...tagSet].sort((a, b) => a.localeCompare(b, 'zh'));
      await writeJsonAtomic(USERDATA_FILE, ud);
      return sendJson(res, 200, { ok: true, photo: ud.photos[id], tags: ud.tags });
    }

    if (pathname === '/api/batch-meta' && req.method === 'POST') {
      const body = await readBody(req);
      const { ids, addTags, removeTags, rating, favorite } = body || {};
      if (!Array.isArray(ids) || ids.length === 0) {
        return sendJson(res, 400, { error: 'ids 不能为空' });
      }
      if (ids.length > 500) return sendJson(res, 400, { error: '单次最多 500 张' });
      const ud = await readJson(USERDATA_FILE, { photos: {}, tags: [] });
      const tagSet = new Set(ud.tags || []);
      for (const id of ids) {
        if (typeof id !== 'string' || !/^[a-f0-9]{16}$/.test(id)) continue;
        const prev = ud.photos[id] || {};
        let tags = new Set(prev.tags || []);
        for (const t of addTags || []) tags.add(String(t).trim());
        for (const t of removeTags || []) tags.delete(String(t));
        tags = [...tags].filter(Boolean).slice(0, 30);
        ud.photos[id] = {
          tags,
          rating: Number.isFinite(rating) ? Math.max(0, Math.min(5, Math.round(rating))) : prev.rating || 0,
          favorite: typeof favorite === 'boolean' ? favorite : Boolean(prev.favorite),
          note: prev.note || '',
          updatedAt: new Date().toISOString(),
        };
        for (const t of tags) tagSet.add(t);
      }
      ud.tags = [...tagSet].sort((a, b) => a.localeCompare(b, 'zh'));
      await writeJsonAtomic(USERDATA_FILE, ud);
      return sendJson(res, 200, { ok: true, count: ids.length, tags: ud.tags });
    }

    if (pathname === '/api/reveal' && req.method === 'POST') {
      const { file } = await readBody(req);
      if (typeof file !== 'string' || !file) return sendJson(res, 400, { error: '缺少文件路径' });
      if (!fs.existsSync(file)) return sendJson(res, 404, { error: '文件不存在' });
      await execFileAsync('open', ['-R', file]);
      return sendJson(res, 200, { ok: true });
    }

    if (pathname === '/api/open' && req.method === 'POST') {
      const { file } = await readBody(req);
      if (typeof file !== 'string' || !file) return sendJson(res, 400, { error: '缺少文件路径' });
      if (!fs.existsSync(file)) return sendJson(res, 404, { error: '文件不存在' });
      await execFileAsync('open', [file]);
      return sendJson(res, 200, { ok: true });
    }

    // 读取原图（仅限索引内已收录的 jpg/jpeg，RAW 不支持浏览器解码）
    if (pathname === '/api/file' && req.method === 'GET') {
      const file = url.searchParams.get('path');
      if (!file) return sendJson(res, 400, { error: '缺少 path 参数' });
      const resolved = path.resolve(file);
      const allowed = await getAllowedFiles();
      if (!allowed.has(resolved)) return sendJson(res, 403, { error: '该文件不在索引内' });
      if (!['.jpg', '.jpeg'].includes(path.extname(resolved).toLowerCase())) {
        return sendJson(res, 415, { error: 'RAW 格式无法在浏览器直接预览' });
      }
      let fstat;
      try {
        fstat = await fsp.stat(resolved);
      } catch {
        return sendJson(res, 404, { error: '文件不存在' });
      }
      const ext = path.extname(resolved).toLowerCase();
      const etag = `W/"${fstat.size}-${fstat.mtimeMs.toString(36)}"`;
      const headers = {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        ETag: etag,
        'Cache-Control': 'private, max-age=3600',
        'Accept-Ranges': 'bytes',
      };
      const range = req.headers.range;
      if (range) {
        const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
        if (m) {
          const start = m[1] ? Number(m[1]) : 0;
          const end = m[2] ? Number(m[2]) : fstat.size - 1;
          if (start >= fstat.size || end >= fstat.size || start > end) {
            res.writeHead(416, { 'Content-Range': `bytes */${fstat.size}` });
            return res.end();
          }
          res.writeHead(206, {
            ...headers,
            'Content-Range': `bytes ${start}-${end}/${fstat.size}`,
            'Content-Length': end - start + 1,
          });
          return fs.createReadStream(resolved, { start, end }).pipe(res);
        }
      }
      res.writeHead(200, { ...headers, 'Content-Length': fstat.size });
      return fs.createReadStream(resolved).pipe(res);
    }

    // 触发重新扫描（子进程异步执行，不阻塞 HTTP）
    if (pathname === '/api/rescan' && req.method === 'POST') {
      let force = false;
      try {
        const body = await readBody(req);
        force = Boolean(body?.force);
      } catch { /* 无请求体时按增量扫描 */ }
      const r = startScan(force);
      if (!r.ok) return sendJson(res, 409, { error: r.error });
      return sendJson(res, 202, { ok: true, force });
    }

    // 查询扫描进度（前端轮询）
    if (pathname === '/api/scan-status' && req.method === 'GET') {
      return sendJson(res, 200, {
        running: scanTask.running,
        force: scanTask.force,
        startedAt: scanTask.startedAt,
        finishedAt: scanTask.finishedAt,
        result: scanTask.result,
        log: scanTask.log.slice(-50), // 只回最近 50 行，控制体积
      });
    }

    if (pathname === '/api/health') {
      return sendJson(res, 200, { ok: true, dataDir: DATA_DIR });
    }

    // 静态资源
    let rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const filePath = resolveSafe(path.join(PUBLIC_DIR, rel), PUBLIC_DIR);
    if (!filePath) return sendJson(res, 403, { error: '禁止访问' });

    let stat;
    try {
      stat = await fsp.stat(filePath);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 Not Found');
    }
    if (stat.isDirectory()) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('403 Forbidden');
    }

    const ext = path.extname(filePath).toLowerCase();
    const etag = `W/"${stat.size}-${stat.mtimeMs.toString(36)}"`;
    const isThumb = filePath.includes('/thumbs/') || filePath.startsWith(path.join(PUBLIC_DIR, 'thumbs'));

    // 必须先判 304 再 writeHead，否则重复写头会抛 ERR_HTTP_HEADERS_SENT 并令进程退出
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { ETag: etag, 'Cache-Control': isThumb ? 'public, max-age=31536000, immutable' : 'no-cache' }).end();
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      ETag: etag,
      'Cache-Control': isThumb ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(filePath).pipe(res);
  } catch (err) {
    // 响应已发出时无法再写头，避免二次写入导致进程崩溃
    if (!res.headersSent) sendJson(res, 500, { error: err.message });
    else {
      console.error('请求处理出错（响应已发送）:', err.message);
      try { res.end(); } catch { /* 连接可能已断开 */ }
    }
  }
});

// 进程级兜底：任何未捕获异常只记录不退出，避免单个请求搞挂整个服务
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException] 已忽略:', err?.message || err);
});
process.on('unhandledRejection', (err) => {
  console.error('[unhandledRejection] 已忽略:', err?.message || err);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n❌ 端口 ${PORT} 已被占用。先执行： lsof -ti tcp:${PORT} | xargs kill\n`);
    process.exit(1);
  }
  console.error('[server error]', err.message);
});

server.listen(PORT, HOST, () => {
  console.log(`\n🖼  GFX 照片管理器已启动`);
  console.log(`   http://${HOST}:${PORT}\n`);
  console.log(`   索引文件: ${INDEX_FILE}`);
  console.log(`   用户数据: ${USERDATA_FILE}`);
  if (WATCH) console.log(`   监听模式: 已开启（目录变动自动扫描）`);
  console.log(`   Ctrl+C 停止\n`);
  if (WATCH) startWatcher();
});
