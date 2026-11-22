#!/usr/bin/env node
/**
 * 扫描照片目录 → 提取 EXIF + 生成缩略图 → 输出索引 JSON
 * 支持增量：已处理且文件未变动的照片直接复用索引，不重复生成缩略图。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import exifr from 'exifr';
import {
  loadConfig,
  ensureDirs,
  INDEX_FILE,
  THUMB_DIR,
  RAW_EXT,
  JPG_EXT,
} from './lib/config.mjs';
import { extractExif, emptyExif } from './lib/exif.mjs';

const args = process.argv.slice(2);
const FORCE = args.includes('--force');
const LIMIT = (() => {
  const i = args.indexOf('--limit');
  return i >= 0 ? Number(args[i + 1]) : 0;
})();
const QUIET = args.includes('--quiet');

const log = (...a) => {
  if (!QUIET) console.log(...a);
};

/** 递归遍历目录，返回 { dir, name, ext, abs, stat } */
async function* walk(dir, cfg, depth = 0) {
  if (depth > cfg.maxDepth) return;
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return; // 无权限目录直接跳过
  }
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name.startsWith('.') && e.name !== '.') continue;
      if (cfg.excludeDirs.includes(e.name)) continue;
      yield* walk(abs, cfg, depth + 1);
    } else if (e.isFile()) {
      if (e.name.startsWith('.')) continue;
      const ext = path.extname(e.name);
      if (!RAW_EXT.has(ext) && !JPG_EXT.has(ext)) continue;
      let stat;
      try {
        stat = await fsp.stat(abs);
      } catch {
        continue;
      }
      yield { dir, name: e.name, ext, abs, stat };
    }
  }
}

/** 同目录 + 同名（忽略扩展名）视为同一张照片的 RAW/JPG 组合 */
function groupKey(abs) {
  return path.join(path.dirname(abs), path.basename(abs, path.extname(abs))).toLowerCase();
}

function makeId(key) {
  return crypto.createHash('sha1').update(key).digest('hex').slice(0, 16);
}

async function generateThumb(photo, cfg) {
  const outPath = path.join(THUMB_DIR, `${photo.id}.jpg`);
  const w = cfg.thumb.width;
  const q = cfg.thumb.quality;

  try {
    if (photo.files.jpg) {
      await sharp(photo.files.jpg)
        .rotate()
        .resize({ width: w, withoutEnlargement: true })
        .jpeg({ quality: q, mozjpeg: true })
        .toFile(outPath);
      return true;
    }
    if (photo.files.raw) {
      // RAF 内嵌预览图（exifr 可抽取），再交给 sharp 缩放
      const buf = await exifr.thumbnail(photo.files.raw);
      if (buf && buf.length) {
        await sharp(buf)
          .rotate()
          .resize({ width: w, withoutEnlargement: true })
          .jpeg({ quality: q, mozjpeg: true })
          .toFile(outPath);
        return true;
      }
    }
  } catch (err) {
    log(`  ⚠ 缩略图失败 ${photo.name}: ${err.message}`);
  }
  return false;
}

async function main() {
  ensureDirs();
  const cfg = loadConfig();
  const t0 = Date.now();

  // 载入旧索引用于增量比对
  let oldIndex = { photos: [] };
  try {
    oldIndex = JSON.parse(await fsp.readFile(INDEX_FILE, 'utf8'));
  } catch {
    /* 首次扫描 */
  }
  const oldMap = new Map(oldIndex.photos.map((p) => [p.id, p]));

  log(`🔍 扫描目录: ${cfg.roots.join(', ')}`);

  /** @type {Map<string, {raw?:object, jpg?:object}>} */
  const groups = new Map();
  let scanned = 0;

  for (const root of cfg.roots) {
    let rootStat;
    try {
      rootStat = await fsp.stat(root);
    } catch {
      log(`⚠ 目录不存在，跳过: ${root}`);
      continue;
    }
    if (!rootStat.isDirectory()) {
      log(`⚠ 不是目录，跳过: ${root}`);
      continue;
    }
    for await (const f of walk(root, cfg)) {
      scanned++;
      const key = groupKey(f.abs);
      if (!groups.has(key)) groups.set(key, {});
      const g = groups.get(key);
      if (RAW_EXT.has(f.ext)) g.raw = f;
      else g.jpg = f;
    }
  }

  let keys = [...groups.keys()];
  if (LIMIT > 0) keys = keys.slice(0, LIMIT);
  log(`📄 发现 ${scanned} 个文件，归纳为 ${keys.length} 张照片`);

  const photos = [];
  let reused = 0;
  let newThumb = 0;
  let exifOk = 0;

  // 轻量并发池
  const queue = [...keys];
  const workers = Array.from({ length: Math.max(1, cfg.concurrency) }, async () => {
    while (queue.length) {
      const key = queue.shift();
      if (!key) return;
      const g = groups.get(key);
      const id = makeId(key);
      const rawFile = g.raw?.abs ?? null;
      const jpgFile = g.jpg?.abs ?? null;
      const primary = rawFile || jpgFile;
      const stat = (g.raw || g.jpg).stat;
      const sig = `${stat.mtimeMs}|${stat.size}`;

      const prev = oldMap.get(id);
      const thumbExists = fs.existsSync(path.join(THUMB_DIR, `${id}.jpg`));

      // 增量命中：签名一致 + 缩略图仍在 → 直接复用
      if (!FORCE && prev && prev.sig === sig && thumbExists) {
        photos.push(prev);
        reused++;
        continue;
      }

      const { exif } = await extractExif(rawFile, jpgFile);
      if (exif.date || exif.camera || exif.lens) exifOk++;

      const baseName = path.basename(primary, path.extname(primary));
      const photo = {
        id,
        name: baseName,
        dir: path.dirname(primary),
        files: { raw: rawFile, jpg: jpgFile },
        hasRaw: Boolean(rawFile),
        hasJpg: Boolean(jpgFile),
        thumb: `thumbs/${id}.jpg`,
        sig,
        mtime: stat.mtimeMs,
        size: (g.raw?.stat.size ?? 0) + (g.jpg?.stat.size ?? 0),
        rawSize: g.raw?.stat.size ?? null,
        jpgSize: g.jpg?.stat.size ?? null,
        exif: exif || emptyExif(),
      };

      const ok = await generateThumb(photo, cfg);
      photo.hasThumb = ok;
      if (ok) newThumb++;
      photos.push(photo);
    }
  });
  await Promise.all(workers);

  photos.sort((a, b) => {
    const da = a.exif?.date || '';
    const db = b.exif?.date || '';
    if (da === db) return a.name.localeCompare(b.name);
    return db.localeCompare(da); // 最新在前
  });

  const index = {
    generatedAt: new Date().toISOString(),
    scanDurationMs: Date.now() - t0,
    roots: cfg.roots,
    total: photos.length,
    photos,
  };

  await fsp.writeFile(INDEX_FILE, JSON.stringify(index), 'utf8');

  log(`✅ 索引已写入 ${path.relative(process.cwd(), INDEX_FILE)}`);
  log(`   总计 ${photos.length} 张 | 复用 ${reused} | 新生成缩略图 ${newThumb} | EXIF 完整 ${exifOk}`);
  log(`⏱  耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main().catch((err) => {
  console.error('❌ 扫描失败:', err);
  process.exit(1);
});
