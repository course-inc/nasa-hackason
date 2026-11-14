// #10 Earth Analogs, target-first: pick a Moon/Mars target and a rehearsal test, and every
// Hokkaido site is ranked for it (Rust/WASM), with the gaps Hokkaido cannot reproduce in numbers.
// State lives in the hash (#target/<body>/<test>/<site>) so a view can be shared as a link.
import { useEffect, useMemo, useState } from 'react';
import type { Core, Gap, SiteScore } from '../core';
import { PlanetMap, missionOverlay, type FlyTarget } from '../map/PlanetMap';

export interface TargetParams { body?: string; test?: string; site?: string }
type Lang = 'en' | 'ja';

const CONTROL_ID = 'sapporo';
const LANG_KEY = 'analog-lang';

const T = {
  en: {
    title: 'Rehearse the Moon in Hokkaido',
    lead: 'Pick a Moon or Mars site and a test. Every Hokkaido site is scored on 5 measured axes, and what Hokkaido cannot reproduce is stated in numbers.',
    target: '1. Target on the Moon / Mars', test: '2. What to rehearse',
    overview: 'All tests at a glance', bestSite: 'Best site in Hokkaido', when: 'When', cannot: 'Cannot reproduce',
    ranking: (t: string) => `Hokkaido sites for “${t}”`,
    match: 'Match', of100: '/100', excluded: 'Excluded (built-up land)',
    gapsTitle: 'What Hokkaido cannot reproduce',
    gapsNote: 'Red = matters for this test. Rehearse procedures here; true conditions need a vacuum chamber, offloading rig or parabolic flight.',
    season: 'Best season', seasonNote: '(rule of thumb; monthly satellite data is the next step)',
    similar: 'Most similar', different: 'Least similar',
    walk: '🥾 Practice walk here', plan: 'Plan the route there',
    src: 'Target values', approx: ' (representative values)',
    moon: 'Moon', mars: 'Mars', earthLabel: 'Earth · Hokkaido', control: 'control',
  },
  ja: {
    title: '北海道で月の予行演習',
    lead: '月・火星の場所と試験を選ぶと、北海道の全地点を実測データの5軸で採点し、北海道では再現できないことを数字で示します。',
    target: '1. 月・火星の目的地', test: '2. 練習したいこと',
    overview: '試験ごとの一覧', bestSite: '北海道で一番近い場所', when: 'いつ', cannot: '再現できないこと',
    ranking: (t: string) => `「${t}」の北海道ランキング`,
    match: '一致度', of100: '/100', excluded: '除外（市街地）',
    gapsTitle: '北海道では再現できないこと',
    gapsNote: '赤はこの試験で効くもの。北海道では手順の練習まで、本番の条件は真空チャンバー・吊り下げ装置・放物線飛行で。',
    season: 'おすすめの時期', seasonNote: '（目安。月別の衛星データは次の段で）',
    similar: '似ている点', different: '違う点',
    walk: '🥾 ここで歩く練習', plan: '現地のルートを計画',
    src: '天体側の値', approx: '（代表値）',
    moon: '月', mars: '火星', earthLabel: '地球 北海道', control: '対照',
  },
} as const;

// English for data/bodies.json `kind` (generated from app/js, Japanese only).
const KIND_EN: Record<string, string> = {
  mons_mouton: 'Artemis III candidate region', malapert: 'Artemis III candidate region',
  shackleton: 'permanent shadow, water ice', marius: 'lava-tube skylight (JAXA SELENE)',
  compton: 'silicic volcanism', arcadia: 'crewed-landing candidate, shallow ground ice',
  deuteronilus: 'crewed exploration zone candidate', jezero: 'Perseverance, ancient lake delta',
  mawrth: 'clay minerals', arsia: 'lava-tube skylights',
};

function loadLang(): Lang {
  try { return localStorage.getItem(LANG_KEY) === 'ja' ? 'ja' : 'en'; } catch { return 'en'; }
}

/** 0 → blue (#40a9ff), 1 → orange (#ff7a45), mixed in RGB so it never passes through green. */
export function scoreColor(s: number): string {
  const k = Math.max(0, Math.min(1, s));
  const mix = (a: number, b: number) => Math.round(a + (b - a) * k);
  return `rgb(${mix(64, 255)} ${mix(169, 122)} ${mix(255, 69)})`;
}

export function TargetView({ core, params }: { core: Core; params: TargetParams }) {
  const tests = useMemo(() => core.profiles.filter((p) => p.test), [core]);
  const [lang, setLang] = useState<Lang>(loadLang);
  const [bodyId, setBodyId] = useState(params.body && core.bodies.some((b) => b.id === params.body) ? params.body : 'mons_mouton');
  const [testId, setTestId] = useState(params.test && tests.some((t) => t.id === params.test) ? params.test : tests[0].id);
  const [siteId, setSiteId] = useState<string | null>(params.site ?? null);
  const [earthFly, setEarthFly] = useState<FlyTarget | null>(null);
  const t = T[lang];

  const body = core.bodies.find((b) => b.id === bodyId)!;
  const test = tests.find((x) => x.id === testId)!;
  const site = (id: string) => core.earthSites.find((e) => e.id === id)!;
  const siteName = (id: string) => (lang === 'en' ? site(id).en ?? site(id).name : site(id).name);
  const bodyName = (b = body) => (lang === 'en' ? b.name : b.ja);
  const testName = (x = test) => (lang === 'en' ? x.en : x.label);

  const ranking = useMemo(() => core.rankSites(bodyId, testId), [core, bodyId, testId]);
  const overview = useMemo(() => tests.map((x) => {
    const r = core.rankSites(bodyId, x.id)[0];
    return { test: x, best: r, gaps: core.gaps(r.earth_id, bodyId, x.id).filter((g) => g.critical) };
  }), [core, tests, bodyId]);

  // Colours are relative to this ranking so the best and worst sites always stand apart.
  const [lo, hi] = useMemo(() => {
    const v = ranking.filter((r) => !r.excluded).map((r) => r.total);
    return [Math.min(...v), Math.max(...v)];
  }, [ranking]);
  const rel = (s: number) => (hi > lo ? (s - lo) / (hi - lo) : 1);

  const cur: SiteScore = ranking.find((r) => r.earth_id === siteId) ?? ranking[0];
  const curSite = site(cur.earth_id);
  const gaps = useMemo(() => core.gaps(cur.earth_id, bodyId, testId), [core, cur.earth_id, bodyId, testId]);
  const bodyFly = useMemo<FlyTarget>(() => ({ lat: body.lat, lon: body.lon, z: body.world === 'moon' ? 5 : 6, seq: Date.now() }), [body]);

  useEffect(() => { try { localStorage.setItem(LANG_KEY, lang); } catch { /* private mode */ } }, [lang]);
  useEffect(() => {
    const h = `#target/${bodyId}/${testId}${siteId ? `/${siteId}` : ''}`;
    if (location.hash.startsWith('#target') && location.hash !== h) history.replaceState(null, '', h);
  }, [bodyId, testId, siteId]);

  const pickSite = (id: string) => {
    const e = site(id);
    setSiteId(id);
    setEarthFly({ lat: e.lat, lon: e.lon, z: 12, seq: Date.now() });
  };
  const pickBody = (id: string) => { setBodyId(id); setSiteId(null); };
  const pickTest = (id: string) => { setTestId(id); setSiteId(null); };

  const earthFeatures = useMemo(() => ranking.map((r) => {
    const e = site(r.earth_id);
    return {
      kind: 'point' as const, lat: e.lat, lon: e.lon,
      radius: r.earth_id === cur.earth_id ? 11 : 5 + 5 * rel(r.total),
      color: r.earth_id === CONTROL_ID ? '#8c8c8c' : scoreColor(rel(r.total)),
      tooltip: `${lang === 'en' ? e.en ?? e.name : e.name} · ${Math.round(r.total * 100)}`,
      openTooltip: r.earth_id === cur.earth_id,
      onClick: () => pickSite(r.earth_id),
    };
  }), [ranking, cur.earth_id, lang, lo, hi]);
  const bodyFeatures = useMemo(() => core.bodies.filter((b) => b.world === body.world).map((b) => ({
    kind: 'point' as const, lat: b.lat, lon: b.lon, radius: b.id === bodyId ? 10 : 6,
    color: b.id === bodyId ? '#ff7a45' : '#40a9ff', tooltip: lang === 'en' ? b.name : b.ja,
    openTooltip: b.id === bodyId, onClick: () => pickBody(b.id),
  })), [core, body.world, bodyId, lang]);

  const sorted = [...cur.dims].sort((a, b) => b.s - a.s);
  const dimLabel = (d: { label: string; label_en: string }) => (lang === 'en' ? d.label_en : d.label);

  return (
    <section className="view target">
      <aside className="panel">
        <div className="lang tabs">
          <button className={lang === 'en' ? 'on' : ''} onClick={() => setLang('en')}>EN</button>
          <button className={lang === 'ja' ? 'on' : ''} onClick={() => setLang('ja')}>日本語</button>
        </div>
        <h2 className="walk-title">{t.title}</h2>
        <p className="muted">{t.lead}</p>

        <label>{t.target}
          <select id="target-body" value={bodyId} onChange={(e) => pickBody(e.target.value)}>
            {(['moon', 'mars'] as const).map((w) => (
              <optgroup key={w} label={`${core.world(w).icon} ${t[w]}`}>
                {core.bodies.filter((b) => b.world === w).map((b) => (
                  <option key={b.id} value={b.id}>{bodyName(b)} — {lang === 'en' ? KIND_EN[b.id] ?? b.kind : b.kind}</option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>

        <div className="muted" style={{ marginBottom: 6 }}>{t.test}</div>
        <div className="tabs" id="test-tabs">
          {tests.map((x) => (
            <button key={x.id} data-test={x.id} className={x.id === testId ? 'on' : ''} onClick={() => pickTest(x.id)}>{testName(x)}</button>
          ))}
        </div>

        <details className="overview" open>
          <summary>{t.overview} — {bodyName()}</summary>
          <table id="overview">
            <thead><tr><th /><th>{t.bestSite}</th><th>{t.match}</th><th>{t.when}</th><th>{t.cannot}</th></tr></thead>
            <tbody>
              {overview.map((o) => (
                <tr key={o.test.id} className={o.test.id === testId ? 'on' : ''} onClick={() => pickTest(o.test.id)}>
                  <th>{testName(o.test)}</th>
                  <td>{siteName(o.best.earth_id)}</td>
                  <td className="num">{Math.round(o.best.total * 100)}</td>
                  <td>{lang === 'en' ? o.test.season_en : o.test.season}</td>
                  <td>{o.gaps.slice(0, 2).map((g) => <span key={g.key} className="gap critical small">{lang === 'en' ? g.label_en : g.label} {g.value}</span>)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>

        <h3 className="sub">{t.ranking(testName())}</h3>
        <ol id="rank-list">
          {ranking.map((r, i) => (
            <li key={r.earth_id} onClick={() => pickSite(r.earth_id)}
              className={`${r.earth_id === cur.earth_id ? 'active' : ''} ${r.earth_id === CONTROL_ID ? 'control' : ''}`}>
              <span className="rank">{i + 1}</span>
              <span className="name">{siteName(r.earth_id)}{r.earth_id === CONTROL_ID && !/control|対照/.test(siteName(r.earth_id)) ? ` (${t.control})` : ''}
                <span className="dims">{r.dims.map((d) => <i key={d.key} title={dimLabel(d)} style={{ background: scoreColor(d.s), opacity: 0.35 + 0.65 * d.s }} />)}</span>
              </span>
              <b className="score" style={{ color: r.excluded ? undefined : scoreColor(rel(r.total)) }}>{r.excluded ? '–' : Math.round(r.total * 100)}</b>
            </li>
          ))}
        </ol>

        <div id="target-detail" className="card">
          <h4>{siteName(cur.earth_id)} ↔ {bodyName()}</h4>
          <p className="muted">{lang === 'en' ? curSite.lithology_en ?? '' : curSite.lithology_ja ?? ''}
            {' · '}{curSite.elev_m ?? '–'} m</p>
          <div className="total">{t.match} <b>{cur.excluded ? '–' : Math.round(cur.total * 100)}</b><small>{t.of100} · {testName()}</small></div>
          {cur.excluded && <p className="warn">⛔ {t.excluded}</p>}
          {cur.dims.map((d) => (
            <div key={d.key}>
              <div className="bar" title={d.formula}>
                <label>{dimLabel(d)} <small>×{test.w[d.key]}</small></label>
                <div className="track"><div className="fill" style={{ width: `${d.s * 100}%` }} /></div>
                <span>{Math.round(d.s * 100)}</span>
              </div>
              <div className="why">{lang === 'en' ? d.why_en : d.why}</div>
            </div>
          ))}
          <div className="sim"><b>{t.similar}</b> {sorted.slice(0, 2).map(dimLabel).join(' · ')}
            {' / '}<b>{t.different}</b> {sorted.slice(-2).map(dimLabel).join(' · ')}</div>
          <p className="season"><b>{t.season}</b> {lang === 'en' ? test.season_en : test.season} <span className="muted">{t.seasonNote}</span></p>
        </div>

        <div className="card gaps" id="gaps">
          <h4>{t.gapsTitle}</h4>
          {gaps.map((g: Gap) => (
            <div key={g.key} className="gap-row">
              <span className={`gap ${g.critical ? 'critical' : ''}`}>{lang === 'en' ? g.label_en : g.label} · {g.value}</span>
              <p>{lang === 'en' ? g.detail_en : g.detail}</p>
            </div>
          ))}
          <p className="muted">{t.gapsNote}</p>
        </div>

        <div className="btns">
          <a className="btn" href={`#walk/earth/${curSite.lat}/${curSite.lon}/14`}>{t.walk}</a>
          <a className="btn" href={`#walk/${body.world}/${body.lat}/${body.lon}/${body.world === 'mars' ? 9 : 10}`}>{core.world(body.world).icon} {t.plan}</a>
        </div>
        <p className="muted">{t.src}: {body.src}{body.approx ? t.approx : ''}</p>
      </aside>
      <div className="maps">
        <PlanetMap core={core} world="earth" baseKey="s2" fly={earthFly} features={earthFeatures}>
          <div className="maplabel">{t.earthLabel}</div>
        </PlanetMap>
        <PlanetMap key={body.world} core={core} world={body.world} view={[body.lat, body.lon, body.world === 'moon' ? 5 : 6]}
          fly={bodyFly} overlays={missionOverlay(core, body.world)} features={bodyFeatures}>
          <div className="maplabel">{core.world(body.world).icon} {bodyName()}</div>
        </PlanetMap>
      </div>
    </section>
  );
}
