// Astronaut view (#suit): walk the route on the real Jezero terrain with the helmet numbers on top.
// Shows only what NASA's EVA display work asks for on the way back (SUITS: path back to the
// airlock; Joint AR: direct return to the lander with a time estimate, distances): which way and
// how far the base is, how much margin is left, and how far to the turn-back point.
// Big area: the 3D terrain (MOLA/HRSC grid + HiRISE photo) seen from just behind the walker.
// Corner: the 2D map (Viking + HiRISE tiles) following the walker.
// It reads the route and settings drawn on the WALKBACK screen (same plan, same Rust numbers).
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Core, Waypoint } from '../core';
import { LANDING, exampleRoute, loadWalkData, type WalkData } from '../walk/data';
import { peekWalkController } from '../walk/controller';
import { DEFAULT_PARAMS, WORLD, denseRoute, evaParams, evaluate, turnIndex, type PlanParams } from '../walk/plan';
import { fmtH } from '../walk/geo';
import { Terrain3D, type Camera3D, type Line3D, type Patch3D, type Point3D } from '../map/Terrain3D';
import { LAYERS } from '../layers';
import { PlanetMap, type Feature } from '../map/PlanetMap';
import { useT } from '../i18n';
import './suit.css';

const R_MARS_M = 3389.5e3;
const K = (Math.PI / 180) * R_MARS_M;
/** Planar distance (m) and bearing (deg, 0 = north) from a to b; fine at a few km. */
function vec(a: Waypoint, b: Waypoint) {
  const dx = (b.lon - a.lon) * K * Math.cos((a.lat * Math.PI) / 180), dy = (b.lat - a.lat) * K;
  return { m: Math.hypot(dx, dy), deg: (Math.atan2(dx, dy) * 180) / Math.PI };
}
const fmtKm = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`);
const HIRISE = ['hirise'];
/** Follow camera: a little behind and above the walker, looking along the way. */
const CAM_DIST_M = 160, CAM_TILT = 18;
const MAP_Z = 15;
/** Playback only: how fast ▶ and the keys move along the route. The calculation's walking speed is unchanged. */
const SPEEDS = [0.5, 1, 2, 5, 10];

// Sharper ground near the walker: HiRISE z15 tiles (≈1.2 m/px; the whole-crater photo is ≈9.6 m/px),
// bundled copy first, NASA Trek as the fallback. EPSG:4326 tiles: 2^(z+1) × 2^z of 256 px.
const HZ = 15, TILE_DEG = 180 / 2 ** HZ, PATCH_TILES = 8, PATCH_MOVE_M = 700;
const hiriseTile = (y: number, x: number) => [`./tiles/mars-hirise/${HZ}/${y}/${x}.png`,
  LAYERS.marsOverlay.hirise.url.replace('{z}', String(HZ)).replace('{y}', String(y)).replace('{x}', String(x))];
const tileCache = new Map<string, Promise<HTMLImageElement | null>>();
function loadTile(y: number, x: number) {
  const key = `${y}/${x}`;
  let p = tileCache.get(key);
  if (!p) {
    const [local, remote] = hiriseTile(y, x);
    p = new Promise((res) => {
      const im = new Image();
      im.crossOrigin = 'anonymous';
      im.onload = () => res(im);
      im.onerror = () => { if (im.src.endsWith(local.slice(1))) im.src = remote; else res(null); };
      im.src = local;
    });
    tileCache.set(key, p);
  }
  return p;
}
/** A PATCH_TILES² mosaic of HiRISE tiles centred on lat/lon, with the same light Mars tint as the 2D map. */
async function buildPatch(lat: number, lon: number): Promise<Patch3D | null> {
  const x0 = Math.floor((lon + 180) / TILE_DEG) - PATCH_TILES / 2, y0 = Math.floor((90 - lat) / TILE_DEG) - PATCH_TILES / 2;
  const tiles = await Promise.all(Array.from({ length: PATCH_TILES * PATCH_TILES }, (_, k) => loadTile(y0 + Math.floor(k / PATCH_TILES), x0 + (k % PATCH_TILES))));
  if (!tiles.some(Boolean)) return null;
  const cv = document.createElement('canvas');
  cv.width = cv.height = PATCH_TILES * 256;
  const ctx = cv.getContext('2d')!;
  ctx.filter = 'sepia(0.85) saturate(2.1) hue-rotate(-28deg) brightness(0.98)';
  tiles.forEach((im, k) => im && ctx.drawImage(im, (k % PATCH_TILES) * 256, Math.floor(k / PATCH_TILES) * 256));
  return { image: cv, west: -180 + x0 * TILE_DEG, east: -180 + (x0 + PATCH_TILES) * TILE_DEG, north: 90 - y0 * TILE_DEG, south: 90 - (y0 + PATCH_TILES) * TILE_DEG };
}
/** Half-size (deg of latitude) of the 2D map's window around the walker. */
const MAP_HALF = 0.004;

export function SuitView({ core }: { core: Core }) {
  const t = useT();
  const [data, setData] = useState<WalkData | null>(null);
  const [route, setRoute] = useState<Waypoint[]>([]);
  const [params, setParams] = useState<PlanParams>(DEFAULT_PARAMS);
  useEffect(() => { loadWalkData(core).then(setData, () => undefined); }, [core]);
  // Follow the route and sliders of the WALKBACK screen.
  useEffect(() => {
    const read = () => {
      const c = peekWalkController();
      if (!c) return;
      const r = c.route(), q = c.params();
      setRoute((old) => (JSON.stringify(old) === JSON.stringify(r) ? old : r));
      setParams((old) => (JSON.stringify(old) === JSON.stringify(q) ? old : q));
    };
    read();
    const id = setInterval(read, 700);
    return () => clearInterval(id);
  }, []);

  const p = useMemo(() => evaParams(params), [params]);
  const dense = useMemo(() => denseRoute(core, data, route), [core, data, route]);
  const ev = useMemo(() => (dense.pts.length >= 2 ? evaluate(core, dense, p) : null), [core, dense, p]);
  const turn = ev ? turnIndex(ev) : null;
  const last = dense.pts.length - 1;
  const outEnd = turn ?? last;

  // Where the astronaut is: a position along the route (slider, keys or ▶ walk).
  const [pos, setPos] = useState(0);
  const [walking, setWalking] = useState(false);
  /** Playback speed multiplier: ×1 walks the whole route in 20 s. */
  const [speed, setSpeed] = useState(1);
  const speedRef = useRef(speed);
  speedRef.current = speed;
  const raf = useRef(0);
  useEffect(() => { setPos(0); setWalking(false); }, [route, params]);
  useEffect(() => {
    if (!walking) return;
    const t0 = performance.now(), from = pos, span = Math.max(1, last - from), ms = (20000 / speed) * (span / Math.max(1, last));
    const frame = (now: number) => {
      const f = Math.min(1, (now - t0) / ms);
      setPos(from + span * f);
      if (f < 1) raf.current = requestAnimationFrame(frame); else setWalking(false);
    };
    raf.current = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf.current);
  }, [walking, speed]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keys (only while this tab is shown): ↑/W walk on, ↓/S walk back, space ▶/■.
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (!location.hash.startsWith('#suit') || last < 1) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      const k = e.key.toLowerCase();
      if (k === 'arrowup' || k === 'w') { e.preventDefault(); setWalking(false); setPos((x) => Math.min(last, x + 0.5 * speedRef.current)); }
      else if (k === 'arrowdown' || k === 's') { e.preventDefault(); setWalking(false); setPos((x) => Math.max(0, x - 0.5 * speedRef.current)); }
      else if (k === ' ') { e.preventDefault(); setWalking((w) => !w); }
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [last]);

  // Position on the route at pos: point and direction of travel (looking a few steps ahead, so the camera does not jitter).
  const at = (x: number) => {
    const i = Math.max(0, Math.min(last, Math.floor(x))), j = Math.min(last, i + 1), u = Math.min(1, Math.max(0, x - i));
    const here: Waypoint = { lat: dense.pts[i].lat + (dense.pts[j].lat - dense.pts[i].lat) * u, lon: dense.pts[i].lon + (dense.pts[j].lon - dense.pts[i].lon) * u };
    const k0 = Math.min(Math.max(0, last - 1), i), k1 = Math.min(last, i + 3);
    return { i, j, u, here, heading: vec(dense.pts[k0], dense.pts[k1]).deg };
  };

  // 3D follow camera (~10 per second) and 2D map follow (twice a second; a fit, not a fly, so it keeps up), from the latest pos.
  const posRef = useRef(pos);
  posRef.current = pos;
  const [camera, setCamera] = useState<Camera3D | null>(null);
  const [fit, setFit] = useState<{ bounds: [[number, number], [number, number]]; seq: number } | null>(null);
  const atRef = useRef(at);
  atRef.current = at;
  useEffect(() => {
    if (last < 1) return;
    let lastCam = -1, lastFly = -1, n = 0;
    const id = setInterval(() => {
      const x = posRef.current;
      const { here, heading } = atRef.current(x);
      if (x !== lastCam) {
        lastCam = x;
        setCamera({ target: here, heading, tilt: CAM_TILT, distance: CAM_DIST_M, seq: performance.now() });
      }
      if (++n % 5 === 0 && x !== lastFly) {
        lastFly = x;
        const dl = MAP_HALF / Math.cos((here.lat * Math.PI) / 180);
        setFit({ bounds: [[here.lat - MAP_HALF, here.lon - dl], [here.lat + MAP_HALF, here.lon + dl]], seq: performance.now() });
      }
    }, 100);
    return () => clearInterval(id);
  }, [last, dense]);

  // Sharper ground: rebuild the HiRISE patch when the walker is PATCH_MOVE_M from its centre.
  const [patch, setPatch] = useState<Patch3D | null>(null);
  const patchAt = useRef<Waypoint | null>(null);
  useEffect(() => {
    if (last < 1) return;
    let live = true;
    const id = setInterval(() => {
      const { here } = atRef.current(posRef.current);
      if (patchAt.current && vec(patchAt.current, here).m < PATCH_MOVE_M) return;
      patchAt.current = here;
      buildPatch(here.lat, here.lon).then((p) => { if (live && p) setPatch(p); }, () => undefined);
    }, 300);
    return () => { live = false; clearInterval(id); patchAt.current = null; };
  }, [last, dense]);

  // Route layers: the way out, the part past the turn-back point, base and turn-back markers.
  const lines3d = useMemo<Line3D[]>(() => {
    if (last < 1) return [];
    const ll = (a: number, b: number) => dense.pts.slice(a, b + 1).map((q) => [q.lat, q.lon] as [number, number]);
    const l: Line3D[] = [{ pts: ll(0, outEnd), color: '#7cb8d6', width: 5 }];
    if (turn != null) l.push({ pts: ll(turn, last), color: '#8c8c8c', width: 3, opacity: 0.8 });
    return l;
  }, [dense, outEnd, turn, last]);
  const features = useMemo<Feature[]>(() => {
    if (last < 1) return [];
    const f: Feature[] = lines3d.map((l) => ({ kind: 'line', pts: l.pts, color: l.color, weight: l.width - 1, opacity: l.opacity, dash: l.opacity ? '6 6' : undefined }));
    f.push({ kind: 'point', lat: dense.pts[0].lat, lon: dense.pts[0].lon, radius: 7, color: '#ffffff', tooltip: t('基地', 'Base') });
    if (turn != null) f.push({ kind: 'point', lat: dense.pts[turn].lat, lon: dense.pts[turn].lon, radius: 7, color: '#ff4d4f', tooltip: t('引き返し地点', 'Turn-back point') });
    return f;
  }, [lines3d, dense, turn, last]); // eslint-disable-line react-hooks/exhaustive-deps
  // The walker moves in steps of a tenth of a route step in 3D, so the overlay is not rebuilt every frame.
  const step = Math.round(pos * 10) / 10;
  const points3d = useMemo<Point3D[]>(() => {
    if (last < 1) return [];
    const ps: Point3D[] = [{ lat: dense.pts[0].lat, lon: dense.pts[0].lon, color: '#ffffff', size: 0.3 }];
    if (turn != null) ps.push({ lat: dense.pts[turn].lat, lon: dense.pts[turn].lon, color: '#ff4d4f', size: 0.3 });
    const h = atRef.current(step).here;
    ps.push({ lat: h.lat, lon: h.lon, color: '#ff7a45', size: 0.18 });
    return ps;
  }, [dense, turn, last, step]);
  const view = useMemo<[number, number, number]>(() => [route[0]?.lat ?? LANDING.lat, route[0]?.lon ?? LANDING.lon, MAP_Z], [route]);

  if (!data) return <div className="suit"><p className="suit-empty">{t('NASA データを読み込み中…', 'Loading NASA data…')}</p></div>;
  if (!ev || route.length < 2) {
    return (
      <div className="suit">
        <div className="suit-empty">
          <p>{t('まだルートがありません。', 'No route yet.')}</p>
          <p className="muted">{t('「火星で歩いて帰る」でルートを引くと、ここでそのルートを 3D の地形の上で歩けます。', 'Draw a route on “Walk back on Mars” and you can walk it here on the 3D terrain.')}</p>
          <div className="suit-actions">
            <a className="btn" href="#walk">{t('ルートを引く', 'Draw a route')}</a>
            <button onClick={() => peekWalkController()?.setRoute(exampleRoute(data.traverseRaw))}>{t('サンプルのルートで見る', 'Use the sample route')}</button>
          </div>
        </div>
      </div>
    );
  }

  const { i, j, u, here, heading } = at(pos);
  const lerp = (x: number, y: number) => x + (y - x) * u;
  const a = ev.ticks[i], b = ev.ticks[j] ?? a;
  const km = lerp(a.km, b.km), margin = lerp(a.margin_h, b.margin_h), home = lerp(a.home_h, b.home_h);
  const o2 = lerp(a.o2_left, b.o2_left), water = lerp(a.water_left, b.water_left);
  const base = dense.pts[0];
  const toBase = vec(here, base);
  // The arrow shows the base relative to the direction of travel (= the 3D camera's view).
  const rel = ((toBase.deg - heading) % 360 + 540) % 360 - 180;
  const turnKm = turn != null ? ev.ticks[turn]?.km ?? null : null;
  const toTurnKm = turnKm != null ? turnKm - km : null;
  const past = turn != null && pos >= turn;
  const state: 'ok' | 'soon' | 'now' = past || margin <= 0 ? 'now' : margin < 0.75 ? 'soon' : 'ok';
  const msg = state === 'now' ? t('今すぐ基地へ戻る', 'Head back to base now')
    : state === 'soon' ? t('まもなく引き返し', 'Turn back soon')
    : t('帰れる', 'You can get home');
  const live: Feature[] = [{ kind: 'walker', lat: here.lat, lon: here.lon, color: '#ff7a45' }];

  return (
    <div className={`suit suit-${state}`}>
      <div className="suit-stage">
        {data.demGrid
          ? <Terrain3D grid={data.demGrid} radiusKm={core.world(WORLD).radius_km} palette="mars" lines={lines3d} points={points3d}
              camera={camera} patch={patch} photo="./data/jezero_ortho.jpg" label={t('Jezero クレーター（3D・歩く人の目線）', 'Jezero crater (3D, walker’s view)')} />
          : <p className="suit-empty">{t('3D の地形データを読み込めませんでした。', 'Could not load the 3D terrain data.')}</p>}

        <div className="suit-hud" role="status" aria-live="polite">
          <div className="suit-msg">{msg}</div>
          <div className="suit-hud-row">
            <div className="suit-compass" aria-label={t(`基地は ${Math.round(rel)}° の方向`, `Base at ${Math.round(rel)}°`)}>
              <svg viewBox="-60 -60 120 120" width="92" height="92" aria-hidden="true">
                <circle r="54" className="ring" />
                <g transform={`rotate(${rel})`}><path d="M0,-48 L16,-6 L5,-10 L5,30 L-5,30 L-5,-10 L-16,-6 Z" className="arrow" /></g>
              </svg>
              <div className="suit-big">{fmtKm(toBase.m)}</div>
              <div className="suit-sub">{t('基地まで（直線）', 'to base (straight)')}</div>
            </div>
            <div className="suit-figs">
              <div><span>{t('帰りに要る時間', 'Time to get home')}</span><b>{fmtH(home)}</b></div>
              <div className={state !== 'ok' ? 'warn' : ''}>
                <span>{t('引き返しまでの余裕', 'Margin before turn-back')}</span>
                <b>{past ? t('超過', 'passed') : fmtH(Math.max(0, margin))}</b>
              </div>
              <div className={state !== 'ok' ? 'warn' : ''}>
                <span>{t('帰れない境界まで', 'To the point of no return')}</span>
                <b className="small">{toTurnKm == null ? t('最後まで帰れる', 'Whole route walkable') : past ? t('越えた', 'crossed') : fmtKm(toTurnKm * 1000)}</b>
              </div>
            </div>
          </div>
          <div className="suit-bars">
            <Bar label="O₂" v={o2} warn={ev.limiting === 'o2' && o2 < 0.35} />
            <Bar label={t('冷却水', 'Water')} v={water} warn={ev.limiting === 'water' && water < 0.35} />
          </div>
          <div className="suit-foot">{t(`歩いた距離 ${km.toFixed(2)} km`, `Walked ${km.toFixed(2)} km`)}</div>
        </div>

        <div className="suit-map2d" aria-label={t('2D 地図', '2D map')}>
          <PlanetMap core={core} world={WORLD} view={view} fit={fit} baseKey="viking" overlayKeys={HIRISE} collapsedLayers features={features} live={live} />
          <div className="suit-legend"><i className="lg-base" />{t('基地', 'Base')} <i className="lg-turn" />{t('引き返し', 'Turn-back')} <i className="lg-me" />{t('いま', 'You')}</div>
        </div>
      </div>

      <div className="suit-controls">
        <button onClick={() => (walking ? setWalking(false) : (pos >= last && setPos(0), setWalking(true)))}>
          {walking ? t('■ 止める', '■ Stop') : t('▶ 歩いてみる', '▶ Walk')}
        </button>
        <span className="suit-speed" role="group" aria-label={t('再生の速さ', 'Playback speed')}>
          {t('再生の速さ', 'Playback speed')}
          {SPEEDS.map((x) => (
            <button key={x} className={x === speed ? 'on' : ''} aria-pressed={x === speed} onClick={() => setSpeed(x)}>×{x}</button>
          ))}
        </span>
        <label>
          {t('いまの位置', 'Position')}
          <input type="range" min={0} max={last} step={0.1} value={pos} onChange={(e) => { setWalking(false); setPos(+e.target.value); }} />
        </label>
        <span className="muted keys">{t('↑/W 進む・↓/S 戻る・スペース 歩く/止める', '↑/W forward, ↓/S back, space walk/stop')}</span>
        <a href="#walk">{t('ルートを変える', 'Change route')}</a>
        <a href="#sources">{t('出典', 'Sources')}</a>
      </div>
    </div>
  );
}

const Bar = ({ label, v, warn }: { label: string; v: number; warn: boolean }) => (
  <div className={`suit-bar${warn ? ' warn' : ''}`}>
    <span>{label}</span>
    <div className="suit-track"><div style={{ width: `${Math.max(0, Math.min(1, v)) * 100}%` }} /></div>
    <b>{Math.round(Math.max(0, v) * 100)}%</b>
  </div>
);
