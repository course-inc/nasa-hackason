// #11 Martian Map "WALKBACK" (Jezero): plan a walk from a base on Mars, see where you can still
// walk home from (O₂ and cooling water), check the plan against Perseverance's real drives and
// real EVA durations, play it back through a helmet display, and find the same walk in Hokkaido.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Core, Waypoint, World } from '../core';
import { getElevation } from '../elevation';
import { PlanetMap, missionOverlay, type Feature, type FlyTarget } from '../map/PlanetMap';
import { JEZERO, LANDING, ensureFooting, exampleRoute, loadWalkData, type WalkData } from '../walk/data';
import { fmtH, footingImage, reachImage, slopeColor } from '../walk/geo';
import { DEFAULT_START, WALKBACK_COLOR, WATER_PER_O2, WORLD, waterFactor, denseRoute, easyLeg, evaParams, evaluate, reachFrom, rehearsalPoints, roverCheck, roverWalkbackSql, turnIndex, turnWaypoint, walkbackState } from '../walk/plan';
import { setWalkController, type EvidenceTopic } from '../walk/controller';
import { useLang, useT } from '../i18n';
import { GpxError, SAMPLE_GPX, atDistance, importWalk, type WalkImport } from '../walk/gpx';
import { EarthWalkPanel, WalkImportCard } from '../walk/WalkRecord';
import { Guide } from '../walk/Guide';
import { RouteEditor, type Preview } from '../walk/RouteEditor';
import { Hud, type HudState } from '../walk/Hud';
import { EvaCard, RoverCard } from '../walk/Evidence';
import { RehearsalPanel, useRehearsal } from '../walk/Rehearsal';
import { Terrain3D, type Camera3D, type Line3D, type Point3D } from '../map/Terrain3D';
import { Globe, type GlobeCamera, type GlobeMark } from '../map/Globe';
import type { Reach, RoverWalkback } from '../core';

type Mode = 'pan' | 'route' | 'base';
export interface WalkParams { world?: World; lat?: number; lon?: number; z?: number }

const HIRISE = ['hirise'];

export function WalkView({ core, params }: { core: Core; params: WalkParams }) {
  const t = useT();
  const lang = useLang();
  const [data, setData] = useState<WalkData | null>(null);
  const [route, setRouteRaw] = useState<Waypoint[]>([]);
  // Undo / redo for route edits (↶ ↷, Cmd/Ctrl+Z, Cmd/Ctrl+Shift+Z or Ctrl+Y). Every change of
  // the route goes through setRoute and is recorded; the verdict, HUD and 3D follow the route.
  const hist = useRef<{ past: Waypoint[][]; future: Waypoint[][] }>({ past: [], future: [] });
  const [, setHistVer] = useState(0);
  const routeNow = useRef<Waypoint[]>([]);
  routeNow.current = route;
  const setRoute = (next: Waypoint[] | ((r: Waypoint[]) => Waypoint[])) => {
    const cur = routeNow.current;
    const n = typeof next === 'function' ? next(cur) : next;
    if (n === cur) return;
    if (cur.length) { hist.current.past.push(cur); if (hist.current.past.length > 200) hist.current.past.shift(); }
    hist.current.future = [];
    routeNow.current = n;
    setRouteRaw(n);
    setHistVer((v) => v + 1);
  };
  const undo = () => {
    const prev = hist.current.past.pop();
    if (!prev) return;
    hist.current.future.push(routeNow.current);
    routeNow.current = prev;
    setRouteRaw(prev); setHistVer((v) => v + 1);
  };
  const redo = () => {
    const next = hist.current.future.pop();
    if (!next) return;
    hist.current.past.push(routeNow.current);
    routeNow.current = next;
    setRouteRaw(next); setHistVer((v) => v + 1);
  };
  const [mode, setMode] = useState<Mode>('route');
  const [speed, setSpeed] = useState(2);
  const [o2, setO2] = useState(8);
  const [water, setWater] = useState(8);
  const [reserve, setReserve] = useState(20);
  const [showReach, setShowReach] = useState(true);
  const [showRover, setShowRover] = useState(true);
  // Footing (THEMIS thermal inertia, TES dust): counted in every walk number; layer off by default.
  const [footOn, setFootOn] = useState(true);
  // Departure, local solar hour at Jezero: MEDA air temperature over the walk sets the cooling water.
  const [start, setStart] = useState(DEFAULT_START);
  const [showFoot, setShowFoot] = useState(false);
  const [view3d, setView3d] = useState(false);
  const [globeOn, setGlobeOn] = useState(false);
  const [globeCam, setGlobeCam] = useState<GlobeCamera | null>(null);
  const [globeFromMap, setGlobeFromMap] = useState(false);
  const [globeStart, setGlobeStart] = useState<{ lat: number; lon: number }>(LANDING);
  // The map fills the screen; the panel floats over it and can be folded away (closed on phones).
  const [panelOpen, setPanelOpen] = useState(() => typeof matchMedia === 'undefined' || !matchMedia('(max-width: 820px)').matches);
  const [fly, setFly] = useState<FlyTarget | null>(null);
  const [view] = useState<[number, number, number]>(() =>
    params.lat != null ? [params.lat, params.lon!, params.z ?? 13] : [LANDING.lat, LANDING.lon - 0.015, 13]);

  useEffect(() => {
    loadWalkData(core).then((d) => {
      setData(d);
      setRouteRaw((r) => (r.length ? r : d.traverseRaw.length ? exampleRoute(d.traverseRaw) : [LANDING]));
    });
  }, [core]);
  useEffect(() => {
    if (params.lat != null && params.lon != null) setFly({ lat: params.lat, lon: params.lon, z: params.z ?? 13, seq: Date.now() });
  }, [params.lat, params.lon, params.z]);

  // Same functions as the agent tools (walk/plan.ts), so both always show the same numbers.
  const p = useMemo(() => evaParams({ speed, o2, water, reserve, footing: footOn, start }), [speed, o2, water, reserve, footOn, start]);
  const dense = useMemo(() => denseRoute(core, data, route), [core, data, route]);
  const ev = useMemo(() => evaluate(core, dense, p), [core, dense, p]);
  // The same route on firm ground, to show how much time the footing adds.
  const evFirm = useMemo(() => (footOn && data?.footing ? evaluate(core, dense, { ...p, footing: false }) : null), [core, dense, p, footOn, data]);
  const footModel = useMemo(() => { try { return core.footingModel(); } catch { return null; } }, [core]);
  const wx = useMemo(() => {
    if (!data?.weather) return null;
    try { return { ...core.weatherWalk(start, o2), f: waterFactor(core, p) }; } catch { return null; }
  }, [core, data, start, o2, p]);
  const wxModel = useMemo(() => { try { return core.weatherModel(); } catch { return null; } }, [core]);
  const radModel = useMemo(() => { try { return core.radiationModel(); } catch { return null; } }, [core]);
  const rad = useMemo(() => { try { return core.radiationExposure(ev.total_h); } catch { return null; } }, [core, ev.total_h]);
  const footImg = useMemo(() => {
    if (!showFoot || !data?.dem || !data.footing) return null;
    ensureFooting(core, true);
    const img = footingImage(core.footingBadness(JEZERO), data.dem);
    ensureFooting(core, footOn);
    return img;
  }, [core, data, showFoot]); // eslint-disable-line react-hooks/exhaustive-deps
  const check = useMemo(() => roverCheck(core, data, dense), [core, data, dense]);
  const longer = useMemo(() => (data?.eva ? core.evaLongerShare(ev.total_h) : 0), [core, data, ev.total_h]);

  // Walk-home area (recomputed shortly after the base or the budget changes).
  const base = route[0];
  const [reachRaw, setReachRaw] = useState<Reach | null>(null);
  const [reachImg, setReachImg] = useState<{ url: string; bounds: [[number, number], [number, number]]; area: number; max: number } | null>(null);
  useEffect(() => {
    if (!data?.dem || !base) return;
    const id = setTimeout(() => {
      const r = reachFrom(core, data, base, p);
      setReachImg(r ? { ...reachImage(r, data.dem!), area: r.area_km2, max: r.max_km } : null);
      setReachRaw(r);
    }, 60);
    return () => clearTimeout(id);
  }, [core, data, base?.lat, base?.lon, p]); // eslint-disable-line react-hooks/exhaustive-deps

  // B: crewed rover on Perseverance's path breaks down: can the crew walk home from each point?
  const [roverMode, setRoverMode] = useState(false);
  const [rw, setRw] = useState<RoverWalkback | null>(null);
  const [rwState, setRwState] = useState<'idle' | 'loading' | 'error'>('idle');
  useEffect(() => {
    if (!roverMode || !data) { setRw(null); setRwState('idle'); return; }
    let live = true;
    // The path comes from the rover_traverse table (DuckDB loads on first use, ~1–2 s).
    setRwState('loading');
    roverWalkbackSql(core, data, p)
      .then((x) => { if (live) { setRw(x?.r ?? null); setRwState('idle'); } })
      .catch((e) => { console.warn('rover walkback', e); if (live) setRwState('error'); });
    return () => { live = false; };
  }, [core, data, p, roverMode]);
  const flag = rw?.first_stranded != null ? rw.points[rw.first_stranded] : null;
  const rwLines = useMemo(() => {
    if (!rw) return [] as { pts: [number, number][]; color: string }[];
    const out: { pts: [number, number][]; color: string }[] = [];
    let cur: { pts: [number, number][]; color: string } | null = null;
    for (const pt of rw.points) {
      const color = WALKBACK_COLOR[walkbackState(pt)];
      const ll: [number, number] = [pt.lat, pt.lon];
      if (!cur || cur.color !== color) {
        if (cur) cur.pts.push(ll);
        cur = { pts: cur ? [cur.pts[cur.pts.length - 1], ll] : [ll], color };
        out.push(cur);
      } else cur.pts.push(ll);
    }
    return out.filter((l) => l.pts.length > 1);
  }, [rw]);

  // Elevation for waypoints outside the Jezero grid (Trek MOLA identify).
  const [easy, setEasy] = useState(false);
  const addPoint = (lat: number, lon: number) => {
    const wp: Waypoint = { lat, lon, elev: undefined };
    if (mode === 'base') setRoute((r) => [wp, ...r.slice(1)]);
    else {
      // Easy-path mode: follow the least-effort walk from the last point (Rust Dijkstra on the grid).
      const last = route[route.length - 1];
      const leg = easy && last ? easyLeg(core, data, last, wp, p) : null;
      if (leg) { leg[leg.length - 1] = wp; setRoute((r) => [...r, ...leg]); }
      else setRoute((r) => [...r, wp]);
    }
    getElevation(WORLD, lat, lon).then((elev) => setRouteRaw((r) => r.map((x) => (x.lat === lat && x.lon === lon ? { ...x, elev } : x))));
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
    const turn = turnIndex(ev) ?? pts.length - 1;
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
  const marsForReh = useMemo(() => rehearsalPoints(core, data, route), [core, data, route]);
  const startRehearsal = () => { setRehOpen(true); setRehSel(0); reh.run(marsForReh); };

  // ---- A: a GPX walk in Hokkaido, replayed on Mars ----
  const [walkRec, setWalkRec] = useState<WalkImport | null>(null);
  const [walkErr, setWalkErr] = useState<string | null>(null);
  const [walkBusy, setWalkBusy] = useState(false);
  const loadWalk = async (text: string, file: string): Promise<WalkImport> => {
    setWalkBusy(true); setWalkErr(null);
    try {
      await loadWalkData(core);
      const rec = await importWalk(core, text, file);
      stop();
      setWalkRec(rec);
      setRoute(rec.route);
      live$.current.route = rec.route;
      const v = Math.min(5, Math.max(0.5, Math.round(rec.summary.flat_kmh * 100) / 100));
      setSpeed(v); live$.current.speed = v;
      setRehOpen(false);
      setFly({ lat: LANDING.lat, lon: LANDING.lon, z: 15, seq: Date.now() });
      return rec;
    } catch (e) {
      const code = e instanceof GpxError ? e.message : '';
      setWalkErr(code === 'no-time' ? t('この GPX には時刻がありません。時刻つきで記録した GPX（多くの登山・ランニングアプリの書き出し）を使ってください。', 'This GPX has no times. Use a GPX recorded with times (most hiking or running apps export one).')
        : code === 'no-points' ? t('GPX に歩いた点（trkpt）が見つかりませんでした。トラックとして書き出した GPX を使ってください。', 'No track points (trkpt) in this GPX. Export the walk as a track.')
        : code === 'not-gpx' ? t('GPX として読めませんでした。.gpx ファイルを選んでください。', 'This is not a GPX file. Choose a .gpx file.')
        : t('歩いた記録を読み込めませんでした。もう一度試すか、別の GPX を選んでください。', 'Could not load the walk. Try again or choose another GPX.'));
      throw e;
    } finally { setWalkBusy(false); }
  };
  const loadSample = async () => {
    const r = await fetch(SAMPLE_GPX);
    if (!r.ok) { setWalkErr(t('例の GPX を読み込めませんでした。', 'Could not load the sample GPX.')); throw new Error('sample'); }
    return loadWalk(await r.text(), SAMPLE_GPX.split('/').pop()!);
  };
  const clearWalk = () => { stop(); setWalkRec(null); setWalkErr(null); if (data) setRoute(exampleRoute(data.traverseRaw)); setSpeed(2); };
  const onDropFile = (f: File) => { f.text().then((t) => loadWalk(t, f.name)).catch(() => undefined); };
  const earthWalker = useMemo<[number, number] | null>(() => {
    if (!walkRec || !hud) return null;
    return atDistance(core, 'earth', walkRec.earth, hud.phase === 'done' ? 0 : hud.km);
  }, [core, walkRec, hud]);

  // Keyboard undo/redo for the route, only while this view is shown and not while typing.
  const sectionRef = useRef<HTMLElement>(null);
  const undoRef = useRef({ undo, redo });
  undoRef.current = { undo, redo };
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || !sectionRef.current?.offsetParent) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
      const k = e.key.toLowerCase();
      if (k === 'z' && !e.shiftKey) { e.preventDefault(); undoRef.current.undo(); }
      else if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); undoRef.current.redo(); }
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, []);

  // ---- agent controller (agent/tools.ts drives the screen through this) ----
  const [camera, setCamera] = useState<Camera3D | null>(null);
  const [exag, setExag] = useState<number | undefined>(undefined);
  const [flash, setFlash] = useState<EvidenceTopic | null>(null);
  const live$ = useRef({ route, speed, o2, water, reserve, footOn, start, play, stop, startRehearsalWith: reh.run, found: reh.found, loadWalk, loadSample, walkRec });
  live$.current = { route, speed, o2, water, reserve, footOn, start, play, stop, startRehearsalWith: reh.run, found: reh.found, loadWalk, loadSample, walkRec };
  useEffect(() => {
    setWalkController({
      core,
      data: () => loadWalkData(core),
      route: () => live$.current.route,
      params: () => ({ speed: live$.current.speed, o2: live$.current.o2, water: live$.current.water, reserve: live$.current.reserve, footing: live$.current.footOn, start: live$.current.start }),
      setRoute: (r) => { live$.current.route = r; setRoute(r); },
      setParams: (q) => {
        if (q.speed != null) { setSpeed(q.speed); live$.current.speed = q.speed; }
        if (q.o2 != null) { setO2(q.o2); live$.current.o2 = q.o2; }
        if (q.water != null) { setWater(q.water); live$.current.water = q.water; }
        if (q.reserve != null) { setReserve(q.reserve); live$.current.reserve = q.reserve; }
        if (q.start != null) { setStart(q.start); live$.current.start = q.start; }
      },
      runRehearsal: (pts) => { setRehOpen(true); setRehSel(0); return live$.current.startRehearsalWith(pts); },
      selectRehearsal: (i) => { setRehOpen(true); setRehSel(i); },
      set3d: setView3d,
      setCamera: (c) => {
        if (c.exaggeration != null) setExag(c.exaggeration);
        if ([c.lat, c.lon, c.distance_m, c.heading_deg, c.tilt_deg].some((x) => x != null)) {
          setCamera({ target: c.lat != null && c.lon != null ? { lat: c.lat, lon: c.lon } : undefined,
            distance: c.distance_m, heading: c.heading_deg, tilt: c.tilt_deg, seq: Date.now() });
        }
      },
      setOverlay: (o) => { if (o.rover != null) setShowRover(o.rover); if (o.reach != null) setShowReach(o.reach); },
      flyTo: (lat, lon, z) => setFly({ lat, lon, z, seq: Date.now() }),
      setGlobe: (on, cam) => { setGlobeFromMap(!cam); setGlobeOn(on); if (on && cam) setGlobeCam({ ...cam, seq: Date.now() }); },
      importWalk: (text, file) => live$.current.loadWalk(text, file),
      importSample: () => live$.current.loadSample(),
      walk: () => live$.current.walkRec,
      setRoverMode: (on) => {
        setRoverMode(on);
        if (on) setTimeout(() => document.getElementById('rover-walkback')?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 50);
      },
      play: () => live$.current.play(),
      stop: () => live$.current.stop(),
      openEvidence: (topic) => {
        setFlash(topic);
        setTimeout(() => {
          const el = document.getElementById(`ev-${topic === 'hokkaido_terrain' ? 'terrain' : topic}`);
          if (el instanceof HTMLDetailsElement) el.open = true;
          el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }, 50);
        setTimeout(() => setFlash((f) => (f === topic ? null : f)), 4000);
      },
    });
    return () => setWalkController(null);
  }, [core]);
  const fl = (topic: EvidenceTopic) => (flash === topic ? 'flash' : undefined);

  // Route editor: where the map is, and what the walk would be with one more point there
  // (same functions as the panel, so the rubber band and the verdict agree).
  const [mapHost, setMapHost] = useState<HTMLDivElement | null>(null);
  const routePreview = (pts: Waypoint[]): Preview | null => {
    if (!data || pts.length < 2) return null;
    const e = evaluate(core, denseRoute(core, data, pts), p);
    return { ok: e.ok, out_km: e.out_km, total_h: e.total_h, o2_left: e.ticks.at(-1)?.o2_left ?? null };
  };

  // ---- map features ----
  const roverFeatures = useMemo<Feature[]>(() => {
    if (rw) {
      const f: Feature[] = rwLines.map((l) => ({ kind: 'line', pts: l.pts, color: l.color, weight: 4, opacity: 0.95 }));
      if (flag) f.push({ kind: 'point', lat: flag.lat, lon: flag.lon, radius: 10, color: '#ff4d4f', openTooltip: true,
        tooltip: t(`🚩 人が乗っていたらここで引き返し<br>走行 ${flag.km.toFixed(1)} km・sol ${flag.sol}`, `🚩 With a crew aboard, turn back here<br>${flag.km.toFixed(1)} km driven · sol ${flag.sol}`) });
      return f;
    }
    return data && showRover
      ? [{ kind: 'lines', lines: data.traverse, color: '#36cfc9', weight: 2.5, opacity: 0.85, tooltip: t('Perseverance が実際に走った道', "Perseverance's real path") }]
      : [];
  }, [data, showRover, rw, rwLines, flag, lang]); // eslint-disable-line react-hooks/exhaustive-deps
  const turnIdx = turnIndex(ev);
  const features = useMemo<Feature[]>(() => {
    const f: Feature[] = [];
    if (footImg) f.push({ kind: 'image', url: footImg.url, bounds: footImg.bounds, opacity: 0.7 });
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
    // Hover a segment for its distance, steepest slope and time (summed from the engine's legs).
    // The waypoints themselves are drawn by RouteEditor as draggable handles.
    for (let i = 0; i + 1 < dense.wp.length; i++) {
      const a = dense.wp[i], b = dense.wp[i + 1], legs = ev.legs.slice(a, b);
      if (!legs.length) continue;
      const km = legs.reduce((x, l) => x + l.km, 0), h = legs.reduce((x, l) => x + l.hours, 0);
      const known = legs.filter((l) => l.known), steep = known.length ? Math.max(...known.map((l) => Math.abs(l.slope_deg))) : null;
      f.push({ kind: 'line', pts: pts.slice(a, b + 1).map((q) => [q.lat, q.lon] as [number, number]), color: '#000', weight: 16, opacity: 0.01,
        tooltip: `${i === 0 ? t('基地', 'Base') : `WP${i}`} → WP${i + 1}<br>${km.toFixed(2)} km · ${t('最大の坂', 'steepest')} ${steep == null ? '—' : `${steep.toFixed(0)}°`} · ${fmtH(h)}` });
    }
    if (turnIdx != null && pts[turnIdx]) {
      f.push({ kind: 'point', lat: pts[turnIdx].lat, lon: pts[turnIdx].lon, radius: 9, color: '#faad14', tooltip: t('🚩 引き返し地点', '🚩 Turn-back point'), openTooltip: true });
    }
    return f;
  }, [reachImg, showReach, footImg, roverFeatures, dense, ev, route, turnIdx, lang]); // eslint-disable-line react-hooks/exhaustive-deps
  // The same layers for the 3D view.
  const lines3d = useMemo<Line3D[]>(() => {
    const l: Line3D[] = [];
    if (data && showRover && !rw) for (const t of data.traverse) l.push({ pts: t, color: '#36cfc9', width: 2.5, opacity: 0.9 });
    for (const f of features) if (f.kind === 'line' && (f.opacity ?? 1) > 0.05) l.push({ pts: f.pts, color: f.color, width: (f.weight ?? 3) >= 5 ? 5 : (f.weight ?? 3) >= 4 ? 3.5 : 2, opacity: f.opacity });
    return l;
  }, [data, showRover, features, rw]);
  const points3d = useMemo<Point3D[]>(() => {
    const ps: Point3D[] = route.map((w, i) => ({ lat: w.lat, lon: w.lon, color: i === 0 ? '#ffffff' : '#ffd666', size: i === 0 ? 2.2 : 1.2 }));
    if (turnIdx != null && dense.pts[turnIdx]) ps.push({ lat: dense.pts[turnIdx].lat, lon: dense.pts[turnIdx].lon, color: '#faad14', size: 2 });
    if (flag) ps.push({ lat: flag.lat, lon: flag.lon, color: '#ff4d4f', size: 3 });
    return ps;
  }, [route, turnIdx, dense, flag]);
  const focus3d = useMemo(() => {
    if (route.length < 2) return null;
    const la = route.map((w) => w.lat), lo = route.map((w) => w.lon);
    return [[Math.min(...la), Math.min(...lo)], [Math.max(...la), Math.max(...lo)]] as [[number, number], [number, number]];
  }, [route]);
  const live = useMemo<Feature[]>(() => (walker ? [{ kind: 'walker', lat: walker[0], lon: walker[1], color: '#ff7a45' }] : []), [walker]);
  const overlays = useMemo(() => missionOverlay(core, WORLD), [core]);
  // The Jezero HiRISE photo as a close-up patch on the globe (same bounds as the elevation grid).
  const globePatch = useMemo(() => {
    const d = data?.dem;
    if (!d) return null;
    const north = d.lat0 + d.dlat / 2, west = d.lon0 - d.dlon / 2;
    return { url: './data/jezero_ortho.jpg', north, south: north - d.rows * d.dlat, west, east: west + d.cols * d.dlon };
  }, [data]);
  const globeMarks = useMemo<GlobeMark[]>(() => [
    { lat: LANDING.lat, lon: LANDING.lon, kind: 'base', label: t('基地: Jezero クレーター（Perseverance 着陸地点）', 'Base: Jezero crater (Perseverance landing site)') },
    // Other landing sites come from the gazetteer layer (with a card each).
  ], [core, lang]); // eslint-disable-line react-hooks/exhaustive-deps

  const n = route.length;
  const tools: [Mode | 'undo' | 'redo' | 'clear' | 'example' | 'easy', string, string][] = [
    ['pan', '✋', t('地図を動かす', 'Move the map')], ['route', '〰', t('ルートを引く', 'Draw the route')], ['base', '⌂', t('基地を置き直す', 'Move the base')],
    ['undo', '↶', t('戻す（⌘Z / Ctrl+Z）', 'Undo (⌘Z / Ctrl+Z)')], ['redo', '↷', t('やり直す（⌘⇧Z / Ctrl+Y）', 'Redo (⌘⇧Z / Ctrl+Y)')],
    ['clear', '🗑', t('ルートを消す', 'Clear the route')], ['example', '★', t('例のルートに戻す', 'Example route')],
    ['easy', '⤳', easy ? t('楽な道モード: オン（坂の楽な道で点をつなぐ）', 'Easy path: on (joins points along the easiest slopes)') : t('楽な道モード: オフ（まっすぐつなぐ）', 'Easy path: off (straight lines)')],
  ];

  return (
    <section ref={sectionRef} className="view walk" onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); }}
      onDrop={(e) => { const f = e.dataTransfer.files?.[0]; if (f) { e.preventDefault(); onDropFile(f); } }}>
      <aside className={`panel ${panelOpen ? 'open' : 'closed'}`} aria-label={t('計画パネル', 'Plan panel')}>
        <button className="panel-fold" onClick={() => setPanelOpen(false)} aria-label={t('パネルを畳む', 'Fold the panel')} title={t('パネルを畳んで地図を広く', 'Fold the panel to see more map')}>⟨</button>
        <h2 className="walk-title">{t('火星', 'Mars')} <small>{t('Jezero クレーター・Perseverance の着陸地点が基地', "Jezero crater · base at Perseverance's landing site")}</small></h2>
        <p className="muted">{t('基地から歩いて出て、酸素と冷却水が尽きる前に帰れるか。地図をクリックしてルートを引きます（最初の点が基地）。', 'Walk out from the base: can you get back before oxygen or cooling water runs out? Click the map to draw a route (the first point is the base).')}</p>
        {data?.errors.length ? <p className="warn">{data.errors.map((e) => ({
          dem: t('火星の地形データを読み込めませんでした（判定は「地形不明＝急な登り」として計算します）。', 'Could not load the Mars terrain (unknown ground is counted as a steep climb).'),
          traverse: t('探査車の走行記録を読み込めませんでした（実走ルートとの比較とローバーの判定は出ません）。', "Could not load Perseverance's path (no rover comparison)."),
          eva: t('船外活動の記録を読み込めませんでした（実際の船外活動との比較は出ません）。', 'Could not load the EVA records (no EVA comparison).'),
          hokkaido: t('北海道の地形データを読み込めませんでした（練習コース探しは使えません）。', 'Could not load the Hokkaido terrain (no practice courses).'),
        } as Record<string, string>)[e] ?? e).join(' ')} {t('ページを再読み込みしてください。', 'Reload the page to try again.')}</p> : null}

        <div className={`verdict ${n < 2 ? '' : ev.ok ? 'ok' : 'ng'}`}>
          {!data ? t('データを読み込み中…', 'Loading data…') : n < 2 ? t('地図をクリックしてルートを引いてください', 'Click the map to draw a route') : ev.ok ? t('帰れる', 'Can walk back') : t(`途中で引き返す（引き返し地点: WP${turnWaypoint(ev, dense)} の手前）`, `Turn back before WP${turnWaypoint(ev, dense)}`)}
        </div>
        {n >= 2 && (
          <>
            <div className="kv"><span>{t('行き / 帰り（まっすぐ）', 'Out / back (straight)')}</span><b>{ev.out_km.toFixed(1)} km / {ev.back_km.toFixed(1)} km</b></div>
            <div className="kv"><span>{t('かかる時間', 'Time')}</span><b>{fmtH(ev.total_h)}</b></div>
            {rad && <div className="kv" id="rad-dose"><span>{t('放射線（この船外活動）', 'Radiation (this EVA)')}</span><b>{rad.dose_msv.toFixed(2)} mSv <small className="muted">{t(`生涯上限の ${(rad.career_share * 100).toFixed(2)}%`, `${(rad.career_share * 100).toFixed(2)}% of career limit`)}</small></b></div>}
            {evFirm && ev.total_h - evFirm.total_h >= 1 / 60 && <div className="kv sub" id="foot-extra"><span>{t('うち足場で増えた時間', 'of which footing adds')}</span><b>+{fmtH(ev.total_h - evFirm.total_h)}</b></div>}
            <div className="kv"><span>{t('体力の消費 / 使える分', 'Effort used / usable')}</span><b>{ev.total_effort_h.toFixed(1)} / {ev.usable_h.toFixed(1)} h</b></div>
            <div className="kv"><span>{t('先に尽きるもの', 'Runs out first')}</span><b className={ev.limiting === 'water' ? 'water' : ''}>{ev.limiting === 'water' ? t('冷却水', 'Cooling water') : t('酸素', 'Oxygen')}</b></div>
            {reachImg && <div className="kv"><span>{t('歩いて帰れる範囲', 'Walk-home area')}</span><b>{reachImg.area.toFixed(0)} km²{t('（最遠 ', ' (farthest ')}{reachImg.max.toFixed(1)} km{t('）', ')')}</b></div>}
            {ev.unknown_segments > 0 && <p className="warn">{t(`地形が分からない区間 ${ev.unknown_segments} か所は、急な登り（約17°）として安全側で計算しています。`, `${ev.unknown_segments} segments without terrain data are counted as a steep climb (~17°), to stay on the safe side.`)}</p>}
          </>
        )}
        <div className="btns">
          <button className="primary" onClick={hud ? stop : play} disabled={n < 2}>{hud ? t('■ 止める', '■ Stop') : t('▶ ヘルメットで歩く', '▶ Walk it (helmet view)')}</button>
          <button onClick={startRehearsal} disabled={marsForReh.length < 3 || !data?.hokkaido.length || reh.status === 'running'}>
            {reh.status === 'running' ? t(`探しています ${reh.done}/${reh.total}`, `Searching ${reh.done}/${reh.total}`) : t('北海道で練習コースを探す', 'Find a practice course in Hokkaido')}
          </button>
        </div>

        <details open id="ev-consumables" className={fl('consumables')}>
          <summary>{t('条件', 'Settings')}</summary>
          <label>{t('歩く速さ（平地）', 'Walking speed (flat)')} <b>{+speed.toFixed(2)}</b> km/h{walkRec && Math.abs(speed - walkRec.summary.flat_kmh) < 0.01 ? (walkRec.synthetic ? t('（仮データの値）', ' (sample value)') : t('（チームの実測）', " (team's measurement)")) : ''}
            <input id="speed" type="range" min={0.5} max={5} step={0.5} value={speed} onChange={(e) => setSpeed(+e.target.value)} /></label>
          <label>{t('酸素', 'Oxygen')} <b>{o2}</b> {t('時間分', 'h')}
            <input id="o2" type="range" min={2} max={12} step={0.5} value={o2} onChange={(e) => setO2(+e.target.value)} /></label>
          <label>{t('冷却水', 'Cooling water')} <b>{water}</b> {t('時間分', 'h')}
            <input id="water" type="range" min={2} max={12} step={0.5} value={water} onChange={(e) => setWater(+e.target.value)} /></label>
          <label>{t('残しておく余裕', 'Reserve at arrival')} <b>{reserve}</b>%{t('（最低30分）', ' (at least 30 min)')}
            <input id="reserve" type="range" min={0} max={50} step={5} value={reserve} onChange={(e) => setReserve(+e.target.value)} /></label>
          <label>{t('出発時刻（火星の地方時）', 'Departure (Mars local time)')} <b>{String(Math.floor(start)).padStart(2, '0')}:{start % 1 ? '30' : '00'}</b>
            <input id="start" type="range" min={5} max={19} step={0.5} value={start} onChange={(e) => setStart(+e.target.value)} /></label>
          {wx && wx.temp_k != null && (
            <div className="kv sub" id="wx-line"><span>{t('出発時の気温・気圧（MEDA）', 'Air at departure (MEDA)')}</span><b>{(wx.temp_k - 273.15).toFixed(0)} °C · {wx.pressure_pa != null ? `${(wx.pressure_pa / 100).toFixed(2)} hPa` : '—'}</b></div>
          )}
          {wx && <div className="kv sub" id="wx-water"><span>{t('冷却水の減り方（気温による・目安）', 'Cooling water use (air temperature, estimate)')}</span><b>×{wx.f.toFixed(2)}</b></div>}
          <label className="check" id="foot-toggle"><input type="checkbox" checked={footOn} onChange={(e) => setFootOn(e.target.checked)} /> {t('足場（地面のやわらかさ）を計算に入れる', 'Count the footing (how loose the ground is)')}</label>
          {footModel && (
            <p className="muted" id="ev-footing">{t(
              `足場: Mars Odyssey THEMIS の熱慣性（100 m）と MGS TES のダスト被覆指数から、歩く時間（＝酸素・冷却水）を何倍にするかを決めています。熱慣性 ${footModel.ti_loose} 以下は細かい砂・ちり（Presley & Christensen 1997）で ×${footModel.eta_loose}（砂の上を歩くと平らな硬い地面の 1.6〜2.5 倍のエネルギー、Lejeune ほか 1998 の下限）、${footModel.ti_firm} 以上は岩・固まった地面（Putzig & Mellon 2007）で ×${footModel.eta_firm}（未舗装路の地形係数、Soule & Goldman 1972）。その間は熱慣性の対数で直線的に補間（目安）。ダスト被覆指数 ${footModel.dci_dusty} 未満のちりに覆われた所は ×${footModel.dust_extra}（目安）。岩の多さは熱慣性に含まれます（1 km より細かい岩の量の地図はないため）。`,
              `Footing: from Mars Odyssey THEMIS thermal inertia (100 m) and the MGS TES dust cover index, a factor on walking time (and so O₂ and water). Thermal inertia ≤ ${footModel.ti_loose}: fine sand and dust (Presley & Christensen 1997), ×${footModel.eta_loose} (walking on sand costs 1.6–2.5× the energy of firm ground, Lejeune et al. 1998, low end); ≥ ${footModel.ti_firm}: rock or cemented ground (Putzig & Mellon 2007), ×${footModel.eta_firm} (dirt-road terrain coefficient, Soule & Goldman 1972). In between: linear in log thermal inertia (estimate). Dust cover index < ${footModel.dci_dusty}: ×${footModel.dust_extra} (estimate). Rock abundance is part of thermal inertia (no rock map finer than 1 km exists).`)}</p>
          )}
          {wxModel && data?.weather && (
            <p className="muted" id="ev-weather">{t(
              `気温: Perseverance の MEDA が Jezero で測った気温と気圧（NASA PDS、1 火星年に散らばる ${data.weather.sols.length} sol を地方時ごとに平均、表 mars_weather）。冷却水は「体が出す熱 − 宇宙服から外へ逃げる熱」を捨てるのに使うので、寒いほど少なくて済みます。体の熱 ${wxModel.metabolic_w} W（火星船外活動の平均代謝、NASA NTRS 20110010198）、逃げる熱 ${wxModel.leak_w_per_k} W/K ×（皮膚 ${wxModel.t_skin_k} K − 気温）、基準は試験室の ${wxModel.t_ref_k} K（この3つは目安）。出発から酸素の時間分の気温の平均で冷却水の時間を補正します。気圧は表示のみ。`,
              `Air: temperature and pressure Perseverance MEDA measured at Jezero (NASA PDS; ${data.weather.sols.length} sols over one Mars year averaged by local time; table mars_weather). Cooling water carries away body heat minus what leaks out through the suit, so colder air needs less. Body heat ${wxModel.metabolic_w} W (average Mars EVA metabolic rate, NASA NTRS 20110010198), leak ${wxModel.leak_w_per_k} W/K × (skin ${wxModel.t_skin_k} K − air), reference ${wxModel.t_ref_k} K lab (these three are estimates). The water time is corrected by the mean over the oxygen time from departure. Pressure is shown only.`)}</p>
          )}
          {radModel && (
            <p className="muted" id="ev-radiation">{t(
              `放射線: Curiosity の RAD が火星の地表で測った線量当量 ${radModel.dose_eq_msv_per_day} ± ${radModel.dose_eq_sigma} mSv/日（吸収線量 ${radModel.absorbed_mgy_per_day} mGy/日、Hassler ほか 2014 Science）で、歩く時間 × この値。上限は NASA-STD-3001 の生涯 ${radModel.career_limit_msv} mSv（太陽フレア 1 回あたり ${radModel.spe_limit_msv} mSv）。この値では 1 回の船外活動で放射線が先に尽きることはありません（酸素・冷却水が先）。Gale は Jezero より約 2 km 低いので、Jezero の値は目安。太陽フレア（SPE）は数時間で桁違いに増えるので、そのときはすぐ基地へ戻る、が対策です。`,
              `Radiation: Curiosity RAD measured ${radModel.dose_eq_msv_per_day} ± ${radModel.dose_eq_sigma} mSv/day dose equivalent on the surface (${radModel.absorbed_mgy_per_day} mGy/day absorbed; Hassler et al. 2014, Science); walking time × this rate. Limits from NASA-STD-3001: ${radModel.career_limit_msv} mSv per career (${radModel.spe_limit_msv} mSv per solar particle event). At this rate radiation never runs out first on one EVA (O₂ or water does). Gale is ~2 km lower than Jezero, so the value is an estimate there. A solar particle event can raise it by orders of magnitude for hours: the answer is to head back at once.`)}</p>
          )}
          <p className="muted">{t('急いで歩くと冷却水は酸素の約1.15倍の速さで減ります（NASA の歩行帰還試験、Gernhardt 2010）。帰着時に30分・2割を残すのは Apollo 以来の慣例です。', 'Walking hard uses cooling water about 1.15× as fast as oxygen (NASA walkback tests, Gernhardt 2010). Arriving with 30 min / 20% left is Apollo-era practice.')}</p>
        </details>

        <WalkImportCard rec={walkRec} error={walkErr} busy={walkBusy} onFile={onDropFile}
          onSample={() => { loadSample().catch(() => undefined); }} onClear={clearWalk} />
        <div id="ev-rover" className={fl('rover')}><RoverCard check={check} /></div>
        <div className={`card rover-walkback ${roverMode ? 'on' : ''}`} id="rover-walkback">
          <h4>{t('有人ローバーが壊れたら、歩いて帰れるか', 'If a crewed rover breaks down, can the crew walk back?')}</h4>
          <p className="muted">{t('Perseverance の実走ルートを人が乗ったローバーで走ったと仮定。着陸地点が基地。どこで壊れたら歩いて帰れなくなるか（上の条件と同じ酸素・冷却水）。', "Suppose a crew drove Perseverance's real path, with the landing site as the base. Where would a breakdown leave them unable to walk home (same oxygen and cooling water as above)?")}</p>
          <button onClick={() => setRoverMode(!roverMode)} disabled={!data?.rover}>{roverMode ? t('探査車の道を元に戻す', 'Show the plain rover path') : t('探査車の道を色分けする', 'Colour the rover path')}</button>
          {roverMode && rwState === 'loading' && !rw && <p className="muted">{t('探査車の走行記録をデータベース（DuckDB）から読み込み中…', 'Loading the rover record from the database (DuckDB)…')}</p>}
          {roverMode && rwState === 'error' && <p className="warn">{t('走行記録のデータベースを読み込めませんでした。Web 版はネットから読み込むので、接続を確かめてもう一度押してください。', 'Could not load the rover database. The web version downloads it; check the connection and press again.')}</p>}
          {rw && (
            <>
              <div className="big-line"><b>{Math.round(rw.ok_share * 100)}%</b><span>{t(`の区間から歩いて帰れる（地形データのある走行 ${rw.inside_km.toFixed(1)} km のうち）`, `of the path lets the crew walk home (of ${rw.inside_km.toFixed(1)} km driven with terrain data)`)}</span></div>
              <div className="kv"><span>🚩 {t('最初に帰れなくなる点', 'First point with no walk home')}</span><b className={flag ? 'ng' : ''}>{flag ? t(`走行 ${flag.km.toFixed(1)} km・sol ${flag.sol}`, `${flag.km.toFixed(1)} km driven · sol ${flag.sol}`) : t('なし（全区間から帰れる）', 'None (walk home from anywhere)')}</b></div>
              <p className="muted">{t('道の色: 緑 帰れる / 黄 ぎりぎり（使える分の85%超） / 赤 帰れない / 灰 地形データの外。Apollo の月面車も「壊れても歩いて帰れる距離」までしか離れませんでした（walkback 制約）。出典: Mars 2020 走行記録（NASA/JPL）、地形 HiRISE・MOLA。判定はこのアプリの計算です。', 'Path colours: green can walk home / yellow tight (over 85% of what is usable) / red cannot / grey outside the terrain data. Apollo rovers never drove farther than the crew could walk back (the walkback constraint). Sources: Mars 2020 traverse (NASA/JPL), HiRISE and MOLA terrain; the verdict is this app\'s calculation.')}</p>
            </>
          )}
        </div>
        <div id="ev-eva" className={fl('eva')}><EvaCard eva={data?.eva ?? null} planH={ev.total_h} longer={longer} /></div>

        <details>
          <summary>{t('地図の表示', 'Map layers')}</summary>
          <label className="check"><input type="checkbox" checked={showReach} onChange={(e) => setShowReach(e.target.checked)} /> {t('歩いて帰れる範囲', 'Walk-home area')}</label>
          <label className="check"><input type="checkbox" checked={showRover} onChange={(e) => setShowRover(e.target.checked)} /> {t('探査車の実走ルート', "Perseverance's real path")}</label>
          <label className="check"><input type="checkbox" id="show-foot" checked={showFoot} onChange={(e) => setShowFoot(e.target.checked)} /> {t('足場の悪さ（熱慣性・ダスト）', 'Poor footing (thermal inertia, dust)')}</label>
          {showFoot && <div className="foot-legend"><i /><span>{t('かたい地面', 'firm')}</span><span>{t('やわらかい砂・ちり（遅く・消費が増える）', 'loose sand / dust (slower, uses more)')}</span></div>}
          <p className="muted">{t('ルートの色: 緑 8°未満 / 黄 8〜15° / 赤 15°以上 / 灰 地形不明。帰れる範囲の黄色い縁が限界の線です。', 'Route colours: green under 8° / yellow 8–15° / red over 15° / grey unknown. The yellow edge of the walk-home area is the limit.')}</p>
        </details>
        <p id="ev-terrain" className={`muted src ${fl('terrain') ?? ''} ${fl('hokkaido_terrain') ?? ''}`}>{t('データ: Mars 2020 Perseverance 走行記録（NASA/JPL MMGIS）、MRO HiRISE 画像と地形（NASA/UArizona, USGS）、MGS MOLA 地形、Mars Odyssey THEMIS、MRO CTX、data.nasa.gov 船外活動記録、NASADEM（北海道の地形、NASA/JPL）。北海道の航空写真は国土地理院（表示のみ）。', 'Data: Mars 2020 Perseverance traverse (NASA/JPL MMGIS), MRO HiRISE images and terrain (NASA/UArizona, USGS), MGS MOLA, Mars Odyssey THEMIS, MRO CTX, data.nasa.gov EVA records, NASADEM (Hokkaido terrain, NASA/JPL). Hokkaido aerial photos: GSI Japan (display only).')}{data?.dem?.src ? ` ${t('地形グリッド', 'Terrain grid')}: ${data.dem.src}` : ''}</p>
      </aside>

      {!panelOpen && (
        <button className={`panel-chip ${n < 2 ? '' : ev.ok ? 'ok' : 'ng'}`} onClick={() => setPanelOpen(true)} aria-label={t('パネルを開く', 'Open the panel')}>
          <span>☰</span><b>{!data ? t('読み込み中…', 'Loading…') : n < 2 ? t('ルートを引く', 'Draw a route') : ev.ok ? t('帰れる', 'Can walk back') : t('引き返す', 'Turn back')}</b>
          {n >= 2 && <small>{ev.out_km.toFixed(1)} km · {fmtH(ev.total_h)}</small>}
        </button>
      )}
      <div className={`maps ${walkRec || (rehOpen && reh.found.length) ? '' : 'single'} ${panelOpen ? 'panel-open' : ''}`}>
        <div className="mapwrap" ref={setMapHost}
          // Zooming out further at the smallest zoom (Leaflet greys out its − button there) goes back up to the globe.
          onWheel={(e) => { if (e.deltaY > 0 && !globeOn && e.currentTarget.querySelector('.leaflet-control-zoom-out.leaflet-disabled')) { setGlobeStart(route[0] ?? LANDING); setGlobeFromMap(true); setGlobeOn(true); } }}
          onClickCapture={(e) => { if (!globeOn && (e.target as HTMLElement).closest('.leaflet-control-zoom-out.leaflet-disabled')) { setGlobeStart(route[0] ?? LANDING); setGlobeFromMap(true); setGlobeOn(true); } }}>
          <PlanetMap core={core} world={WORLD} view={view} fly={fly} baseKey="viking" overlayKeys={HIRISE} collapsedLayers
            overlays={overlays} features={features} live={live} crosshair={mode !== 'pan'}
            onClick={(lat, lon) => mode !== 'pan' && !hud && addPoint(lat, lon)}>
            <div className="leaflet-bar draw-toolbar">
              {tools.map(([m, icon, title]) => (
                <a key={m} href="#" title={title} aria-label={title} data-m={m} className={`${m === mode || (m === 'easy' && easy) ? 'on' : ''}${(m === 'undo' && !hist.current.past.length) || (m === 'redo' && !hist.current.future.length) ? ' off' : ''}`} onClick={(e) => {
                  e.preventDefault(); e.stopPropagation();
                  if (m === 'undo') undo();
                  else if (m === 'redo') redo();
                  else if (m === 'clear') setRoute((r) => r.slice(0, 1));
                  else if (m === 'example') { if (data) setRoute(exampleRoute(data.traverseRaw)); }
                  else if (m === 'easy') { setEasy((x) => !x); setMode('route'); }
                  else setMode(m);
                }}>{icon}</a>
              ))}
            </div>
          </PlanetMap>
          {view3d && data?.demGrid && (
            <div className="terrain-over">
              <Terrain3D grid={data.demGrid} radiusKm={core.world(WORLD).radius_km} palette="mars" lines={lines3d} points={points3d}
                reach={showReach ? reachRaw : null} walker={walker} focus={focus3d} label={t('Jezero クレーター（3D）', 'Jezero crater (3D)')}
                camera={camera} exaggeration={exag} photo="./data/jezero_ortho.jpg" />
            </div>
          )}
          {globeOn && (
            <div className="terrain-over globe-over">
              <Globe marks={globeMarks} lines={data?.traverse ?? []} focus={LANDING} camera={globeCam} patch={globePatch} startClose={globeFromMap ? globeStart : null}
                onEnter={(lat, lon) => {
                  // Inside the Jezero grid: the Jezero map at street level; elsewhere the global 2D map there.
                  const d = data?.dem;
                  const inJezero = !!d && lat <= d.lat0 && lat >= d.lat0 - d.rows * d.dlat && lon >= d.lon0 && lon <= d.lon0 + d.cols * d.dlon;
                  setGlobeOn(false); setView3d(false);
                  setFly({ lat, lon, z: inJezero ? 13 : 7, seq: Date.now() });
                }} />
            </div>
          )}
          {data?.demGrid && (
            <div className="view-toggle" role="group" aria-label={t('地図の表示', 'Map view')}>
              <button className={globeOn ? 'on' : ''} onClick={() => { setGlobeStart(route[0] ?? LANDING); setGlobeFromMap(true); setGlobeOn(true); }} title={t('火星全体を回して見る', 'Turn the whole planet')}>🌐 {t('全球', 'Globe')}</button>
              <button className={!globeOn && !view3d ? 'on' : ''} onClick={() => { setGlobeOn(false); setView3d(false); }}>2D</button>
              <button className={!globeOn && view3d ? 'on' : ''} onClick={() => { setGlobeOn(false); setView3d(true); }}>3D</button>
            </div>
          )}
          {hud && <Hud s={hud} limiting={ev.limiting} onStop={stop} rad={(h) => { try { return core.radiationExposure(h); } catch { return null; } }} />}
          {!hud && <Guide />}
          <RouteEditor host={mapHost} route={route} drawing={mode === 'route' && !hud && !globeOn} onChange={setRoute}
            preview={routePreview} connect={easy ? (a, b) => easyLeg(core, data, a, b, p) : undefined} onFinish={() => setMode('pan')} t={t} />
          {!globeOn && !view3d && !hud && (hist.current.past.length > 0 || hist.current.future.length > 0) && (
            <div className="undo-bar" role="group" aria-label={t('元に戻す', 'Undo')}>
              <button onClick={undo} disabled={!hist.current.past.length} title={t('戻す（⌘Z / Ctrl+Z）', 'Undo (⌘Z / Ctrl+Z)')}>↶ {t('戻す', 'Undo')} <kbd>⌘Z</kbd></button>
              <button onClick={redo} disabled={!hist.current.future.length} title={t('やり直す（⌘⇧Z / Ctrl+Y）', 'Redo (⌘⇧Z / Ctrl+Y)')}>↷ {t('やり直す', 'Redo')}</button>
            </div>
          )}
          {!globeOn && !view3d && !walkRec && !(rehOpen && reh.found.length > 0) && (
            <div className="draw-hint" aria-live="polite">{mode === 'route'
              ? (easy ? t('⤳ 楽な道モード（坂の楽な道でつなぐ）・', '⤳ Easy path (follows the easiest slopes) · ') : '') + t('クリックで点を追加・点に乗せると距離と O₂・ドラッグで移動・線の中の小さな点で挿入・右クリックで削除・Backspace で最後の点を消す・Esc か Enter で終わる', 'Click to add · hover a point for distance and O₂ · drag to move · drag a middle dot to insert · right-click to delete · Backspace removes the last point · Esc or Enter to finish')
              : mode === 'base' ? t('クリックした所に基地を置き直す', 'Click to move the base')
              : t('〰 を押すとルートを引けます（点はドラッグで動かせます）', 'Press 〰 to draw a route (points can be dragged)')}</div>
          )}
        </div>
        {walkRec && <EarthWalkPanel core={core} rec={walkRec} walker={earthWalker} />}
        {!walkRec && rehOpen && reh.found.length > 0 && (
          <RehearsalPanel core={core} mars={marsForReh} found={reh.found} selected={Math.min(rehSel, reh.found.length - 1)} onSelect={setRehSel}
            params={p} onImportFile={onDropFile} />
        )}
        {rehOpen && reh.status === 'done' && reh.found.length === 0 && (
          <p className="warn floating">{t('北海道の候補地の範囲（約21km四方）に収まるコースが見つかりませんでした。ルートを短くして（★で例のルートに戻すのが早いです）、もう一度探してください。', 'No Hokkaido practice course fits (each area is about 21 km across). Shorten the route (★ restores the example) and search again.')}</p>
        )}
      </div>
    </section>
  );
}
