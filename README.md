# Hokkaido Analog Finder

NASA Space Apps 2026 (Sapporo). One map app for two challenges:

- **#10 Earth Analogs**: score Hokkaido sites against Moon/Mars sites on 5 dimensions (topography, geology, temperature, lighting, regolith).
- **#11 Martian Map (WALKBACK)**: plan an EVA walk on Mars, the Moon or a Hokkaido analog site, and check the O₂ return limit.

## Stack

| Layer | Where | What |
|---|---|---|
| Rust core | `crates/analog-core` | Scoring, geodesy per body, route time / return limit. Bundles `data/*.json`. Unit tests. |
| WASM bindings | `crates/analog-wasm` | `wasm-bindgen` surface (JSON in/out). Built into `web/src/wasm/` by `mise run wasm`. |
| Web UI | `web/` | React 18 + Vite + TypeScript + Leaflet. Calls the Rust core through WASM, so it works as a plain static site. |
| Desktop | `src-tauri/` | Tauri v2 shell around `web/`. Same WASM core; also exposes it as native commands. |
| Legacy | `app/` | The first plain-JS prototype. Kept as a fallback until the React version is checked; it is the source of `data/*.json` via `mise run sync-data`. |

```
data/*.json ──include_str!──▶ analog-core ──▶ analog-wasm ──▶ web (React) ──▶ static site / GitHub Pages
                                    └──────────────▶ src-tauri ──────────────▶ desktop app
```

## Getting started

```bash
mise run setup       # wasm target, wasm-bindgen-cli 0.2.130, pnpm install
mise run dev         # http://localhost:5173  (#analogs, #walk)
mise run tauri-dev   # desktop window
mise run build       # web/dist, deployable as is
mise run ci-changed  # checks for what changed
```

Requirements: Rust (rustup), Node 22 + pnpm, mise. The e2e smoke test needs Playwright with Chromium (`npx playwright install chromium`).

## Data flow

`scripts/compute_earth_metrics.py` → `app/js/earth-metrics.js` → `mise run sync-data` → `data/earth-metrics.json` → rebuilt into the WASM on the next `mise run wasm`.
Moon/Mars targets, oxide compositions and mission landing sites follow the same path from `app/js/bodies.js` and `app/js/data/missions.js`.
