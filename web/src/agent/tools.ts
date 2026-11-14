// Agent tools for WALKBACK. Compute tools return numbers from the Rust core and the bundled NASA
// data (the same functions the screen uses, walk/plan.ts); view tools only move the screen.
import type { Core, Waypoint } from '../core';
import { LANDING, exampleRoute, loadHokkaidoGrid, type WalkData } from '../walk/data';
import { fmtH } from '../walk/geo';
import { computePlan, rehearsalPoints, turnIndex, turnWaypoint, WATER_PER_O2, type PlanParams } from '../walk/plan';
import { nextFrame, walkController, type EvidenceTopic } from '../walk/controller';
import { registerTool } from './port';
import type { ToolDef, ToolResult } from './types';

type Lang = 'ja' | 'en';
type Src = NonNullable<ToolResult['sources']>;

export const SRC = {
  rover: { label: 'Mars 2020 Perseverance traverse (NASA/JPL MMGIS)', url: 'https://mars.nasa.gov/mmgis-maps/M20/Layers/json/M20_traverse.json' },
  hirise: { label: 'MRO HiRISE DTMs (NASA/UArizona, USGS Astrogeology)', url: 'https://stac.astrogeology.usgs.gov/browser-dev/#/collections/mro_hirise_socet_dtms' },
  mola: { label: 'MGS MOLA MEGDR via Mars Trek (NASA)', url: 'https://trek.nasa.gov/mars/' },
  eva: { label: 'data.nasa.gov: Extra-vehicular Activity (EVA) - US and Russia', url: 'https://data.nasa.gov/docs/legacy/Extra-vehicular_Activity_EVA_-_US_and_Russia/Extra-vehicular_Activity_EVA_-_US_and_Russia_rows.csv' },
  gernhardt: { label: 'Gernhardt et al. 2010, NASA walkback / EVA metabolic tests (NTRS)', url: 'https://ntrs.nasa.gov/search?q=Gernhardt%20walkback%20EVA' },
  nasadem: { label: 'NASADEM (NASA/JPL, 1 arc-second)', url: 'https://lpdaac.usgs.gov/products/nasadem_hgtv001/' },
  engine: { label: 'analog-core (Rust) route / reach / rehearse engine' },
} satisfies Record<string, Src[number]>;

const LANG = { type: 'string', enum: ['ja', 'en'], description: 'Language of the returned text (default ja).' };
const lang = (a: { lang?: string } | undefined): Lang => (a?.lang === 'en' ? 'en' : 'ja');
const t = (l: Lang, ja: string, en: string) => (l === 'ja' ? ja : en);
const r1 = (x: number) => x.toFixed(1);

// ---------- route arguments ----------
export type RouteArg = { lat: number; lon: number }[] | 'example' | 'current' | { along_rover_km: number } | { away_km: number };

/** Perseverance's path from the landing site, cut at `km` of driving, as waypoints every ~0.5 km. */
export function alongRover(core: Core, raw: [number, number, number][][], km: number): Waypoint[] {
  const pts: Waypoint[] = [LANDING];
  let done = 0, next = Math.min(0.5, km), prev: { lat: number; lng: number } | null = null;
  for (const line of raw) {
    for (const p of line) {
      const cur = { lat: p[1], lng: p[0] };
      if (prev) done += core.distanceKm('mars', prev, cur);
      prev = cur;
      if (done >= next - 1e-9) {
        pts.push({ lat: p[1], lon: p[0] });
        if (next >= km - 1e-9) return pts;
        next = Math.min(km, next + 0.5);
      }
    }
  }
  return pts;
}

export function resolveRoute(core: Core, data: WalkData, arg: unknown, current: Waypoint[]): Waypoint[] {
  if (arg == null || arg === 'current') return current;
  if (arg === 'example') return exampleRoute(data.traverseRaw);
  if (Array.isArray(arg)) {
    const r = arg.map((p) => ({ lat: Number(p?.lat), lon: Number(p?.lon) }));
    if (r.length < 2 || r.some((p) => !Number.isFinite(p.lat) || !Number.isFinite(p.lon))) throw new Error('route needs at least 2 points {lat, lon}');
    return r;
  }
  if (typeof arg === 'object' && 'away_km' in (arg as object)) {
    const km = Number((arg as { away_km: unknown }).away_km);
    if (!(km > 0 && km <= 15)) throw new Error('away_km must be between 0 and 15');
    return exampleRoute(data.traverseRaw, Math.min(0.6, km), km);
  }
  if (typeof arg === 'object' && 'along_rover_km' in (arg as object)) {
    const km = Number((arg as { along_rover_km: unknown }).along_rover_km);
    if (!(km > 0 && km <= 30)) throw new Error('along_rover_km must be between 0 and 30');
    return alongRover(core, data.traverseRaw, km);
  }
  throw new Error('route must be an array of {lat, lon}, "example", "current", {away_km} or {along_rover_km}');
}

const paramsFrom = (a: Record<string, unknown>, cur: PlanParams): PlanParams => {
  const n = (k: string, lo: number, hi: number, d: number) => {
    const v = a[k];
    if (v == null) return d;
    const x = Number(v);
    if (!Number.isFinite(x) || x < lo || x > hi) throw new Error(`${k} must be between ${lo} and ${hi}`);
    return x;
  };
  return { speed: n('speed_kmh', 0.5, 5, cur.speed), o2: n('o2_h', 2, 12, cur.o2), water: n('water_h', 2, 12, cur.water), reserve: n('reserve', 0, 50, cur.reserve) };
};

// ---------- walkback_check ----------
const walkbackCheck: ToolDef = {
  name: 'walkback_check',
  kind: 'compute',
  description: 'Plan a walk on Mars (Jezero crater) from a base and check whether the astronaut can walk home before oxygen or suit cooling water runs out. Shows the route on the map and returns: can return or not, out/back km, time, effort used vs usable, which consumable runs out first, the turn-back point, the walk-home area (km²); with_rehearsal also finds the 3 best practice courses in Hokkaido with the same slopes. Unset parameters keep the screen\'s current values.',
  parameters: {
    type: 'object',
    properties: {
      route: {
        description: 'Route: array of {lat, lon} (first point is the base), "example" (the default 3 km route along Perseverance\'s path), "current" (what is on screen), {away_km: N} (follow Perseverance\'s path until N km in a straight line from the landing site), or {along_rover_km: N} (Perseverance\'s path from the landing site for N km of driving).',
        oneOf: [
          { type: 'array', items: { type: 'object', properties: { lat: { type: 'number' }, lon: { type: 'number' } }, required: ['lat', 'lon'] }, minItems: 2 },
          { type: 'string', enum: ['example', 'current'] },
          { type: 'object', properties: { away_km: { type: 'number', minimum: 0.5, maximum: 15 } }, required: ['away_km'] },
          { type: 'object', properties: { along_rover_km: { type: 'number', minimum: 0.5, maximum: 30 } }, required: ['along_rover_km'] },
        ],
      },
      speed_kmh: { type: 'number', minimum: 0.5, maximum: 5, description: 'Walking speed on flat ground' },
      o2_h: { type: 'number', minimum: 2, maximum: 12, description: 'Oxygen supply in hours' },
      water_h: { type: 'number', minimum: 2, maximum: 12, description: 'Cooling water supply in hours' },
      reserve: { type: 'number', minimum: 0, maximum: 50, description: 'Reserve kept at arrival, percent (at least 30 min)' },
      with_rehearsal: { type: 'boolean', description: 'Also search Hokkaido for practice courses with the same slopes' },
      lang: LANG,
    },
    additionalProperties: false,
  },
  async run(a: Record<string, unknown> = {}) {
    const l = lang(a);
    const c = await walkController();
    const data = await c.data();
    const route = resolveRoute(c.core, data, a.route, c.route());
    const params = paramsFrom(a, c.params());
    c.setRoute(route);
    c.setParams(params);
    const plan = computePlan(c.core, data, route, params);
    const { ev, dense, reach } = plan;
    const ti = turnIndex(ev);
    const lines: string[] = [];
    if (ev.ok) lines.push(t(l, '判定: 帰れる。', 'Verdict: can walk back.'));
    else lines.push(t(l,
      `判定: 帰れない。途中で引き返す（WP${turnWaypoint(ev, dense)} の手前、出発から ${r1(ev.ticks[ti!]?.km ?? 0)} km 地点）。`,
      `Verdict: cannot complete it. Turn back before WP${turnWaypoint(ev, dense)} (${r1(ev.ticks[ti!]?.km ?? 0)} km from the base).`));
    lines.push(t(l,
      `行き ${r1(ev.out_km)} km / 帰り（まっすぐ）${r1(ev.back_km)} km、かかる時間 ${fmtH(ev.total_h)}、体力の消費 ${r1(ev.total_effort_h)} / 使える分 ${r1(ev.usable_h)} h、先に尽きるもの: ${ev.limiting === 'water' ? '冷却水' : '酸素'}。`,
      `Out ${r1(ev.out_km)} km / back (straight) ${r1(ev.back_km)} km, time ${fmtH(ev.total_h)}, effort ${r1(ev.total_effort_h)} of ${r1(ev.usable_h)} usable h, runs out first: ${ev.limiting === 'water' ? 'cooling water' : 'oxygen'}.`));
    if (reach) lines.push(t(l, `基地から歩いて帰れる範囲: ${reach.area_km2.toFixed(0)} km²（最遠 ${r1(reach.max_km)} km）。`,
      `Walk-home area from the base: ${reach.area_km2.toFixed(0)} km² (farthest ${r1(reach.max_km)} km).`));
    if (ev.unknown_segments > 0) lines.push(t(l, `地形が分からない区間 ${ev.unknown_segments} か所は急な登り（約17°）として計算。`, `${ev.unknown_segments} segments without terrain data are counted as a steep climb (~17°).`));
    lines.push(t(l, `条件: 速さ ${params.speed} km/h、酸素 ${params.o2} 時間、冷却水 ${params.water} 時間、余裕 ${params.reserve}%。`,
      `Settings: speed ${params.speed} km/h, O₂ ${params.o2} h, water ${params.water} h, reserve ${params.reserve}%.`));

    let rehearsal: { site: string; score: number; slope_diff_deg: number; climb_mars_m: number; climb_earth_m: number }[] | undefined;
    if (a.with_rehearsal) {
      const found = await c.runRehearsal(rehearsalPoints(c.core, data, route));
      rehearsal = found.slice(0, 3).map((f) => ({ site: f.site.name, score: Math.round(f.m.score), slope_diff_deg: +f.m.rms_deg.toFixed(1), climb_mars_m: Math.round(f.m.climb_mars_m), climb_earth_m: Math.round(f.m.climb_earth_m) }));
      lines.push(rehearsal.length
        ? t(l, '北海道の練習コース: ', 'Practice courses in Hokkaido: ') + rehearsal.map((x, i) => t(l,
          `${i + 1}) ${x.site} スコア ${x.score}、坂の違い ${x.slope_diff_deg}°、登り合計 火星 ${x.climb_mars_m} m / 北海道 ${x.climb_earth_m} m`,
          `${i + 1}) ${x.site} score ${x.score}, slope difference ${x.slope_diff_deg}°, total climb Mars ${x.climb_mars_m} m / Hokkaido ${x.climb_earth_m} m`)).join('; ') + '。'
        : t(l, '北海道の候補地の範囲（約21km四方）に収まる練習コースが見つかりませんでした。', 'No Hokkaido practice course fits (each area is about 21 km across).'));
    }
    return {
      text: lines.join(' '),
      data: {
        ok: ev.ok, out_km: ev.out_km, back_km: ev.back_km, total_h: ev.total_h, effort_h: ev.total_effort_h, usable_h: ev.usable_h,
        limiting: ev.limiting, turn_back_km: ti != null ? ev.ticks[ti]?.km ?? null : null, turn_back_point: ti != null ? dense.pts[ti] : null,
        reach_km2: reach?.area_km2 ?? null, reach_max_km: reach?.max_km ?? null, params, waypoints: route.length, rehearsal,
      },
      sources: [SRC.engine, SRC.rover, SRC.hirise, SRC.mola, SRC.gernhardt, ...(a.with_rehearsal ? [SRC.nasadem] : [])],
    };
  },
};

// ---------- open_evidence ----------
const TOPICS: EvidenceTopic[] = ['rover', 'eva', 'terrain', 'consumables', 'hokkaido_terrain'];
const openEvidence: ToolDef = {
  name: 'open_evidence',
  kind: 'compute',
  description: 'Show the evidence behind the plan and open its card on screen. topic: rover (Perseverance\'s real drives: km, slope distribution, how much of this route follows them), eva (real EVA durations: count, median, share longer than this plan), terrain (the Mars elevation data used), consumables (O₂/cooling-water model, Gernhardt 2010 coefficients 3.1/2.7, reserve rule), hokkaido_terrain (the Hokkaido elevation grids). Returns numbers from the loaded data and source links.',
  parameters: { type: 'object', properties: { topic: { type: 'string', enum: TOPICS }, lang: LANG }, required: ['topic'], additionalProperties: false },
  async run(a: { topic?: string; lang?: string } = {}) {
    const l = lang(a);
    const topic = a.topic as EvidenceTopic;
    if (!TOPICS.includes(topic)) throw new Error(`topic must be one of ${TOPICS.join(', ')}`);
    const c = await walkController();
    const data = await c.data();
    const plan = computePlan(c.core, data, c.route(), c.params());
    c.openEvidence(topic);
    const R = c.core.world('mars').radius_km * 1000;
    switch (topic) {
      case 'rover': {
        const r = data.rover;
        if (!r) throw new Error('rover traverse not loaded');
        const k = plan.check;
        return {
          text: t(l,
            `Perseverance の走行記録: 着陸から ${r.last_sol} 火星日、${r1(r.km)} km。走った坂（${r.window_m}m ごと）: 中央値 ${r1(r.slope_p50)}°、9割 ${r1(r.slope_p90)}°、最大 ${r1(r.slope_max)}°。` +
              (k ? ` 今のルートは ${Math.round(k.near_share * 100)}% が実走路から ${k.near_m}m 以内、最大の坂 ${r1(k.route_max_slope)}°、坂が探査車の9割以内の区間 ${Math.round(k.within_rover_share * 100)}%。` : ''),
            `Perseverance traverse: ${r1(r.km)} km over ${r.last_sol} sols. Slopes driven (per ${r.window_m} m): median ${r1(r.slope_p50)}°, 90% ${r1(r.slope_p90)}°, max ${r1(r.slope_max)}°.` +
              (k ? ` This route: ${Math.round(k.near_share * 100)}% within ${k.near_m} m of the real drives, max slope ${r1(k.route_max_slope)}°, ${Math.round(k.within_rover_share * 100)}% of it within the rover's 90% slope.` : '')),
          data: { rover: r, route_check: k && { near_share: k.near_share, near_m: k.near_m, route_max_slope: k.route_max_slope, within_rover_share: k.within_rover_share } },
          sources: [SRC.rover, SRC.engine],
        };
      }
      case 'eva': {
        const e = data.eva;
        if (!e) throw new Error('EVA records not loaded');
        const apolloMax = e.apollo_hours.at(-1) ?? 0;
        return {
          text: t(l,
            `実際の船外活動 ${e.count} 回: 中央値 ${r1(e.median_h)} h、9割 ${r1(e.p90_h)} h、最長 ${r1(e.max_h)} h。Apollo の月面活動 ${e.apollo_hours.length} 回、最長 ${r1(apolloMax)} h。今の計画（${r1(plan.ev.total_h)} 時間）より長かったのは ${Math.round(plan.longer * 100)}%。`,
            `${e.count} real EVAs: median ${r1(e.median_h)} h, 90% ${r1(e.p90_h)} h, longest ${r1(e.max_h)} h. Apollo lunar EVAs: ${e.apollo_hours.length}, longest ${r1(apolloMax)} h. ${Math.round(plan.longer * 100)}% were longer than this plan (${r1(plan.ev.total_h)} h).`),
          data: { count: e.count, median_h: e.median_h, p90_h: e.p90_h, max_h: e.max_h, longest: e.longest, apollo_count: e.apollo_hours.length, apollo_max_h: apolloMax, plan_h: plan.ev.total_h, longer_share: plan.longer },
          sources: [SRC.eva],
        };
      }
      case 'terrain': {
        const d = data.dem;
        if (!d) throw new Error('Jezero elevation grid not loaded');
        const cellM = (d.dlat * Math.PI / 180) * R;
        return {
          text: t(l,
            `火星の地形: Jezero クレーターの標高グリッド ${d.cols}×${d.rows}（1マス約 ${Math.round(cellM)} m）。出典: ${d.src ?? 'n/a'}`,
            `Mars terrain: Jezero elevation grid ${d.cols}×${d.rows} (cells ~${Math.round(cellM)} m). Source: ${d.src ?? 'n/a'}`),
          data: { rows: d.rows, cols: d.cols, cell_m: cellM, src: d.src },
          sources: [SRC.hirise, SRC.mola],
        };
      }
      case 'consumables': {
        const ev = plan.ev;
        return {
          text: t(l,
            `消耗品のモデル: 急いで歩くと冷却水は酸素の ${r1(3.1)}/${r1(2.7)} = ${WATER_PER_O2.toFixed(2)} 倍の速さで減る（Gernhardt 2010 の歩行帰還試験）。帰着時に ${plan.params.reserve}%・最低30分を残す。今の条件で使える酸素 ${r1(ev.usable_o2_h)} h、冷却水 ${r1(ev.usable_water_h)} h、先に尽きるもの: ${ev.limiting === 'water' ? '冷却水' : '酸素'}。`,
            `Consumables model: walking hard uses cooling water ${r1(3.1)}/${r1(2.7)} = ${WATER_PER_O2.toFixed(2)}× as fast as O₂ (Gernhardt 2010 walkback tests). Keep ${plan.params.reserve}% and at least 30 min at arrival. Usable now: O₂ ${r1(ev.usable_o2_h)} h, water ${r1(ev.usable_water_h)} h; runs out first: ${ev.limiting === 'water' ? 'cooling water' : 'oxygen'}.`),
          data: { water_coef: 3.1, o2_coef: 2.7, ratio: WATER_PER_O2, reserve_pct: plan.params.reserve, min_reserve_h: 0.5, usable_o2_h: ev.usable_o2_h, usable_water_h: ev.usable_water_h, limiting: ev.limiting },
          sources: [SRC.gernhardt, SRC.engine],
        };
      }
      case 'hokkaido_terrain': {
        const sites = data.hokkaido;
        if (!sites.length) throw new Error('Hokkaido grids not loaded');
        const g = await loadHokkaidoGrid(c.core, sites[0].id);
        const cellM = Math.round((g.dlat * Math.PI / 180) * 6371000);
        return {
          text: t(l,
            `北海道の地形: 候補地 ${sites.length} か所の標高グリッド（各 約${g.cols}×${g.rows}、1マス約 ${cellM} m）。出典: ${g.src ?? 'NASADEM'}。候補地: ${sites.map((s) => s.name).join('、')}。`,
            `Hokkaido terrain: elevation grids around ${sites.length} candidate sites (~${g.cols}×${g.rows} each, cells ~${cellM} m). Source: ${g.src ?? 'NASADEM'}. Sites: ${sites.map((s) => s.name).join(', ')}.`),
          data: { sites: sites.map((s) => ({ id: s.id, name: s.name, lat: s.lat, lon: s.lon })), cell_m: cellM, src: g.src },
          sources: [SRC.nasadem],
        };
      }
    }
  },
};

// ---------- view tools ----------
const VIEW_NOTE = 'Only changes what is shown; returns no numbers.';
const view3d: ToolDef = {
  name: 'view_3d',
  kind: 'view',
  description: `Switch the Jezero map between 2D and 3D and move the 3D camera (heading: direction the camera looks, degrees clockwise from north; tilt: degrees below the horizon, 90 = straight down; exaggeration: height scale). ${VIEW_NOTE}`,
  parameters: {
    type: 'object',
    properties: {
      on: { type: 'boolean' }, lat: { type: 'number' }, lon: { type: 'number' },
      distance_m: { type: 'number', minimum: 100, maximum: 60000 }, heading_deg: { type: 'number' },
      tilt_deg: { type: 'number', minimum: 5, maximum: 89 }, exaggeration: { type: 'number', minimum: 1, maximum: 6 },
    },
    additionalProperties: false,
  },
  async run(a: { on?: boolean; lat?: number; lon?: number; distance_m?: number; heading_deg?: number; tilt_deg?: number; exaggeration?: number } = {}) {
    const c = await walkController();
    await c.data();
    const on = a.on ?? true;
    c.set3d(on);
    if (on) {
      await nextFrame();
      c.setCamera({ lat: a.lat, lon: a.lon, distance_m: a.distance_m, heading_deg: a.heading_deg, tilt_deg: a.tilt_deg, exaggeration: a.exaggeration });
    }
    return { text: on ? 'Showing the 3D view.' : 'Showing the 2D map.' };
  },
};

const viewOverlay: ToolDef = {
  name: 'view_overlay',
  kind: 'view',
  description: `Show or hide map layers: rover (Perseverance's real path), reach (walk-home area); rehearsal_index (0-2) picks which Hokkaido practice course is shown after walkback_check with_rehearsal. ${VIEW_NOTE}`,
  parameters: {
    type: 'object',
    properties: { rover: { type: 'boolean' }, reach: { type: 'boolean' }, rehearsal_index: { type: 'integer', minimum: 0, maximum: 2 } },
    additionalProperties: false,
  },
  async run(a: { rover?: boolean; reach?: boolean; rehearsal_index?: number } = {}) {
    const c = await walkController();
    c.setOverlay({ rover: a.rover, reach: a.reach });
    if (a.rehearsal_index != null) c.selectRehearsal(a.rehearsal_index);
    return { text: 'Map layers updated.' };
  },
};

const viewSetParams: ToolDef = {
  name: 'view_set_params',
  kind: 'view',
  description: `Move the sliders on screen (walking speed km/h, O₂ hours, cooling water hours, reserve %). ${VIEW_NOTE} Call walkback_check to get the numbers.`,
  parameters: {
    type: 'object',
    properties: {
      speed_kmh: { type: 'number', minimum: 0.5, maximum: 5 }, o2_h: { type: 'number', minimum: 2, maximum: 12 },
      water_h: { type: 'number', minimum: 2, maximum: 12 }, reserve: { type: 'number', minimum: 0, maximum: 50 },
    },
    additionalProperties: false,
  },
  async run(a: Record<string, unknown> = {}) {
    const c = await walkController();
    const p = paramsFrom(a, c.params());
    c.setParams(p);
    return { text: 'Sliders updated.' };
  },
};

const viewWalk: ToolDef = {
  name: 'view_walk',
  kind: 'view',
  description: `Play the route through the helmet display (out to the turn-back point and home), or stop it. ${VIEW_NOTE}`,
  parameters: { type: 'object', properties: { action: { type: 'string', enum: ['play', 'stop'] } }, required: ['action'], additionalProperties: false },
  async run(a: { action?: string } = {}) {
    const c = await walkController();
    await c.data();
    await nextFrame();
    if (a.action === 'stop') { c.stop(); return { text: 'Stopped the walk.' }; }
    c.play();
    return { text: 'Playing the walk in the helmet display.' };
  },
};

export const WALK_TOOLS: ToolDef[] = [walkbackCheck, openEvidence, view3d, viewOverlay, viewSetParams, viewWalk];

/**
 * Register the WALKBACK tools and #10's Hokkaido tools.
 */
export function registerAgentTools(core: Core): () => void {
  const off = WALK_TOOLS.map(registerTool);
  let live = true;
  // #10's explore.ts (explore_hokkaido, view_scan, …): every exported make…Tool(core). Loaded lazily
  // so duckdb-wasm stays out of the first load.
  import('./explore').then((m) => {
    if (!live) return;
    for (const [name, f] of Object.entries(m as Record<string, unknown>)) {
      if (/^make\w*Tool$/.test(name) && typeof f === 'function') {
        try { off.push(registerTool((f as (c: Core) => ToolDef)(core))); } catch { /* skip a tool that cannot be built */ }
      }
    }
  }).catch(() => undefined);
  return () => { live = false; off.forEach((f) => f()); };
}
