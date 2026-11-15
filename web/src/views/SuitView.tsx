// Astronaut view (#suit): one glanceable helmet screen for the walk home.
// Shows only what NASA's EVA display work asks for on the way back (SUITS: path back to the
// airlock; Joint AR: direct return to the lander with a time estimate, distances): which way and
// how far the base is, how much margin is left, and how far to the turn-back point.
// It reads the route and settings drawn on the WALKBACK screen (same plan, same Rust numbers).
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Core, Waypoint } from '../core';
import { exampleRoute, loadWalkData, type WalkData } from '../walk/data';
import { peekWalkController } from '../walk/controller';
import { DEFAULT_PARAMS, denseRoute, evaParams, evaluate, turnIndex, type PlanParams } from '../walk/plan';
import { fmtH } from '../walk/geo';
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

  // Where the astronaut is: a position along the way out (slider or ▶ walk).
  const [pos, setPos] = useState(0);
  const [walking, setWalking] = useState(false);
  const raf = useRef(0);
  useEffect(() => { setPos(0); setWalking(false); }, [route, params]);
  useEffect(() => {
    if (!walking) return;
    const t0 = performance.now(), from = pos, span = Math.max(1, last - from), ms = 14000 * (span / Math.max(1, last));
    const frame = (now: number) => {
      const f = Math.min(1, (now - t0) / ms);
      setPos(from + span * f);
      if (f < 1) raf.current = requestAnimationFrame(frame); else setWalking(false);
    };
    raf.current = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf.current);
  }, [walking]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!data) return <div className="suit"><p className="suit-empty">{t('NASA データを読み込み中…', 'Loading NASA data…')}</p></div>;
  if (!ev || route.length < 2) {
    return (
      <div className="suit">
        <div className="suit-empty">
          <p>{t('まだルートがありません。', 'No route yet.')}</p>
          <p className="muted">{t('「火星で歩いて帰る」でルートを引くと、ここに帰り道ナビが出ます。', 'Draw a route on “Walk back on Mars” and the way-home navigator shows here.')}</p>
          <div className="suit-actions">
            <a className="btn" href="#walk">{t('ルートを引く', 'Draw a route')}</a>
            <button onClick={() => peekWalkController()?.setRoute(exampleRoute(data.traverseRaw))}>{t('サンプルのルートで見る', 'Use the sample route')}</button>
          </div>
        </div>
      </div>
    );
  }

  const i = Math.max(0, Math.min(last, Math.floor(pos)));
  const j = Math.min(last, i + 1), u = Math.min(1, pos - i);
  const lerp = (x: number, y: number) => x + (y - x) * u;
  const a = ev.ticks[i], b = ev.ticks[j] ?? a;
  const here: Waypoint = { lat: lerp(dense.pts[i].lat, dense.pts[j].lat), lon: lerp(dense.pts[i].lon, dense.pts[j].lon) };
  const km = lerp(a.km, b.km), margin = lerp(a.margin_h, b.margin_h), home = lerp(a.home_h, b.home_h);
  const o2 = lerp(a.o2_left, b.o2_left), water = lerp(a.water_left, b.water_left);
  const base = dense.pts[0];
  const toBase = vec(here, base);
  // Heading = direction of travel on this leg; the arrow shows the base relative to it.
  const ahead = vec(dense.pts[Math.min(last - 1, i)], dense.pts[Math.min(last, i + 1)]);
  const rel = ((toBase.deg - ahead.deg) % 360 + 540) % 360 - 180;
  const turnKm = turn != null ? ev.ticks[turn]?.km ?? null : null;
  const toTurnKm = turnKm != null ? turnKm - km : null;
  const past = turn != null && pos >= turn;
  const state: 'ok' | 'soon' | 'now' = past || margin <= 0 ? 'now' : margin < 0.75 ? 'soon' : 'ok';
  const msg = state === 'now' ? t('今すぐ基地へ戻る', 'Head back to base now')
    : state === 'soon' ? t('まもなく引き返し', 'Turn back soon')
    : t('帰れる', 'You can get home');

  // Mini-map (north up), fitted to the route.
  const W = 260, H = 200, pad = 14;
  const lats = dense.pts.map((q) => q.lat), lons = dense.pts.map((q) => q.lon);
  const [la0, la1, lo0, lo1] = [Math.min(...lats), Math.max(...lats), Math.min(...lons), Math.max(...lons)];
  const cos = Math.cos((base.lat * Math.PI) / 180);
  const sx = (W - 2 * pad) / Math.max(1e-9, (lo1 - lo0) * cos), sy = (H - 2 * pad) / Math.max(1e-9, la1 - la0), s = Math.min(sx, sy);
  const X = (q: Waypoint) => pad + (q.lon - lo0) * cos * s + ((W - 2 * pad) - (lo1 - lo0) * cos * s) / 2;
  const Y = (q: Waypoint) => H - pad - (q.lat - la0) * s - ((H - 2 * pad) - (la1 - la0) * s) / 2;
  const line = (pts: Waypoint[]) => pts.map((q) => `${X(q).toFixed(1)},${Y(q).toFixed(1)}`).join(' ');

  return (
    <div className={`suit suit-${state}`}>
      <div className="suit-visor" role="status" aria-live="polite">
        <div className="suit-msg">{msg}</div>

        <div className="suit-main">
          <div className="suit-compass" aria-label={t(`基地は ${Math.round(rel)}° の方向`, `Base at ${Math.round(rel)}°`)}>
            <svg viewBox="-60 -60 120 120" width="180" height="180" aria-hidden="true">
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
              <b>{toTurnKm == null ? t('このルートは最後まで帰れる', 'Whole route walkable') : past ? t('越えた', 'crossed') : fmtKm(toTurnKm * 1000)}</b>
            </div>
            <div className="suit-bars">
              <Bar label="O₂" v={o2} warn={ev.limiting === 'o2' && o2 < 0.35} />
              <Bar label={t('冷却水', 'Water')} v={water} warn={ev.limiting === 'water' && water < 0.35} />
            </div>
          </div>

          <svg className="suit-map" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={t('ミニマップ', 'Mini-map')}>
            <polyline points={line(dense.pts.slice(0, outEnd + 1))} className="route" />
            {turn != null && <polyline points={line(dense.pts.slice(turn))} className="route beyond" />}
            <line x1={X(here)} y1={Y(here)} x2={X(base)} y2={Y(base)} className="home" />
            <rect x={X(base) - 5} y={Y(base) - 5} width="10" height="10" className="base" />
            {turn != null && <circle cx={X(dense.pts[turn])} cy={Y(dense.pts[turn])} r="5" className="turn" />}
            <circle cx={X(here)} cy={Y(here)} r="6" className="me" />
            <text x={W - 6} y={14} textAnchor="end" className="north">N↑</text>
          </svg>
        </div>

        <div className="suit-foot">
          <span>{t(`歩いた距離 ${km.toFixed(2)} km`, `Walked ${km.toFixed(2)} km`)}</span>
          <span className="legend"><i className="lg-base" />{t('基地', 'Base')} <i className="lg-turn" />{t('引き返し地点', 'Turn-back')} <i className="lg-me" />{t('いま', 'You')}</span>
        </div>
      </div>

      <div className="suit-controls">
        <button onClick={() => (walking ? setWalking(false) : (pos >= last && setPos(0), setWalking(true)))}>
          {walking ? t('■ 止める', '■ Stop') : t('▶ 歩いてみる', '▶ Walk')}
        </button>
        <label>
          {t('いまの位置', 'Position')}
          <input type="range" min={0} max={last} step={0.1} value={pos} onChange={(e) => { setWalking(false); setPos(+e.target.value); }} />
        </label>
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
