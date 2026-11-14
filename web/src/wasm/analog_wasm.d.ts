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
 * Ranking of every Earth site for a profile id (or a weights JSON object).
 */
export function rankAll(profile_or_weights: string): string;

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
 * Bilinear elevations for `[[lat, lon], …]` from a stored grid (null outside or in holes).
 */
export function sampleGrid(name: string, latlons: string): string;

/**
 * Parse the data.nasa.gov EVA CSV, keep its statistics and return them.
 */
export function setEvaCsv(csv: string): string;

/**
 * Store an elevation grid under a name (`{lat0, lon0, dlat, dlon, rows, cols, z}`).
 */
export function setGrid(name: string, grid_json: string): void;

/**
 * Store the simplified Perseverance traverse (`{drives: [{sol, c: [[lon, lat, z], …]}]}`).
 */
export function setTraverse(traverse_json: string): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly bootstrap: () => [number, number];
    readonly distanceKm: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number];
    readonly evaLongerShare: (a: number) => number;
    readonly evaluateRoute: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
    readonly rankAll: (a: number, b: number) => [number, number, number, number];
    readonly reach: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => [number, number, number, number];
    readonly rehearse: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => [number, number, number, number];
    readonly roverCheck: (a: number, b: number, c: number) => [number, number, number, number];
    readonly sampleGrid: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly setEvaCsv: (a: number, b: number) => [number, number];
    readonly setGrid: (a: number, b: number, c: number, d: number) => [number, number];
    readonly setTraverse: (a: number, b: number) => [number, number, number, number];
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
