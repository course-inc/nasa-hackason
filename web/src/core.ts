// Typed wrapper around the Rust core (crates/analog-core) compiled to WASM.
// The same module runs in the browser build and inside the Tauri window.
import init, * as wasm from './wasm/analog_wasm.js';

export type World = 'earth' | 'moon' | 'mars';

export interface WorldInfo {
  id: World; label: string; icon: string;
  radius_km: number; gravity: number; axial_tilt_deg: number;
  view: [number, number, number];
}
export interface EarthSite {
  id: string; name: string; en?: string; lat: number; lon: number;
  elev_m?: number | null; slope_mean_deg: number; relief_m?: number | null;
  landcover_center?: string | null; lithology_ja?: string | null; lithology_en?: string | null; age_ja?: string | null;
}
export interface Body {
  id: string; world: World; name: string; ja: string; lat: number; lon: number;
  kind: string; task: string[]; tmin: number; tmax: number; slope_mean_deg: number;
  oxides: string; approx: boolean; src: string;
}
export interface Landing { name: string; year: number; agency: string; lat: number; lon: number }
export interface Preset { id: string; name: string; lat: number; lon: number; z: number }
export interface Profile { id: string; label: string; en: string; test: boolean; season: string; season_en: string; w: Record<string, number> }
export interface DimScore { key: string; label: string; label_en: string; s: number; why: string; why_en: string; formula: string }
export interface PairScore { body_id: string; total: number; raw: number; excluded: string | null; dims: DimScore[] }
export interface SiteRanking { earth_id: string; ranks: PairScore[] }
export interface SiteScore extends PairScore { earth_id: string }
export interface Gap {
  key: 'gravity' | 'vacuum' | 'cold' | 'hot' | 'sun' | 'radiation';
  label: string; label_en: string; value: string; detail: string; detail_en: string; critical: boolean;
}
export interface Waypoint { lat: number; lon: number; elev?: number | null }
export interface EvaParams {
  speed_kmh: number; o2_h: number; reserve: number;
  water_h?: number; min_reserve_h?: number; unknown_slope?: number;
}
export interface Leg { km: number; slope_deg: number; hours: number; effort_h: number; known: boolean }
export interface Tick { idx: number; t_h: number; km: number; o2_left: number; water_left: number; home_h: number; margin_h: number }
export interface RouteEval {
  out_km: number; out_h: number; back_km: number; back_h: number; total_h: number;
  total_effort_h: number; usable_h: number; usable_o2_h: number; usable_water_h: number;
  limiting: 'o2' | 'water';
  limit_km: number; max_slope_deg: number; unknown_segments: number;
  ok: boolean; point_of_no_return: number | null;
  legs: Leg[]; ticks: Tick[];
}
export interface Grid { lat0: number; lon0: number; dlat: number; dlon: number; rows: number; cols: number; z: (number | null)[] }
export interface Reach { rows: number; cols: number; ratio: (number | null)[]; budget_h: number; area_km2: number; max_km: number }
export interface RoverStats { km: number; first_sol: number; last_sol: number; slope_p50: number; slope_p90: number; slope_max: number; window_m: number }
export interface RouteCheck {
  dist_m: number[]; near_share: number; near_m: number; route_max_slope: number;
  within_rover_share: number; rover: RoverStats;
}
export interface EvaRecord { id: string; country: string; crew: string; vehicle: string; date: string; hours: number }
export interface EvaStats { count: number; median_h: number; p90_h: number; max_h: number; longest: EvaRecord | null; hours: number[]; apollo_hours: number[] }
export interface RehearsalMatch {
  pts: [number, number, number][]; rms_deg: number; score: number; rotation_deg: number; mirrored: boolean;
  climb_mars_m: number; climb_earth_m: number;
}

export interface Boot {
  worlds: WorldInfo[];
  earthSites: EarthSite[];
  bodies: Body[];
  missions: { landings: Record<World, Landing[]>; presets: Record<World, Preset[]> };
  profiles: Profile[];
  dims: [string, string][];
}

export interface Core extends Boot {
  world: (w: World) => WorldInfo;
  rankAll: (profileId: string) => SiteRanking[];
  rankSites: (bodyId: string, profileId: string) => SiteScore[];
  gaps: (earthId: string, bodyId: string, test: string) => Gap[];
  evaluateRoute: (world: World, pts: Waypoint[], p: EvaParams) => RouteEval;
  distanceKm: (world: World, a: { lat: number; lng: number }, b: { lat: number; lng: number }) => number;
  setGrid: (name: string, g: Grid | string) => void;
  sampleGrid: (name: string, latlons: [number, number][]) => (number | null)[];
  reach: (world: World, grid: string, lat: number, lon: number, p: EvaParams, maxSlopeDeg: number) => Reach;
  setTraverse: (json: string) => RoverStats;
  roverCheck: (pts: Waypoint[], nearM: number) => RouteCheck;
  setEvaCsv: (csv: string) => EvaStats;
  evaLongerShare: (hours: number) => number;
  rehearse: (from: World, pts: Waypoint[], grid: string, stride: number, rotStepDeg: number, top: number) => RehearsalMatch[];
}

let corePromise: Promise<Core> | null = null;

export function loadCore(): Promise<Core> {
  corePromise ??= init().then(() => {
    const boot = JSON.parse(wasm.bootstrap()) as Boot;
    const worlds = Object.fromEntries(boot.worlds.map((w) => [w.id, w])) as Record<World, WorldInfo>;
    return {
      ...boot,
      world: (w) => worlds[w],
      rankAll: (id) => JSON.parse(wasm.rankAll(id)),
      rankSites: (b, p) => JSON.parse(wasm.rankSites(b, p)),
      gaps: (e, b, t) => JSON.parse(wasm.gaps(e, b, t)),
      evaluateRoute: (world, pts, p) => JSON.parse(wasm.evaluateRoute(world, JSON.stringify(pts), JSON.stringify(p))),
      distanceKm: (world, a, b) => wasm.distanceKm(world, a.lat, a.lng, b.lat, b.lng),
      setGrid: (name, g) => wasm.setGrid(name, typeof g === 'string' ? g : JSON.stringify(g)),
      sampleGrid: (name, ll) => JSON.parse(wasm.sampleGrid(name, JSON.stringify(ll))),
      reach: (world, grid, lat, lon, p, max) => JSON.parse(wasm.reach(world, grid, lat, lon, JSON.stringify(p), max)),
      setTraverse: (json) => JSON.parse(wasm.setTraverse(json)),
      roverCheck: (pts, near) => JSON.parse(wasm.roverCheck(JSON.stringify(pts), near)),
      setEvaCsv: (csv) => JSON.parse(wasm.setEvaCsv(csv)),
      evaLongerShare: (h) => wasm.evaLongerShare(h),
      rehearse: (from, pts, grid, stride, rot, top) => JSON.parse(wasm.rehearse(from, JSON.stringify(pts), grid, stride, rot, top)),
    };
  });
  return corePromise;
}
