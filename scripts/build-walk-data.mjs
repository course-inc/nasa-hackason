// Builds the WALKBACK data files the app loads from web/public/data/ (bundled, so the desktop
// app works offline).
//   node scripts/build-walk-data.mjs            (mise run walk-data)
//
// Inputs (downloaded into data/raw/, not committed):
//   M20_traverse.json  https://mars.nasa.gov/mmgis-maps/M20/Layers/json/M20_traverse.json
//   eva.csv            https://data.nasa.gov/docs/legacy/Extra-vehicular_Activity_EVA_-_US_and_Russia/Extra-vehicular_Activity_EVA_-_US_and_Russia_rows.csv
//   jezero_dem.json    Jezero elevation grid (HiRISE DTM filled with MOLA), see docs/walkback.md
// Outputs:
//   web/public/data/m20_traverse.json   drives [{sol, c: [[lon, lat, z], …]}], points ≥ 3 m apart
//   web/public/data/eva.csv             copy
//   web/public/data/jezero_dem.json     copy
//   web/public/data/hokkaido/<id>.json  elevation grid around each #10 Hokkaido site, from GSI
//                                       DEM PNG tiles (国土地理院 標高タイル), resampled to lat/lon
//   Pass --no-hokkaido to skip the GSI download.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const raw = (f) => path.join(root, 'data/raw', f);
const outDir = path.join(root, 'web/public/data');
fs.mkdirSync(path.join(outDir, 'hokkaido'), { recursive: true });
const write = (f, s) => { fs.writeFileSync(path.join(outDir, f), s); console.log(`web/public/data/${f}: ${(s.length / 1024).toFixed(0)} KB`); };

// ---- Perseverance traverse ----
if (fs.existsSync(raw('M20_traverse.json'))) {
  const t = JSON.parse(fs.readFileSync(raw('M20_traverse.json'), 'utf8'));
  const R = 3389500, K = (Math.PI / 180) * R;
  const drives = [];
  for (const f of t.features) {
    const lines = f.geometry.type === 'MultiLineString' ? f.geometry.coordinates : [f.geometry.coordinates];
    for (const line of lines) {
      const c = [];
      for (const p of line) {
        if (p.length < 3 || !p.every(Number.isFinite)) continue;
        const last = c[c.length - 1];
        if (last) {
          const dx = (p[0] - last[0]) * K * Math.cos((p[1] * Math.PI) / 180), dy = (p[1] - last[1]) * K;
          if (Math.hypot(dx, dy) < 3) continue;
        }
        c.push([+p[0].toFixed(6), +p[1].toFixed(6), +p[2].toFixed(1)]);
      }
      if (c.length > 1) drives.push({ sol: f.properties?.sol ?? 0, c });
    }
  }
  write('m20_traverse.json', JSON.stringify({ src: 'NASA/JPL-Caltech Mars 2020 MMGIS M20_traverse.json', drives }));
} else console.warn('skip traverse: data/raw/M20_traverse.json missing');

if (fs.existsSync(raw('eva.csv'))) write('eva.csv', fs.readFileSync(raw('eva.csv'), 'utf8'));
else console.warn('skip eva: data/raw/eva.csv missing');

if (fs.existsSync(raw('jezero_dem.json'))) write('jezero_dem.json', JSON.stringify(JSON.parse(fs.readFileSync(raw('jezero_dem.json'), 'utf8'))));
else console.warn('skip jezero dem: data/raw/jezero_dem.json missing');

// ---- Hokkaido grids from GSI DEM PNG tiles ----
// PNG decoder for 8-bit RGB/RGBA, non-interlaced (what GSI serves).
function decodePng(buf) {
  let pos = 8, w = 0, h = 0, ct = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos), type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); ct = data[9]; if (data[8] !== 8 || data[12] !== 0) throw new Error('unsupported png'); }
    if (type === 'IDAT') idat.push(data);
    pos += 12 + len;
  }
  const bpp = ct === 6 ? 4 : ct === 2 ? 3 : (() => { throw new Error(`png color type ${ct}`); })();
  const inf = zlib.inflateSync(Buffer.concat(idat));
  const out = Buffer.alloc(w * h * bpp), stride = w * bpp;
  for (let y = 0; y < h; y++) {
    const f = inf[y * (stride + 1)], src = inf.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[y * stride + x - bpp] : 0, b = y ? out[(y - 1) * stride + x] : 0;
      const c = x >= bpp && y ? out[(y - 1) * stride + x - bpp] : 0;
      let v = src[x];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      out[y * stride + x] = v & 255;
    }
  }
  return { w, h, bpp, px: out };
}

// GSI DEM PNG: h = (R·2¹⁶ + G·2⁸ + B) × 0.01 m; (128, 0, 0) = no data; ≥ 2²³ is negative.
function gsiHeight(r, g, b) {
  const x = r * 65536 + g * 256 + b;
  if (x === 8388608) return null;
  return (x < 8388608 ? x : x - 16777216) * 0.01;
}

const Z = 12, SPAN_TILES = 3, CELL_DEG = 0.00075; // ≈ 83 m N–S
const tileXY = (lat, lon, z) => {
  const n = 2 ** z, s = Math.sin((lat * Math.PI) / 180);
  return [((lon + 180) / 360) * n, (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n];
};

async function siteGrid(site) {
  const [cx, cy] = tileXY(site.lat, site.lon, Z);
  const x0 = Math.floor(cx - SPAN_TILES / 2), y0 = Math.floor(cy - SPAN_TILES / 2);
  const tiles = new Map();
  for (let ty = y0; ty < y0 + SPAN_TILES; ty++) for (let tx = x0; tx < x0 + SPAN_TILES; tx++) {
    const url = `https://cyberjapandata.gsi.go.jp/xyz/dem_png/${Z}/${tx}/${ty}.png`;
    const r = await fetch(url);
    if (r.ok) tiles.set(`${tx}/${ty}`, decodePng(Buffer.from(await r.arrayBuffer())));
  }
  // lat/lon bounds of the tile block
  const lon = (x) => (x / 2 ** Z) * 360 - 180;
  const lat = (y) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** Z))) * 180) / Math.PI;
  const north = lat(y0), south = lat(y0 + SPAN_TILES), west = lon(x0), east = lon(x0 + SPAN_TILES);
  const dlat = CELL_DEG, dlon = CELL_DEG / Math.cos((site.lat * Math.PI) / 180);
  const rows = Math.floor((north - south) / dlat) - 1, cols = Math.floor((east - west) / dlon) - 1;
  const lat0 = north - dlat, lon0 = west + dlon;
  const z = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const [px, py] = tileXY(lat0 - r * dlat, lon0 + c * dlon, Z);
    const tx = Math.floor(px), ty = Math.floor(py), t = tiles.get(`${tx}/${ty}`);
    if (!t) { z.push(null); continue; }
    const ix = Math.min(255, Math.floor((px - tx) * 256)), iy = Math.min(255, Math.floor((py - ty) * 256));
    const o = (iy * t.w + ix) * t.bpp, hgt = gsiHeight(t.px[o], t.px[o + 1], t.px[o + 2]);
    z.push(hgt === null ? null : Math.round(hgt));
  }
  return { id: site.id, name: site.name, lat0, lon0, dlat, dlon, rows, cols, z, src: '国土地理院 標高タイル (DEM PNG, z12)' };
}

if (!process.argv.includes('--no-hokkaido')) {
  const sites = JSON.parse(fs.readFileSync(path.join(root, 'data/earth-metrics.json'), 'utf8')).filter((s) => s.id !== 'sapporo');
  const index = [];
  for (const s of sites) {
    try {
      const g = await siteGrid(s);
      const nulls = g.z.filter((v) => v === null).length / g.z.length;
      write(`hokkaido/${s.id}.json`, JSON.stringify(g));
      index.push({ id: s.id, name: s.name, lat: s.lat, lon: s.lon, rows: g.rows, cols: g.cols, nulls: +nulls.toFixed(3) });
    } catch (e) { console.warn(`skip ${s.id}: ${e.message}`); }
  }
  write('hokkaido/index.json', JSON.stringify(index, null, 1));
}
