// DuckDB-WASM over the whole-Hokkaido scan, for data exploration and agent tools.
// The engine files are bundled from node_modules (Vite `?url`), so this works offline in Tauri
// and on the static web build. Every number in these tables comes from the Rust core: cell
// values from `scanColumns()`, match scores from `scan.scores()` (the same formula as the map).
//   cells   (k, lat, lon, elev_m, relief_m, slope_deg, slope_p90_deg, shadow, ndvi, urban, crop,
//            forest, water, barren, tmin_jan_c, tmax_aug_c, precip_mm, screened)
//   sites   (earth_id, name_en, name_ja, lat, lon)            the 14 known sites
//   targets (body_id, world, name_en, name_ja, lat, tmin_k, tmax_k, slope_deg)
//   tests   (id, name_en, name_ja, season_en, season_ja)
//   score_<body>_<test> (k, score, excluded)                  created by ensureScores
//   scan    view: cells ⨝ the score table of the last ensureScores pair
import * as duckdb from '@duckdb/duckdb-wasm';
import mvpWasm from '@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url';
import mvpWorker from '@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url';
import ehWasm from '@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url';
import ehWorker from '@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url';
import type { Core, Scan } from './core';
import { scanColumns } from './wasm/analog_wasm.js';

export type Row = Record<string, string | number | boolean | null>;

export interface Db {
  scan: Scan;
  query: (sql: string) => Promise<Row[]>;
  /** Create score_<body>_<test> once and point the `scan` view at it. Returns the table name. */
  ensureScores: (body: string, test: string) => Promise<string>;
}

const CELL_COLS: [string, string][] = [
  ['k', 'INTEGER'], ['lat', 'DOUBLE'], ['lon', 'DOUBLE'], ['elev_m', 'DOUBLE'], ['relief_m', 'DOUBLE'],
  ['slope_deg', 'DOUBLE'], ['slope_p90_deg', 'DOUBLE'], ['shadow', 'DOUBLE'], ['ndvi', 'DOUBLE'],
  ['urban', 'DOUBLE'], ['crop', 'DOUBLE'], ['forest', 'DOUBLE'], ['water', 'DOUBLE'], ['barren', 'DOUBLE'],
  ['tmin_jan_c', 'DOUBLE'], ['tmax_aug_c', 'DOUBLE'], ['precip_mm', 'DOUBLE'], ['screened', 'VARCHAR'],
];
export const CELL_COLUMNS = CELL_COLS.map(([c]) => c);

const cell = (v: unknown) => {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return `"${v.replace(/"/g, '""')}"`;
  return String(v);
};
const toCsv = (cols: string[], rows: unknown[][]) =>
  [cols.join(','), ...rows.map((r) => r.map(cell).join(','))].join('\n');

/** Identifier-safe body/test id (ids come from the core's own lists). */
const ident = (s: string) => {
  if (!/^[a-z0-9_]+$/.test(s)) throw new Error(`bad id: ${s}`);
  return s;
};

let dbPromise: Promise<Db> | null = null;

export function openDb(core: Core): Promise<Db> {
  dbPromise ??= open(core);
  dbPromise.catch(() => { dbPromise = null; });
  return dbPromise;
}

async function open(core: Core): Promise<Db> {
  const [scan, bundle] = await Promise.all([
    core.loadScan(1),
    duckdb.selectBundle({
      mvp: { mainModule: mvpWasm, mainWorker: mvpWorker },
      eh: { mainModule: ehWasm, mainWorker: ehWorker },
    }),
  ]);
  const worker = new Worker(bundle.mainWorker!);
  const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  const conn = await db.connect();

  const query = async (sql: string): Promise<Row[]> => {
    const t = await conn.query(sql);
    return t.toArray().map((r) => {
      const o = r.toJSON() as Record<string, unknown>;
      for (const key in o) if (typeof o[key] === 'bigint') o[key] = Number(o[key]);
      return o as Row;
    });
  };
  const load = async (table: string, cols: [string, string][], rows: unknown[][]) => {
    const file = `${table}.csv`;
    await db.registerFileText(file, toCsv(cols.map(([c]) => c), rows));
    const types = cols.map(([c, ty]) => `'${c}': '${ty}'`).join(', ');
    await conn.query(`CREATE OR REPLACE TABLE ${table} AS SELECT * FROM read_csv('${file}', header = true, columns = {${types}})`);
    await db.dropFile(file);
  };

  const c = JSON.parse(scanColumns()) as Record<string, unknown[]>;
  await load('cells', CELL_COLS, c.k.map((_, i) => CELL_COLUMNS.map((name) => c[name][i])));
  await load('sites', [['earth_id', 'VARCHAR'], ['name_en', 'VARCHAR'], ['name_ja', 'VARCHAR'], ['lat', 'DOUBLE'], ['lon', 'DOUBLE']],
    core.earthSites.map((e) => [e.id, e.en ?? e.name, e.name, e.lat, e.lon]));
  await load('targets', [['body_id', 'VARCHAR'], ['world', 'VARCHAR'], ['name_en', 'VARCHAR'], ['name_ja', 'VARCHAR'],
    ['lat', 'DOUBLE'], ['tmin_k', 'DOUBLE'], ['tmax_k', 'DOUBLE'], ['slope_deg', 'DOUBLE']],
    core.bodies.map((b) => [b.id, b.world, b.name, b.ja, b.lat, b.tmin, b.tmax, b.slope_mean_deg]));
  await load('tests', [['id', 'VARCHAR'], ['name_en', 'VARCHAR'], ['name_ja', 'VARCHAR'], ['season_en', 'VARCHAR'], ['season_ja', 'VARCHAR']],
    core.profiles.filter((p) => p.test).map((p) => [p.id, p.en, p.label, p.season_en, p.season]));

  const screened = c.screened as (string | null)[];
  const made = new Map<string, Promise<void>>();
  let current = '';
  const ensureScores = async (body: string, test: string) => {
    if (!core.bodies.some((b) => b.id === body)) throw new Error(`unknown target ${body}`);
    if (!core.profiles.some((p) => p.test && p.id === test)) throw new Error(`unknown test ${test}`);
    const table = `score_${ident(body)}_${ident(test)}`;
    if (!made.has(table)) {
      made.set(table, (async () => {
        const s = scan.scores(body, test);
        await load(table, [['k', 'INTEGER'], ['score', 'DOUBLE'], ['excluded', 'BOOLEAN']],
          Array.from(s, (v, k) => [k, v, screened[k] !== null]));
      })());
    }
    await made.get(table);
    if (current !== table) {
      await conn.query(`CREATE OR REPLACE VIEW scan AS SELECT c.*, s.score, s.excluded FROM cells c JOIN ${table} s USING (k)`);
      current = table;
    }
    return table;
  };

  return { scan, query, ensureScores };
}
