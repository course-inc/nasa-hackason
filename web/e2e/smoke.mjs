// Headless smoke test of the built app: both views, world switching, route + pins, Rust results.
//   BASE_URL=http://localhost:4173 node e2e/smoke.mjs   (mise run e2e builds and serves first)
// External tiles are stubbed, and elevation APIs return fake values, so it runs offline.
import { createRequire } from 'node:module';

// Resolved via require so a globally installed Playwright (NODE_PATH) also works.
const { chromium } = createRequire(import.meta.url)('playwright');

const BASE = process.env.BASE_URL ?? 'http://localhost:4173';
const fail = (m) => { console.error('FAIL', m); process.exitCode = 1; };
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
const errs = [];
p.on('pageerror', (e) => errs.push(e.message));
p.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errs.push(m.text()));
let elev = 0; // legacy elevation stubs (analogs view)
await p.route('**/*', (r) => {
  const u = r.request().url();
  if (u.includes('identify') || u.includes('getelevation')) {
    elev++;
    const v = 100 + (elev * 37) % 400;
    return r.fulfill({ contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ value: String(v), elevation: v }) });
  }
  if (u.startsWith(BASE)) return r.continue();
  return r.fulfill({ status: 204 });
});

await p.goto(`${BASE}/#analogs`);
await p.waitForSelector('#site-list li');
const n = await p.locator('#site-list li').count();
console.log('sites', n); if (n < 10) fail('site list');
await p.locator('#site-list li').nth(1).click();
await p.waitForTimeout(1300);
const total = await p.locator('#detail .total b').innerText();
console.log('top match score', total); if (!(+total > 0)) fail('score');
console.log('dim bars', await p.locator('#detail .bar').count());
await p.locator('.maplabel.tabs button[data-w=moon]').click();
await p.waitForTimeout(300);
console.log('body scale', await p.locator('.maps .mapwrap').nth(1).locator('.planet-scale').innerText());
await p.screenshot({ path: 'e2e/shot-analogs.png' });

// WALKBACK: bundled Jezero data loads, the example route is judged, and a clicked route is too.
await p.goto(`${BASE}/#walk`);
await p.waitForSelector('.walk .verdict.ok, .walk .verdict.ng', { timeout: 15000 });
const verdict = await p.locator('.walk .verdict').innerText();
console.log('walk example:', verdict, '|', (await p.locator('.walk .panel').innerText()).split('\n').slice(4, 14).join(' | '));
if (!/帰れる|引き返す/.test(verdict)) fail('walk verdict');
await p.locator('.draw-toolbar a[data-m=clear]').click();
await p.locator('.draw-toolbar a[data-m=route]').click();
const box = await p.locator('.maps.single .map').boundingBox();
const click = (dx, dy) => p.mouse.click(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy);
for (const [dx, dy] of [[60, -40], [140, -20], [200, 60]]) { await click(dx, dy); await p.waitForTimeout(150); }
await p.waitForTimeout(400);
const clicked = await p.locator('.walk .verdict').innerText();
console.log('walk clicked:', clicked); if (!/帰れる|引き返す/.test(clicked)) fail('walk clicked route');
await p.locator('.walk .btns button.primary').click();
await p.waitForSelector('.hud', { timeout: 5000 }).catch(() => fail('helmet HUD'));
await p.waitForTimeout(800);
await p.screenshot({ path: 'e2e/shot-walk.png' });
await p.locator('.walk .btns button.primary').click();
await p.goto(`${BASE}/#analogs`);
await p.waitForTimeout(300);
console.log('elevation calls', elev, 'errors', errs);
if (errs.length) fail('console errors');
await b.close();
