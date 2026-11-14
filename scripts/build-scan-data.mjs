#!/usr/bin/env node
// #10 whole-Hokkaido scan: cut Hokkaido into square cells and measure every cell from open data.
//   node scripts/build-scan-data.mjs [--cell-km 1] [--offline]
// Writes web/public/data/scan/hokkaido-<cell>km.json. All input values are NASA data. Downloads
// are cached under data/raw/ so a rerun (or a finer cell size) needs no network:
// NASADEM tiles in data/raw/nasadem/<id>.tif, NASA POWER climatology in data/raw/power/<lat>_<lon>.json.
//
// Per cell (from NASADEM, 1 arc-second ≈ 30 m pixels):
//   elev     mean elevation [m]               relief  max − min [m]
//   slope    mean slope [0.1°]                p90     90th-percentile slope [0.1°]
//   shadow   share of pixels that get no sun at noon on the December solstice [‰]
//            (north-facing tilt steeper than the solstice noon sun, ≈ 23° at 43.5°N)
//   land     share of the cell that is land [%]
// On the NASA POWER grid (0.5° × 0.625°, the app interpolates to cells and corrects for height):
//   elev, monthly mean daily min / max air temperature (T2M_MIN / T2M_MAX) [°C], precipitation [mm/yr]
import fs from 'node:fs';
import path from 'node:path';
import { fromArrayBuffer } from 'geotiff';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const CELL_KM = +arg('--cell-km', '1');
const OFFLINE = process.argv.includes('--offline');
const CONC = 8;

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const rawDir = (...p) => path.join(root, 'data/raw', ...p);
const outFile = path.join(root, 'web/public/data/scan', `hokkaido-${CELL_KM}km.json`);

// Main island of Hokkaido (Rishiri/Rebun/Okushiri fall inside too; the Kurils are outside).
const BOX = { north: 45.56, south: 41.35, west: 139.3, east: 145.85 };
const LAT_MID = (BOX.north + BOX.south) / 2;
const dlat = CELL_KM / 111.32;
const dlon = CELL_KM / (111.32 * Math.cos((LAT_MID * Math.PI) / 180));
const rows = Math.ceil((BOX.north - BOX.south) / dlat);
const cols = Math.ceil((BOX.east - BOX.west) / dlon);
const lat0 = BOX.north - dlat / 2; // centre of row 0 (north)
const lon0 = BOX.west + dlon / 2; //  centre of col 0 (west)
const N = rows * cols;
console.log(`grid ${rows}×${cols} = ${N} cells of ${CELL_KM} km`);


async function pool(items, fn) {
  let i = 0, done = 0;
  const work = async () => {
    while (i < items.length) {
      const it = items[i++];
      await fn(it);
      if (++done % 200 === 0) console.log(`  ${done}/${items.length}`);
    }
  };
  await Promise.all(Array.from({ length: CONC }, work));
}

async function cached(file, url, { json = false } = {}) {
  if (fs.existsSync(file)) return fs.readFileSync(file);
  if (fs.existsSync(file + '.none')) return null;
  if (OFFLINE) return null;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await fetch(url);
      if (r.status === 404) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file + '.none', ''); return null; }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const buf = Buffer.from(await r.arrayBuffer());
      if (json) JSON.parse(buf.toString('utf8'));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, buf);
      return buf;
    } catch (e) {
      if (attempt === 3) throw new Error(`${url}: ${e.message}`);
      await new Promise((res) => setTimeout(res, 1000 * 2 ** attempt));
    }
  }
}

// ---- 1. NASADEM (NASA, 1 arc-second ≈ 30 m) → per-cell terrain ----
// NASADEM_HGT v001 is read as cloud-optimised GeoTIFFs from the Microsoft Planetary Computer
// mirror (no Earthdata login needed). Sea is 0 m.
const BINS = 45; // 2° slope bins up to 90°
const cnt = new Uint32Array(N), land = new Uint32Array(N), shadow = new Uint32Array(N);
const sumZ = new Float64Array(N), sumS = new Float64Array(N);
const minZ = new Float32Array(N).fill(Infinity), maxZ = new Float32Array(N).fill(-Infinity);
const hist = new Uint32Array(N * BINS);
const DEG = 180 / Math.PI;
// Solstice noon sun elevation by latitude (Earth tilt 23.44°).
const solsticeSun = (lat) => 90 - lat - 23.44;

const PC = 'https://planetarycomputer.microsoft.com/api';
async function nasademItems() {
  const file = rawDir('nasadem/items.json');
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  if (OFFLINE) return [];
  const r = await fetch(`${PC}/stac/v1/search`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ collections: ['nasadem'], bbox: [BOX.west, BOX.south, BOX.east, BOX.north], limit: 200 }),
  });
  if (!r.ok) throw new Error(`NASADEM STAC search: HTTP ${r.status}`);
  const items = (await r.json()).features.map((f) => ({ id: f.id, href: f.assets.elevation.href }));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(items, null, 1));
  return items;
}
let sasToken = null;
async function signed(href) {
  if (!sasToken) {
    const r = await fetch(`${PC}/sas/v1/token/nasadem`);
    if (!r.ok) throw new Error(`NASADEM token: HTTP ${r.status}`);
    sasToken = (await r.json()).token;
  }
  return `${href}?${sasToken}`;
}

const items = await nasademItems();
console.log(`NASADEM: ${items.length} tiles of 1°`);
let used = 0;
const CONC_DEM = 4; // tiles are ~10–25 MB each
const queue = [...items];
await Promise.all(Array.from({ length: CONC_DEM }, async () => {
  while (queue.length) {
    const it = queue.shift();
    const file = rawDir(`nasadem/${it.id}.tif`);
    let buf = fs.existsSync(file) ? fs.readFileSync(file) : null;
    if (!buf && !OFFLINE) {
      buf = await cached(file, await signed(it.href));
    }
    if (!buf) continue;
    const tiff = await fromArrayBuffer(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    const img = await tiff.getImage();
    const [west, , , north] = img.getBoundingBox();
    const [rx, ry] = img.getResolution(); // degrees; ry is negative
    const W = img.getWidth(), H = img.getHeight();
    const z = (await img.readRasters({ interleave: true }));
    const nodata = img.getGDALNoData();
    used++;
    console.log(`  ${it.id}: ${W}×${H}`);
    for (let y = 1; y < H - 1; y++) {
      const lat = north + (y + 0.5) * ry;
      const r = Math.floor((BOX.north - lat) / dlat);
      if (r < 0 || r >= rows) continue;
      const dyM = Math.abs(ry) * 111320, dxM = rx * 111320 * Math.cos((lat * Math.PI) / 180);
      const sunTan = Math.tan((Math.max(1, solsticeSun(lat)) * Math.PI) / 180);
      for (let x = 1; x < W - 1; x++) {
        const lon = west + (x + 0.5) * rx;
        const c = Math.floor((lon - BOX.west) / dlon);
        if (c < 0 || c >= cols) continue;
        const k = r * cols + c, h = z[y * W + x];
        cnt[k]++;
        if (h <= 0 || h === nodata) continue; // sea / void
        land[k]++;
        sumZ[k] += h;
        if (h < minZ[k]) minZ[k] = h;
        if (h > maxZ[k]) maxZ[k] = h;
        const e = z[y * W + x + 1], w = z[y * W + x - 1], s = z[(y + 1) * W + x], n = z[(y - 1) * W + x];
        if (e === nodata || w === nodata || s === nodata || n === nodata) continue;
        const gx = (e - w) / (2 * dxM), gyS = (s - n) / (2 * dyM); // gyS: rise towards the south
        const slope = Math.atan(Math.hypot(gx, gyS)) * DEG;
        sumS[k] += slope;
        hist[k * BINS + Math.min(BINS - 1, Math.floor(slope / 2))]++;
        // Ground rising towards the south faces north; it is self-shadowed when steeper than the sun.
        if (gyS > sunTan) shadow[k]++;
      }
    }
  }
}));
console.log(`NASADEM tiles used: ${used}`);
if (!used) throw new Error('NASADEM: no tiles (network?)');

const cells = { i: [], elev: [], relief: [], slope: [], p90: [], shadow: [], land: [] };
for (let k = 0; k < N; k++) {
  if (!cnt[k] || land[k] / cnt[k] < 0.5) continue;
  let nS = 0;
  for (let b = 0; b < BINS; b++) nS += hist[k * BINS + b];
  if (!nS) continue;
  let acc = 0, p90 = 0;
  for (let b = 0; b < BINS; b++) { acc += hist[k * BINS + b]; if (acc >= 0.9 * nS) { p90 = (b + 1) * 2; break; } }
  cells.i.push(k);
  cells.elev.push(Math.round(sumZ[k] / land[k]));
  cells.relief.push(Math.round(maxZ[k] - minZ[k]));
  cells.slope.push(Math.round((sumS[k] / nS) * 10));
  cells.p90.push(p90 * 10);
  cells.shadow.push(Math.round((shadow[k] / nS) * 1000));
  cells.land.push(Math.round((land[k] / cnt[k]) * 100));
}
console.log(`land cells: ${cells.i.length}`);

// ---- 2. NASA POWER climatology on its native grid ----
const P = { dlat: 0.5, dlon: 0.625 };
P.lat0 = Math.ceil(BOX.north / P.dlat) * P.dlat; // north row centre
P.lon0 = Math.floor(BOX.west / P.dlon) * P.dlon; //  west col centre
P.rows = Math.round((P.lat0 - Math.floor(BOX.south / P.dlat) * P.dlat) / P.dlat) + 1;
P.cols = Math.round((Math.ceil(BOX.east / P.dlon) * P.dlon - P.lon0) / P.dlon) + 1;
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const pts = [];
for (let r = 0; r < P.rows; r++) for (let c = 0; c < P.cols; c++) pts.push([r, c, +(P.lat0 - r * P.dlat).toFixed(3), +(P.lon0 + c * P.dlon).toFixed(3)]);
console.log(`POWER: ${pts.length} grid points`);
const power = { ...P, elev: [], tmin: [], tmax: [], precip: [] };
const res = new Array(pts.length);
await pool(pts.map((p, k) => [k, p]), async ([k, [, , lat, lon]]) => {
  const url = `https://power.larc.nasa.gov/api/temporal/climatology/point?parameters=T2M_MIN,T2M_MAX,PRECTOTCORR&community=AG&longitude=${lon}&latitude=${lat}&format=JSON`;
  const buf = await cached(rawDir(`power/${lat}_${lon}.json`), url, { json: true });
  res[k] = buf ? JSON.parse(buf.toString('utf8')) : null;
});
for (const j of res) {
  const p = j?.properties?.parameter;
  const ok = p && p.T2M_MIN && p.T2M_MIN.JAN > -900;
  power.elev.push(ok ? Math.round(j.geometry.coordinates[2] ?? 0) : null);
  power.tmin.push(ok ? MONTHS.map((m) => +p.T2M_MIN[m].toFixed(1)) : null);
  power.tmax.push(ok ? MONTHS.map((m) => +p.T2M_MAX[m].toFixed(1)) : null);
  power.precip.push(ok ? Math.round(p.PRECTOTCORR.ANN * 365.25) : null);
}
const missing = power.tmin.filter((v) => v === null).length;
if (missing === pts.length) throw new Error('NASA POWER: no data (network?)');
console.log(`POWER points with data: ${pts.length - missing}`);

// ---- 3. write ----
const out = {
  version: 1, cell_km: CELL_KM, lat0, lon0, dlat, dlon, rows, cols,
  src: {
    dem: 'NASA NASADEM_HGT v001, 1 arc-second (via Microsoft Planetary Computer)',
    climate: 'NASA POWER climatology T2M_MIN / T2M_MAX / PRECTOTCORR, MERRA-2 (https://power.larc.nasa.gov)',
    built: new Date().toISOString().slice(0, 10),
  },
  cells, power,
};
fs.mkdirSync(path.dirname(outFile), { recursive: true });
const s = JSON.stringify(out);
fs.writeFileSync(outFile, s);
console.log(`${path.relative(root, outFile)}: ${(s.length / 1024 / 1024).toFixed(1)} MB`);
