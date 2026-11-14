// Evidence cards: how the plan compares with Perseverance's real drives and with real EVAs.
import type { EvaStats, RouteCheck } from '../core';

export function RoverCard({ check }: { check: RouteCheck | null }) {
  if (!check) return null;
  const r = check.rover;
  const steepOk = check.route_max_slope <= r.slope_max;
  return (
    <div className="card">
      <h4>探査車の実走ルートと照らす</h4>
      <div className="big-line"><b>{Math.round(check.near_share * 100)}%</b><span>のルートが、Perseverance が実際に走った道から {check.near_m}m 以内</span></div>
      <div className="kv"><span>このルートの最大の坂</span><b className={steepOk ? '' : 'ng'}>{check.route_max_slope.toFixed(1)}°</b></div>
      <div className="kv"><span>探査車が走った坂（9割 / 最大）</span><b>{r.slope_p90.toFixed(1)}° / {r.slope_max.toFixed(1)}°</b></div>
      <div className="kv"><span>坂が探査車の9割以内の区間</span><b>{Math.round(check.within_rover_share * 100)}%</b></div>
      <p className="muted">探査車の記録: 着陸から {r.last_sol} 火星日、{r.km.toFixed(1)} km。坂は {r.window_m}m ごとの高低差から計算。</p>
    </div>
  );
}

export function EvaCard({ eva, planH, longer }: { eva: EvaStats | null; planH: number; longer: number }) {
  if (!eva || eva.count === 0) return null;
  const max = Math.max(10, Math.ceil(eva.max_h), Math.ceil(planH));
  const bins = Array.from({ length: max }, (_, i) => eva.hours.filter((h) => h >= i && h < i + 1).length);
  const top = Math.max(...bins);
  const W = 260, H = 70, bw = W / max;
  return (
    <div className="card">
      <h4>実際の船外活動と比べる</h4>
      <div className="big-line"><b>{Math.round(longer * 100)}%</b><span>過去の船外活動 {eva.count} 回のうち、この計画（{planH.toFixed(1)} 時間）より長かった割合</span></div>
      <svg viewBox={`0 0 ${W} ${H + 16}`} className="hist" role="img" aria-label="船外活動の時間の分布">
        {bins.map((n, i) => (
          <rect key={i} x={i * bw + 1} y={H - (n / top) * H} width={bw - 2} height={(n / top) * H} className="hist-bar" />
        ))}
        <line x1={(planH / max) * W} x2={(planH / max) * W} y1={0} y2={H} className="hist-plan" />
        {[0, 2, 4, 6, 8, 10].filter((h) => h <= max).map((h) => (
          <text key={h} x={(h / max) * W} y={H + 12} className="hist-label">{h}h</text>
        ))}
      </svg>
      <div className="kv"><span>中央値 / 最長</span><b>{eva.median_h.toFixed(1)} h / {eva.max_h.toFixed(1)} h</b></div>
      <div className="kv"><span>Apollo の月面活動</span><b>{eva.apollo_hours.length} 回、最長 {(eva.apollo_hours.at(-1) ?? 0).toFixed(1)} h</b></div>
      <p className="muted">出典: data.nasa.gov「Extra-vehicular Activity (EVA) - US and Russia」。多くは宇宙ステーションでの活動。</p>
    </div>
  );
}
