// Helmet-style overlay shown over the map while a walk is played back.
import { fmtH } from './geo';

export interface HudState {
  t_h: number; km: number; o2: number; water: number; home_h: number; margin_h: number;
  phase: 'out' | 'turn' | 'back' | 'done';
  slope: number | null;
}

const Gauge = ({ label, v, warn }: { label: string; v: number; warn: boolean }) => (
  <div className={`hud-gauge${warn ? ' warn' : ''}`}>
    <span>{label}</span>
    <div className="hud-track"><div style={{ width: `${Math.max(0, Math.min(1, v)) * 100}%` }} /></div>
    <b>{Math.round(Math.max(0, v) * 100)}%</b>
  </div>
);

export function Hud({ s, limiting, onStop }: { s: HudState; limiting: 'o2' | 'water'; onStop: () => void }) {
  const msg =
    s.phase === 'turn' ? '引き返し地点。今すぐ基地へ戻る' :
    s.phase === 'back' ? '帰還中' :
    s.phase === 'done' ? '基地に帰着' :
    s.margin_h < 0.5 ? 'まもなく引き返し地点' : '';
  return (
    <div className={`hud phase-${s.phase}`} role="status" aria-live="polite">
      <div className="hud-visor" />
      <div className="hud-top">
        <div><span>経過</span><b>{fmtH(s.t_h)}</b></div>
        <div><span>歩いた距離</span><b>{s.km.toFixed(2)} km</b></div>
        <div><span>帰りに要る時間</span><b>{fmtH(s.home_h)}</b></div>
        <div><span>足元の坂</span><b>{s.slope == null ? '—' : `${s.slope.toFixed(0)}°`}</b></div>
      </div>
      <div className="hud-left">
        <Gauge label="O₂" v={s.o2} warn={limiting === 'o2' && s.o2 < 0.35} />
        <Gauge label="冷却水" v={s.water} warn={limiting === 'water' && s.water < 0.35} />
      </div>
      {msg && <div className={`hud-msg${s.phase === 'turn' || s.margin_h < 0.5 ? ' alert' : ''}`}>{msg}</div>}
      <button className="hud-stop" onClick={onStop}>■ 止める</button>
    </div>
  );
}
