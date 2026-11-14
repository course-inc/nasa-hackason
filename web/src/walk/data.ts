// WALKBACK datasets bundled under web/public/data (built by scripts/build-walk-data.mjs), so the
// desktop app works without a network. Large JSON is handed to the Rust core once.
import type { Core, EvaStats, RoverStats, Waypoint } from '../core';

export const JEZERO = 'jezero';
/** Perseverance landing site ("Octavia E. Butler Landing"). */
export const LANDING: Waypoint = { lat: 18.4446, lon: 77.4509 };

export interface HokkaidoSite { id: string; name: string; lat: number; lon: number; rows: number; cols: number; nulls: number }

/** jezero_footing.json (scripts/build-jezero-footing.mjs). */
export interface Footing { rows: number; cols: number; ti: (number | null)[]; dci: (number | null)[]; src: string }
/** The footing JSON as text, handed to the Rust core when the footing is switched on. */
export let footingText = '';
let footingSet: boolean | null = null;
/** Count the footing in the Rust core's Jezero grid or not (only calls into WASM on a change). */
export function ensureFooting(core: Core, on: boolean) {
  if (!footingText || footingSet === on) return;
  try { core.setFooting(JEZERO, on ? footingText : ''); footingSet = on; } catch (e) { console.warn('footing', e); }
}

/** Elevation grid as stored in web/public/data (north-up, cell centres, metres or null). */
export interface GridData { lat0: number; lon0: number; dlat: number; dlon: number; rows: number; cols: number; z: (number | null)[]; src?: string }

export interface WalkData {
  dem: { lat0: number; lon0: number; dlat: number; dlon: number; rows: number; cols: number; src?: string } | null;
  /** The same Jezero grid with elevations, for the 3D view. */
  demGrid: GridData | null;
  rover: RoverStats | null;
  /** Rover path as [lat, lon] polylines for the map. */
  traverse: [number, number][][];
  /** The same path as [lon, lat, z] for building the example route. */
  traverseRaw: [number, number, number][][];
  eva: EvaStats | null;
  hokkaido: HokkaidoSite[];
  /** Footing per Jezero grid cell (THEMIS thermal inertia, TES dust cover index), for the map layer. */
  footing: Footing | null;
  /** Jezero hourly air temperature / pressure (Perseverance MEDA), loaded into the Rust core. */
  weather: { hours: { hour: number; air_temp_k: number | null; pressure_pa: number | null; sols: number }[]; sols: number[]; src: string } | null;
  /** Datasets that failed to load: 'dem' | 'traverse' | 'eva' | 'hokkaido' (details in the console). */
  errors: string[];
}

const get = async (path: string) => {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return r.text();
};

let cache: Promise<WalkData> | null = null;

export function loadWalkData(core: Core): Promise<WalkData> {
  cache ??= (async () => {
    const d: WalkData = { dem: null, demGrid: null, rover: null, traverse: [], traverseRaw: [], eva: null, hokkaido: [], footing: null, weather: null, errors: [] };
    await Promise.all([
      get('./data/jezero_dem.json').then((t) => {
        core.setGrid(JEZERO, t);
        const g = JSON.parse(t) as GridData;
        const { z: _z, ...meta } = g;
        d.dem = meta;
        d.demGrid = g;
      }).catch((e) => (console.warn('jezero dem', e), d.errors.push('dem'))),
      get('./data/jezero_weather.json').then((t) => { core.setWeather(t); d.weather = JSON.parse(t); })
        .catch((e) => (console.warn('weather', e), d.errors.push('weather'))),
      get('./data/jezero_footing.json').then((t) => { footingText = t; d.footing = JSON.parse(t); })
        .catch((e) => (console.warn('footing', e), d.errors.push('footing'))),
      get('./data/m20_traverse.json').then((t) => {
        d.rover = core.setTraverse(t);
        const j = JSON.parse(t) as { drives: { sol: number; c: [number, number, number][] }[] };
        d.traverseRaw = j.drives.map((x) => x.c);
        d.traverse = j.drives.map((x) => x.c.map((p) => [p[1], p[0]] as [number, number]));
      }).catch((e) => (console.warn('traverse', e), d.errors.push('traverse'))),
      get('./data/eva.csv').then((t) => { d.eva = core.setEvaCsv(t); })
        .catch((e) => (console.warn('eva', e), d.errors.push('eva'))),
      get('./data/hokkaido/index.json').then((t) => { d.hokkaido = JSON.parse(t); })
        .catch((e) => (console.warn('hokkaido grids', e), d.errors.push('hokkaido'))),
    ]);
    // The grid is set first (above); footing counts by default.
    if (d.dem) ensureFooting(core, true);
    return d;
  })();
  return cache;
}

const loadedHk = new Map<string, Promise<GridData>>();
export function loadHokkaidoGrid(core: Core, id: string): Promise<GridData> {
  let p = loadedHk.get(id);
  if (!p) {
    p = get(`./data/hokkaido/${id}.json`).then((t) => { core.setGrid(`hk:${id}`, t); return JSON.parse(t) as GridData; });
    loadedHk.set(id, p);
  }
  return p;
}

/**
 * Example route: the first points where Perseverance's path got 0.6, 1.2, … `awayKm` km (straight
 * line) from the landing site. Gives a meaningful first screen before anyone clicks.
 */
export function exampleRoute(raw: [number, number, number][][], stepKm = 0.6, awayKm = 3.0): Waypoint[] {
  const R = 3389.5, k = (Math.PI / 180) * R;
  const pts: Waypoint[] = [LANDING];
  let next = stepKm;
  for (const line of raw) {
    for (const p of line) {
      const away = Math.hypot((p[0] - LANDING.lon) * k * Math.cos((p[1] * Math.PI) / 180), (p[1] - LANDING.lat) * k);
      if (away >= next) {
        pts.push({ lat: p[1], lon: p[0] });
        next += stepKm;
        if (next > awayKm + 1e-9) return pts;
      }
    }
  }
  return pts;
}
