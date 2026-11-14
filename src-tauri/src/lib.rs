//! Desktop shell. The web UI calls analog-core through WASM in both builds, so the web
//! version and the desktop version always compute the same numbers. The commands below
//! expose the same core natively for desktop-only features later (local files, offline tiles).

use analog_core::{route, scoring, world::World};

#[tauri::command]
fn rank_all(profile: String) -> Vec<scoring::SiteRanking> {
    scoring::rank_all(&scoring::profile(&profile).w)
}

#[tauri::command]
fn evaluate_route(
    world: World,
    points: Vec<route::Waypoint>,
    params: route::EvaParams,
) -> route::RouteEval {
    route::evaluate_route(world, &points, params)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![rank_all, evaluate_route])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
