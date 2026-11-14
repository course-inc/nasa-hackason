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
  landcover_center?: string | null; lithology_ja?: string | null; age_ja?: string | null;
}
export interface Body {
  id: string; world: World; name: string; ja: string; lat: number; lon: number;
  kind: string; task: string[]; tmin: number; tmax: number; slope_mean_deg: number;
  oxides: string; approx: boolean; src: string;
}
export interface Landing { name: string; year: number; agency: string; lat: number; lon: number }
export interface Preset { id: string; name: string; lat: number; lon: number; z: number }
export interface Profile { id: string; label: string; w: Record<string, number> }
export interface DimScore { key: string; label: string; s: number; why: string; formula: string }
export interface PairScore { body_id: string; total: number; raw: number; excluded: string | null; dims: DimScore[] }
export interface SiteRanking { earth_id: string; ranks: PairScore[] }
export interface Waypoint { lat: number; lon: number; elev?: number | null }
export interface EvaParams { speed_kmh: number; o2_h: number; reserve: number }
export interface RouteEval {
  out_km: number; out_h: number; back_km: number; back_h: number; total_h: number;
  usable_h: number; limit_km: number; max_slope_deg: number; unknown_segments: number;
  ok: boolean; point_of_no_return: number | null;
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
  evaluateRoute: (world: World, pts: Waypoint[], p: EvaParams) => RouteEval;
  distanceKm: (world: World, a: { lat: number; lng: number }, b: { lat: number; lng: number }) => number;
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
      evaluateRoute: (world, pts, p) => JSON.parse(wasm.evaluateRoute(world, JSON.stringify(pts), JSON.stringify(p))),
      distanceKm: (world, a, b) => wasm.distanceKm(world, a.lat, a.lng, b.lat, b.lng),
    };
  });
  return corePromise;
}
