// #10 inside #11: agent tools over the whole-Hokkaido scan.
//   explore_hokkaido (compute)  best 1 km cells for a Moon/Mars target and test, via DuckDB over
//                               the Rust scan (cells + score_<body>_<test>). Numbers only from
//                               the engine/DB; the SQL that produced them is returned.
//   view_scan (view)            switch the #target view (target, test, mode, focus point).
import type { Core } from '../core';
import type { Row } from '../db';
import { DEFAULT_TARGET, DEFAULT_TEST, scanViewBus, type ScanViewRequest } from './scanBus';
import { validateWhere, WHERE_COLUMNS } from './where';

// Same shapes as web/src/agent/types.ts (owned by #11); switch to that import once it lands.
export interface ToolResult { text: string; data?: unknown; sources?: { label: string; url?: string }[]; sql?: string }
export interface ToolDef {
  name: string; description: string; parameters: Record<string, unknown>; kind: 'compute' | 'view';
  run(args: any): Promise<ToolResult>;
}

export const TESTS = ['landing', 'ice', 'walk', 'caves', 'build'] as const;
export { DEFAULT_TARGET, DEFAULT_TEST, scanViewBus };

export const SCAN_SOURCES = [
  { label: 'NASADEM (terrain, 1″)', url: 'https://lpdaac.usgs.gov/products/nasadem_hgtv001/' },
  { label: 'NASA POWER climatology (air temperature, precipitation)', url: 'https://power.larc.nasa.gov/' },
  { label: 'MODIS MOD13A1 NDVI (summer vegetation)', url: 'https://lpdaac.usgs.gov/products/mod13a1v061/' },
  { label: 'MODIS MCD12Q1 land cover via NASA GIBS', url: 'https://gibs.earthdata.nasa.gov/' },
];

export interface ExploreArgs { target?: string; test?: string; n?: number; where?: string }
export interface ExploreRow {
  k: number; lat: number; lon: number; elev_m: number; slope_deg: number; ndvi: number | null; score: number;
  near_site: string | null; near_site_ja: string | null; near_km: number | null; season: string; season_ja: string;
}
export interface ExploreResult extends ToolResult {
  data: ExploreRow[]; sql: string; target: string; test: string;
}

export const exploreParameters = {
  type: 'object',
  properties: {
    target: { type: 'string', description: 'Moon/Mars target id, e.g. jezero, arcadia, mons_mouton, shackleton', default: DEFAULT_TARGET },
    test: { type: 'string', enum: TESTS, description: 'What to rehearse', default: DEFAULT_TEST },
    n: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
    where: {
      type: 'string',
      description: `Optional SQL boolean over the cell columns (${WHERE_COLUMNS.join(', ')}), e.g. "elev_m >= 1000 AND ndvi < 0.4". One expression only.`,
    },
  },
  additionalProperties: false,
} as const;

/** The SQL explore_hokkaido runs. Ordering is scan::top's: score to 0.01 desc, then barest ground. */
export function exploreSql(table: string, n: number, where?: string): string {
  const d = (a: string) => `111.32 * sqrt(pow(t.lat - ${a}.lat, 2) + pow((t.lon - ${a}.lon) * cos(radians((t.lat + ${a}.lat) / 2)), 2))`;
  const order = 'round(score * 100) DESC, ndvi ASC NULLS LAST, barren DESC NULLS LAST, relief_m DESC';
  return [
    'WITH best AS (',
    '  SELECT c.k, c.lat, c.lon, c.elev_m, c.slope_deg, c.ndvi, c.barren, c.relief_m, s.score',
    `  FROM cells c JOIN ${table} s USING (k)`,
    `  WHERE NOT s.excluded AND s.score > 0${where ? ` AND (${where})` : ''}`,
    `  ORDER BY ${order}`,
    `  LIMIT ${n}`,
    '), near AS (',
    `  SELECT b.k, arg_min(t.name_en, ${d('b')}) AS site, arg_min(t.name_ja, ${d('b')}) AS site_ja, min(${d('b')}) AS km`,
    '  FROM best b CROSS JOIN sites t GROUP BY b.k',
    ')',
    'SELECT best.k, best.lat, best.lon, best.elev_m, best.slope_deg, best.ndvi, best.score,',
    '  CASE WHEN near.km <= 15 THEN near.site END AS near_site,',
    '  CASE WHEN near.km <= 15 THEN near.site_ja END AS near_site_ja,',
    '  CASE WHEN near.km <= 15 THEN round(near.km, 1) END AS near_km',
    'FROM best JOIN near USING (k)',
    `ORDER BY ${order}`,
  ].join('\n');
}

const num = (v: Row[string]) => (v === null ? null : Number(v));

export async function exploreHokkaido(core: Core, args: ExploreArgs = {}): Promise<ExploreResult> {
  const target = args.target ?? DEFAULT_TARGET;
  const test = args.test ?? DEFAULT_TEST;
  const body = core.bodies.find((b) => b.id === target);
  if (!body) throw new Error(`unknown target "${target}" (one of ${core.bodies.map((b) => b.id).join(', ')})`);
  const prof = core.profiles.find((p) => p.test && p.id === test);
  if (!prof) throw new Error(`unknown test "${test}" (one of ${TESTS.join(', ')})`);
  const n = Math.max(1, Math.min(50, Math.round(Number(args.n ?? 10)) || 10));
  let where: string | undefined;
  if (args.where !== undefined && args.where !== '') {
    const w = validateWhere(args.where);
    if (!w.ok) throw new Error(`where: ${w.error}`);
    where = w.where;
  }

  const { openDb } = await import('../db'); // duckdb-wasm stays out of the first load
  const db = await openDb(core);
  const table = await db.ensureScores(target, test);
  const sql = exploreSql(table, n, where);
  const data: ExploreRow[] = (await db.query(sql)).map((r) => ({
    k: Number(r.k), lat: Number(r.lat), lon: Number(r.lon), elev_m: Number(r.elev_m), slope_deg: Number(r.slope_deg),
    ndvi: num(r.ndvi), score: Number(r.score),
    near_site: (r.near_site as string | null) ?? null, near_site_ja: (r.near_site_ja as string | null) ?? null, near_km: num(r.near_km),
    season: prof.season_en, season_ja: prof.season,
  }));

  const line = (r: ExploreRow, i: number) =>
    `${i + 1}) ${r.lat.toFixed(2)}N ${r.lon.toFixed(2)}E, ${Math.round(r.elev_m)} m, slope ${r.slope_deg.toFixed(1)}°, ` +
    `NDVI ${r.ndvi === null ? 'n/a' : r.ndvi.toFixed(2)}, score ${r.score.toFixed(2)}${r.near_site ? ` (≈ ${r.near_site}, ${r.near_km} km)` : ''}`;
  const text = data.length
    ? `Top ${data.length} Hokkaido cells for ${body.name} / ${prof.en}${where ? ` where ${where}` : ''}: ${data.map(line).join('; ')}. Best season: ${prof.season_en}.`
    : `No open-ground Hokkaido cell matches ${body.name} / ${prof.en}${where ? ` where ${where}` : ''}.`;
  return { text, data, sql, sources: SCAN_SOURCES, target, test };
}

export function makeExploreTool(core: Core): ToolDef {
  return {
    name: 'explore_hokkaido',
    description: 'Find where in Hokkaido to rehearse a Moon/Mars activity: ranks every 1 km land cell (NASA terrain, climate, vegetation, land cover) with the same scoring engine as the map, optionally filtered by a SQL condition. Returns the cells, the SQL and the data sources.',
    parameters: exploreParameters,
    kind: 'compute',
    run: (args: ExploreArgs) => exploreHokkaido(core, args ?? {}),
  };
}

export function makeScanViewTool(core: Core): ToolDef {
  return {
    name: 'view_scan',
    description: 'Show the Hokkaido map for a Moon/Mars target and test: mode "scan" shows the 1 km heat map, "sites" the 14 known sites; focus flies to a point and opens that cell.',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Moon/Mars target id' },
        test: { type: 'string', enum: TESTS },
        mode: { type: 'string', enum: ['scan', 'sites'], default: 'scan' },
        focus: { type: 'object', properties: { lat: { type: 'number' }, lon: { type: 'number' } }, required: ['lat', 'lon'] },
      },
      additionalProperties: false,
    },
    kind: 'view',
    run: async (args: Omit<ScanViewRequest, 'seq'> = {}) => {
      if (args.target && !core.bodies.some((b) => b.id === args.target)) throw new Error(`unknown target "${args.target}"`);
      if (args.test && !(TESTS as readonly string[]).includes(args.test)) throw new Error(`unknown test "${args.test}"`);
      const mode = args.mode ?? 'scan';
      scanViewBus.emit({ ...args, mode });
      if (!location.hash.startsWith('#target')) location.hash = '#target';
      return { text: `Showing ${mode === 'scan' ? 'the 1 km scan' : 'the 14 known sites'}${args.target ? ` for ${args.target}` : ''}${args.test ? ` / ${args.test}` : ''}${args.focus ? ` at ${args.focus.lat.toFixed(3)}N ${args.focus.lon.toFixed(3)}E` : ''}.` };
    },
  };
}
