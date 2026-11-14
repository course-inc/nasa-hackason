// Hash router.
//   #target[/body/test/site]      → #10 Earth Analogs, target-first (default)
//   #analogs                      → #10 Earth Analogs, site-first
//   #walk[/world/lat/lon/zoom]    → #11 WALKBACK route planner (#mars kept as an alias)
import { useEffect, useState } from 'react';
import { loadCore, type Core, type World } from './core';
import { AnalogsView } from './views/AnalogsView';
import { TargetView, type TargetParams } from './views/TargetView';
import { WalkView, type WalkParams } from './views/WalkView';

type View = 'target' | 'analogs' | 'walk';

function parseHash(): { view: View; params: WalkParams; target: TargetParams } {
  const [name, world, lat, lon, z] = location.hash.replace(/^#/, '').split('/');
  if (name === 'analogs') return { view: 'analogs', params: {}, target: {} };
  if (name === 'walk' || name === 'mars') {
    const w = (['earth', 'moon', 'mars'].includes(world) ? world : name === 'mars' ? 'mars' : undefined) as World | undefined;
    const num = (s?: string) => (s && Number.isFinite(+s) ? +s : undefined);
    return { view: 'walk', params: { world: w, lat: num(lat), lon: num(lon), z: num(z) }, target: {} };
  }
  return { view: 'target', params: {}, target: name === 'target' ? { body: world, test: lat, ...(lon === 'scan' ? { mode: 'scan' } : { site: lon }) } : {} };
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
        <h1>HOKKAIDO ANALOG FINDER</h1>
        <nav>
          <a href="#target" className={route.view === 'target' ? 'on' : ''}>#10 Earth Analogs</a>
          <a href="#analogs" className={route.view === 'analogs' ? 'on' : ''}>Site → Moon/Mars</a>
          <a href="#walk" className={route.view === 'walk' ? 'on' : ''}>#11 Martian Map (WALKBACK)</a>
        </nav>
      </header>
      {error && <p className="warn" style={{ padding: 16 }}>Could not load the Rust core (WASM): {error}</p>}
      {core && (
        <>
          {/* Views stay mounted once opened so map state survives tab switches. */}
          {visited.has('target') && <div className="view-host" hidden={route.view !== 'target'}><TargetView core={core} params={route.target} /></div>}
          {visited.has('analogs') && <div className="view-host" hidden={route.view !== 'analogs'}><AnalogsView core={core} /></div>}
          {visited.has('walk') && <div className="view-host" hidden={route.view !== 'walk'}><WalkView core={core} params={route.params} /></div>}
        </>
      )}
      <footer>Data: NASA GIBS, NASA Solar System Treks (LRO LOLA/WAC/Diviner, MGS MOLA/TES, Viking, Mars Odyssey THEMIS), JAXA SELENE (Kaguya), ESA Mars Express HRSC, MRO CTX (Caltech), ESA Sentinel-2 cloudless (EOX), 国土地理院, 産総研 地質調査総合センター</footer>
    </>
  );
}
