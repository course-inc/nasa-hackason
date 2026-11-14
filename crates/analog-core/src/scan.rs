//! Whole-Hokkaido scan (#10, tier 2): every land cell of a square grid is scored against a
//! Moon/Mars target with exactly the same formulas as the 14 hand-picked sites
//! ([`crate::scoring::score_pair`]). Cell data comes from `scripts/build-scan-data.mjs`
//! (GSI DEM terrain per cell, NASA POWER climatology on its own 0.5° × 0.625° grid).

use crate::data::{earth_sites, Body, EarthSite};
use crate::scoring::{profile, score_pair, PairScore, Weights};
use serde::{Deserialize, Serialize};

/// Height correction for air temperature (standard atmosphere lapse rate).
pub const LAPSE_K_PER_M: f64 = 0.0065;

#[derive(Debug, Clone, Deserialize)]
pub struct Cells {
    /// Grid index `row * cols + col` of each land cell.
    pub i: Vec<u32>,
    pub elev: Vec<f64>,
    pub relief: Vec<f64>,
    /// Tenths of a degree.
    pub slope: Vec<f64>,
    pub p90: Vec<f64>,
    /// Per mille of the cell in shadow at noon on the December solstice.
    pub shadow: Vec<f64>,
    pub land: Vec<f64>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Power {
    pub lat0: f64,
    pub lon0: f64,
    pub dlat: f64,
    pub dlon: f64,
    pub rows: usize,
    pub cols: usize,
    pub elev: Vec<Option<f64>>,
    /// Monthly mean daily minimum / maximum air temperature, °C, Jan..Dec.
    pub tmin: Vec<Option<[f64; 12]>>,
    pub tmax: Vec<Option<[f64; 12]>>,
    /// mm per year.
    pub precip: Vec<Option<f64>>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Scan {
    pub cell_km: f64,
    /// Centre of row 0 (north) / column 0 (west).
    pub lat0: f64,
    pub lon0: f64,
    pub dlat: f64,
    pub dlon: f64,
    pub rows: usize,
    pub cols: usize,
    pub cells: Cells,
    pub power: Power,
    #[serde(default)]
    pub src: serde_json::Value,
}

#[derive(Debug, Clone, Serialize)]
pub struct Meta {
    pub cell_km: f64,
    pub lat0: f64,
    pub lon0: f64,
    pub dlat: f64,
    pub dlon: f64,
    pub rows: usize,
    pub cols: usize,
    pub n: usize,
    pub src: serde_json::Value,
}

/// Climate of one cell, height-corrected. Temperatures in °C.
#[derive(Debug, Clone, Copy, Serialize)]
pub struct CellClimate {
    pub tmin: [f64; 12],
    pub tmax: [f64; 12],
    pub precip: f64,
}

impl Scan {
    pub fn from_json(s: &str) -> Result<Scan, String> {
        let sc: Scan = serde_json::from_str(s).map_err(|e| e.to_string())?;
        let n = sc.cells.i.len();
        let c = &sc.cells;
        if [&c.elev, &c.relief, &c.slope, &c.p90, &c.shadow, &c.land]
            .iter()
            .any(|v| v.len() != n)
        {
            return Err("scan: cell columns differ in length".into());
        }
        let p = &sc.power;
        let m = p.rows * p.cols;
        if p.elev.len() != m || p.tmin.len() != m || p.tmax.len() != m || p.precip.len() != m {
            return Err("scan: power grid size does not match rows × cols".into());
        }
        Ok(sc)
    }

    pub fn meta(&self) -> Meta {
        Meta {
            cell_km: self.cell_km,
            lat0: self.lat0,
            lon0: self.lon0,
            dlat: self.dlat,
            dlon: self.dlon,
            rows: self.rows,
            cols: self.cols,
            n: self.len(),
            src: self.src.clone(),
        }
    }

    pub fn len(&self) -> usize {
        self.cells.i.len()
    }

    pub fn is_empty(&self) -> bool {
        self.cells.i.is_empty()
    }

    /// Centre of land cell `k`.
    pub fn latlon(&self, k: usize) -> (f64, f64) {
        let g = self.cells.i[k] as usize;
        let (r, c) = (g / self.cols, g % self.cols);
        (
            self.lat0 - r as f64 * self.dlat,
            self.lon0 + c as f64 * self.dlon,
        )
    }

    /// Land cell containing a point, if any.
    pub fn cell_at(&self, lat: f64, lon: f64) -> Option<usize> {
        let r = ((self.lat0 + self.dlat / 2.0 - lat) / self.dlat).floor();
        let c = ((lon - (self.lon0 - self.dlon / 2.0)) / self.dlon).floor();
        if r < 0.0 || c < 0.0 || r >= self.rows as f64 || c >= self.cols as f64 {
            return None;
        }
        let g = (r as usize * self.cols + c as usize) as u32;
        self.cells.i.binary_search(&g).ok()
    }

    /// NASA POWER climate interpolated to cell `k` and corrected to the cell's mean height.
    pub fn climate(&self, k: usize) -> Option<CellClimate> {
        let (lat, lon) = self.latlon(k);
        let p = &self.power;
        let fr = ((p.lat0 - lat) / p.dlat).clamp(0.0, (p.rows - 1) as f64);
        let fc = ((lon - p.lon0) / p.dlon).clamp(0.0, (p.cols - 1) as f64);
        let (r0, c0) = (fr.floor() as usize, fc.floor() as usize);
        let (r1, c1) = ((r0 + 1).min(p.rows - 1), (c0 + 1).min(p.cols - 1));
        let (tr, tc) = (fr - r0 as f64, fc - c0 as f64);
        let mut acc = CellClimate {
            tmin: [0.0; 12],
            tmax: [0.0; 12],
            precip: 0.0,
        };
        let mut wsum = 0.0;
        for (r, c, w) in [
            (r0, c0, (1.0 - tr) * (1.0 - tc)),
            (r0, c1, (1.0 - tr) * tc),
            (r1, c0, tr * (1.0 - tc)),
            (r1, c1, tr * tc),
        ] {
            let j = r * p.cols + c;
            let (Some(e), Some(lo), Some(hi), Some(pr)) =
                (p.elev[j], p.tmin[j], p.tmax[j], p.precip[j])
            else {
                continue;
            };
            let w = w.max(1e-9);
            let sea = LAPSE_K_PER_M * e; // reduce to sea level
            for m in 0..12 {
                acc.tmin[m] += w * (lo[m] + sea);
                acc.tmax[m] += w * (hi[m] + sea);
            }
            acc.precip += w * pr;
            wsum += w;
        }
        if wsum == 0.0 {
            return None;
        }
        let up = LAPSE_K_PER_M * self.cells.elev[k];
        for m in 0..12 {
            acc.tmin[m] = acc.tmin[m] / wsum - up;
            acc.tmax[m] = acc.tmax[m] / wsum - up;
        }
        acc.precip /= wsum;
        Some(acc)
    }

    /// Cell `k` as an [`EarthSite`], so the 14-site formulas apply unchanged.
    /// No vegetation or lithology per cell yet: those terms stay neutral (see [`scan_weights`]).
    pub fn site(&self, k: usize) -> EarthSite {
        let (lat, lon) = self.latlon(k);
        let cl = self.climate(k);
        let c = &self.cells;
        EarthSite {
            id: format!("cell-{}", c.i[k]),
            name: String::new(),
            en: None,
            lat,
            lon,
            elev_m: Some(c.elev[k]),
            slope_mean_deg: c.slope[k] / 10.0,
            slope_p90_deg: Some(c.p90[k] / 10.0),
            relief_m: Some(c.relief[k]),
            ndvi_min: None,
            ndvi_median: None,
            barren_frac: None,
            landcover_center: None,
            lst_night_jan_k: None,
            lst_day_aug_k: None,
            precip_mm_yr: cl.map(|x| x.precip),
            t2m_min_jan_c: cl.map(|x| x.tmin[0]),
            t2m_max_aug_c: cl.map(|x| x.tmax[7]),
            lithology_ja: None,
            lithology_en: None,
            age_ja: None,
            age_en: None,
        }
    }
}

/// Profile weights with geology switched off: the grid has no rock type per cell yet, so a
/// constant geology term would only flatten the map.
pub fn scan_weights(profile_id: &str) -> Weights {
    let mut w = profile(profile_id).w;
    w.insert("geology".into(), 0.0);
    w
}

/// Total match (0–1) of every land cell, in cell order.
pub fn scores(scan: &Scan, b: &Body, profile_id: &str) -> Vec<f32> {
    let w = scan_weights(profile_id);
    (0..scan.len())
        .map(|k| score_pair(&scan.site(k), b, &w).total as f32)
        .collect()
}

#[derive(Debug, Clone, Serialize)]
pub struct Candidate {
    pub k: usize,
    pub lat: f64,
    pub lon: f64,
    pub score: f64,
    pub elev_m: f64,
    pub slope_deg: f64,
    pub shadow: f64,
    /// Nearest of the 14 known sites and its distance in km, when within 15 km.
    pub near: Option<(String, f64)>,
}

fn km(a: (f64, f64), b: (f64, f64)) -> f64 {
    let dy = (a.0 - b.0) * 111.32;
    let dx = (a.1 - b.1) * 111.32 * ((a.0 + b.0) / 2.0).to_radians().cos();
    dx.hypot(dy)
}

/// Best cells, at least `min_km` apart, best first.
pub fn top(scan: &Scan, scores: &[f32], n: usize, min_km: f64) -> Vec<Candidate> {
    let mut order: Vec<usize> = (0..scores.len()).collect();
    order.sort_by(|a, b| scores[*b].total_cmp(&scores[*a]));
    let mut out: Vec<Candidate> = Vec::new();
    for k in order {
        if out.len() >= n {
            break;
        }
        let p = scan.latlon(k);
        if out.iter().any(|c| km((c.lat, c.lon), p) < min_km) {
            continue;
        }
        let near = earth_sites()
            .iter()
            .map(|e| (e.id.clone(), km((e.lat, e.lon), p)))
            .min_by(|a, b| a.1.total_cmp(&b.1))
            .filter(|x| x.1 <= 15.0)
            .map(|(id, d)| (id, (d * 10.0).round() / 10.0));
        out.push(Candidate {
            k,
            lat: p.0,
            lon: p.1,
            score: scores[k] as f64,
            elev_m: scan.cells.elev[k],
            slope_deg: scan.cells.slope[k] / 10.0,
            shadow: scan.cells.shadow[k] / 1000.0,
            near,
        });
    }
    out
}

/// How a known site's own cell ranks in the scan.
#[derive(Debug, Clone, Serialize)]
pub struct SiteCheck {
    pub earth_id: String,
    pub k: Option<usize>,
    pub score: Option<f64>,
    /// 1 = best cell in Hokkaido.
    pub rank: Option<usize>,
    /// Share of land cells scoring below it (0–1).
    pub percentile: Option<f64>,
}

pub fn site_checks(scan: &Scan, scores: &[f32]) -> Vec<SiteCheck> {
    let mut sorted: Vec<f32> = scores.to_vec();
    sorted.sort_by(|a, b| b.total_cmp(a));
    let n = sorted.len().max(1) as f64;
    earth_sites()
        .iter()
        .map(|e| {
            let k = scan.cell_at(e.lat, e.lon);
            let s = k.map(|k| scores[k]);
            let rank = s.map(|s| sorted.partition_point(|x| *x > s) + 1);
            SiteCheck {
                earth_id: e.id.clone(),
                k,
                score: s.map(|s| s as f64),
                rank,
                percentile: rank.map(|r| 1.0 - (r as f64 - 1.0) / n),
            }
        })
        .collect()
}

#[derive(Debug, Clone, Serialize)]
pub struct CellDetail {
    pub k: usize,
    pub lat: f64,
    pub lon: f64,
    pub elev_m: f64,
    pub relief_m: f64,
    pub slope_deg: f64,
    pub slope_p90_deg: f64,
    pub shadow: f64,
    pub land: f64,
    pub climate: Option<CellClimate>,
    pub score: PairScore,
}

pub fn detail(scan: &Scan, k: usize, b: &Body, profile_id: &str) -> Option<CellDetail> {
    if k >= scan.len() {
        return None;
    }
    let (lat, lon) = scan.latlon(k);
    let c = &scan.cells;
    Some(CellDetail {
        k,
        lat,
        lon,
        elev_m: c.elev[k],
        relief_m: c.relief[k],
        slope_deg: c.slope[k] / 10.0,
        slope_p90_deg: c.p90[k] / 10.0,
        shadow: c.shadow[k] / 1000.0,
        land: c.land[k] / 100.0,
        climate: scan.climate(k),
        score: score_pair(&scan.site(k), b, &scan_weights(profile_id)),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data::bodies;

    /// 3×3 cells around Tokachi; the centre is a steep high cell, the corners are missing (sea).
    fn tiny() -> Scan {
        let s = r#"{
          "cell_km": 1, "lat0": 43.43, "lon0": 142.67, "dlat": 0.009, "dlon": 0.0124, "rows": 3, "cols": 3,
          "cells": {"i": [1, 3, 4, 5, 7], "elev": [800, 900, 1800, 900, 800], "relief": [100, 120, 500, 120, 100],
                    "slope": [50, 80, 220, 80, 50], "p90": [100, 140, 340, 140, 100], "shadow": [0, 0, 120, 0, 0],
                    "land": [100, 100, 100, 100, 100]},
          "power": {"lat0": 43.5, "lon0": 142.5, "dlat": 0.5, "dlon": 0.625, "rows": 2, "cols": 2,
                    "elev": [500, 500, 500, null],
                    "tmin": [[-15,-14,-8,-2,3,8,13,15,10,3,-4,-11],[-15,-14,-8,-2,3,8,13,15,10,3,-4,-11],[-15,-14,-8,-2,3,8,13,15,10,3,-4,-11],null],
                    "tmax": [[-3,-2,2,10,17,21,25,26,22,15,7,0],[-3,-2,2,10,17,21,25,26,22,15,7,0],[-3,-2,2,10,17,21,25,26,22,15,7,0],null],
                    "precip": [1200, 1200, 1200, null]}
        }"#;
        Scan::from_json(s).unwrap()
    }

    #[test]
    fn lapse_rate_cools_high_cells() {
        let sc = tiny();
        let centre = sc.climate(2).unwrap();
        // 1800 m vs 500 m grid point → 1300 m × 6.5 K/km ≈ 8.45 K colder.
        assert!((centre.tmin[0] - (-15.0 - 8.45)).abs() < 1e-6);
        let low = sc.climate(0).unwrap();
        assert!(low.tmax[7] > centre.tmax[7]);
    }

    #[test]
    fn cell_lookup_round_trips() {
        let sc = tiny();
        for k in 0..sc.len() {
            let (lat, lon) = sc.latlon(k);
            assert_eq!(sc.cell_at(lat, lon), Some(k));
        }
        assert_eq!(sc.cell_at(43.43, 142.67), None); // corner cell is sea
        assert_eq!(sc.cell_at(10.0, 10.0), None);
    }

    #[test]
    fn steep_centre_wins_for_walking_on_steep_moon() {
        let sc = tiny();
        let b = bodies().iter().find(|b| b.id == "shackleton").unwrap(); // 15° mean slope
        let s = scores(&sc, b, "walk");
        assert_eq!(s.len(), 5);
        assert!(s.iter().all(|x| (0.0..=1.0).contains(x)));
        let t = top(&sc, &s, 3, 0.5);
        assert_eq!(t[0].k, 2);
        assert!(t.windows(2).all(|x| x[0].score >= x[1].score));
        assert_eq!(t[0].near.as_ref().map(|n| n.0.as_str()), Some("tokachi"));
    }

    #[test]
    fn same_formula_as_known_sites() {
        // A cell that copies a known site's terrain and temperatures scores like that site
        // once vegetation, rock and surface temperature are made equally unknown.
        let sc = tiny();
        let b = &bodies()[0];
        let cell = sc.site(2);
        let mut known = earth_sites()[0].clone();
        known.lat = cell.lat;
        known.slope_mean_deg = cell.slope_mean_deg;
        known.t2m_min_jan_c = cell.t2m_min_jan_c;
        known.t2m_max_aug_c = cell.t2m_max_aug_c;
        known.precip_mm_yr = cell.precip_mm_yr;
        known.lst_night_jan_k = None;
        known.lst_day_aug_k = None;
        known.ndvi_min = None;
        known.barren_frac = None;
        known.landcover_center = None;
        known.lithology_ja = None;
        let w = scan_weights("landing");
        let a = score_pair(&cell, b, &w).total;
        let k = score_pair(&known, b, &w).total;
        assert!((a - k).abs() < 1e-12);
    }

    #[test]
    fn checks_cover_every_known_site() {
        let sc = tiny();
        let s = scores(&sc, &bodies()[0], "landing");
        let c = site_checks(&sc, &s);
        assert_eq!(c.len(), earth_sites().len());
        let tok = c.iter().find(|x| x.earth_id == "tokachi").unwrap();
        // Tokachi (43.42, 142.69) falls in the grid; its percentile is within 0–1.
        if let Some(p) = tok.percentile {
            assert!((0.0..=1.0).contains(&p));
        }
    }
}
