// #11 Martian Map "WALKBACK": layered map + EVA route with a return limit (evaluated in Rust).
// Works on Mars, Moon and Earth (Hokkaido = practice the same walk on an analog site).
import { useEffect, useMemo, useState } from 'react';
import type { Core, Waypoint, World } from '../core';
import { getElevation } from '../elevation';
import { PlanetMap, missionOverlay, type Feature, type FlyTarget } from '../map/PlanetMap';
import { WorldTabs } from './WorldTabs';

type Mode = 'pan' | 'pin' | 'route';
interface Pin extends Waypoint { label: string }
interface Drawing { pins: Pin[]; route: Waypoint[] }
const empty = (): Drawing => ({ pins: [], route: [] });

export interface WalkParams { world?: World; lat?: number; lon?: number; z?: number }

export function WalkView({ core, params }: { core: Core; params: WalkParams }) {
  const [world, setWorld] = useState<World>(params.world ?? 'mars');
  const [view, setView] = useState<[number, number, number] | undefined>(
    params.lat != null ? [params.lat, params.lon!, params.z ?? 10] : undefined);
  const [fly, setFly] = useState<FlyTarget | null>(null);
  const [mode, setMode] = useState<Mode>('route');
  const [drawings, setDrawings] = useState<Record<World, Drawing>>({ earth: empty(), moon: empty(), mars: empty() });
  const [speed, setSpeed] = useState(2);
  const [o2, setO2] = useState(8);
  const [reserve, setReserve] = useState(20);

  // Follow links like #walk/earth/43.6/142.9/14 from the analogs view.
  useEffect(() => {
    if (!params.world) return;
    if (params.world !== world) {
      setView(params.lat != null ? [params.lat, params.lon!, params.z ?? 10] : undefined);
      setWorld(params.world);
    } else if (params.lat != null) {
      setFly({ lat: params.lat, lon: params.lon!, z: params.z ?? 10, seq: Date.now() });
    }
  }, [params.world, params.lat, params.lon, params.z]); // eslint-disable-line react-hooks/exhaustive-deps

  const d = drawings[world];
  const update = (w: World, fn: (d: Drawing) => Drawing) => setDrawings((all) => ({ ...all, [w]: fn(all[w]) }));

  const fetchElev = (w: World, kind: 'pins' | 'route', idx: number, lat: number, lon: number) =>
    getElevation(w, lat, lon).then((elev) => update(w, (dd) => {
      const list = [...dd[kind]] as Waypoint[];
      if (list[idx] && list[idx].lat === lat && list[idx].lon === lon) list[idx] = { ...list[idx], elev };
      return { ...dd, [kind]: list };
    }));

  const onClick = (lat: number, lon: number) => {
    if (mode === 'pan') return;
    const w = world, kind = mode === 'pin' ? 'pins' : 'route';
    const idx = d[kind].length;
    update(w, (dd) => kind === 'pins'
      ? { ...dd, pins: [...dd.pins, { lat, lon, elev: undefined, label: `P${dd.pins.length + 1}` }] }
      : { ...dd, route: [...dd.route, { lat, lon, elev: undefined }] });
    fetchElev(w, kind, idx, lat, lon);
  };

  const undo = () => update(world, (dd) => mode === 'pin' || (!dd.route.length && dd.pins.length)
    ? { ...dd, pins: dd.pins.slice(0, -1) } : { ...dd, route: dd.route.slice(0, -1) });
  const clear = () => update(world, empty);
  const exportGeoJSON = () => {
    const fc = {
      type: 'FeatureCollection', properties: { body: world },
      features: [
        ...d.pins.map((p) => ({ type: 'Feature', properties: { kind: 'pin', label: p.label, elevation_m: p.elev ?? null }, geometry: { type: 'Point', coordinates: [p.lon, p.lat] } })),
        ...(d.route.length > 1 ? [{ type: 'Feature', properties: { kind: 'route', elevations_m: d.route.map((p) => p.elev ?? null) }, geometry: { type: 'LineString', coordinates: d.route.map((p) => [p.lon, p.lat]) } }] : []),
      ],
    };
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(fc, null, 2)], { type: 'application/geo+json' }));
    a.download = `${world}-plan.geojson`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  const ev = useMemo(() => core.evaluateRoute(world, d.route, { speed_kmh: speed, o2_h: o2, reserve: reserve / 100 }),
    [core, world, d.route, speed, o2, reserve]);

  const fmtElev = (v: number | null | undefined) => (v === undefined ? '標高 取得中…' : v === null ? '標高 —' : `標高 ${Math.round(v)} m`);
  const features: Feature[] = [
    ...(d.route.length ? [{ kind: 'ring', lat: d.route[0].lat, lon: d.route[0].lon, radiusKm: ev.limit_km, color: '#ff4d4f', tooltip: `引き返し限界（平地）${ev.limit_km.toFixed(1)} km` } as Feature] : []),
    { kind: 'line', pts: d.route.map((p) => [p.lat, p.lon] as [number, number]), color: '#ffd666' },
    ...d.route.map((p, i): Feature => ({
      kind: 'point', lat: p.lat, lon: p.lon, radius: i === 0 ? 8 : 5, color: i === 0 ? '#52c41a' : '#ffd666',
      tooltip: `${i === 0 ? '基地 / 出発点' : `WP${i}`}<br>${fmtElev(p.elev)}`,
    })),
    ...d.pins.map((p): Feature => ({ kind: 'pin', lat: p.lat, lon: p.lon, tooltip: `${p.label}<br>${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}<br>${fmtElev(p.elev)}` })),
  ];

  const changeWorld = (w: World) => { setView(undefined); setWorld(w); };
  // Selected preset per world; cleared whenever the world changes (tabs or #walk links).
  const [presetId, setPresetId] = useState('');
  useEffect(() => setPresetId(''), [world]);
  const presets = core.missions.presets[world] ?? [];
  const tools: [Mode | 'undo' | 'clear' | 'export', string, string][] = [
    ['pan', '✋', '移動'], ['pin', '📍', 'ピンを置く'], ['route', '〰', 'ルートを引く'],
    ['undo', '↶', '1つ戻す'], ['clear', '🗑', 'このワールドの描画を消す'], ['export', '⤓', 'GeoJSON で保存'],
  ];

  return (
    <section className="view">
      <aside className="panel">
        <WorldTabs core={core} worlds={['mars', 'moon', 'earth']} value={world} onChange={changeWorld} />
        <label>地点
          <select id="walk-preset" value={presetId} onChange={(e) => {
            setPresetId(e.target.value);
            const p = presets.find((x) => x.id === e.target.value);
            if (p) setFly({ lat: p.lat, lon: p.lon, z: p.z, seq: Date.now() });
          }}>
            <option value="">— 地点を選ぶ —</option>
            {presets.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        <label>歩行速度（平地） <b>{speed}</b> km/h
          <input id="speed" type="range" min={0.5} max={5} step={0.5} value={speed} onChange={(e) => setSpeed(+e.target.value)} /></label>
        <label>O₂ 残量 <b>{o2}</b> h
          <input id="o2" type="range" min={1} max={12} step={0.5} value={o2} onChange={(e) => setO2(+e.target.value)} /></label>
        <label>予備 <b>{reserve}</b> %
          <input id="reserve" type="range" min={0} max={50} step={5} value={reserve} onChange={(e) => setReserve(+e.target.value)} /></label>
        <div id="route-stats">
          {d.route.length < 2 ? (
            <p className="muted">地図をクリックしてルートを置く（最初の点が基地）。📍でメモ用のピンも置けます。</p>
          ) : (
            <>
              <div className="kv"><span>往路</span><b>{ev.out_km.toFixed(2)} km / {ev.out_h.toFixed(1)} h</b></div>
              <div className="kv"><span>帰路（直線）</span><b>{ev.back_km.toFixed(2)} km / {ev.back_h.toFixed(1)} h</b></div>
              <div className="kv"><span>最大傾斜</span><b>{ev.max_slope_deg.toFixed(1)}°</b></div>
              <div className="kv"><span>所要時間 / 使えるO₂</span><b>{ev.total_h.toFixed(1)} / {ev.usable_h.toFixed(1)} h</b></div>
              <div className={`verdict ${ev.ok ? 'ok' : 'ng'}`}>
                {ev.ok ? '✅ 帰還できる' : `⛔ WP${ev.point_of_no_return ?? d.route.length - 1} で引き返し限界を超える`}</div>
              {ev.unknown_segments > 0 && <p className="muted">標高未取得の区間 {ev.unknown_segments} は平地として計算</p>}
              <p className="warn">⚠ 傾斜は経由点の標高差のみ（区間内の起伏は未考慮）。速度式は地球の Tobler 式を流用、重力 {core.world(world).gravity} m/s² の補正は未実装。</p>
            </>
          )}
        </div>
      </aside>
      <div className="maps single">
        <PlanetMap core={core} world={world} view={view} fly={fly} baseKey={world === 'mars' ? 'viking' : world === 'earth' ? 's2' : undefined}
          collapsedLayers={false} overlays={missionOverlay(core, world)} features={features}
          crosshair={mode !== 'pan'} onClick={onClick}>
          <div className="leaflet-bar draw-toolbar">
            {tools.map(([m, icon, title]) => (
              <a key={m} href="#" title={title} data-m={m} className={m === mode ? 'on' : ''} onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                if (m === 'undo') undo(); else if (m === 'clear') clear(); else if (m === 'export') exportGeoJSON(); else setMode(m);
              }}>{icon}</a>
            ))}
          </div>
        </PlanetMap>
      </div>
    </section>
  );
}
