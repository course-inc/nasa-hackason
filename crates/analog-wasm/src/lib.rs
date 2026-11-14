//! wasm-bindgen surface of analog-core. Everything goes in and out as JSON strings so the
//! TypeScript side (web/src/core.ts) owns the types and no extra glue crates are needed.

use analog_core::{data, route, scoring, world};
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
