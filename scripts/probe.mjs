#!/usr/bin/env node
/**
 * EXIF 探测器：对单个文件打印 exifr 的原始解析结果 + 本项目的提取结果。
 * 用途：拿到真实 GFX 照片后，校准 lib/config.mjs 里的 FILM_MODE_MAP 映射表。
 *
 *   node scripts/probe.mjs /path/to/DSCF1234.RAF
 */
import exifr from 'exifr';
import fs from 'node:fs';
import path from 'node:path';
import { extractExif } from './lib/exif.mjs';
import { FILM_MODE_MAP, mapFilmMode } from './lib/config.mjs';

const file = process.argv[2];
if (!file) {
  console.error('用法: node scripts/probe.mjs <照片文件>');
  process.exit(1);
}
if (!fs.existsSync(file)) {
  console.error(`❌ 文件不存在: ${file}`);
  process.exit(1);
}

const clean = (o) => JSON.parse(JSON.stringify(o, (k, v) => (v instanceof Buffer ? `<Buffer ${v.length}B>` : v)));

console.log(`\n🔬 探测: ${path.basename(file)}`);
console.log(`   路径: ${file}`);
console.log(`   大小: ${(fs.statSync(file).size / 1024 / 1024).toFixed(1)} MB\n`);

async function dump(label, opts) {
  try {
    const r = await exifr.parse(file, opts);
    console.log(`── ${label} ──`);
    console.log(r ? JSON.stringify(clean(r), null, 1) : '(解析为 null)');
  } catch (err) {
    console.log(`── ${label} ──\n(解析失败: ${err.message})`);
  }
  console.log('');
}

// 1. 标准块（带值翻译）
await dump('标准 EXIF（已翻译）', {
  tiff: true, ifd0: true, exif: true, gps: true, translateValues: true, mergeOutput: false,
});

// 2. 开启 MakerNote（Fujifilm 胶片模拟藏在这里）
await dump('含 MakerNote（未翻译原始值）', {
  tiff: true, ifd0: true, exif: true, gps: true, makerNote: true,
  translateValues: false, translateKeys: false, mergeOutput: false,
});

// 3. 本项目实际提取结果
const { exif, source } = await extractExif(file, null);
console.log('── 本项目提取结果 ──');
console.log(JSON.stringify({ source: source ? path.basename(source) : null, ...exif }, null, 1));

// 4. 胶片模拟映射表自检
console.log('\n── 胶片模拟映射表（供校准参考）──');
for (const [k, v] of Object.entries(FILM_MODE_MAP)) {
  console.log(`  ${String(k).padStart(4)} → ${v}`);
}
console.log(`\n  若上方提取结果里 filmMode 显示为「未知胶片模拟 (n)」，`);
console.log(`  请把 n 对应的实际胶片模拟名称补进 scripts/lib/config.mjs 的 FILM_MODE_MAP。`);
console.log(`  当前 filmModeRaw = ${exif.filmModeRaw}, filmMode = ${exif.filmMode}`);
console.log(`  mapFilmMode(原始值) = ${mapFilmMode(exif.filmModeRaw)}\n`);
