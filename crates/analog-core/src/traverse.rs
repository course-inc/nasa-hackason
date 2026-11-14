//! Perseverance's real drive path (Mars 2020 MMGIS `M20_traverse.json`, simplified into
//! `web/public/data/m20_traverse.json`) used as evidence: which parts of a planned walk follow
//! ground a rover has actually crossed, and how steep the rover's own path got.

use crate::route::Waypoint;
use crate::world::World;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Drive {
    pub sol: u32,
    /// [lon, lat, elevation m]
    pub c: Vec<[f64; 3]>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Traverse {
    pub drives: Vec<Drive>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RoverStats {
    pub km: f64,
    pub first_sol: u32,
    pub last_sol: u32,
    /// Slope of the rover's path over ~`window_m` stretches, degrees.
    pub slope_p50: f64,
    pub slope_p90: f64,
    pub slope_max: f64,
    pub window_m: f64,
}

/// Local planar metres around a reference latitude (fine at a few tens of km).
fn xy(world: World, lat0: f64, lon: f64, lat: f64) -> (f64, f64) {
    let k = world.info().radius_km * 1000.0 * std::f64::consts::PI / 180.0;
    (lon * k * lat0.to_radians().cos(), lat * k)
}

fn pct(sorted: &[f64], q: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    let i = ((sorted.len() - 1) as f64 * q).round() as usize;
    sorted[i]
}

pub fn stats(t: &Traverse, window_m: f64) -> RoverStats {
    let w = World::Mars;
    let lat0 = t
        .drives
        .first()
        .and_then(|d| d.c.first())
        .map(|c| c[1])
        .unwrap_or(0.0);
    let mut km = 0.0;
    let mut slopes = Vec::new();
    for d in &t.drives {
        let mut acc = 0.0;
        let mut anchor = match d.c.first() {
            Some(a) => *a,
            None => continue,
        };
        for pair in d.c.windows(2) {
            let (a, b) = (pair[0], pair[1]);
            let (ax, ay) = xy(w, lat0, a[0], a[1]);
            let (bx, by) = xy(w, lat0, b[0], b[1]);
            let seg = ((bx - ax).powi(2) + (by - ay).powi(2)).sqrt();
            km += seg / 1000.0;
            acc += seg;
            if acc >= window_m {
                slopes.push(((b[2] - anchor[2]).abs() / acc).atan().to_degrees());
                anchor = b;
                acc = 0.0;
            }
        }
    }
    slopes.sort_by(|a, b| a.partial_cmp(b).unwrap());
    RoverStats {
        km,
        first_sol: t.drives.iter().map(|d| d.sol).min().unwrap_or(0),
        last_sol: t.drives.iter().map(|d| d.sol).max().unwrap_or(0),
        slope_p50: pct(&slopes, 0.5),
        slope_p90: pct(&slopes, 0.9),
        slope_max: slopes.last().copied().unwrap_or(0.0),
        window_m,
    }
}

/// Distance from p to segment ab (planar).
fn seg_dist(p: (f64, f64), a: (f64, f64), b: (f64, f64)) -> f64 {
    let (dx, dy) = (b.0 - a.0, b.1 - a.1);
    let l2 = dx * dx + dy * dy;
    let t = if l2 > 0.0 {
        (((p.0 - a.0) * dx + (p.1 - a.1) * dy) / l2).clamp(0.0, 1.0)
    } else {
        0.0
    };
    ((p.0 - a.0 - t * dx).powi(2) + (p.1 - a.1 - t * dy).powi(2)).sqrt()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RouteCheck {
    /// Per input point: metres to the nearest rover path.
    pub dist_m: Vec<f64>,
    /// Share of the route length (0–1) within `near_m` of the rover path.
    pub near_share: f64,
    pub near_m: f64,
    /// Steepest leg of the planned route, degrees (legs with known elevation).
    pub route_max_slope: f64,
    /// Share of route legs whose slope is at or below the rover's 90th percentile.
    pub within_rover_share: f64,
    pub rover: RoverStats,
}

/// Compare a planned route (densified points with elevation) with the rover's path.
pub fn check(t: &Traverse, pts: &[Waypoint], near_m: f64) -> RouteCheck {
    let w = World::Mars;
    let rover = stats(t, 25.0);
    let lat0 = pts.first().map(|p| p.lat).unwrap_or(0.0);
    let segs: Vec<((f64, f64), (f64, f64))> = t
        .drives
        .iter()
        .flat_map(|d| d.c.windows(2).map(|p| (p[0], p[1])).collect::<Vec<_>>())
        .map(|(a, b)| (xy(w, lat0, a[0], a[1]), xy(w, lat0, b[0], b[1])))
        .collect();
    let dist_m: Vec<f64> = pts
        .iter()
        .map(|p| {
            let q = xy(w, lat0, p.lon, p.lat);
            segs.iter()
                .map(|(a, b)| seg_dist(q, *a, *b))
                .fold(f64::INFINITY, f64::min)
        })
        .collect();
    let (mut total, mut near, mut legs, mut ok, mut max_slope) = (0.0, 0.0, 0, 0, 0.0_f64);
    for i in 1..pts.len() {
        let a = xy(w, lat0, pts[i - 1].lon, pts[i - 1].lat);
        let b = xy(w, lat0, pts[i].lon, pts[i].lat);
        let len = ((b.0 - a.0).powi(2) + (b.1 - a.1).powi(2)).sqrt();
        total += len;
        if dist_m[i - 1] <= near_m && dist_m[i] <= near_m {
            near += len;
        }
        if let (Some(za), Some(zb)) = (pts[i - 1].elev, pts[i].elev) {
            if len > 0.0 {
                let s = ((zb - za).abs() / len).atan().to_degrees();
                max_slope = max_slope.max(s);
                legs += 1;
                if s <= rover.slope_p90 {
                    ok += 1;
                }
            }
        }
    }
    RouteCheck {
        dist_m,
        near_share: if total > 0.0 { near / total } else { 0.0 },
        near_m,
        route_max_slope: max_slope,
        within_rover_share: if legs > 0 {
            ok as f64 / legs as f64
        } else {
            0.0
        },
        rover,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line() -> Traverse {
        // ~1 km due north at 18.44°N climbing 10 m every ~111 m.
        let c = (0..10)
            .map(|i| {
                [
                    77.45,
                    18.44 + i as f64 * 0.001875,
                    -2570.0 + i as f64 * 10.0,
                ]
            })
            .collect();
        Traverse {
            drives: vec![Drive { sol: 14, c }],
        }
    }

    #[test]
    fn stats_of_a_steady_climb() {
        let s = stats(&line(), 25.0);
        assert!((s.km - 1.0).abs() < 0.02, "km {}", s.km);
        // 10 m over ~111 m → ~5.1°
        assert!((s.slope_p50 - 5.1).abs() < 0.3, "slope {}", s.slope_p50);
        assert_eq!((s.first_sol, s.last_sol), (14, 14));
    }

    #[test]
    fn route_on_the_path_is_near() {
        let t = line();
        let on: Vec<Waypoint> = (0..5)
            .map(|i| Waypoint {
                lat: 18.44 + i as f64 * 0.003,
                lon: 77.45,
                elev: Some(-2570.0 + i as f64 * 16.0),
            })
            .collect();
        let r = check(&t, &on, 100.0);
        assert!(r.near_share > 0.99);
        let off: Vec<Waypoint> = on
            .iter()
            .map(|p| Waypoint {
                lon: p.lon + 0.02,
                ..*p
            })
            .collect();
        assert!(check(&t, &off, 100.0).near_share < 0.01);
    }
}
