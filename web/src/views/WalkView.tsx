// #11 Martian Map "WALKBACK" (Jezero): plan a walk from a base on Mars, see where you can still
// walk home from (O₂ and cooling water), check the plan against Perseverance's real drives and
// real EVA durations, play it back through a helmet display, and find the same walk in Hokkaido.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Core, EvaParams, Waypoint, World } from '../core';
import { getElevation } from '../elevation';
import { PlanetMap, missionOverlay, type Feature, type FlyTarget } from '../map/PlanetMap';
import { JEZERO, LANDING, exampleRoute, loadWalkData, type WalkData } from '../walk/data';
import { densify, fmtH, reachImage, slopeColor } from '../walk/geo';
import { Hud, type HudState } from '../walk/Hud';
import { EvaCard, RoverCard } from '../walk/Evidence';
import { RehearsalPanel, useRehearsal } from '../walk/Rehearsal';
import { Terrain3D, type Line3D, type Point3D } from '../map/Terrain3D';
import type { Reach } from '../core';

type Mode = 'pan' | 'route' | 'base';
export interface WalkParams { world?: World; lat?: number; lon?: number; z?: number }

const WORLD: World = 'mars';
const WATER_PER_O2 = 3.1 / 2.7; // same constant as analog-core route.rs (Gernhardt 2010)
const MAX_SLOPE = 25;
const HIRISE = ['hirise']; // steeper steps are not walkable in the walk-home area

export function WalkView({ core, params }: { core: Core; params: WalkParams }) {
  const [data, setData] = useState<WalkData | null>(null);
  const [route, setRoute] = useState<Waypoint[]>([]);
  const [mode, setMode] = useState<Mode>('route');
  const [speed, setSpeed] = useState(2);
  const [o2, setO2] = useState(8);
  const [water, setWater] = useState(8);
  const [reserve, setReserve] = useState(20);
  const [showReach, setShowReach] = useState(true);
  const [showRover, setShowRover] = useState(true);
  const [view3d, setView3d] = useState(false);
  const [fly, setFly] = useState<FlyTarget | null>(null);
  const [view] = useState<[number, number, number]>(() =>
    params.lat != null ? [params.lat, params.lon!, params.z ?? 13] : [LANDING.lat, LANDING.lon - 0.015, 13]);

  useEffect(() => {
    loadWalkData(core).then((d) => {
      setData(d);
      setRoute((r) => (r.length ? r : d.traverseRaw.length ? exampleRoute(d.traverseRaw) : [LANDING]));
    });
  }, [core]);
  useEffect(() => {
    if (params.lat != null && params.lon != null) setFly({ lat: params.lat, lon: params.lon, z: params.z ?? 13, seq: Date.now() });
  }, [params.lat, params.lon, params.z]);

  const p: EvaParams = useMemo(() => ({ speed_kmh: speed, o2_h: o2, water_h: water, reserve: reserve / 100, min_reserve_h: 0.5 }),
    [speed, o2, water, reserve]);
  const dense = useMemo(() => (data ? densify(core, WORLD, route, 40) : { pts: route, wp: route.map((_, i) => i) }), [core, data, route]);
  const ev = useMemo(() => core.evaluateRoute(WORLD, dense.pts, p), [core, dense, p]);
  const check = useMemo(() => {
    if (!data?.rover || dense.pts.length < 2) return null;
    try { return core.roverCheck(dense.pts, 100); } catch { return null; }
  }, [core, data, dense]);
  const longer = useMemo(() => (data?.eva ? core.evaLongerShare(ev.total_h) : 0), [core, data, ev.total_h]);

  // Walk-home area (recomputed shortly after the base or the budget changes).
  const base = route[0];
  const [reachRaw, setReachRaw] = useState<Reach | null>(null);
  const [reachImg, setReachImg] = useState<{ url: string; bounds: [[number, number], [number, number]]; area: number; max: number } | null>(null);
  useEffect(() => {
    if (!data?.dem || !base) return;
    const id = setTimeout(() => {
      try {
        const r = core.reach(WORLD, JEZERO, base.lat, base.lon, p, MAX_SLOPE);
        setReachImg({ ...reachImage(r, data.dem!), area: r.area_km2, max: r.max_km });
        setReachRaw(r);
      } catch { setReachImg(null); setReachRaw(null); }
    }, 60);
    return () => clearTimeout(id);
  }, [core, data, base?.lat, base?.lon, p]); // eslint-disable-line react-hooks/exhaustive-deps

  // Elevation for waypoints outside the Jezero grid (Trek MOLA identify).
  const addPoint = (lat: number, lon: number) => {
    const wp: Waypoint = { lat, lon, elev: undefined };
    if (mode === 'base') setRoute((r) => [wp, ...r.slice(1)]);
    else setRoute((r) => [...r, wp]);
    getElevation(WORLD, lat, lon).then((elev) => setRoute((r) => r.map((x) => (x.lat === lat && x.lon === lon ? { ...x, elev } : x))));
    if (mode === 'base') setMode('route');
  };

  // ---- playback ----
  const [hud, setHud] = useState<HudState | null>(null);
  const [walker, setWalker] = useState<[number, number] | null>(null);
  const raf = useRef(0);
  const stop = () => { cancelAnimationFrame(raf.current); setHud(null); setWalker(null); };
  const play = () => {
    if (dense.pts.length < 2) return;
    cancelAnimationFrame(raf.current);
    const pts = dense.pts, ticks = ev.ticks;
    const turn = ev.point_of_no_return != null ? Math.max(1, ev.point_of_no_return - 1) : pts.length - 1;
    const tt = ticks[turn];
    const eTurn = (1 - tt.o2_left) * ev.usable_o2_h;
    const homeE = Math.max(0, ev.usable_h - tt.margin_h - eTurn);
    const OUT_MS = 11000 * Math.min(1, Math.max(0.4, turn / 120)), BACK_MS = 5000, HOLD = 1400;
    const t0 = performance.now();
    const frame = (now: number) => {
      const el = Math.max(0, now - t0); // rAF time can be slightly before t0
      if (el < OUT_MS) {
        const f = (el / OUT_MS) * turn, i = Math.floor(f), j = Math.min(turn, i + 1), u = f - i;
        const a = ticks[i], b = ticks[j];
        const lerp = (x: number, y: number) => x + (y - x) * u;
        setWalker([lerp(pts[i].lat, pts[j].lat), lerp(pts[i].lon, pts[j].lon)]);
        setHud({ t_h: lerp(a.t_h, b.t_h), km: lerp(a.km, b.km), o2: lerp(a.o2_left, b.o2_left), water: lerp(a.water_left, b.water_left),
          home_h: lerp(a.home_h, b.home_h), margin_h: lerp(a.margin_h, b.margin_h), phase: 'out', slope: ev.legs[Math.min(i, ev.legs.length - 1)]?.slope_deg ?? null });
      } else if (el < OUT_MS + HOLD) {
        setWalker([pts[turn].lat, pts[turn].lon]);
        setHud({ t_h: tt.t_h, km: tt.km, o2: tt.o2_left, water: tt.water_left, home_h: tt.home_h, margin_h: tt.margin_h, phase: 'turn', slope: null });
      } else if (el < OUT_MS + HOLD + BACK_MS) {
        const u = (el - OUT_MS - HOLD) / BACK_MS;
        setWalker([pts[turn].lat + (pts[0].lat - pts[turn].lat) * u, pts[turn].lon + (pts[0].lon - pts[turn].lon) * u]);
        setHud({ t_h: tt.t_h + tt.home_h * u, km: tt.km, o2: tt.o2_left - (homeE * u) / ev.usable_o2_h,
          water: tt.water_left - (homeE * WATER_PER_O2 * u) / ev.usable_water_h, home_h: tt.home_h * (1 - u),
          margin_h: tt.margin_h, phase: 'back', slope: null });
      } else {
        setWalker([pts[0].lat, pts[0].lon]);
        setHud((h) => (h ? { ...h, home_h: 0, phase: 'done' } : h));
        return;
      }
      raf.current = requestAnimationFrame(frame);
    };
    raf.current = requestAnimationFrame(frame);
  };
  useEffect(() => () => cancelAnimationFrame(raf.current), []);
  useEffect(() => { stop(); }, [route, p]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- rehearsal in Hokkaido ----
  const reh = useRehearsal(core, data?.hokkaido ?? []);
  const [rehOpen, setRehOpen] = useState(false);
  const [rehSel, setRehSel] = useState(0);
  const marsForReh = useMemo(() => (data ? densify(core, WORLD, route, 80).pts.filter((x) => x.elev != null) : []), [core, data, route]);
  const startRehearsal = () => { setRehOpen(true); setRehSel(0); reh.run(marsForReh); };

  // ---- map features ----
  const roverFeatures = useMemo<Feature[]>(() => (data && showRover
    ? [{ kind: 'lines', lines: data.traverse, color: '#36cfc9', weight: 2.5, opacity: 0.85, tooltip: 'Perseverance が実際に走った道' }]
    : []), [data, showRover]);
  const turnIdx = ev.point_of_no_return != null ? Math.max(1, ev.point_of_no_return - 1) : null;
  const features = useMemo<Feature[]>(() => {
    const f: Feature[] = [];
    if (reachImg && showReach) f.push({ kind: 'image', url: reachImg.url, bounds: reachImg.bounds, opacity: 0.55 });
    f.push(...roverFeatures);
    // Route coloured by slope, in runs of the same colour.
    const pts = dense.pts;
    let run: [number, number][] = [], col = '';
    for (let i = 1; i < pts.length; i++) {
      const c = slopeColor(ev.legs[i - 1]?.known ? ev.legs[i - 1].slope_deg : null);
      if (c !== col && run.length) { f.push({ kind: 'line', pts: run, color: col, weight: 5 }); run = [run[run.length - 1]]; }
      if (!run.length) run.push([pts[i - 1].lat, pts[i - 1].lon]);
      run.push([pts[i].lat, pts[i].lon]);
      col = c;
    }
    if (run.length > 1) f.push({ kind: 'line', pts: run, color: col, weight: 5 });
    if (pts.length > 1) {
      const last = pts[pts.length - 1];
      f.push({ kind: 'line', pts: [[last.lat, last.lon], [pts[0].lat, pts[0].lon]], color: '#ffffff', weight: 2, dash: '4 6', opacity: 0.7 });
    }
    route.forEach((w, i) => f.push({
      kind: 'point', lat: w.lat, lon: w.lon, radius: i === 0 ? 9 : 5, color: i === 0 ? '#ffffff' : '#ffd666',
      tooltip: i === 0 ? '基地（ここから出てここに戻る）' : `WP${i}${w.elev != null ? `<br>標高 ${Math.round(w.elev)} m` : ''}`,
    }));
    if (turnIdx != null && pts[turnIdx]) {
      f.push({ kind: 'point', lat: pts[turnIdx].lat, lon: pts[turnIdx].lon, radius: 9, color: '#faad14', tooltip: 'ここで引き返す', openTooltip: true });
    }
    return f;
  }, [reachImg, showReach, roverFeatures, dense, ev, route, turnIdx]);
  // The same layers for the 3D view.
  const lines3d = useMemo<Line3D[]>(() => {
    const l: Line3D[] = [];
    if (data && showRover) for (const t of data.traverse) l.push({ pts: t, color: '#36cfc9', width: 2.5, opacity: 0.9 });
    for (const f of features) if (f.kind === 'line') l.push({ pts: f.pts, color: f.color, width: (f.weight ?? 3) >= 5 ? 5 : 2, opacity: f.opacity });
    return l;
  }, [data, showRover, features]);
  const points3d = useMemo<Point3D[]>(() => {
    const ps: Point3D[] = route.map((w, i) => ({ lat: w.lat, lon: w.lon, color: i === 0 ? '#ffffff' : '#ffd666', size: i === 0 ? 2.2 : 1.2 }));
    if (turnIdx != null && dense.pts[turnIdx]) ps.push({ lat: dense.pts[turnIdx].lat, lon: dense.pts[turnIdx].lon, color: '#faad14', size: 2 });
    return ps;
  }, [route, turnIdx, dense]);
  const focus3d = useMemo(() => {
    if (route.length < 2) return null;
    const la = route.map((w) => w.lat), lo = route.map((w) => w.lon);
    return [[Math.min(...la), Math.min(...lo)], [Math.max(...la), Math.max(...lo)]] as [[number, number], [number, number]];
  }, [route]);
  const live = useMemo<Feature[]>(() => (walker ? [{ kind: 'walker', lat: walker[0], lon: walker[1], color: '#ff7a45' }] : []), [walker]);
  const overlays = useMemo(() => missionOverlay(core, WORLD), [core]);

  const n = route.length;
  const tools: [Mode | 'undo' | 'clear' | 'example', string, string][] = [
    ['pan', '✋', '地図を動かす'], ['route', '〰', 'ルートを引く'], ['base', '⌂', '基地を置き直す'],
    ['undo', '↶', '1つ戻す'], ['clear', '🗑', 'ルートを消す'], ['example', '★', '例のルートに戻す'],
  ];

  return (
    <section className="view walk">
      <aside className="panel">
        <h2 className="walk-title">WALKBACK <small>Jezero クレーター</small></h2>
        <p className="muted">基地から歩いて出て、酸素と冷却水が尽きる前に帰れるか。地図をクリックしてルートを引きます（最初の点が基地）。</p>
        {data?.errors.length ? <p className="warn">読み込めなかったデータ: {data.errors.join(' / ')}</p> : null}

        <div className={`verdict ${n < 2 ? '' : ev.ok ? 'ok' : 'ng'}`}>
          {n < 2 ? 'ルートを引いてください' : ev.ok ? '帰れる' : `途中で引き返す（WP${dense.wp.findIndex((w) => w >= (ev.point_of_no_return ?? 0))} の手前）`}
        </div>
        {n >= 2 && (
          <>
            <div className="kv"><span>行き / 帰り（まっすぐ）</span><b>{ev.out_km.toFixed(1)} km / {ev.back_km.toFixed(1)} km</b></div>
            <div className="kv"><span>かかる時間</span><b>{fmtH(ev.total_h)}</b></div>
            <div className="kv"><span>体力の消費 / 使える分</span><b>{ev.total_effort_h.toFixed(1)} / {ev.usable_h.toFixed(1)} h</b></div>
            <div className="kv"><span>先に尽きるもの</span><b className={ev.limiting === 'water' ? 'water' : ''}>{ev.limiting === 'water' ? '冷却水' : '酸素'}</b></div>
            {reachImg && <div className="kv"><span>歩いて帰れる範囲</span><b>{reachImg.area.toFixed(0)} km²（最遠 {reachImg.max.toFixed(1)} km）</b></div>}
            {ev.unknown_segments > 0 && <p className="warn">地形が分からない区間 {ev.unknown_segments} か所は、急な登り（約17°）として安全側で計算しています。</p>}
          </>
        )}
        <div className="btns">
          <button className="primary" onClick={hud ? stop : play} disabled={n < 2}>{hud ? '■ 止める' : '▶ ヘルメットで歩く'}</button>
          <button onClick={startRehearsal} disabled={marsForReh.length < 3 || !data?.hokkaido.length || reh.status === 'running'}>
            {reh.status === 'running' ? `探しています ${reh.done}/${reh.total}` : '北海道で練習コースを探す'}
          </button>
        </div>

        <details open>
          <summary>条件</summary>
          <label>歩く速さ（平地） <b>{speed}</b> km/h
            <input id="speed" type="range" min={0.5} max={5} step={0.5} value={speed} onChange={(e) => setSpeed(+e.target.value)} /></label>
          <label>酸素 <b>{o2}</b> 時間分
            <input id="o2" type="range" min={2} max={12} step={0.5} value={o2} onChange={(e) => setO2(+e.target.value)} /></label>
          <label>冷却水 <b>{water}</b> 時間分
            <input id="water" type="range" min={2} max={12} step={0.5} value={water} onChange={(e) => setWater(+e.target.value)} /></label>
          <label>残しておく余裕 <b>{reserve}</b>%（最低30分）
            <input id="reserve" type="range" min={0} max={50} step={5} value={reserve} onChange={(e) => setReserve(+e.target.value)} /></label>
          <p className="muted">急いで歩くと冷却水は酸素の約1.15倍の速さで減ります（NASA の歩行帰還試験、Gernhardt 2010）。帰着時に30分・2割を残すのは Apollo 以来の慣例です。</p>
        </details>

        <RoverCard check={check} />
        <EvaCard eva={data?.eva ?? null} planH={ev.total_h} longer={longer} />

        <details>
          <summary>地図の表示</summary>
          <label className="check"><input type="checkbox" checked={showReach} onChange={(e) => setShowReach(e.target.checked)} /> 歩いて帰れる範囲</label>
          <label className="check"><input type="checkbox" checked={showRover} onChange={(e) => setShowRover(e.target.checked)} /> 探査車の実走ルート</label>
          <p className="muted">ルートの色: 緑 8°未満 / 黄 8〜15° / 赤 15°以上 / 灰 地形不明。帰れる範囲の黄色い縁が限界の線です。</p>
        </details>
        <p className="muted src">データ: Mars 2020 Perseverance 走行記録（NASA/JPL MMGIS）、MRO HiRISE 画像と地形（NASA/UArizona, USGS）、MGS MOLA 地形、Mars Odyssey THEMIS、MRO CTX、data.nasa.gov 船外活動記録、国土地理院 標高タイル。{data?.dem?.src ? ` 地形グリッド: ${data.dem.src}` : ''}</p>
      </aside>

      <div className={`maps ${rehOpen && reh.found.length ? '' : 'single'}`}>
        <div className="mapwrap">
          <PlanetMap core={core} world={WORLD} view={view} fly={fly} baseKey="viking" overlayKeys={HIRISE} collapsedLayers
            overlays={overlays} features={features} live={live} crosshair={mode !== 'pan'}
            onClick={(lat, lon) => mode !== 'pan' && !hud && addPoint(lat, lon)}>
            <div className="leaflet-bar draw-toolbar">
              {tools.map(([m, icon, title]) => (
                <a key={m} href="#" title={title} aria-label={title} data-m={m} className={m === mode ? 'on' : ''} onClick={(e) => {
                  e.preventDefault(); e.stopPropagation();
                  if (m === 'undo') setRoute((r) => r.slice(0, Math.max(1, r.length - 1)));
                  else if (m === 'clear') setRoute((r) => r.slice(0, 1));
                  else if (m === 'example') { if (data) setRoute(exampleRoute(data.traverseRaw)); }
                  else setMode(m);
                }}>{icon}</a>
              ))}
            </div>
          </PlanetMap>
          {view3d && data?.demGrid && (
            <div className="terrain-over">
              <Terrain3D grid={data.demGrid} radiusKm={core.world(WORLD).radius_km} palette="mars" lines={lines3d} points={points3d}
                reach={showReach ? reachRaw : null} walker={walker} focus={focus3d} label="Jezero クレーター（3D）" />
            </div>
          )}
          {data?.demGrid && (
            <div className="view-toggle" role="group" aria-label="地図の表示">
              <button className={view3d ? '' : 'on'} onClick={() => setView3d(false)}>2D</button>
              <button className={view3d ? 'on' : ''} onClick={() => setView3d(true)}>3D</button>
            </div>
          )}
          {hud && <Hud s={hud} limiting={ev.limiting} onStop={stop} />}
        </div>
        {rehOpen && reh.found.length > 0 && (
          <RehearsalPanel core={core} mars={marsForReh} found={reh.found} selected={Math.min(rehSel, reh.found.length - 1)} onSelect={setRehSel} />
        )}
        {rehOpen && reh.status === 'done' && reh.found.length === 0 && (
          <p className="warn floating">北海道の候補地の範囲（約21km四方）に収まるコースが見つかりませんでした。ルートを短くしてください。</p>
        )}
      </div>
    </section>
  );
}
