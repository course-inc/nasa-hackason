//! Elevation grids (north-up lat/lon rasters) and the "walk-home area" around a base.
//!
//! The area is computed with two Dijkstra runs over the grid's 8-neighbour graph: one for the
//! effort to walk out from the base to every cell, one for the effort to walk back. A cell is
//! reachable when out + back fits the consumable budget. Uphill and downhill differ, so the two
//! runs are not the same.

use crate::route::{effort_factor, slope_factor, EvaParams};
use crate::world::World;
use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::collections::BinaryHeap;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Grid {
    /// Latitude of the centre of the first (north-most) row.
    pub lat0: f64,
    /// Longitude of the centre of the first (west-most) column.
    pub lon0: f64,
    /// Row / column spacing in degrees (positive; rows go south).
    pub dlat: f64,
    pub dlon: f64,
    pub rows: usize,
    pub cols: usize,
    /// Row-major elevations in metres; `None` where unknown.
    pub z: Vec<Option<f64>>,
}

impl Grid {
    pub fn at(&self, r: usize, c: usize) -> Option<f64> {
        self.z.get(r * self.cols + c).copied().flatten()
    }
    pub fn lat(&self, r: f64) -> f64 {
        self.lat0 - r * self.dlat
    }
    pub fn lon(&self, c: f64) -> f64 {
        self.lon0 + c * self.dlon
    }
    /// Fractional (row, col) of a point.
    pub fn rc(&self, lat: f64, lon: f64) -> (f64, f64) {
        ((self.lat0 - lat) / self.dlat, (lon - self.lon0) / self.dlon)
    }
    pub fn contains(&self, lat: f64, lon: f64) -> bool {
        let (r, c) = self.rc(lat, lon);
        r >= 0.0 && c >= 0.0 && r <= (self.rows - 1) as f64 && c <= (self.cols - 1) as f64
    }
    /// Bilinear elevation; `None` outside the grid or next to a hole.
    pub fn sample(&self, lat: f64, lon: f64) -> Option<f64> {
        if !self.contains(lat, lon) {
            return None;
        }
        let (r, c) = self.rc(lat, lon);
        let (r0, c0) = (r.floor() as usize, c.floor() as usize);
        let (r1, c1) = ((r0 + 1).min(self.rows - 1), (c0 + 1).min(self.cols - 1));
        let (fr, fc) = (r - r0 as f64, c - c0 as f64);
        let a = self.at(r0, c0)?;
        let b = self.at(r0, c1)?;
        let d = self.at(r1, c0)?;
        let e = self.at(r1, c1)?;
        Some((a * (1.0 - fc) + b * fc) * (1.0 - fr) + (d * (1.0 - fc) + e * fc) * fr)
    }
    /// Cell size in metres (north-south, east-west) on a body.
    pub fn cell_m(&self, world: World) -> (f64, f64) {
        let k = world.info().radius_km * 1000.0 * std::f64::consts::PI / 180.0;
        let mid = self.lat((self.rows as f64 - 1.0) / 2.0).to_radians().cos();
        (self.dlat * k, self.dlon * k * mid)
    }
}

#[derive(Copy, Clone, PartialEq)]
struct Node(f64, usize);
impl Eq for Node {}
impl Ord for Node {
    fn cmp(&self, o: &Self) -> Ordering {
        o.0.partial_cmp(&self.0).unwrap_or(Ordering::Equal)
    }
}
impl PartialOrd for Node {
    fn partial_cmp(&self, o: &Self) -> Option<Ordering> {
        Some(self.cmp(o))
    }
}

/// Result of [`reach`]: per-cell share of the budget used for out + back (≤ 1 is reachable).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Reach {
    pub rows: usize,
    pub cols: usize,
    /// Row-major; `None` where unreachable even in theory (holes, outside).
    pub ratio: Vec<Option<f64>>,
    pub budget_h: f64,
    /// Area of reachable cells, km².
    pub area_km2: f64,
    /// Farthest reachable straight-line distance from base, km.
    pub max_km: f64,
}

/// Base cell index of `(lat, lon)`, clamped into the grid.
fn base_cell(g: &Grid, lat: f64, lon: f64) -> (usize, usize) {
    let (br, bc) = g.rc(lat, lon);
    (
        br.round().clamp(0.0, (g.rows - 1) as f64) as usize,
        bc.round().clamp(0.0, (g.cols - 1) as f64) as usize,
    )
}

/// Effort-hours from the base cell to every cell (`reverse`: from every cell back to the base),
/// up to the budget; steps steeper than `max_slope_deg` are not walkable.
fn efforts(
    world: World,
    g: &Grid,
    start: usize,
    p: &EvaParams,
    max_slope_deg: f64,
    reverse: bool,
) -> Vec<f64> {
    dijkstra(world, g, start, p, max_slope_deg, reverse, p.budget(), None).0
}

/// Effort-hours to walk `dist` metres from elevation `za` to `zb`; `None` when steeper than
/// `max_slope` (rise over run).
fn step_cost(
    p: &EvaParams,
    za: Option<f64>,
    zb: Option<f64>,
    dist: f64,
    max_slope: f64,
) -> Option<f64> {
    let slope = match (za, zb) {
        (Some(za), Some(zb)) => (zb - za) / dist,
        _ => p.unknown_slope.abs(),
    };
    if slope.abs() > max_slope {
        return None;
    }
    Some(dist / (p.speed_kmh * 1000.0 * slope_factor(slope)) * effort_factor(slope))
}

/// Effort-hours to walk the straight line between two points, sampled about once per cell.
fn line_cost(
    world: World,
    g: &Grid,
    a: (f64, f64),
    b: (f64, f64),
    p: &EvaParams,
    max_slope: f64,
) -> Option<f64> {
    let (dy, dx) = g.cell_m(world);
    let len = (((b.0 - a.0) / g.dlat * dy).powi(2) + ((b.1 - a.1) / g.dlon * dx).powi(2)).sqrt();
    let n = ((len / dy.min(dx)).ceil() as usize).max(1);
    let seg = len / n as f64;
    let mut total = 0.0;
    let mut prev = g.sample(a.0, a.1);
    for k in 1..=n {
        let f = k as f64 / n as f64;
        let z = g.sample(a.0 + (b.0 - a.0) * f, a.1 + (b.1 - a.1) * f);
        total += step_cost(p, prev, z, seg, max_slope)?;
        prev = z;
    }
    Some(total)
}

/// Dijkstra over the 8-neighbour graph from `start`, up to `cap` effort-hours, stopping early
/// once `target` is settled. Returns effort per cell and each cell's predecessor.
#[allow(clippy::too_many_arguments)]
fn dijkstra(
    world: World,
    g: &Grid,
    start: usize,
    p: &EvaParams,
    max_slope_deg: f64,
    reverse: bool,
    cap: f64,
    target: Option<usize>,
) -> (Vec<f64>, Vec<usize>) {
    let n = g.rows * g.cols;
    let budget = cap;
    let (dy, dx) = g.cell_m(world);
    let max_slope = max_slope_deg.to_radians().tan();
    // Effort-hours to step from cell a to neighbour b.
    let step = |a: usize, b: usize, dist: f64| step_cost(p, g.z[a], g.z[b], dist, max_slope);
    let dirs: [(i64, i64); 8] = [
        (-1, 0),
        (1, 0),
        (0, -1),
        (0, 1),
        (-1, -1),
        (-1, 1),
        (1, -1),
        (1, 1),
    ];
    let mut best = vec![f64::INFINITY; n];
    let mut prev = vec![usize::MAX; n];
    let mut heap = BinaryHeap::new();
    best[start] = 0.0;
    heap.push(Node(0.0, start));
    while let Some(Node(cost, i)) = heap.pop() {
        if cost > best[i] || cost > budget {
            continue;
        }
        if Some(i) == target {
            break;
        }
        let (r, c) = ((i / g.cols) as i64, (i % g.cols) as i64);
        for (ddr, ddc) in dirs {
            let (nr, nc) = (r + ddr, c + ddc);
            if nr < 0 || nc < 0 || nr >= g.rows as i64 || nc >= g.cols as i64 {
                continue;
            }
            let j = nr as usize * g.cols + nc as usize;
            let dist = ((ddr as f64 * dy).powi(2) + (ddc as f64 * dx).powi(2)).sqrt();
            // Outbound: i → j. Return trip: walking j → i, so cost the reverse step.
            let s = if reverse {
                step(j, i, dist)
            } else {
                step(i, j, dist)
            };
            if let Some(s) = s {
                let nc2 = cost + s;
                if nc2 < best[j] {
                    best[j] = nc2;
                    prev[j] = i;
                    heap.push(Node(nc2, j));
                }
            }
        }
    }
    (best, prev)
}

/// Least-effort walking path between two points over the grid (the "easy path" when drawing a
/// route): cell centres from `from` to `to`, with the end points themselves at both ends.
/// `None` when either point is outside the grid or no walkable path connects them.
pub fn easy_path(
    world: World,
    g: &Grid,
    from: (f64, f64),
    to: (f64, f64),
    p: &EvaParams,
    max_slope_deg: f64,
) -> Option<Vec<(f64, f64)>> {
    if !g.contains(from.0, from.1) || !g.contains(to.0, to.1) || g.rows == 0 || g.cols == 0 {
        return None;
    }
    let (ar, ac) = base_cell(g, from.0, from.1);
    let (br, bc) = base_cell(g, to.0, to.1);
    let (a, b) = (ar * g.cols + ac, br * g.cols + bc);
    let (best, prev) = dijkstra(world, g, a, p, max_slope_deg, false, f64::INFINITY, Some(b));
    if !best[b].is_finite() {
        return None;
    }
    let mut cells = vec![b];
    while let Some(&i) = cells.last() {
        if i == a {
            break;
        }
        cells.push(prev[i]);
    }
    cells.reverse();
    // Grid path: the end points themselves, cell centres in between.
    let ll = |i: usize| (g.lat((i / g.cols) as f64), g.lon((i % g.cols) as f64));
    let mut pts: Vec<(f64, f64)> = cells.iter().map(|&i| ll(i)).collect();
    let mut cost: Vec<f64> = cells.iter().map(|&i| best[i]).collect();
    pts[0] = from;
    if pts.len() > 1 {
        *pts.last_mut().unwrap() = to;
    } else {
        pts.push(to);
        cost.push(best[b]);
    }
    // String-pull: an 8-neighbour path zigzags even on flat ground, so from each anchor jump to
    // the farthest point whose straight line costs no more than 3% over the grid path to it.
    let max_slope = max_slope_deg.to_radians().tan();
    let mut out = vec![pts[0]];
    let mut i = 0;
    while i + 1 < pts.len() {
        let mut j = i + 1;
        for k in (i + 2..pts.len()).rev() {
            let grid_cost = cost[k] - cost[i];
            if let Some(c) = line_cost(world, g, pts[i], pts[k], p, max_slope) {
                if c <= grid_cost * 1.03 + 1e-9 {
                    j = k;
                    break;
                }
            }
        }
        out.push(pts[j]);
        i = j;
    }
    Some(out)
}

/// Per cell: effort to walk back to the base only, as a share of the budget (≤ 1: can walk home).
/// `None` where the base cannot be reached within the budget. Used when the crew is already out
/// there (for example a rover that broke down) and only the walk home counts.
pub fn home_ratio(
    world: World,
    g: &Grid,
    base_lat: f64,
    base_lon: f64,
    p: &EvaParams,
    max_slope_deg: f64,
) -> Vec<Option<f64>> {
    let budget = p.budget();
    let (br, bc) = base_cell(g, base_lat, base_lon);
    efforts(world, g, br * g.cols + bc, p, max_slope_deg, true)
        .into_iter()
        .map(|t| (t.is_finite() && budget > 0.0).then(|| t / budget))
        .collect()
}

/// Walk-home area around a base. Steps steeper than `max_slope_deg` are not walkable.
pub fn reach(
    world: World,
    g: &Grid,
    base_lat: f64,
    base_lon: f64,
    p: &EvaParams,
    max_slope_deg: f64,
) -> Reach {
    let n = g.rows * g.cols;
    let budget = p.budget();
    let (dy, dx) = g.cell_m(world);
    let (br, bc) = base_cell(g, base_lat, base_lon);
    let start = br * g.cols + bc;
    let run = |reverse: bool| efforts(world, g, start, p, max_slope_deg, reverse);
    let out = run(false);
    let back = run(true);
    let mut area = 0.0;
    let mut max_km = 0.0_f64;
    let ratio = (0..n)
        .map(|i| {
            let t = out[i] + back[i];
            if !t.is_finite() || budget <= 0.0 {
                return None;
            }
            let r = t / budget;
            if r <= 1.0 {
                area += dx * dy / 1e6;
                let (rr, cc) = ((i / g.cols) as f64, (i % g.cols) as f64);
                let d = (((rr - br as f64) * dy).powi(2) + ((cc - bc as f64) * dx).powi(2)).sqrt();
                max_km = max_km.max(d / 1000.0);
            }
            Some(r)
        })
        .collect();
    Reach {
        rows: g.rows,
        cols: g.cols,
        ratio,
        budget_h: budget,
        area_km2: area,
        max_km,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn flat(rows: usize, cols: usize, d: f64) -> Grid {
        Grid {
            lat0: 0.0,
            lon0: 0.0,
            dlat: d,
            dlon: d,
            rows,
            cols,
            z: vec![Some(0.0); rows * cols],
        }
    }
    fn params() -> EvaParams {
        EvaParams {
            water_h: 100.0,
            min_reserve_h: 0.0,
            ..EvaParams::new(2.0, 2.0, 0.0)
        }
    }

    #[test]
    fn bilinear_sample() {
        let mut g = flat(2, 2, 1.0);
        g.z = vec![Some(0.0), Some(10.0), Some(20.0), Some(30.0)];
        assert!((g.sample(-0.5, 0.5).unwrap() - 15.0).abs() < 1e-9);
        assert!(g.sample(1.0, 0.0).is_none());
    }

    #[test]
    fn flat_reach_is_about_half_budget_radius() {
        // 2 h budget at 2 km/h → 2 km out and 2 km back. Cell ≈ 59 m on Mars at 0.001°.
        let g = flat(161, 161, 0.001);
        let r = reach(World::Mars, &g, -0.08, 0.08, &params(), 25.0);
        assert!((r.max_km - 2.0).abs() < 0.15, "max_km {}", r.max_km);
        let disk = std::f64::consts::PI * 4.0;
        assert!(
            r.area_km2 > disk * 0.75 && r.area_km2 < disk * 1.05,
            "area {}",
            r.area_km2
        );
    }

    #[test]
    fn a_wall_blocks_the_way() {
        let mut g = flat(61, 61, 0.001);
        // 500 m cliff along column 40.
        for r in 0..61 {
            for c in 40..61 {
                g.z[r * 61 + c] = Some(500.0);
            }
        }
        let rr = reach(World::Mars, &g, -0.03, 0.03, &params(), 25.0);
        let east = rr.ratio[30 * 61 + 45];
        assert!(east.is_none(), "beyond the cliff should be unreachable");
        assert!(rr.ratio[30 * 61 + 35].unwrap() < 1.0);
    }

    #[test]
    fn easy_path_goes_around_a_wall() {
        let mut g = flat(61, 61, 0.001);
        // 500 m wall across column 30, open at the south end (rows 50..).
        for r in 0..50 {
            g.z[r * 61 + 30] = Some(500.0);
        }
        let path = easy_path(
            World::Mars,
            &g,
            (-0.03, -0.0),
            (-0.03, 0.06),
            &params(),
            25.0,
        )
        .unwrap();
        assert_eq!(path.first(), Some(&(-0.03, -0.0)));
        assert_eq!(path.last(), Some(&(-0.03, 0.06)));
        // It must pass the wall through the gap, south of row 50 (lat ≤ -0.05).
        assert!(
            path.iter().any(|&(lat, _)| lat <= -0.0495),
            "path did not detour"
        );
        // Flat ground: the straight line, no zigzag points.
        let flat_path = easy_path(
            World::Mars,
            &flat(61, 61, 0.001),
            (-0.01, 0.0),
            (-0.05, 0.03),
            &params(),
            25.0,
        )
        .unwrap();
        assert_eq!(flat_path.len(), 2, "{flat_path:?}");
        // Outside the grid: no path.
        assert!(easy_path(World::Mars, &g, (1.0, 0.0), (-0.03, 0.06), &params(), 25.0).is_none());
    }
}
