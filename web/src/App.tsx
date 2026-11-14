// Hash router.
//   #analogs                      → #10 Earth Analogs (default)
//   #walk[/world/lat/lon/zoom]    → #11 WALKBACK route planner (#mars kept as an alias)
import { useEffect, useState } from 'react';
import { loadCore, type Core, type World } from './core';
import { AnalogsView } from './views/AnalogsView';
import { WalkView, type WalkParams } from './views/WalkView';

function parseHash(): { view: 'analogs' | 'walk'; params: WalkParams } {
  const [name, world, lat, lon, z] = location.hash.replace(/^#/, '').split('/');
  if (name === 'walk' || name === 'mars') {
    const w = (['earth', 'moon', 'mars'].includes(world) ? world : name === 'mars' ? 'mars' : undefined) as World | undefined;
    const num = (s?: string) => (s && Number.isFinite(+s) ? +s : undefined);
    return { view: 'walk', params: { world: w, lat: num(lat), lon: num(lon), z: num(z) } };
  }
  return { view: 'analogs', params: {} };
}

export function App() {
  const [core, setCore] = useState<Core | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [route, setRoute] = useState(parseHash);
  const [visited, setVisited] = useState<Set<string>>(() => new Set([parseHash().view]));

  useEffect(() => { loadCore().then(setCore, (e) => setError(String(e))); }, []);
  useEffect(() => {
    const on = () => {
      const r = parseHash();
      setRoute(r);
      setVisited((v) => (v.has(r.view) ? v : new Set(v).add(r.view)));
    };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);

  return (
    <>
      <header>
        <h1>HOKKAIDO ANALOG FINDER <small>prototype · Rust + React</small></h1>
        <nav>
          <a href="#analogs" className={route.view === 'analogs' ? 'on' : ''}>#10 Earth Analogs</a>
          <a href="#walk" className={route.view === 'walk' ? 'on' : ''}>#11 Martian Map (WALKBACK)</a>
        </nav>
      </header>
      {error && <p className="warn" style={{ padding: 16 }}>Rust コア (WASM) を読み込めませんでした: {error}</p>}
      {core && (
        <>
          {/* Views stay mounted once opened so map state survives tab switches. */}
          {visited.has('analogs') && <div className="view-host" hidden={route.view !== 'analogs'}><AnalogsView core={core} /></div>}
          {visited.has('walk') && <div className="view-host" hidden={route.view !== 'walk'}><WalkView core={core} params={route.params} /></div>}
        </>
      )}
      <footer>Data: NASA GIBS, NASA Solar System Treks (LRO LOLA/WAC/Diviner, MGS MOLA/TES, Viking, Mars Odyssey THEMIS), JAXA SELENE (Kaguya), ESA Mars Express HRSC, MRO CTX (Caltech), ESA Sentinel-2 cloudless (EOX), 国土地理院, 産総研 地質調査総合センター</footer>
    </>
  );
}
