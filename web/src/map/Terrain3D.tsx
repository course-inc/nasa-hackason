// 3D terrain view: an elevation grid as a lit mesh with the route, rover path, walk-home area and
// walker draped on it. Everything comes from bundled data, so it works offline.
import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import type { Reach } from '../core';
import type { GridData } from '../walk/data';
import { useT } from '../i18n';

export interface Line3D { pts: [number, number][]; color: string; width: number; opacity?: number }
export interface Point3D { lat: number; lon: number; color: string; size: number }
/**
 * Camera request (agent view_3d tool). heading: direction the camera looks, degrees clockwise from
 * north. tilt: how far it looks down from the horizon (90 = straight down). A new seq re-applies it.
 */
export interface Camera3D { target?: { lat: number; lon: number }; distance?: number; heading?: number; tilt?: number; seq: number }

interface Props {
  grid: GridData;
  radiusKm: number;
  /** Colour ramp: Mars ochre or Earth green/brown. */
  palette: 'mars' | 'earth';
  lines?: Line3D[];
  points?: Point3D[];
  reach?: Reach | null;
  walker?: [number, number] | null;
  /** [[south, west], [north, east]] the camera frames first. */
  focus?: [[number, number], [number, number]] | null;
  label?: string;
  /** Surface photo covering exactly the grid's extent (e.g. web/public/data/jezero_ortho.jpg). */
  photo?: string;
  camera?: Camera3D | null;
  /** Height exaggeration set from outside (the ×1/×2/×4 buttons still work). */
  exaggeration?: number;
}

const MAX_SIDE = 720; // the Jezero grid (700 × 467) at full resolution

/** Bilinear elevation at lat/lon; nulls fall back to the grid minimum. */
function sampler(g: GridData) {
  let min = Infinity;
  for (const v of g.z) if (v != null && v < min) min = v;
  if (!isFinite(min)) min = 0;
  const at = (r: number, c: number) => {
    const v = g.z[Math.max(0, Math.min(g.rows - 1, r)) * g.cols + Math.max(0, Math.min(g.cols - 1, c))];
    return v ?? min;
  };
  return {
    min,
    z(lat: number, lon: number) {
      const fr = (g.lat0 - lat) / g.dlat, fc = (lon - g.lon0) / g.dlon;
      const r = Math.floor(fr), c = Math.floor(fc), dr = fr - r, dc = fc - c;
      return at(r, c) * (1 - dr) * (1 - dc) + at(r, c + 1) * (1 - dr) * dc + at(r + 1, c) * dr * (1 - dc) + at(r + 1, c + 1) * dr * dc;
    },
  };
}

function ramp(t: number, palette: 'mars' | 'earth'): [number, number, number] {
  const stops: [number, [number, number, number]][] = palette === 'mars'
    ? [[0, [70, 40, 32]], [0.35, [140, 78, 50]], [0.7, [196, 128, 82]], [1, [236, 200, 160]]]
    : [[0, [46, 92, 60]], [0.4, [104, 140, 76]], [0.75, [168, 150, 104]], [1, [235, 232, 225]]];
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const [t0, a] = stops[i - 1], [t1, b] = stops[i], f = (t - t0) / (t1 - t0 || 1);
      return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
    }
  }
  return stops[stops.length - 1][1];
}

/** Elevation colours with the walk-home area painted over them, one pixel per grid cell. */
/** The surface photo with the walk-home area tinted over it (one reach cell per grid cell). */
function photoTexture(g: GridData, img: HTMLImageElement, reach: Reach | null | undefined) {
  const cv = document.createElement('canvas');
  cv.width = img.naturalWidth; cv.height = img.naturalHeight;
  const ctx = cv.getContext('2d')!;
  ctx.drawImage(img, 0, 0);
  if (reach && reach.rows === g.rows && reach.cols === g.cols) {
    const rc = document.createElement('canvas');
    rc.width = g.cols; rc.height = g.rows;
    const rctx = rc.getContext('2d')!, im = rctx.createImageData(g.cols, g.rows);
    for (let i = 0; i < reach.ratio.length; i++) {
      const q = reach.ratio[i];
      if (q == null || q > 1) continue;
      const o = i * 4;
      // Over the photo: a light green tint inside, a thin yellow band at the limit.
      if (q > 0.94) { im.data[o] = 255; im.data[o + 1] = 214; im.data[o + 2] = 102; im.data[o + 3] = 150; }
      else { im.data[o] = 120; im.data[o + 1] = 220; im.data[o + 2] = 80; im.data[o + 3] = 26; }
    }
    rctx.putImageData(im, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(rc, 0, 0, cv.width, cv.height);
  }
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

function texture(g: GridData, palette: 'mars' | 'earth', reach: Reach | null | undefined) {
  const cv = document.createElement('canvas');
  cv.width = g.cols; cv.height = g.rows;
  const ctx = cv.getContext('2d')!;
  const img = ctx.createImageData(g.cols, g.rows);
  let lo = Infinity, hi = -Infinity;
  for (const v of g.z) if (v != null) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  const useReach = reach && reach.rows === g.rows && reach.cols === g.cols;
  for (let i = 0; i < g.z.length; i++) {
    const v = g.z[i], o = i * 4;
    let [r, gg, b] = v == null ? [90, 90, 90] : ramp((v - lo) / (hi - lo || 1), palette);
    const q = useReach ? reach!.ratio[i] : null;
    if (q != null && q <= 1) {
      const [cr, cg, cb, a] = q > 0.85 ? [255, 214, 102, 0.8] : [82, 196, 26, 0.28];
      r = r * (1 - a) + cr * a; gg = gg * (1 - a) + cg * a; b = b * (1 - a) + cb * a;
    }
    img.data[o] = r; img.data[o + 1] = gg; img.data[o + 2] = b; img.data[o + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

export function Terrain3D({ grid, radiusKm, palette, lines = [], points = [], reach, walker, focus, label, camera, exaggeration, photo }: Props) {
  const t = useT();
  // Surface photo (when given) or the elevation colours; the photo loads once and stays.
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [usePhoto, setUsePhoto] = useState(true);
  useEffect(() => {
    if (!photo) return;
    let live = true;
    const im = new Image();
    im.onload = () => live && setImg(im);
    im.src = photo;
    return () => { live = false; };
  }, [photo]);
  const surface = () => (img && usePhoto ? photoTexture(grid, img, reach) : texture(grid, palette, reach));
  const host = useRef<HTMLDivElement>(null);
  const [exag, setExag] = useState(exaggeration ?? (palette === 'mars' ? 2 : 1.5));
  useEffect(() => { if (exaggeration != null) setExag(exaggeration); }, [exaggeration]);
  const scene = useRef<{
    r: THREE.WebGLRenderer; s: THREE.Scene; cam: THREE.PerspectiveCamera; ctl: OrbitControls;
    project: (lat: number, lon: number, lift?: number) => THREE.Vector3; overlay: THREE.Group; walker: THREE.Mesh;
    terrain: THREE.Mesh; mats: LineMaterial[];
    goal: { pos: THREE.Vector3; target: THREE.Vector3 } | null;
  } | null>(null);

  // Terrain mesh + renderer: rebuilt when the grid or the height scale changes.
  useEffect(() => {
    const el = host.current!;
    const g = grid, smp = sampler(g);
    const k = (Math.PI / 180) * radiusKm * 1000;
    const latC = g.lat0 - (g.rows / 2) * g.dlat, lonC = g.lon0 + (g.cols / 2) * g.dlon;
    const cosC = Math.cos((latC * Math.PI) / 180);
    const project = (lat: number, lon: number, lift = 0) =>
      new THREE.Vector3((lon - lonC) * k * cosC, (smp.z(lat, lon) - smp.min) * exag + lift, -(lat - latC) * k);

    const step = Math.max(1, Math.ceil(Math.max(g.rows, g.cols) / MAX_SIDE));
    const nr = Math.floor((g.rows - 1) / step) + 1, nc = Math.floor((g.cols - 1) / step) + 1;
    const pos = new Float32Array(nr * nc * 3), uv = new Float32Array(nr * nc * 2);
    for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) {
      const r = i * step, c = j * step, n = i * nc + j;
      const lat = g.lat0 - r * g.dlat, lon = g.lon0 + c * g.dlon;
      const v = g.z[r * g.cols + c] ?? smp.min;
      pos[n * 3] = (lon - lonC) * k * cosC; pos[n * 3 + 1] = (v - smp.min) * exag; pos[n * 3 + 2] = -(lat - latC) * k;
      uv[n * 2] = (c + 0.5) / g.cols; uv[n * 2 + 1] = 1 - (r + 0.5) / g.rows;
    }
    const idx: number[] = [];
    for (let i = 0; i < nr - 1; i++) for (let j = 0; j < nc - 1; j++) {
      const a = i * nc + j, b = a + 1, c = a + nc, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({ map: surface(), roughness: 0.95, metalness: 0 });
    const terrain = new THREE.Mesh(geo, mat);
    terrain.castShadow = true;
    terrain.receiveShadow = true;

    const s = new THREE.Scene();
    const span0 = Math.max(g.cols * g.dlon * k * cosC, g.rows * g.dlat * k);
    // Mars: no solid sky colour; the canvas is transparent over a butterscotch sky gradient (CSS),
    // and a matching haze fades distant ground. Earth keeps a plain dark background.
    if (palette === 'mars') s.fog = new THREE.Fog('#c9926a', span0 * 0.25, span0 * 1.6);
    else s.background = new THREE.Color('#0f1a24');
    s.add(terrain);
    s.add(new THREE.HemisphereLight(palette === 'mars' ? '#ffd9c2' : '#dfefff', '#2a1a14', palette === 'mars' ? 0.55 : 0.9));
    // Low afternoon sun from the west-north-west: long shadows make the relief stand out.
    const sun = new THREE.DirectionalLight(palette === 'mars' ? '#fff1e0' : '#ffffff', palette === 'mars' ? 2.8 : 2.2);
    sun.position.set(-1, palette === 'mars' ? 0.42 : 1.1, -0.45).normalize().multiplyScalar(span0 * 1.2);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const sc0 = sun.shadow.camera as THREE.OrthographicCamera;
    sc0.left = -span0 * 0.75; sc0.right = span0 * 0.75; sc0.top = span0 * 0.75; sc0.bottom = -span0 * 0.75;
    sc0.near = span0 * 0.1; sc0.far = span0 * 3;
    sun.shadow.bias = -0.0005;
    s.add(sun);
    const overlay = new THREE.Group();
    s.add(overlay);
    const span = Math.max(g.cols * g.dlon * k * cosC, g.rows * g.dlat * k);
    const walkerMesh = new THREE.Mesh(new THREE.SphereGeometry(span / 220, 16, 12), new THREE.MeshBasicMaterial({ color: '#ff7a45' }));
    walkerMesh.visible = false;
    s.add(walkerMesh);

    const r = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, alpha: palette === 'mars' });
    r.setPixelRatio(Math.min(2, window.devicePixelRatio));
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    el.appendChild(r.domElement);
    const cam = new THREE.PerspectiveCamera(45, 1, span / 2000, span * 10);
    const ctl = new OrbitControls(cam, r.domElement);
    ctl.enableDamping = true;
    ctl.maxPolarAngle = Math.PI * 0.49;

    // Frame the focus box (or the whole grid) from the south-west, looking down ~40°.
    const [[s0, w0], [n0, e0]] = focus ?? [[g.lat0 - g.rows * g.dlat, g.lon0], [g.lat0, g.lon0 + g.cols * g.dlon]];
    const target = project((s0 + n0) / 2, (w0 + e0) / 2);
    const fspan = Math.max(span / 12, (e0 - w0) * k * cosC, (n0 - s0) * k);
    ctl.target.copy(target);
    cam.position.copy(target).add(new THREE.Vector3(-0.55, 0.75, 0.9).normalize().multiplyScalar(fspan * 1.5));

    const mats: LineMaterial[] = [];
    scene.current = { r, s, cam, ctl, project, overlay, walker: walkerMesh, terrain, mats, goal: null };
    ctl.addEventListener('start', () => { if (scene.current) scene.current.goal = null; }); // the user takes over

    const resize = () => {
      const w = el.clientWidth || 1, h = el.clientHeight || 1;
      r.setSize(w, h, false);
      r.domElement.style.width = '100%'; r.domElement.style.height = '100%';
      cam.aspect = w / h; cam.updateProjectionMatrix();
      for (const m of scene.current?.mats ?? []) m.resolution.set(w, h);
    };
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    resize();
    let raf = 0;
    const loop = () => {
      const goal = scene.current?.goal;
      if (goal) { // ease towards a camera request
        cam.position.lerp(goal.pos, 0.12); ctl.target.lerp(goal.target, 0.12);
        if (cam.position.distanceTo(goal.pos) < span / 5000) { cam.position.copy(goal.pos); ctl.target.copy(goal.target); scene.current!.goal = null; }
      }
      ctl.update(); r.render(s, cam); raf = requestAnimationFrame(loop);
    };
    loop();
    return () => {
      cancelAnimationFrame(raf); ro.disconnect(); ctl.dispose();
      s.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose();
        const mm = m.material as THREE.Material | THREE.Material[] | undefined;
        (Array.isArray(mm) ? mm : mm ? [mm] : []).forEach((x) => { (x as THREE.MeshStandardMaterial).map?.dispose(); x.dispose(); });
      });
      r.dispose(); el.removeChild(r.domElement);
      scene.current = null;
    };
    // focus is only used for the first framing; re-framing on every route edit would be jarring.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [grid, radiusKm, palette, exag]);

  // Walk-home area: repaint the terrain texture.
  useEffect(() => {
    const sc = scene.current;
    if (!sc) return;
    const m = sc.terrain.material as THREE.MeshStandardMaterial;
    m.map?.dispose();
    m.map = surface();
    m.needsUpdate = true;
  }, [reach, grid, palette, exag, img, usePhoto]); // eslint-disable-line react-hooks/exhaustive-deps

  // Lines and points draped on the terrain.
  useEffect(() => {
    const sc = scene.current;
    if (!sc) return;
    sc.overlay.children.slice().forEach((o) => { sc.overlay.remove(o); (o as THREE.Mesh).geometry?.dispose(); });
    sc.mats.length = 0;
    const w = host.current?.clientWidth || 1, h = host.current?.clientHeight || 1;
    const lift = 4 * exag;
    for (const l of lines) {
      if (l.pts.length < 2) continue;
      const g = new LineGeometry();
      g.setPositions(l.pts.flatMap(([la, lo]) => sc.project(la, lo, lift).toArray()));
      const m = new LineMaterial({ color: l.color, linewidth: l.width, transparent: (l.opacity ?? 1) < 1, opacity: l.opacity ?? 1, depthTest: true });
      m.resolution.set(w, h);
      sc.mats.push(m);
      sc.overlay.add(new Line2(g, m));
    }
    const span = (sc.cam.far / 10);
    for (const p of points) {
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(span / 1100 * p.size, 16, 12), new THREE.MeshBasicMaterial({ color: p.color }));
      mesh.position.copy(sc.project(p.lat, p.lon, lift * 2));
      sc.overlay.add(mesh);
    }
  }, [lines, points, exag, grid]);

  // Camera requests: look at target from distance, heading and tilt (missing parts keep the current view).
  useEffect(() => {
    const sc = scene.current;
    if (!sc || !camera) return;
    const target = camera.target ? sc.project(camera.target.lat, camera.target.lon) : sc.ctl.target.clone();
    const off = sc.cam.position.clone().sub(sc.ctl.target);
    const dist = camera.distance ?? off.length();
    const curHeading = Math.atan2(-off.x, off.z) * 180 / Math.PI;
    const curTilt = Math.asin(Math.max(-1, Math.min(1, off.y / (off.length() || 1)))) * 180 / Math.PI;
    const h = ((camera.heading ?? curHeading) * Math.PI) / 180;
    const t = (Math.max(5, Math.min(89, camera.tilt ?? curTilt)) * Math.PI) / 180;
    const pos = target.clone().add(new THREE.Vector3(-Math.sin(h) * Math.cos(t), Math.sin(t), Math.cos(h) * Math.cos(t)).multiplyScalar(dist));
    sc.goal = { pos, target };
  }, [camera?.seq, exag, grid]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const sc = scene.current;
    if (!sc) return;
    sc.walker.visible = !!walker;
    if (walker) sc.walker.position.copy(sc.project(walker[0], walker[1], 12 * exag));
  }, [walker, exag]);

  return (
    <div className={`terrain3d ${palette}`}>
      <div ref={host} className="terrain3d-canvas" />
      {label && <div className="maplabel">{label}</div>}
      <div className="terrain3d-ctl" role="group" aria-label={t('表示', 'Display')}>
        {photo && (
          <>
            <button className={img && usePhoto ? 'on' : ''} onClick={() => setUsePhoto(true)} disabled={!img}>{t('写真', 'Photo')}</button>
            <button className={!usePhoto || !img ? 'on' : ''} onClick={() => setUsePhoto(false)}>{t('高さの色', 'Height colours')}</button>
          </>
        )}
        <span>{t('高さ', 'Height')}</span>
        {[1, 2, 4].map((x) => (
          <button key={x} className={x === exag ? 'on' : ''} onClick={() => setExag(x)}>×{x}</button>
        ))}
      </div>
      <div className="terrain3d-help">{t('ドラッグで回転・右ドラッグで移動・ホイールで拡大', 'Drag to rotate, right-drag to pan, wheel to zoom')}</div>
    </div>
  );
}
