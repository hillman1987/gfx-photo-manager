import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
export const DATA_DIR = path.join(PROJECT_ROOT, 'data');
export const PUBLIC_DIR = path.join(PROJECT_ROOT, 'public');
export const THUMB_DIR = path.join(PUBLIC_DIR, 'thumbs');
export const INDEX_FILE = path.join(DATA_DIR, 'photos.json');
export const USERDATA_FILE = path.join(DATA_DIR, 'userdata.json');

export const RAW_EXT = new Set(['.raf', '.RAF']);
export const JPG_EXT = new Set(['.jpg', '.jpeg', '.JPG', '.JPEG']);

export function loadConfig() {
  const cfgPath = path.join(PROJECT_ROOT, 'config.json');
  const defaults = {
    roots: [path.join(os.homedir(), 'Pictures')],
    excludeDirs: ['node_modules', '.git', 'Photos Library.photoslibrary'],
    maxDepth: 12,
    thumb: { width: 640, quality: 82 },
    concurrency: 6,
  };
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  } catch {
    /* 使用默认值 */
  }
  const merged = { ...defaults, ...cfg, thumb: { ...defaults.thumb, ...(cfg.thumb || {}) } };
  merged.roots = merged.roots.map((r) => (r.startsWith('~') ? path.join(os.homedir(), r.slice(1)) : r));
  return merged;
}

export function ensureDirs() {
  for (const d of [DATA_DIR, PUBLIC_DIR, THUMB_DIR]) {
    fs.mkdirSync(d, { recursive: true });
  }
}

/** Fujifilm FilmMode 数值 → 可读名称（含 GFX100S 全系胶片模拟） */
export const FILM_MODE_MAP = {
  0: 'Provia / 标准',
  1: 'Studio Portrait / 人像柔和',
  2: 'Astia / 柔和',
  3: 'Studio Portrait EX',
  4: 'Velvia / 鲜艳',
  5: 'PRO Neg. Std',
  6: 'PRO Neg. Hi',
  7: 'Classic Chrome 经典正片',
  8: 'ETERNA / 电影',
  9: 'Classic Neg. 经典负片',
  10: 'Nostalgic Neg. 怀旧负片',
  11: 'ETERNA Bleach Bypass 漂白',
  12: 'Bleach Bypass',
  16: 'ACROS',
  17: 'ACROS + Ye 黄',
  18: 'ACROS + R 红',
  19: 'ACROS + G 绿',
  32: 'Monochrome 黑白',
  33: 'Monochrome + Ye',
  34: 'Monochrome + R',
  35: 'Monochrome + G',
  48: 'Sepia 棕褐色',
  256: 'ACROS',
  272: 'ACROS + Ye',
  288: 'ACROS + R',
  304: 'ACROS + G',
  512: 'Monochrome 黑白',
  528: 'Sepia 棕褐色',
};

export function mapFilmMode(rawValue, translated) {
  if (typeof translated === 'string' && translated.trim()) {
    const clean = translated.replace(/^F\d+\//, '').trim();
    return clean || translated;
  }
  if (rawValue === undefined || rawValue === null) return null;
  const num = Number(rawValue);
  if (Number.isNaN(num)) return null;
  return FILM_MODE_MAP[num] ?? `未知胶片模拟 (${num})`;
}
