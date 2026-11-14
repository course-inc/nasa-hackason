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
let elev = 0;
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

await p.goto(`${BASE}/#walk/mars/18.44/77.45/11`);
await p.waitForSelector('#walk-preset');
await p.waitForTimeout(300);
const box = await p.locator('.maps.single .map').boundingBox();
const click = (dx, dy) => p.mouse.click(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy);
for (const [dx, dy] of [[0, 0], [120, -60], [260, -20], [300, 120]]) { await click(dx, dy); await p.waitForTimeout(120); }
await p.waitForTimeout(400);
const marsStats = (await p.locator('#route-stats').innerText()).replace(/\n/g, ' | ');
console.log('mars:', marsStats); if (!/往路/.test(marsStats)) fail('mars route');
await p.screenshot({ path: 'e2e/shot-walk.png' });
await p.locator('.panel .tabs button[data-w=earth]').click();
await p.waitForTimeout(300);
if (/往路/.test(await p.locator('#route-stats').innerText())) fail('earth should start empty');
await p.selectOption('#walk-preset', 'daisetsu');
await p.waitForTimeout(1300);
await p.locator('.draw-toolbar a[data-m=pin]').click();
await click(0, 0);
await p.locator('.draw-toolbar a[data-m=route]').click();
for (const [dx, dy] of [[-100, 0], [50, -80], [150, 40]]) { await click(dx, dy); await p.waitForTimeout(120); }
await p.waitForTimeout(400);
console.log('earth:', (await p.locator('#route-stats').innerText()).replace(/\n/g, ' | '));
await p.locator('.panel .tabs button[data-w=mars]').click();
await p.waitForTimeout(300);
if (!/往路/.test(await p.locator('#route-stats').innerText())) fail('mars route not kept');
await p.goto(`${BASE}/#analogs`);
await p.waitForTimeout(300);
console.log('elevation calls', elev, 'errors', errs);
if (errs.length) fail('console errors');
await b.close();
