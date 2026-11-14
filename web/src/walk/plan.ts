// One plan → all its numbers. The WALKBACK screen and the agent tools both call this, so what a
// tool reports is exactly what the screen shows. Every number comes from the Rust core.
import type { Core, EvaParams, Reach, RouteCheck, RouteEval, RoverWalkback, Waypoint, World } from '../core';
import { JEZERO, LANDING, type WalkData } from './data';
import { densify, type Dense } from './geo';

export const WORLD: World = 'mars';
/** Same constant as analog-core route.rs (Gernhardt 2010): cooling water per unit of O₂ when walking hard. */
export const WATER_PER_O2 = 3.1 / 2.7;
/** Steeper steps are not walkable in the walk-home area. */
export const MAX_SLOPE = 25;

/** The sliders on the screen. reserve is in percent. */
export interface PlanParams { speed: number; o2: number; water: number; reserve: number }
export const DEFAULT_PARAMS: PlanParams = { speed: 2, o2: 8, water: 8, reserve: 20 };

export const evaParams = (q: PlanParams): EvaParams =>
  ({ speed_kmh: q.speed, o2_h: q.o2, water_h: q.water, reserve: q.reserve / 100, min_reserve_h: 0.5 });

export function denseRoute(core: Core, data: WalkData | null, route: Waypoint[]): Dense {
  return data ? densify(core, WORLD, route, 40) : { pts: route, wp: route.map((_, i) => i) };
}

export function evaluate(core: Core, dense: Dense, p: EvaParams): RouteEval {
  return core.evaluateRoute(WORLD, dense.pts, p);
}

export function roverCheck(core: Core, data: WalkData | null, dense: Dense): RouteCheck | null {
  if (!data?.rover || dense.pts.length < 2) return null;
  try { return core.roverCheck(dense.pts, 100); } catch { return null; }
}

export function reachFrom(core: Core, data: WalkData | null, base: Waypoint | undefined, p: EvaParams): Reach | null {
  if (!data?.dem || !base) return null;
  try { return core.reach(WORLD, JEZERO, base.lat, base.lon, p, MAX_SLOPE); } catch { return null; }
}

/** The Mars route resampled for the Hokkaido rehearsal search (points with known elevation). */
export function rehearsalPoints(core: Core, data: WalkData | null, route: Waypoint[]): Waypoint[] {
  return data ? densify(core, WORLD, route, 80).pts.filter((x) => x.elev != null) : [];
}

/** Index of the dense point where the walker turns back, or null when the whole route is walkable. */
export const turnIndex = (ev: RouteEval) => (ev.point_of_no_return != null ? Math.max(1, ev.point_of_no_return - 1) : null);

/** Waypoint number (WP n) the turn-back point lies before. */
export const turnWaypoint = (ev: RouteEval, dense: Dense) =>
  dense.wp.findIndex((w) => w >= (ev.point_of_no_return ?? 0));

export interface Plan {
  route: Waypoint[]; params: PlanParams; dense: Dense; ev: RouteEval;
  check: RouteCheck | null; longer: number; reach: Reach | null;
}

/** Everything the left panel shows for a route and slider settings. */
export function computePlan(core: Core, data: WalkData | null, route: Waypoint[], params: PlanParams): Plan {
  const p = evaParams(params);
  const dense = denseRoute(core, data, route);
  const ev = evaluate(core, dense, p);
  return {
    route, params, dense, ev,
    check: roverCheck(core, data, dense),
    longer: data?.eva ? core.evaLongerShare(ev.total_h) : 0,
    reach: reachFrom(core, data, route[0], p),
  };
}

/** Share of the budget above which the walk home is "tight" (same edge as the walk-home area map). */
export const TIGHT = 0.85;

/**
 * B: a crewed rover drives Perseverance's path from the landing site (the base) and breaks down.
 * From each point, could the crew walk home with these consumables? (Rust: home_ratio + walkback)
 */
export function roverWalkback(core: Core, data: WalkData | null, p: EvaParams): RoverWalkback | null {
  if (!data?.dem || !data.rover) return null;
  try { return core.roverWalkback(WORLD, JEZERO, LANDING.lat, LANDING.lon, p, MAX_SLOPE); } catch { return null; }
}

export type WalkbackState = 'ok' | 'tight' | 'no' | 'out';
export const walkbackState = (pt: { ratio: number | null; inside: boolean }): WalkbackState =>
  !pt.inside ? 'out' : pt.ratio == null || pt.ratio > 1 ? 'no' : pt.ratio > TIGHT ? 'tight' : 'ok';
export const WALKBACK_COLOR: Record<WalkbackState, string> = { ok: '#52c41a', tight: '#fadb14', no: '#ff4d4f', out: '#8c8c8c' };

/**
 * The same check with the path read from the rover_traverse table (DuckDB, parquet) instead of
 * the bundled JSON: SQL fetches the rows, the Rust core does the walking maths.
 */
export async function roverWalkbackSql(core: Core, data: WalkData | null, p: EvaParams): Promise<{ r: RoverWalkback; sql: string } | null> {
  if (!data?.dem) return null;
  const { marsQuery, ROVER_PATH_SQL } = await import('../agent/marsDb');
  const rows = await marsQuery(core, ROVER_PATH_SQL);
  return { r: core.roverWalkbackFrom(WORLD, JEZERO, LANDING.lat, LANDING.lon, p, MAX_SLOPE, rows), sql: ROVER_PATH_SQL };
}
