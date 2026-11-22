import exifr from 'exifr';
import { mapFilmMode, FILM_MODE_MAP } from './config.mjs';

/** 快门速度数值 → 1/xxx 形式 */
function fmtShutter(exposureTime) {
  if (!exposureTime || exposureTime <= 0) return null;
  if (exposureTime >= 1) return `${Number(exposureTime.toFixed(1))}s`;
  return `1/${Math.round(1 / exposureTime)}`;
}

/** 从 exifr 输出的多层级结果里尽可能捞取 Fujifilm 胶片模拟 */
function pickFilmMode(raw, translated) {
  const grab = (obj) => {
    if (!obj || typeof obj !== 'object') return undefined;
    for (const key of ['FilmMode', 'filmMode', 'FilmSimulation', '0x1401']) {
      if (obj[key] !== undefined) return obj[key];
    }
    return undefined;
  };
  const candidates = [translated, raw];
  for (const c of candidates) {
    if (!c) continue;
    const direct = grab(c);
    if (direct !== undefined) return { value: direct, translated: c === translated };
    // exifr 在 mergeOutput:false 时会按 block 分块：ifd0 / exif / fujifilm / makernote
    for (const block of ['fujifilm', 'makernote', 'exif', 'ifd0', 'gps']) {
      const v = grab(c[block]);
      if (v !== undefined) return { value: v, translated: c === translated };
    }
  }
  return { value: undefined, translated: false };
}

function toNum(v) {
  if (v === undefined || v === null) return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

/**
 * 提取 EXIF。优先从 RAW 读取（MakerNotes 更完整），失败则回退 JPEG。
 * @param {string} rawPath
 * @param {string|null} jpgPath
 */
export async function extractExif(rawPath, jpgPath) {
  const targets = [rawPath, jpgPath].filter(Boolean);
  let raw = null;
  let translated = null;
  let usedFile = null;

  for (const file of targets) {
    try {
      // 第一轮：开启 makerNote，做值翻译
      translated = await exifr.parse(file, {
        tiff: true,
        ifd0: true,
        exif: true,
        gps: true,
        makerNote: true,
        translateValues: true,
        translateKeys: false,
        mergeOutput: false,
        silentErrors: true,
      });
      // 第二轮：保留原始数值，用于胶片模拟兜底映射
      raw = await exifr.parse(file, {
        tiff: true,
        ifd0: true,
        exif: true,
        gps: true,
        makerNote: true,
        translateValues: false,
        translateKeys: false,
        mergeOutput: false,
        silentErrors: true,
      });
      if (translated || raw) {
        usedFile = file;
        break;
      }
    } catch {
      /* 换下一个文件 */
    }
  }

  if (!translated && !raw) return { exif: emptyExif(), source: null };

  const t = translated || {};
  const r = raw || {};
  const pick = (...keys) => {
    for (const src of [t, r]) {
      for (const k of keys) {
        if (src[k] !== undefined && src[k] !== null) return src[k];
      }
    }
    for (const block of ['ifd0', 'exif', 'fujifilm', 'makernote']) {
      for (const src of [t, r]) {
        const b = src[block];
        if (!b) continue;
        for (const k of keys) {
          if (b[k] !== undefined && b[k] !== null) return b[k];
        }
      }
    }
    return undefined;
  };

  const fm = pickFilmMode(r, t);
  const filmMode = mapFilmMode(fm.value, fm.translated ? fm.value : undefined);

  const lat = toNum(pick('latitude', 'GPSLatitude', 'lat'));
  const lon = toNum(pick('longitude', 'GPSLongitude', 'lon'));
  const rawShutter = toNum(pick('ExposureTime', 'exposureTime'));

  const dateRaw = pick('DateTimeOriginal', 'CreateDate', 'ModifyDate', 'DateTime');
  let date = null;
  if (dateRaw instanceof Date) date = dateRaw.toISOString();
  else if (typeof dateRaw === 'string') {
    const d = new Date(dateRaw.replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3'));
    if (!Number.isNaN(d.getTime())) date = d.toISOString();
  }

  const exposure = toNum(pick('ExposureCompensation', 'exposureCompensation'));

  return {
    source: usedFile,
    exif: {
      camera: pick('Make', 'make') && pick('Model', 'model')
        ? `${pick('Make', 'make')} ${pick('Model', 'model')}`.trim()
        : pick('Model', 'model') || null,
      lens: pick('LensModel', 'lensModel', 'Lens') || null,
      date,
      iso: toNum(pick('ISO', 'ISOSpeedRatings', 'PhotographicSensitivity')),
      fNumber: toNum(pick('FNumber', 'fNumber', 'ApertureValue')),
      shutter: toNum(rawShutter),
      shutterLabel: fmtShutter(rawShutter),
      focalLength: toNum(pick('FocalLength', 'focalLength')),
      focalLength35: toNum(pick('FocalLengthIn35mmFormat')),
      exposureComp: exposure === null ? null : Number(exposure.toFixed(2)),
      width: toNum(pick('ImageWidth', 'ExifImageWidth')),
      height: toNum(pick('ImageHeight', 'ExifImageHeight')),
      colorSpace: pick('ColorSpace', 'colorSpace') || null,
      meteringMode: pick('MeteringMode') || null,
      flash: pick('Flash') || null,
      whiteBalance: pick('WhiteBalance') || null,
      dynamicRange: pick('DynamicRange', 'dynamicRange') || null,
      filmMode,
      filmModeRaw: fm.value === undefined ? null : toNum(fm.value),
      gps: lat !== null && lon !== null ? { lat, lon } : null,
    },
  };
}

export function emptyExif() {
  return {
    camera: null,
    lens: null,
    date: null,
    iso: null,
    fNumber: null,
    shutter: null,
    shutterLabel: null,
    focalLength: null,
    focalLength35: null,
    exposureComp: null,
    width: null,
    height: null,
    colorSpace: null,
    meteringMode: null,
    flash: null,
    whiteBalance: null,
    dynamicRange: null,
    filmMode: null,
    filmModeRaw: null,
    gps: null,
  };
}
