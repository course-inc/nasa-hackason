//! analog-core: the logic of Hokkaido Analog Finder, shared by the web build (via
//! `analog-wasm`) and the desktop build (via `src-tauri`).
//!
//! - [`scoring`]: #10 Earth Analogs, 5-dimension similarity between Hokkaido and Moon/Mars sites
//! - [`route`]: #11 WALKBACK, EVA route time and O₂ return limit
//! - [`world`]: body constants and geodesy
//! - [`data`]: bundled datasets from `data/*.json`

pub mod data;
pub mod route;
pub mod scoring;
pub mod world;
