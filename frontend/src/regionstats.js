// Region selection helpers: which grid cells fall inside a region, and trend statistics for a regional-average series.
import { geoCircle, geoPath, geoEquirectangular } from 'd3-geo';

const KM_PER_DEG = 111.195;

/** A circle of radius `km` around a point, as a GeoJSON polygon geometry. */
export const circleGeometry = (lat, lon, km) => geoCircle().center([lon, lat]).radius(km / KM_PER_DEG).precision(2)();

// Which grid cells are inside a region, and how much of each cell. The region is drawn once on a scratch canvas that has the
// same pixel grid as the land mask (so every pixel knows whether it is land or sea); then, per 2-degree cell, we measure the
// fraction of the cell that lies in the region, in the region AND on land, and in the region AND at sea. Land-only and
// ocean-only layers use only the matching part, so a coastal cell that merely touches a sea (or a country that merely touches
// the coast) does not leak land data into the ocean region or the reverse.
let scratch, pixelCounts, landTotals; // landTotals: land fraction of each whole cell
function scratchFor(TW, TH) {
  if (!scratch || scratch.TW !== TW || scratch.TH !== TH) {
    const c = document.createElement('canvas'); c.width = TW; c.height = TH;
    const g = c.getContext('2d', { willReadFrequently: true });
    scratch = { g, TW, TH, path: geoPath(geoEquirectangular().scale(TW / (2 * Math.PI)).translate([TW / 2, TH / 2]), g) };
    pixelCounts = null; landTotals = null;
  }
  return scratch;
}
const cellOf = (px, py, TW, TH, nlat, nlon) => Math.min(nlat - 1, Math.floor((1 - (py + 0.5) / TH) * nlat)) * nlon + Math.min(nlon - 1, Math.floor(((px + 0.5) / TW) * nlon));

/** landFrac: land fraction (0..1) per scratch pixel. Returns {cov:{all,land,ocean}, touched, cells, weights, areaKm2, centre}. */
export function cellsInside(geometry, manifest, landFrac, TW, TH) {
  const { nlat, nlon, res } = manifest, N = nlat * nlon, { g, path } = scratchFor(TW, TH);
  if (!pixelCounts) {
    pixelCounts = new Float32Array(N); landTotals = new Float32Array(N);
    for (let py = 0; py < TH; py++) for (let px = 0; px < TW; px++) { const c = cellOf(px, py, TW, TH, nlat, nlon); pixelCounts[c]++; landTotals[c] += landFrac[py * TW + px]; }
    for (let c = 0; c < N; c++) landTotals[c] /= pixelCounts[c] || 1;
  }
  g.clearRect(0, 0, TW, TH); g.fillStyle = '#fff'; g.beginPath(); path(geometry); g.fill();
  const [[bx0, by0], [bx1, by1]] = path.bounds(geometry);
  const y0 = Math.max(0, Math.floor(by0) - 1), y1 = Math.min(TH - 1, Math.ceil(by1) + 1);
  const wide = !(bx1 - bx0 < TW * 0.9), x0 = wide ? 0 : Math.max(0, Math.floor(bx0) - 1), x1 = wide ? TW - 1 : Math.min(TW - 1, Math.ceil(bx1) + 1);
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  const data = h > 0 && w > 0 ? g.getImageData(x0, y0, w, h).data : new Uint8ClampedArray(0);
  const all = new Float32Array(N), land = new Float32Array(N), ocean = new Float32Array(N);
  for (let py = y0; py <= y1; py++) for (let px = x0; px <= x1; px++) {
    const a = data[((py - y0) * w + (px - x0)) * 4 + 3];
    if (!a) continue;
    const al = a / 255, c = cellOf(px, py, TW, TH, nlat, nlon), L = landFrac[py * TW + px];
    all[c] += al; land[c] += al * L; ocean[c] += al * (1 - L);
  }
  const touched = [], cells = [], weights = []; let best = -1, bestCov = 0, area = 0, vx = 0, vy = 0, vz = 0;
  for (let c = 0; c < N; c++) {
    if (!all[c]) continue;
    all[c] /= pixelCounts[c]; land[c] /= pixelCounts[c]; ocean[c] /= pixelCounts[c];
    touched.push(c);
    if (all[c] > bestCov) { bestCov = all[c]; best = c; }
  }
  const add = (c) => {
    const lat = -90 + res * (Math.floor(c / nlon) + 0.5), lon = -180 + res * ((c % nlon) + 0.5), cw = Math.cos((lat * Math.PI) / 180);
    cells.push(c); weights.push(cw); area += res * KM_PER_DEG * res * KM_PER_DEG * cw * all[c];
    const la = (lat * Math.PI) / 180, lo = (lon * Math.PI) / 180;
    vx += Math.cos(la) * Math.cos(lo); vy += Math.cos(la) * Math.sin(lo); vz += Math.sin(la);
  };
  for (const c of touched) if (all[c] >= 0.5) add(c); // "the region's cells": those mostly inside it
  if (!cells.length && best >= 0 && bestCov >= 0.15) add(best); // tiny region: use the single cell that covers most of it
  const centre = cells.length ? { lat: (Math.atan2(vz, Math.hypot(vx, vy)) * 180) / Math.PI, lon: (Math.atan2(vy, vx) * 180) / Math.PI } : null;
  return { cov: { all, land, ocean }, landTotals, touched, cells, weights, areaKm2: area, centre };
}

/** The cells (and weights) a layer should use for a region: only the part of the region in the layer's own domain
 *  (land-only layers see land, ocean-only layers see sea, other layers see the whole cell). A cell is used when more than half
 *  of the part of it the layer can see lies inside the region; it is weighted by that overlapped area. */
export function domainCells(v, region, manifest) {
  const { nlon, res } = manifest;
  const kind = v.domain === 'land' || v.domain === 'ocean' ? v.domain : 'all';
  const cov = region.cov[kind], cells = [], weights = [];
  for (const c of region.touched) {
    const own = kind === 'land' ? region.landTotals[c] : kind === 'ocean' ? 1 - region.landTotals[c] : 1; // the layer's part of this cell
    if (own < 0.05 || cov[c] / own < 0.5) continue;
    cells.push(c); weights.push(Math.cos(((-90 + res * (Math.floor(c / nlon) + 0.5)) * Math.PI) / 180) * cov[c]);
  }
  return { cells, weights };
}

/** Area-weighted regional mean of one variable's yearly series. Cells without data (NaN) are skipped year by year. */
export function regionalSeries(v, list, manifest) {
  const { nlat, nlon, n_years } = manifest, N = nlat * nlon, ys = new Array(n_years).fill(NaN);
  let used = 0;
  for (let k = 0; k < n_years; k++) {
    let sum = 0, ws = 0;
    list.cells.forEach((c, m) => {
      if (isNaN(v.slope[c])) return;
      const y = v.annual[k * N + c];
      if (!isNaN(y)) { sum += y * list.weights[m]; ws += list.weights[m]; }
    });
    if (ws > 0) ys[k] = sum / ws;
  }
  list.cells.forEach((c) => { if (!isNaN(v.slope[c])) used++; });
  return { ys, cellsUsed: used };
}

const erf = (x) => { // Abramowitz & Stegun 7.1.26
  const s = Math.sign(x); x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  return s * (1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x));
};
const normCdf = (z) => 0.5 * (1 + erf(z / Math.SQRT2));
const median = (a) => { const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

/** Theil-Sen slope (per year), its 95% confidence interval (Sen's method), and a Mann-Kendall p-value that is
 *  corrected for lag-1 autocorrelation (variance inflation). ys is one value per year starting at `startYear`. */
export function trendOf(ys) {
  const pts = []; ys.forEach((y, k) => { if (!isNaN(y)) pts.push([k, y]); });
  const n = pts.length;
  if (n < 8) return null;
  const slopes = []; let S = 0;
  for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) {
    const dy = pts[b][1] - pts[a][1];
    slopes.push(dy / (pts[b][0] - pts[a][0])); S += Math.sign(dy);
  }
  slopes.sort((x, y) => x - y);
  const slope = median(slopes);
  const icpt = median(pts.map(([k, y]) => y - slope * k));
  // lag-1 autocorrelation of the detrended series -> inflate the variance of S (Yue & Wang style), never deflate
  const res = pts.map(([k, y]) => y - slope * k - icpt), mr = res.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { den += (res[i] - mr) ** 2; if (i) num += (res[i] - mr) * (res[i - 1] - mr); }
  const r1 = den > 0 ? Math.max(0, Math.min(0.9, num / den)) : 0, infl = (1 + r1) / (1 - r1);
  const varS = ((n * (n - 1) * (2 * n + 5)) / 18) * infl;
  const z = S === 0 ? 0 : (S - Math.sign(S)) / Math.sqrt(varS);
  const p = 2 * (1 - normCdf(Math.abs(z)));
  const N = slopes.length, C = 1.959964 * Math.sqrt(varS);
  const lo = slopes[Math.max(0, Math.floor((N - C) / 2))], hi = slopes[Math.min(N - 1, Math.ceil((N + C) / 2))];
  return { slope, lo, hi, p, z, r1, n, icpt };
}
