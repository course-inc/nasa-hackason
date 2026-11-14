/* tslint:disable */
/* eslint-disable */

/**
 * Static datasets and constants in one call: { worlds, earthSites, bodies, missions, profiles, dims }.
 */
export function bootstrap(): string;

/**
 * Great-circle distance in km on a body.
 */
export function distanceKm(world: string, lat1: number, lon1: number, lat2: number, lon2: number): number;

/**
 * Share (0–1) of real EVAs longer than `hours`; -1 if the CSV is not loaded.
 */
export function evaLongerShare(hours: number): number;

/**
 * Evaluate an EVA route. `points`: [{lat, lon|lng, elev?}], `params`: {speed_kmh, o2_h, reserve}.
 */
export function evaluateRoute(world: string, points: string, params: string): string;

/**
 * What Hokkaido cannot reproduce for this target, with numbers; critical-for-test first.
 */
export function gaps(earth_id: string, body_id: string, test: string): string;

/**
 * Ranking of every Earth site for a profile id (or a weights JSON object).
 */
export function rankAll(profile_or_weights: string): string;

/**
 * Every Hokkaido site ranked for one Moon/Mars target and rehearsal test (profile id).
 */
export function rankSites(body_id: string, profile_id: string): string;

/**
 * Walk-home area around a base on a stored grid.
 */
export function reach(world: string, name: string, lat: number, lon: number, params: string, max_slope_deg: number): string;

/**
 * Find where the same walk can be rehearsed on a stored Earth grid.
 * `points`: densified Mars route with elevation. Returns the best `top` matches.
 */
export function rehearse(from_world: string, points: string, grid_name: string, stride: number, rot_step_deg: number, top: number): string;

/**
 * Compare densified route points (with elevation) with the stored traverse.
 */
export function roverCheck(points: string, near_m: number): string;

/**
 * Crewed-rover breakdown check along the stored traverse: from each point, could the crew walk
 * back to the base (grid `name`, same EvaParams as the walk-home area)?
 */
export function roverWalkback(world: string, name: string, lat: number, lon: number, params: string, max_slope_deg: number): string;

/**
 * Crewed-rover breakdown check on traverse rows read with SQL (`[{drive, seq, sol, lat, lon,
 * elev_m, km}]` in drive/seq order, from the rover_traverse parquet). Same calculation as
 * `roverWalkback`; only where the path comes from differs.
 */
export function roverWalkbackFrom(world: string, name: string, lat: number, lon: number, params: string, max_slope_deg: number, rows: string): string;

/**
 * Bilinear elevations for `[[lat, lon], …]` from a stored grid (null outside or in holes).
 */
export function sampleGrid(name: string, latlons: string): string;

/**
 * One cell in full: terrain, height-corrected climate and the 5-axis score.
 */
export function scanCell(k: number, body_id: string, profile_id: string): string;

/**
 * Land cell index at a point, or -1.
 */
export function scanCellAt(lat: number, lon: number): number;

/**
 * Grid index (`row * cols + col`) of every land cell, in cell order.
 */
export function scanCells(): Uint32Array;

/**
 * Every land cell as columns (for the duckdb `cells` table in web/src/db.ts): terrain, MODIS
 * shares as fractions (null = no data), height-corrected NASA POWER climate and the land-cover
 * screen reason (null = open ground). Same units as `scanCell`.
 */
export function scanColumns(): string;

/**
 * What Hokkaido cannot reproduce, for a scan cell instead of a known site.
 */
export function scanGaps(k: number, body_id: string, test: string): string;

/**
 * Match (0–1) of every land cell for a target and test, in cell order.
 */
export function scanScores(body_id: string, profile_id: string): Float32Array;

/**
 * Best cells at least `min_km` apart, plus how each known site's cell ranks.
 */
export function scanTop(scores: Float32Array | number[], n: number, min_km: number): string;

/**
 * Parse the data.nasa.gov EVA CSV, keep its statistics and return them.
 */
export function setEvaCsv(csv: string): string;

/**
 * Store an elevation grid under a name (`{lat0, lon0, dlat, dlon, rows, cols, z}`).
 */
export function setGrid(name: string, grid_json: string): void;

/**
 * Load the scan grid (web/public/data/scan/hokkaido-*.json). Returns its meta JSON.
 */
export function setScan(json_str: string): string;

/**
 * Store the simplified Perseverance traverse (`{drives: [{sol, c: [[lon, lat, z], …]}]}`).
 */
export function setTraverse(traverse_json: string): string;

/**
 * #11 A: lay a walk recorded on Earth onto Mars from `base` (same east/north metres).
 */
export function transplantWalk(points: string, base_lat: number, base_lon: number): string;

/**
 * #11 A: summary of a recorded walk (`[{lat, lon, elev, t}]`, elevation from a DEM) on Earth.
 */
export function walkSummary(points: string): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly bootstrap: () => [number, number];
    readonly distanceKm: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number];
    readonly evaLongerShare: (a: number) => number;
    readonly evaluateRoute: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
    readonly gaps: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number];
    readonly rankAll: (a: number, b: number) => [number, number, number, number];
    readonly rankSites: (a: number, b: number, c: number, d: number) => [number, number];
    readonly reach: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => [number, number, number, number];
    readonly rehearse: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => [number, number, number, number];
    readonly roverCheck: (a: number, b: number, c: number) => [number, number, number, number];
    readonly roverWalkback: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => [number, number, number, number];
    readonly roverWalkbackFrom: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number) => [number, number, number, number];
    readonly sampleGrid: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly scanCell: (a: number, b: number, c: number, d: number, e: number) => [number, number, number, number];
    readonly scanCellAt: (a: number, b: number) => [number, number, number];
    readonly scanCells: () => [number, number, number, number];
    readonly scanColumns: () => [number, number, number, number];
    readonly scanGaps: (a: number, b: number, c: number, d: number, e: number) => [number, number, number, number];
    readonly scanScores: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly scanTop: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly setEvaCsv: (a: number, b: number) => [number, number];
    readonly setGrid: (a: number, b: number, c: number, d: number) => [number, number];
    readonly setScan: (a: number, b: number) => [number, number, number, number];
    readonly setTraverse: (a: number, b: number) => [number, number, number, number];
    readonly transplantWalk: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly walkSummary: (a: number, b: number) => [number, number, number, number];
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
