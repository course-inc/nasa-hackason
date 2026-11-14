//! WALKBACK: EVA route evaluation with an O₂-based return limit.

use crate::world::{distance_km, LatLon, World};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct Waypoint {
    pub lat: f64,
    #[serde(alias = "lng")]
    pub lon: f64,
    /// Elevation in metres, if known.
    #[serde(default)]
    pub elev: Option<f64>,
}

impl Waypoint {
    fn ll(&self) -> LatLon {
        LatLon {
            lat: self.lat,
            lon: self.lon,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct EvaParams {
    /// Walking speed on flat ground, km/h.
    pub speed_kmh: f64,
    /// O₂ supply, hours.
    pub o2_h: f64,
    /// Reserve kept back, 0–1.
    pub reserve: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RouteEval {
    pub out_km: f64,
    pub out_h: f64,
    pub back_km: f64,
    pub back_h: f64,
    pub total_h: f64,
    pub usable_h: f64,
    /// Radius of the flat-ground return limit around the base, km.
    pub limit_km: f64,
    pub max_slope_deg: f64,
    /// Segments without elevation on both ends (computed as flat).
    pub unknown_segments: usize,
    pub ok: bool,
    /// First waypoint index from which returning straight to base no longer fits the O₂ budget.
    pub point_of_no_return: Option<usize>,
}

/// Tobler's hiking function normalised so flat ground = 1.0 (Earth formula, used as a first guess).
pub fn slope_factor(slope: f64) -> f64 {
    (-3.5 * ((slope + 0.05).abs() - 0.05)).exp()
}

struct Seg {
    km: f64,
    slope: f64,
    known: bool,
}

fn seg(world: World, a: &Waypoint, b: &Waypoint) -> Seg {
    let km = distance_km(world, a.ll(), b.ll());
    match (a.elev, b.elev) {
        (Some(ea), Some(eb)) if km > 0.0 => Seg {
            km,
            slope: (eb - ea) / (km * 1000.0),
            known: true,
        },
        _ => Seg {
            km,
            slope: 0.0,
            known: false,
        },
    }
}

fn hours(s: &Seg, speed: f64) -> f64 {
    s.km / (speed * slope_factor(s.slope))
}

pub fn evaluate_route(world: World, pts: &[Waypoint], p: EvaParams) -> RouteEval {
    let usable_h = p.o2_h * (1.0 - p.reserve.clamp(0.0, 1.0));
    let limit_km = p.speed_kmh * usable_h / 2.0;
    let (mut out_km, mut out_h, mut max_slope, mut unknown) = (0.0, 0.0, 0.0_f64, 0);
    let mut pnr = None;
    for i in 1..pts.len() {
        let s = seg(world, &pts[i - 1], &pts[i]);
        out_km += s.km;
        out_h += hours(&s, p.speed_kmh);
        if !s.known {
            unknown += 1;
        }
        max_slope = max_slope.max(s.slope.abs());
        let back = seg(world, &pts[i], &pts[0]);
        if pnr.is_none() && out_h + hours(&back, p.speed_kmh) > usable_h {
            pnr = Some(i);
        }
    }
    let (back_km, back_h) = if pts.len() > 1 {
        let b = seg(world, &pts[pts.len() - 1], &pts[0]);
        (b.km, hours(&b, p.speed_kmh))
    } else {
        (0.0, 0.0)
    };
    let total_h = out_h + back_h;
    RouteEval {
        out_km,
        out_h,
        back_km,
        back_h,
        total_h,
        usable_h,
        limit_km,
        max_slope_deg: max_slope.atan().to_degrees(),
        unknown_segments: unknown,
        ok: total_h <= usable_h,
        point_of_no_return: pnr,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const P: EvaParams = EvaParams {
        speed_kmh: 2.0,
        o2_h: 8.0,
        reserve: 0.2,
    };
    fn wp(lat: f64, lon: f64, elev: Option<f64>) -> Waypoint {
        Waypoint { lat, lon, elev }
    }

    #[test]
    fn flat_factor_is_one_and_uphill_is_slower() {
        assert!((slope_factor(0.0) - 1.0).abs() < 1e-12);
        assert!(slope_factor(0.2) < slope_factor(0.0));
        assert!(slope_factor(-0.05) > 1.0);
    }

    #[test]
    fn out_and_back_on_flat_ground() {
        // ~1 km east of the base on Mars and back.
        let dlon = (1.0 / 3389.5_f64).to_degrees();
        let r = evaluate_route(
            World::Mars,
            &[wp(0.0, 0.0, Some(0.0)), wp(0.0, dlon, Some(0.0))],
            P,
        );
        assert!((r.out_km - 1.0).abs() < 1e-6 && (r.back_km - 1.0).abs() < 1e-6);
        assert!((r.total_h - 1.0).abs() < 1e-6);
        assert!(r.ok && r.point_of_no_return.is_none());
        assert!((r.usable_h - 6.4).abs() < 1e-12 && (r.limit_km - 6.4).abs() < 1e-12);
    }

    #[test]
    fn long_route_reports_point_of_no_return() {
        let deg = |km: f64| (km / 3389.5_f64).to_degrees();
        let pts = [
            wp(0.0, 0.0, None),
            wp(0.0, deg(3.0), None),
            wp(0.0, deg(6.0), None),
            wp(0.0, deg(9.0), None),
        ];
        let r = evaluate_route(World::Mars, &pts, P);
        assert!(!r.ok);
        // WP2: 6 km out + 6 km back = 6 h ≤ 6.4 h. WP3: 9 + 9 km = 9 h > 6.4 h.
        assert_eq!(r.point_of_no_return, Some(3));
        assert_eq!(r.unknown_segments, 3);
    }

    #[test]
    fn steep_climb_takes_longer() {
        let dlon = (1.0 / 6371.0_f64).to_degrees();
        let flat = evaluate_route(
            World::Earth,
            &[
                wp(43.0, 142.0, Some(0.0)),
                wp(43.0, 142.0 + dlon, Some(0.0)),
            ],
            P,
        );
        let steep = evaluate_route(
            World::Earth,
            &[
                wp(43.0, 142.0, Some(0.0)),
                wp(43.0, 142.0 + dlon, Some(200.0)),
            ],
            P,
        );
        assert!(steep.out_h > flat.out_h);
        assert!(steep.max_slope_deg > 10.0);
    }
}
