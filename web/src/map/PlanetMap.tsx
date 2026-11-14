// PlanetMap: one Leaflet map pane that can show Earth, the Moon or Mars.
// Earth uses Web Mercator (EPSG3857); Moon/Mars Trek tiles are equirectangular (EPSG4326).
// Leaflet cannot change CRS on a live map, so a world change rebuilds the map.
// App content is passed declaratively as `features` and re-rendered on change.
import { useEffect, useRef, type ReactNode } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { LAYERS, makeTile } from '../layers';
import type { Core, World } from '../core';

const EARTH_R_M = 6371000; // radius Leaflet uses for L.circle

export type Feature =
  | { kind: 'point'; lat: number; lon: number; color: string; radius?: number; tooltip?: string; onClick?: () => void; openTooltip?: boolean }
  | { kind: 'pin'; lat: number; lon: number; tooltip?: string }
  | { kind: 'line'; pts: [number, number][]; color: string; weight?: number }
  | { kind: 'ring'; lat: number; lon: number; radiusKm: number; color: string; tooltip?: string };

export interface DataOverlay { name: string; features: Feature[] }

export interface FlyTarget { lat: number; lon: number; z: number; seq: number }

interface Props {
  core: Core;
  world: World;
  /** Initial view when the map is (re)built. Defaults to the world's view. */
  view?: [number, number, number];
  /** Change `seq` to fly to a new place. */
  fly?: FlyTarget | null;
  baseKey?: string;
  features?: Feature[];
  overlays?: DataOverlay[];
  collapsedLayers?: boolean;
  crosshair?: boolean;
  onClick?: (lat: number, lon: number) => void;
  children?: ReactNode;
}

const pinIcon = L.divIcon({ className: 'pin-icon', html: '📍', iconSize: [24, 24], iconAnchor: [12, 22] });

function render(group: L.LayerGroup, features: Feature[], world: World, core: Core) {
  group.clearLayers();
  for (const f of features) {
    let layer: L.Layer;
    switch (f.kind) {
      case 'point': {
        const m = L.circleMarker([f.lat, f.lon], {
          radius: f.radius ?? 6, color: '#fff', weight: 2, fillColor: f.color, fillOpacity: 0.95,
        });
        if (f.onClick) m.on('click', (e) => { L.DomEvent.stopPropagation(e); f.onClick!(); });
        layer = m;
        break;
      }
      case 'pin':
        layer = L.marker([f.lat, f.lon], { icon: pinIcon });
        break;
      case 'line':
        layer = L.polyline(f.pts, { color: f.color, weight: f.weight ?? 3 });
        break;
      case 'ring':
        // L.circle radius is in Earth metres; convert a distance on another body.
        layer = L.circle([f.lat, f.lon], {
          radius: (f.radiusKm / core.world(world).radius_km) * EARTH_R_M,
          color: f.color, weight: 1, dashArray: '6 6', fill: false,
        });
        break;
    }
    if ('tooltip' in f && f.tooltip) {
      (layer as L.Path).bindTooltip(f.tooltip);
      if (f.kind === 'point' && f.openTooltip) setTimeout(() => (layer as L.Path).openTooltip(), 0);
    }
    group.addLayer(layer);
  }
}

// Scale bar using the current body's radius (L.control.scale assumes Earth).
function scaleControl(core: Core, world: World) {
  const C = L.Control.extend({
    options: { position: 'bottomleft' },
    onAdd(map: L.Map) {
      const el = L.DomUtil.create('div', 'planet-scale');
      // The deferred first update can land after map.remove() (world switch, StrictMode remount).
      let removed = false;
      map.on('unload', () => { removed = true; });
      const update = () => {
        if (removed) return;
        const y = map.getSize().y / 2, w = 120;
        const km = core.distanceKm(world, map.containerPointToLatLng([0, y]), map.containerPointToLatLng([w, y]));
        if (!(km > 0)) return;
        const p = 10 ** Math.floor(Math.log10(km)), d = km / p;
        const nice = (d >= 5 ? 5 : d >= 2 ? 2 : 1) * p;
        el.style.width = `${Math.round((w * nice) / km)}px`;
        el.textContent = nice >= 1 ? `${nice} km` : `${Math.round(nice * 1000)} m`;
      };
      map.on('move zoom resize', update);
      setTimeout(update, 0);
      return el;
    },
  });
  return new C();
}

function coordControl() {
  const C = L.Control.extend({
    options: { position: 'bottomright' },
    onAdd(map: L.Map) {
      const el = L.DomUtil.create('div', 'coord-readout');
      map.on('mousemove', (e: L.LeafletMouseEvent) => {
        el.textContent = `${e.latlng.lat.toFixed(4)}, ${e.latlng.lng.toFixed(4)}`;
      });
      return el;
    },
  });
  return new C();
}

export function PlanetMap(props: Props) {
  const { core, world, view, fly, baseKey, features = [], overlays = [], collapsedLayers = true, crosshair, onClick, children } = props;
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const featureGroup = useRef<L.LayerGroup | null>(null);
  const overlayGroups = useRef<Map<string, L.LayerGroup>>(new Map());
  const clickRef = useRef(onClick);
  clickRef.current = onClick;
  const viewRef = useRef(view);
  viewRef.current = view;

  // Build / rebuild on world or overlay set change.
  const overlayNames = overlays.map((o) => o.name).join('|');
  useEffect(() => {
    const info = core.world(world);
    const crs = world === 'earth' ? L.CRS.EPSG3857 : L.CRS.EPSG4326;
    const v = viewRef.current ?? info.view;
    const m = L.map(el.current!, { crs, minZoom: world === 'earth' ? 2 : 0, worldCopyJump: world === 'earth' });
    m.setView([v[0], v[1]], v[2]);

    const base: Record<string, L.Layer> = {}, over: Record<string, L.Layer> = {};
    const baseDefs = LAYERS[world] ?? {};
    for (const d of Object.values(baseDefs)) base[d.name] = makeTile(d);
    for (const d of Object.values(LAYERS[`${world}Overlay`] ?? {})) over[d.name] = makeTile(d);
    overlayGroups.current = new Map();
    for (const name of overlayNames ? overlayNames.split('|') : []) {
      const g = L.layerGroup().addTo(m);
      overlayGroups.current.set(name, g);
      over[name] = g;
    }
    const first = baseDefs[baseKey ?? ''] ?? Object.values(baseDefs)[0];
    if (first) base[first.name].addTo(m);
    L.control.layers(base, over, { collapsed: collapsedLayers }).addTo(m);
    scaleControl(core, world).addTo(m);
    coordControl().addTo(m);
    featureGroup.current = L.layerGroup().addTo(m);
    m.on('click', (e: L.LeafletMouseEvent) => clickRef.current?.(e.latlng.lat, e.latlng.lng));

    map.current = m;
    const ro = new ResizeObserver(() => m.invalidateSize());
    ro.observe(el.current!);
    // stop() first: removing a map mid-flyTo throws "_leaflet_pos" from the pending animation frame.
    return () => { ro.disconnect(); m.stop(); m.remove(); map.current = null; };
  }, [core, world, baseKey, collapsedLayers, overlayNames]);

  useEffect(() => {
    if (featureGroup.current) render(featureGroup.current, features, world, core);
  });
  useEffect(() => {
    for (const o of overlays) {
      const g = overlayGroups.current.get(o.name);
      if (g) render(g, o.features, world, core);
    }
  });
  useEffect(() => {
    if (fly && map.current) map.current.stop().flyTo([fly.lat, fly.lon], fly.z, { duration: 1.0 });
  }, [fly?.seq]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="mapwrap">
      <div ref={el} className="map" style={{ cursor: crosshair ? 'crosshair' : undefined }} />
      {children}
    </div>
  );
}

/** Past landing sites for a world as a toggleable overlay. */
export function missionOverlay(core: Core, world: World): DataOverlay[] {
  if (world === 'earth') {
    return [{ name: '◆ 北海道アナログ候補地', features: core.earthSites.map((e) => ({ kind: 'point', lat: e.lat, lon: e.lon, color: '#b37feb', radius: 5, tooltip: e.name })) }];
  }
  return [{
    name: '◆ 過去ミッション着陸地点',
    features: (core.missions.landings[world] ?? []).map((m) => ({
      kind: 'point', lat: m.lat, lon: m.lon, radius: 5,
      color: m.agency === 'JAXA' ? '#ff4d4f' : '#b37feb', tooltip: `${m.name} (${m.agency} ${m.year})`,
    })),
  }];
}
