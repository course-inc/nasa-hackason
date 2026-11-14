//! wasm-bindgen surface of analog-core. Everything goes in and out as JSON strings so the
//! TypeScript side (web/src/core.ts) owns the types and no extra glue crates are needed.

use analog_core::{data, eva, grid, rehearsal, route, scoring, traverse, world};
use serde::Serialize;
use wasm_bindgen::prelude::*;

fn json<T: Serialize>(v: &T) -> String {
    serde_json::to_string(v).expect("serialize")
}
fn err(e: impl std::fmt::Display) -> JsError {
    JsError::new(&e.to_string())
}

/// Static datasets and constants in one call: { worlds, earthSites, bodies, missions, profiles, dims }.
#[wasm_bindgen(js_name = bootstrap)]
pub fn bootstrap() -> String {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Boot<'a> {
        worlds: Vec<world::WorldInfo>,
        earth_sites: &'a [data::EarthSite],
        bodies: &'a [data::Body],
        missions: &'a data::Missions,
        profiles: Vec<scoring::Profile>,
        dims: Vec<[&'static str; 2]>,
    }
    json(&Boot {
        worlds: world::World::ALL.iter().map(|w| w.info()).collect(),
        earth_sites: data::earth_sites(),
        bodies: data::bodies(),
        missions: data::missions(),
        profiles: scoring::profiles(),
        dims: scoring::DIMS.iter().map(|(k, l)| [*k, *l]).collect(),
    })
}

/// Ranking of every Earth site for a profile id (or a weights JSON object).
#[wasm_bindgen(js_name = rankAll)]
pub fn rank_all(profile_or_weights: &str) -> Result<String, JsError> {
    let w = if profile_or_weights.trim_start().starts_with('{') {
        serde_json::from_str(profile_or_weights).map_err(err)?
    } else {
        scoring::profile(profile_or_weights).w
    };
    Ok(json(&scoring::rank_all(&w)))
}

/// Evaluate an EVA route. `points`: [{lat, lon|lng, elev?}], `params`: {speed_kmh, o2_h, reserve}.
#[wasm_bindgen(js_name = evaluateRoute)]
pub fn evaluate_route(world: &str, points: &str, params: &str) -> Result<String, JsError> {
    let w: world::World =
        serde_json::from_value(serde_json::Value::String(world.into())).map_err(err)?;
    let pts: Vec<route::Waypoint> = serde_json::from_str(points).map_err(err)?;
    let p: route::EvaParams = serde_json::from_str(params).map_err(err)?;
    Ok(json(&route::evaluate_route(w, &pts, p)))
}

/// Great-circle distance in km on a body.
#[wasm_bindgen(js_name = distanceKm)]
pub fn distance_km(
    world: &str,
    lat1: f64,
    lon1: f64,
    lat2: f64,
    lon2: f64,
) -> Result<f64, JsError> {
    let w: world::World =
        serde_json::from_value(serde_json::Value::String(world.into())).map_err(err)?;
    Ok(world::distance_km(
        w,
        world::LatLon {
            lat: lat1,
            lon: lon1,
        },
        world::LatLon {
            lat: lat2,
            lon: lon2,
        },
    ))
}

// ---- WALKBACK datasets kept inside the module so large JSON is parsed once ----

use std::cell::RefCell;
use std::collections::HashMap;

thread_local! {
    static GRIDS: RefCell<HashMap<String, grid::Grid>> = RefCell::new(HashMap::new());
    static TRAVERSE: RefCell<Option<traverse::Traverse>> = const { RefCell::new(None) };
    static EVAS: RefCell<Option<eva::EvaStats>> = const { RefCell::new(None) };
}

fn parse_world(world: &str) -> Result<world::World, JsError> {
    serde_json::from_value(serde_json::Value::String(world.into())).map_err(err)
}

/// Store an elevation grid under a name (`{lat0, lon0, dlat, dlon, rows, cols, z}`).
#[wasm_bindgen(js_name = setGrid)]
pub fn set_grid(name: &str, grid_json: &str) -> Result<(), JsError> {
    let g: grid::Grid = serde_json::from_str(grid_json).map_err(err)?;
    if g.z.len() != g.rows * g.cols || g.rows < 2 || g.cols < 2 {
        return Err(JsError::new("grid size does not match rows × cols"));
    }
    GRIDS.with(|m| m.borrow_mut().insert(name.to_string(), g));
    Ok(())
}

fn with_grid<T>(name: &str, f: impl FnOnce(&grid::Grid) -> T) -> Result<T, JsError> {
    GRIDS.with(|m| {
        m.borrow()
            .get(name)
            .map(f)
            .ok_or_else(|| JsError::new(&format!("grid {name} not loaded")))
    })
}

/// Bilinear elevations for `[[lat, lon], …]` from a stored grid (null outside or in holes).
#[wasm_bindgen(js_name = sampleGrid)]
pub fn sample_grid(name: &str, latlons: &str) -> Result<String, JsError> {
    let pts: Vec<[f64; 2]> = serde_json::from_str(latlons).map_err(err)?;
    with_grid(name, |g| {
        json(&pts.iter().map(|p| g.sample(p[0], p[1])).collect::<Vec<_>>())
    })
}

/// Walk-home area around a base on a stored grid.
#[wasm_bindgen(js_name = reach)]
pub fn reach(
    world: &str,
    name: &str,
    lat: f64,
    lon: f64,
    params: &str,
    max_slope_deg: f64,
) -> Result<String, JsError> {
    let w = parse_world(world)?;
    let p: route::EvaParams = serde_json::from_str(params).map_err(err)?;
    with_grid(name, |g| {
        json(&grid::reach(w, g, lat, lon, &p, max_slope_deg))
    })
}

/// Store the simplified Perseverance traverse (`{drives: [{sol, c: [[lon, lat, z], …]}]}`).
#[wasm_bindgen(js_name = setTraverse)]
pub fn set_traverse(traverse_json: &str) -> Result<String, JsError> {
    let t: traverse::Traverse = serde_json::from_str(traverse_json).map_err(err)?;
    let s = traverse::stats(&t, 25.0);
    TRAVERSE.with(|c| *c.borrow_mut() = Some(t));
    Ok(json(&s))
}

/// Compare densified route points (with elevation) with the stored traverse.
#[wasm_bindgen(js_name = roverCheck)]
pub fn rover_check(points: &str, near_m: f64) -> Result<String, JsError> {
    let pts: Vec<route::Waypoint> = serde_json::from_str(points).map_err(err)?;
    TRAVERSE.with(|c| {
        c.borrow()
            .as_ref()
            .map(|t| json(&traverse::check(t, &pts, near_m)))
            .ok_or_else(|| JsError::new("traverse not loaded"))
    })
}

/// Parse the data.nasa.gov EVA CSV, keep its statistics and return them.
#[wasm_bindgen(js_name = setEvaCsv)]
pub fn set_eva_csv(csv: &str) -> String {
    let s = eva::stats(&eva::parse(csv));
    let out = json(&s);
    EVAS.with(|c| *c.borrow_mut() = Some(s));
    out
}

/// Share (0–1) of real EVAs longer than `hours`; -1 if the CSV is not loaded.
#[wasm_bindgen(js_name = evaLongerShare)]
pub fn eva_longer_share(hours: f64) -> f64 {
    EVAS.with(|c| {
        c.borrow()
            .as_ref()
            .map(|s| eva::longer_share(s, hours))
            .unwrap_or(-1.0)
    })
}

/// Find where the same walk can be rehearsed on a stored Earth grid.
/// `points`: densified Mars route with elevation. Returns the best `top` matches.
#[wasm_bindgen(js_name = rehearse)]
pub fn rehearse(
    from_world: &str,
    points: &str,
    grid_name: &str,
    stride: usize,
    rot_step_deg: f64,
    top: usize,
) -> Result<String, JsError> {
    let w = parse_world(from_world)?;
    let pts: Vec<route::Waypoint> = serde_json::from_str(points).map_err(err)?;
    let prof = rehearsal::profile(w, &pts);
    with_grid(grid_name, |g| {
        json(&rehearsal::search(
            g,
            &prof,
            stride,
            rot_step_deg,
            top,
            400.0,
        ))
    })
}

/// Every Hokkaido site ranked for one Moon/Mars target and rehearsal test (profile id).
#[wasm_bindgen(js_name = rankSites)]
pub fn rank_sites(body_id: &str, profile_id: &str) -> String {
    json(&analog_core::target::rank_sites(body_id, profile_id))
}

/// What Hokkaido cannot reproduce for this target, with numbers; critical-for-test first.
#[wasm_bindgen(js_name = gaps)]
pub fn gaps(earth_id: &str, body_id: &str, test: &str) -> String {
    json(&analog_core::target::gaps_by_id(earth_id, body_id, test))
}

// ---- #10 whole-Hokkaido scan ----

thread_local! {
    static SCAN: RefCell<Option<analog_core::scan::Scan>> = const { RefCell::new(None) };
}

fn find_body(id: &str) -> Result<&'static data::Body, JsError> {
    data::bodies()
        .iter()
        .find(|b| b.id == id)
        .ok_or_else(|| JsError::new(&format!("unknown target {id}")))
}

fn with_scan<T>(f: impl FnOnce(&analog_core::scan::Scan) -> T) -> Result<T, JsError> {
    SCAN.with(|s| {
        s.borrow()
            .as_ref()
            .map(f)
            .ok_or_else(|| JsError::new("scan not loaded"))
    })
}

/// Load the scan grid (web/public/data/scan/hokkaido-*.json). Returns its meta JSON.
#[wasm_bindgen(js_name = setScan)]
pub fn set_scan(json_str: &str) -> Result<String, JsError> {
    let s = analog_core::scan::Scan::from_json(json_str).map_err(err)?;
    let meta = json(&s.meta());
    SCAN.with(|x| *x.borrow_mut() = Some(s));
    Ok(meta)
}

/// Grid index (`row * cols + col`) of every land cell, in cell order.
#[wasm_bindgen(js_name = scanCells)]
pub fn scan_cells() -> Result<Vec<u32>, JsError> {
    with_scan(|s| s.cells.i.clone())
}

/// Match (0–1) of every land cell for a target and test, in cell order.
#[wasm_bindgen(js_name = scanScores)]
pub fn scan_scores(body_id: &str, profile_id: &str) -> Result<Vec<f32>, JsError> {
    let b = find_body(body_id)?;
    with_scan(|s| analog_core::scan::scores(s, b, profile_id))
}

/// Best cells at least `min_km` apart, plus how each known site's cell ranks.
#[wasm_bindgen(js_name = scanTop)]
pub fn scan_top(scores: &[f32], n: usize, min_km: f64) -> Result<String, JsError> {
    with_scan(|s| {
        if scores.len() != s.len() {
            return Err(JsError::new("scores do not match the loaded scan"));
        }
        #[derive(Serialize)]
        struct Out {
            top: Vec<analog_core::scan::Candidate>,
            sites: Vec<analog_core::scan::SiteCheck>,
        }
        Ok(json(&Out {
            top: analog_core::scan::top(s, scores, n, min_km),
            sites: analog_core::scan::site_checks(s, scores),
        }))
    })?
}

/// One cell in full: terrain, height-corrected climate and the 5-axis score.
#[wasm_bindgen(js_name = scanCell)]
pub fn scan_cell(k: usize, body_id: &str, profile_id: &str) -> Result<String, JsError> {
    let b = find_body(body_id)?;
    with_scan(|s| json(&analog_core::scan::detail(s, k, b, profile_id)))
}

/// Land cell index at a point, or -1.
#[wasm_bindgen(js_name = scanCellAt)]
pub fn scan_cell_at(lat: f64, lon: f64) -> Result<i32, JsError> {
    with_scan(|s| s.cell_at(lat, lon).map_or(-1, |k| k as i32))
}

/// What Hokkaido cannot reproduce, for a scan cell instead of a known site.
#[wasm_bindgen(js_name = scanGaps)]
pub fn scan_gaps(k: usize, body_id: &str, test: &str) -> Result<String, JsError> {
    let b = find_body(body_id)?;
    with_scan(|s| {
        if k >= s.len() {
            return json(&Vec::<analog_core::target::Gap>::new());
        }
        json(&analog_core::target::gaps(&s.site(k), b, test))
    })
}
