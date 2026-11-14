// query_nasa: read-only SQL over the NASA tables (DuckDB). For questions no fixed tool answers
// ("how many EVAs ran over 8 hours?", "how far had Perseverance driven by sol 1000?"). Guarded:
// one SELECT, a fixed list of tables, no file or network functions, a row cap and a time cap.
// The SQL and the sources come back with the rows so the panel can show them as evidence.
import type { Core } from '../core';
import type { Row } from '../db';
import { getLang } from '../i18n';
import { marsDb, withTimeout } from './marsDb';
import type { ToolDef, ToolResult } from './types';

export const TABLES: Record<string, string> = {
  rover_traverse: 'Perseverance drive record: mission, drive, seq, sol, lat, lon, elev_m, km (distance driven so far)',
  eva: 'Real EVAs (US and Russia): id, country, crew, vehicle, date, hours',
  mars_footing: 'Footing of the Jezero grid cells (~60 m): lat, lon, thermal_inertia (Mars Odyssey THEMIS, J m-2 K-1 s-1/2; ≤150 loose sand/dust, ≥400 rock/cemented), dust_cover_index (MGS TES; <0.94 dusty)',
  mars_names: "Mars gazetteer (IAU names, landing sites, crewed-landing candidates): name, kind ('feature' | 'landing' | 'crewed'), type (Crater, Vallis, Mons, Planitia, … or 'Landing site'), lat, lon (degrees east, -180..180), diameter_km, origin (what the name honours), year, agency, link",
  targets: 'Moon/Mars target sites: body_id, world, name_en, name_ja, lat, tmin_k, tmax_k, slope_deg',
  sites: '14 known Hokkaido analogue sites: earth_id, name_en, name_ja, lat, lon',
  tests: 'Rehearsal tests: id, name_en, name_ja, season_en, season_ja',
  cells: 'Hokkaido 1 km cells (NASA terrain/climate/vegetation): k, lat, lon, elev_m, relief_m, slope_deg, slope_p90_deg, ndvi, urban, crop, forest, water, barren, tmin_jan_c, tmax_aug_c, precip_mm, screened',
};
const SCAN_SOURCE = { label: 'Hokkaido 1 km scan: NASADEM, NASA POWER, MODIS (analog-core scan)' };
export const MAX_ROWS = 200;
export const TIME_MS = 8000;

const FORBIDDEN = /\b(insert|update|delete|create|drop|alter|attach|detach|copy|export|import|pragma|install|load|call|set|reset|checkpoint|vacuum|begin|commit|rollback|grant|revoke|use|truncate|merge)\b/i;
const FORBIDDEN_FN = /\b(read_\w+|glob|parquet_\w+|sniff_csv|http_\w+|getenv|current_setting|duckdb_\w+|pg_\w+|query|query_table|sql_auto_complete|which_secret)\s*\(/i;

export type Check = { ok: true; sql: string; tables: string[] } | { ok: false; error: string };

/** Accept one read-only SELECT over the allowed tables. */
export function checkSql(input: string): Check {
  const sql = input.replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ').trim().replace(/;\s*$/, '');
  if (!sql) return { ok: false, error: 'empty SQL' };
  if (sql.includes(';')) return { ok: false, error: 'one statement only' };
  if (!/^(select|with)\b/i.test(sql)) return { ok: false, error: 'only SELECT (or WITH … SELECT) is allowed' };
  if (FORBIDDEN.test(sql)) return { ok: false, error: `not allowed: ${sql.match(FORBIDDEN)![0]}` };
  if (FORBIDDEN_FN.test(sql)) return { ok: false, error: `function not allowed: ${sql.match(FORBIDDEN_FN)![1]}` };
  if (/\b(from|join)\s+['"]/i.test(sql)) return { ok: false, error: 'read from the listed tables, not from files' };
  const ctes = new Set([...sql.matchAll(/(?:\bwith\b|,)\s*([a-z_]\w*)\s+as\s*\(/gi)].map((m) => m[1].toLowerCase()));
  const used = [...sql.matchAll(/\b(?:from|join)\s+([a-z_][\w.]*)/gi)].map((m) => m[1].toLowerCase());
  const bad = used.filter((t) => !(t in TABLES) && !ctes.has(t));
  if (bad.length) return { ok: false, error: `unknown table ${bad.join(', ')} (tables: ${Object.keys(TABLES).join(', ')})` };
  return { ok: true, sql, tables: [...new Set(used.filter((t) => t in TABLES))] };
}

const fmt = (v: Row[string]) => (typeof v === 'number' ? (Number.isInteger(v) ? String(v) : String(+v.toFixed(4))) : v === null ? 'null' : String(v));

export function makeQueryNasa(core: Core): ToolDef {
  return {
    name: 'query_nasa',
    kind: 'compute',
    description: `Run one read-only SQL SELECT (DuckDB dialect) over the NASA tables and get the rows back with the SQL and sources. Use it for counts, ranges, lists and comparisons no other tool answers. Tables: ${Object.entries(TABLES).map(([k, v]) => `${k} (${v})`).join('; ')}. At most ${MAX_ROWS} rows and ${TIME_MS / 1000} s: aggregate (count, min, max, avg) or filter with WHERE instead of listing everything.`,
    parameters: {
      type: 'object',
      properties: {
        sql: { type: 'string', description: 'One SELECT statement over the listed tables' },
        limit: { type: ['integer', 'string'], description: `Rows to return (1–${MAX_ROWS}, default 50)` },
      },
      required: ['sql'],
    },
    async run(a: { sql?: string; limit?: number | string } = {}): Promise<ToolResult> {
      const ja = getLang() === 'ja';
      const c = checkSql(String(a.sql ?? ''));
      if (!c.ok) throw new Error(ja ? `この SQL は実行できません: ${c.error}` : `This SQL cannot run: ${c.error}`);
      const limit = Math.max(1, Math.min(MAX_ROWS, Math.round(Number(a.limit ?? 50)) || 50));
      const { db, manifest } = await marsDb(core, c.tables);
      const wrapped = `SELECT * FROM (${c.sql}) AS q LIMIT ${limit + 1}`;
      const t0 = performance.now();
      let rows: Row[];
      try {
        rows = await withTimeout(db.query(wrapped), TIME_MS, 'query');
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/no answer within/.test(msg)) throw new Error(ja ? `${TIME_MS / 1000} 秒で終わりませんでした。WHERE で絞るか、集計（count・max など）にしてください。` : `Did not finish in ${TIME_MS / 1000} s. Narrow it with WHERE or aggregate (count, max…).`);
        throw new Error(ja ? `SQL のエラー: ${msg}` : `SQL error: ${msg}`);
      }
      const ms = Math.round(performance.now() - t0);
      if (rows.length > limit) {
        throw new Error(ja ? `結果が ${limit} 行を超えました。WHERE で絞るか、集計（count・avg など）にしてください。` : `More than ${limit} rows. Narrow it with WHERE or aggregate (count, avg…).`);
      }
      const cols = rows.length ? Object.keys(rows[0]) : [];
      const shown = rows.slice(0, 20).map((r) => cols.map((k) => `${k}=${fmt(r[k])}`).join(', '));
      const text = (ja ? `${rows.length} 行（${ms} ms）: ` : `${rows.length} rows (${ms} ms): `) +
        (shown.length ? shown.join(' | ') : ja ? '該当なし' : 'none') + (rows.length > 20 ? (ja ? ` …ほか ${rows.length - 20} 行` : ` … and ${rows.length - 20} more`) : '');
      const sources = c.tables.map((t) => manifest.tables[t]?.source ?? (t === 'cells' ? SCAN_SOURCE : { label: `${t} (analog-core)` }));
      return { text, data: { rows, ms, tables: c.tables }, sql: c.sql, sources };
    },
  };
}
