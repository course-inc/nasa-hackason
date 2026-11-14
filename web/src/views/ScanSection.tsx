// #10 tier 2: the whole of Hokkaido cut into 1 km cells, every cell scored in Rust/WASM with the
// same formulas as the 14 known sites. Returns the side-panel content plus the map features
// (heat map + best candidates) for TargetView to place.
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Core, Gap, Scan } from '../core';
import type { Feature } from '../map/PlanetMap';
import { heatImage, percentiles } from '../scanHeat';

type Lang = 'en' | 'ja';

const T = {
  en: {
    loading: 'Loading the 1 km grid…', failed: 'Could not load the scan data',
    headline: (n: number, km: number) => `${n.toLocaleString()} land cells of ${km} km, all scored`,
    legend: ['poorest', 'best in Hokkaido'],
    top: 'Best places found by the scan', topNote: 'At least 15 km apart. Click one, or click anywhere on the map.',
    near: (s: string, km: number) => `≈ ${s} (${km} km)`, newSpot: 'new candidate',
    check: 'Check against the 14 known sites',
    checkLine: (a: number, n: number) => `${a} of ${n} known sites fall in the top 10% of all Hokkaido cells`,
    rank: (r: number, n: number) => `#${r.toLocaleString()} / ${n.toLocaleString()}`,
    top10: 'top', outside: 'outside grid',
    cell: 'Selected cell', elev: 'Elevation', relief: 'Relief', slope: 'Mean slope', p90: '90% slope',
    shadow: 'Winter noon shadow', temp: 'Air temperature', jan: 'Jan night', aug: 'Aug day', precip: 'Precipitation',
    ndvi: 'Summer NDVI (MODIS)', cover: 'Built-up / cropland / forest / barren (MODIS)',
    excluded: { forest: 'Screened out: mostly forest — no room to land, walk or build', water: 'Screened out: mostly water', other: 'Screened out: mostly built-up land or cropland' },
    siteScreened: { forest: 'cell mostly forest', water: 'cell mostly water', other: 'cell built-up / farm' },
    checkNote: 'Small domes and craters are smaller than a 1 km cell, so the cell can be mostly forest; the 500 m grid will resolve them.',
    note: 'Rock type is not in the grid yet, so geology is left out of this score. Air temperature is NASA POWER corrected for height; vegetation and land cover are NASA MODIS.',
    gaps: 'What Hokkaido cannot reproduce here', match: 'Match',
  },
  ja: {
    loading: '1km マスを読み込み中…', failed: 'スキャンのデータを読み込めませんでした',
    headline: (n: number, km: number) => `陸の ${km} km マス ${n.toLocaleString()} 個を全部採点`,
    legend: ['遠い', '北海道で一番近い'],
    top: 'スキャンで見つかった上位の場所', topNote: '互いに 15 km 以上離れた場所。押すか、地図のどこかを押してください。',
    near: (s: string, km: number) => `≈ ${s}（${km} km）`, newSpot: '新しい候補',
    check: '人が選んだ14地点で答え合わせ',
    checkLine: (a: number, n: number) => `14地点のうち ${a}/${n} か所が、北海道全体の上位10%に入った`,
    rank: (r: number, n: number) => `${r.toLocaleString()} 位 / ${n.toLocaleString()}`,
    top10: '上位', outside: '範囲外',
    cell: '選んだマス', elev: '標高', relief: '起伏', slope: '平均傾斜', p90: '傾斜（90%）',
    shadow: '冬の正午に影になる割合', temp: '気温', jan: '1月の夜', aug: '8月の昼', precip: '年降水量',
    ndvi: '夏の植生指数 NDVI（MODIS）', cover: '市街地 / 農地 / 森林 / 裸地（MODIS）',
    excluded: { forest: '除外：大部分が森林で、着陸・歩行・建設の練習ができない', water: '除外：大部分が水面', other: '除外：大部分が市街地か農地' },
    siteScreened: { forest: 'マスの大部分が森林', water: 'マスの大部分が水面', other: 'マスが市街地・農地' },
    checkNote: '小さな溶岩ドームや火口は 1 km マスより小さく、マスとしては森が大部分になる。500 m マスで見分けられるようにする。',
    note: '岩石の種類はまだマスに入っていないので、地質はこの点数から外しています。気温は NASA POWER を標高で補正した値、植生と土地被覆は NASA MODIS。',
    gaps: 'このマスで再現できないこと', match: '一致度',
  },
} as const;

/** Which screen excluded a cell, from the core's reason text (see scan::screen_reason). */
function screenKind(reason: string): 'forest' | 'water' | 'other' {
  return reason.includes('森林') ? 'forest' : reason.includes('Water Bodies') ? 'water' : 'other';
}

export function useScanSection({ core, enabled, bodyId, testId, lang, siteName, onFly }: {
  core: Core; enabled: boolean; bodyId: string; testId: string; lang: Lang;
  siteName: (id: string) => string; onFly: (lat: number, lon: number, z: number) => void;
}) {
  const [scan, setScan] = useState<Scan | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The selected cell belongs to one target/test pair, so switching pairs falls back to the best
  // cell, while focusAt() can pick the pair and the point together (view_scan tool).
  const pair = `${bodyId}/${testId}`;
  const [sel, setSel] = useState<{ pair: string; k?: number; at?: [number, number] } | null>(null);
  const setCellK = (kk: number) => setSel({ pair, k: kk });
  const focusAt = useCallback((lat: number, lon: number, body: string, test: string) => setSel({ pair: `${body}/${test}`, at: [lat, lon] }), []);
  const t = T[lang];

  useEffect(() => {
    if (!enabled || scan) return;
    core.loadScan(1).then(setScan, (e) => setError(String(e)));
  }, [core, enabled, scan]);

  const scores = useMemo(() => (scan && enabled ? scan.scores(bodyId, testId) : null), [scan, enabled, bodyId, testId]);
  const pct = useMemo(() => (scores ? percentiles(scores) : null), [scores]);
  const heat = useMemo(() => (scan && pct ? heatImage(scan.meta, scan.cells, pct) : null), [scan, pct]);
  const result = useMemo(() => (scan && scores ? scan.top(scores, 10, 15) : null), [scan, scores]);
  const selK = sel && sel.pair === pair ? sel.k ?? (sel.at && scan ? scan.cellAt(sel.at[0], sel.at[1]) : null) : null;
  const k = selK ?? result?.top[0]?.k ?? null;
  const cell = useMemo(() => (scan && k !== null ? scan.cell(k, bodyId, testId) : null), [scan, k, bodyId, testId]);
  const gaps = useMemo<Gap[]>(() => (scan && k !== null ? scan.gaps(k, bodyId, testId) : []), [scan, k, bodyId, testId]);

  const features = useMemo<Feature[]>(() => {
    if (!enabled || !heat || !result) return [];
    const f: Feature[] = [{ kind: 'image', url: heat.url, bounds: heat.bounds, opacity: 0.75 }];
    result.top.forEach((c, i) => f.push({
      kind: 'point', lat: c.lat, lon: c.lon, radius: c.k === k ? 10 : 7, color: c.k === k ? '#ffffff' : '#ff7a45',
      tooltip: `#${i + 1} · ${Math.round(c.score * 100)}`, openTooltip: c.k === k,
      onClick: () => { setCellK(c.k); onFly(c.lat, c.lon, 11); },
    }));
    if (cell && !result.top.some((c) => c.k === k)) {
      f.push({ kind: 'pin', lat: cell.lat, lon: cell.lon, tooltip: `${Math.round(cell.score.total * 100)}` });
    }
    return f;
  }, [enabled, heat, result, k, cell, onFly]);

  const onMapClick = (lat: number, lon: number) => {
    if (!scan) return;
    const kk = scan.cellAt(lat, lon);
    if (kk !== null) setCellK(kk);
  };

  if (!enabled) return { panel: null, features, onMapClick: undefined, focusAt };
  if (error) return { panel: <p className="warn">{t.failed}: {error}</p>, features, onMapClick, focusAt };
  if (!scan || !result || !scores) return { panel: <p className="muted">{t.loading}</p>, features, onMapClick, focusAt };

  const n = scan.meta.n;
  const known = result.sites.filter((s) => s.earth_id !== 'sapporo');
  const inTop = known.filter((s) => !s.excluded && (s.percentile ?? 0) >= 0.9).length;
  const fmt1 = (v: number) => (Math.round(v * 10) / 10).toString();

  const panel = (
    <div id="scan">
      <p className="scan-head">{t.headline(n, scan.meta.cell_km)}</p>
      <div className="legend"><span>{t.legend[0]}</span><i /><span>{t.legend[1]}</span></div>

      <h3 className="sub">{t.top}</h3>
      <p className="muted">{t.topNote}</p>
      <ol id="scan-top">
        {result.top.map((c, i) => (
          <li key={c.k} className={c.k === k ? 'active' : ''} onClick={() => { setCellK(c.k); onFly(c.lat, c.lon, 11); }}>
            <span className="rank">{i + 1}</span>
            <span className="name">{c.lat.toFixed(3)}°N {c.lon.toFixed(3)}°E · {Math.round(c.elev_m)} m · {fmt1(c.slope_deg)}°
              <small>{c.near ? t.near(siteName(c.near[0]), c.near[1]) : <b className="new">{t.newSpot}</b>}</small>
            </span>
            <b className="score">{Math.round(c.score * 100)}</b>
          </li>
        ))}
      </ol>

      {cell && (
        <div className="card" id="scan-cell">
          <h4>{t.cell}: {cell.lat.toFixed(3)}°N {cell.lon.toFixed(3)}°E</h4>
          <div className="total">{t.match} <b>{Math.round(cell.score.total * 100)}</b><small>/100</small></div>
          <div className="kv"><span>{t.elev}</span><b>{Math.round(cell.elev_m)} m</b></div>
          <div className="kv"><span>{t.relief}</span><b>{Math.round(cell.relief_m)} m</b></div>
          <div className="kv"><span>{t.slope} / {t.p90}</span><b>{fmt1(cell.slope_deg)}° / {fmt1(cell.slope_p90_deg)}°</b></div>
          <div className="kv"><span>{t.shadow}</span><b>{Math.round(cell.shadow * 100)}%</b></div>
          {cell.ndvi !== null && <div className="kv"><span>{t.ndvi}</span><b>{cell.ndvi.toFixed(2)}</b></div>}
          {cell.urban !== null && <div className="kv"><span>{t.cover}</span><b>{[cell.urban, cell.crop, cell.forest, cell.barren].map((x) => `${Math.round((x ?? 0) * 100)}%`).join(' / ')}</b></div>}
          {cell.score.excluded && <p className="warn">⛔ {t.excluded[screenKind(cell.score.excluded)]}</p>}
          {cell.climate && (
            <>
              <div className="kv"><span>{t.temp} ({t.jan} / {t.aug})</span><b>{fmt1(cell.climate.tmin[0])} / {fmt1(cell.climate.tmax[7])} °C</b></div>
              <div className="kv"><span>{t.precip}</span><b>{Math.round(cell.climate.precip)} mm</b></div>
            </>
          )}
          {cell.score.dims.filter((d) => d.key !== 'geology').map((d) => (
            <div key={d.key}>
              <div className="bar" title={d.formula}>
                <label>{lang === 'en' ? d.label_en : d.label}</label>
                <div className="track"><div className="fill" style={{ width: `${d.s * 100}%` }} /></div>
                <span>{Math.round(d.s * 100)}</span>
              </div>
              <div className="why">{lang === 'en' ? d.why_en : d.why}</div>
            </div>
          ))}
          <p className="muted">{t.note}</p>
          <div className="gaps">
            <h4>{t.gaps}</h4>
            {gaps.filter((g) => g.critical).map((g) => (
              <span key={g.key} className="gap critical">{lang === 'en' ? g.label_en : g.label} · {g.value}</span>
            ))}
          </div>
        </div>
      )}

      <details className="overview" open>
        <summary>{t.check}</summary>
        <p className="check-line">{t.checkLine(inTop, known.length)}</p>
        <table id="scan-check">
          <tbody>
            {known.map((s) => (
              <tr key={s.earth_id} onClick={() => { if (s.k !== null) { setCellK(s.k); const c = scan.cell(s.k, bodyId, testId); onFly(c.lat, c.lon, 11); } }}>
                <th>{siteName(s.earth_id)}</th>
                {s.excluded ? (
                  <td colSpan={2} className="muted">⛔ {t.siteScreened[screenKind(s.excluded)]}</td>
                ) : (
                  <>
                    <td>{s.rank ? t.rank(s.rank, n) : t.outside}</td>
                    <td className={(s.percentile ?? 0) >= 0.9 ? 'good' : ''}>{s.percentile !== null ? `${t.top10} ${Math.max(0.1, Math.round((1 - s.percentile) * 1000) / 10)}%` : ''}</td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
        {known.some((s) => s.excluded) && <p className="muted">{t.checkNote}</p>}
      </details>
      <p className="muted">{[scan.meta.src.dem, scan.meta.src.vegetation, scan.meta.src.landcover, scan.meta.src.climate].filter(Boolean).join(' · ')}</p>
    </div>
  );
  return { panel, features, onMapClick, focusAt };
}
