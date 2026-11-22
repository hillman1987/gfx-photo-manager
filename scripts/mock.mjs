#!/usr/bin/env node
/**
 * 生成 GFX100S 风格的演示照片库（用于自测 / 演示，不影响真实扫描逻辑）
 * 产出：
 *   mock-library/<目录>/DSCF####.JPG   模拟 JPEG 原图
 *   mock-library/<目录>/DSCF####.RAF   模拟 RAW（JPEG 副本，用于验证 RAW/JPG 配对）
 *   public/thumbs/*.jpg                缩略图
 *   data/photos.json                   索引
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { PROJECT_ROOT, PUBLIC_DIR, THUMB_DIR, INDEX_FILE } from './lib/config.mjs';

const COUNT = Number(process.env.MOCK_COUNT || 72);
const SET_ROOT = process.argv.includes('--set-root');
const MOCK_DIR = path.join(PROJECT_ROOT, 'mock-library');

const LENSES = [
  { name: 'GF23mmF4 R LM WR', min: 23, max: 23, maxAperture: 4 },
  { name: 'GF32-64mmF4 R LM WR', min: 32, max: 64, maxAperture: 4 },
  { name: 'GF45mmF2.8 R WR', min: 45, max: 45, maxAperture: 2.8 },
  { name: 'GF63mmF2.8 R WR', min: 63, max: 63, maxAperture: 2.8 },
  { name: 'GF80mmF1.7 R WR', min: 80, max: 80, maxAperture: 1.7 },
  { name: 'GF110mmF2 R LM WR', min: 110, max: 110, maxAperture: 2 },
  { name: 'GF250mmF4 R LM OIS WR', min: 250, max: 250, maxAperture: 4 },
];

const FILM_MODES = [
  { label: 'Provia / 标准', raw: 0, tone: 'neutral' },
  { label: 'Velvia / 鲜艳', raw: 4, tone: 'vivid' },
  { label: 'Astia / 柔和', raw: 2, tone: 'soft' },
  { label: 'Classic Chrome 经典正片', raw: 7, tone: 'muted' },
  { label: 'PRO Neg. Std', raw: 5, tone: 'portrait' },
  { label: 'PRO Neg. Hi', raw: 6, tone: 'portrait' },
  { label: 'Classic Neg. 经典负片', raw: 9, tone: 'warm' },
  { label: 'Nostalgic Neg. 怀旧负片', raw: 10, tone: 'amber' },
  { label: 'ETERNA / 电影', raw: 8, tone: 'flat' },
  { label: 'ACROS', raw: 16, tone: 'mono' },
  { label: 'Monochrome 黑白', raw: 32, tone: 'mono' },
];

const LOCATIONS = [
  { name: '东京 · 涩谷', lat: 35.6595, lon: 139.7005 },
  { name: '东京 · 台场', lat: 35.6300, lon: 139.7756 },
  { name: '京都 · 岚山', lat: 35.0094, lon: 135.6668 },
  { name: '大阪 · 中之岛', lat: 34.6937, lon: 135.5023 },
  { name: '上海 · 外滩', lat: 31.2397, lon: 121.4900 },
  { name: '北京 · 国子监', lat: 39.9470, lon: 116.4070 },
  { name: '福冈 · 中洲', lat: 33.5915, lon: 130.4010 },
  null, // 部分照片无 GPS
];

const SCENES = ['街拍', '人像', '风光', '建筑', '夜景', '静物', '旅行'];
const APERTURES = [1.7, 2, 2.8, 4, 5.6, 8, 11, 16];
const ISOS = [100, 100, 160, 200, 320, 400, 800, 1600, 3200];
const SHUTTERS = [1 / 4000, 1 / 2000, 1 / 1000, 1 / 500, 1 / 250, 1 / 125, 1 / 60, 1 / 30, 1 / 8, 0.5, 1];

// 简单可复现的伪随机
let seed = 20260831;
function rnd() {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
}
const pick = (arr) => arr[Math.floor(rnd() * arr.length) % arr.length];

const TONES = {
  neutral: { r: 150, g: 148, b: 142 },
  vivid: { r: 196, g: 118, b: 72 },
  soft: { r: 186, g: 170, b: 164 },
  muted: { r: 138, g: 132, b: 118 },
  portrait: { r: 198, g: 168, b: 158 },
  warm: { r: 202, g: 156, b: 116 },
  amber: { r: 214, g: 164, b: 96 },
  flat: { r: 142, g: 148, b: 150 },
  mono: { r: 138, g: 138, b: 138 },
};

function fmtShutter(t) {
  if (t >= 1) return `${t}s`;
  return `1/${Math.round(1 / t)}`;
}

async function main() {
  await fsp.rm(MOCK_DIR, { recursive: true, force: true });
  await fsp.mkdir(THUMB_DIR, { recursive: true });
  await fsp.mkdir(MOCK_DIR, { recursive: true });

  // 清理旧缩略图，避免演示数据残留
  for (const f of await fsp.readdir(THUMB_DIR).catch(() => [])) {
    if (f.endsWith('.jpg')) await fsp.unlink(path.join(THUMB_DIR, f));
  }

  const photos = [];
  console.log(`🎨 生成 ${COUNT} 张演示照片…`);

  for (let i = 0; i < COUNT; i++) {
    const lens = pick(LENSES);
    const film = pick(FILM_MODES);
    const scene = pick(SCENES);
    const iso = pick(ISOS);
    const aperture = APERTURES.filter((a) => a >= lens.maxAperture)[
      Math.floor(rnd() * APERTURES.filter((a) => a >= lens.maxAperture).length)
    ] || lens.maxAperture;
    const shutter = pick(SHUTTERS);
    const focal = lens.min === lens.max ? lens.min : Math.round(lens.min + rnd() * (lens.max - lens.min));
    const loc = LOCATIONS[Math.floor(rnd() * LOCATIONS.length)];

    // 拍摄时间：近 24 个月内随机
    const daysAgo = Math.floor(rnd() * 730);
    const date = new Date(Date.now() - daysAgo * 86400000 - Math.floor(rnd() * 86400000));
    const dateStr = date.toISOString().slice(0, 10).replace(/-/g, '');
    const timeStr = date.toISOString().slice(11, 19);

    const dirName = `${dateStr}_${loc ? loc.name.split(' · ')[0] : '未命名'}_${scene}`;
    const outDir = path.join(MOCK_DIR, dirName);
    await fsp.mkdir(outDir, { recursive: true });

    const base = `DSCF${String(1000 + i).slice(-4)}`;
    const jpgPath = path.join(outDir, `${base}.JPG`);
    const rafPath = path.join(outDir, `${base}.RAF`);
    const key = path.join(outDir, base).toLowerCase();
    const id = crypto.createHash('sha1').update(key).digest('hex').slice(0, 16);

    // 生成一张有色调差异的图，便于直观区分胶片模拟
    const tone = TONES[film.tone];
    const jitter = () => Math.floor(rnd() * 40) - 20;
    const w = 1600;
    const h = 1200;
    const svg = `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="rgb(${tone.r + jitter()},${tone.g + jitter()},${tone.b + jitter()})"/>
          <stop offset="55%" stop-color="rgb(${tone.r + jitter()},${tone.g + jitter()},${tone.b + jitter()})"/>
          <stop offset="100%" stop-color="rgb(${Math.max(0, tone.r - 60)},${Math.max(0, tone.g - 60)},${Math.max(0, tone.b - 60)})"/>
        </linearGradient>
      </defs>
      <rect width="${w}" height="${h}" fill="url(#g)"/>
      <circle cx="${300 + rnd() * 1000}" cy="${200 + rnd() * 800}" r="${120 + rnd() * 260}" fill="rgba(255,255,255,0.13)"/>
      <circle cx="${200 + rnd() * 1200}" cy="${150 + rnd() * 900}" r="${60 + rnd() * 180}" fill="rgba(0,0,0,0.11)"/>
    </svg>`;

    const jpgBuf = await sharp(Buffer.from(svg)).jpeg({ quality: 88 }).toBuffer();
    await fsp.writeFile(jpgPath, jpgBuf);
    // 模拟 RAW：与 JPEG 同内容（真实 GFX 的 RAF 约 200MB，此处仅为验证配对逻辑）
    await fsp.writeFile(rafPath, jpgBuf);

    await sharp(jpgBuf)
      .resize({ width: 640, withoutEnlargement: true })
      .jpeg({ quality: 82, mozjpeg: true })
      .toFile(path.join(THUMB_DIR, `${id}.jpg`));

    const stat = await fsp.stat(jpgPath);

    photos.push({
      id,
      name: base,
      dir: outDir,
      files: { raw: rafPath, jpg: jpgPath },
      hasRaw: true,
      hasJpg: true,
      thumb: `thumbs/${id}.jpg`,
      sig: `${stat.mtimeMs}|${stat.size}`,
      mtime: stat.mtimeMs,
      size: stat.size * 2,
      rawSize: stat.size,
      jpgSize: stat.size,
      hasThumb: true,
      exif: {
        camera: rnd() > 0.88 ? 'FUJIFILM GFX100S II' : 'FUJIFILM GFX100S',
        lens: lens.name,
        date: date.toISOString(),
        dateLabel: `${dateStr} ${timeStr}`,
        iso,
        fNumber: aperture,
        shutter,
        shutterLabel: fmtShutter(shutter),
        focalLength: focal,
        focalLength35: Math.round(focal * 0.79),
        exposureComp: [-1, -0.67, -0.33, 0, 0.33, 0.67, 1][Math.floor(rnd() * 7)],
        width: 11648,
        height: 8736,
        colorSpace: rnd() > 0.5 ? 'Adobe RGB' : 'sRGB',
        meteringMode: 'Multi-segment',
        flash: 'Off, Did not fire',
        whiteBalance: rnd() > 0.7 ? 'Manual' : 'Auto',
        dynamicRange: pick(['Standard', 'Wide', 'Auto']),
        filmMode: film.label,
        filmModeRaw: film.raw,
        gps: loc ? { lat: loc.lat, lon: loc.lon } : null,
        locationName: loc ? loc.name : null,
      },
    });
  }

  photos.sort((a, b) => (b.exif.date || '').localeCompare(a.exif.date || ''));

  await fsp.mkdir(path.dirname(INDEX_FILE), { recursive: true });
  await fsp.writeFile(
    INDEX_FILE,
    JSON.stringify({
      generatedAt: new Date().toISOString(),
      roots: [MOCK_DIR],
      total: photos.length,
      isMock: true,
      photos,
    })
  );

  if (SET_ROOT) {
    const cfgPath = path.join(PROJECT_ROOT, 'config.json');
    const cfg = JSON.parse(await fsp.readFile(cfgPath, 'utf8'));
    await fsp.writeFile(cfgPath, JSON.stringify({ ...cfg, roots: [MOCK_DIR] }, null, 2));
    console.log(`✅ config.json 的 roots 已切换为: ${MOCK_DIR}`);
  }

  console.log(`✅ 演示库已生成: ${MOCK_DIR}`);
  console.log(`   索引: ${INDEX_FILE} (${photos.length} 张)`);
  console.log(`   缩略图: ${THUMB_DIR}`);
  console.log(`\n▶ 启动: npm run serve\n`);
}

main().catch((e) => {
  console.error('❌ 生成失败:', e);
  process.exit(1);
});
