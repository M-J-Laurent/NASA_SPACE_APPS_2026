"""Trend statistics on (time, lat, lon) grids.

Rate of change:  Theil-Sen slope (median of all pairwise slopes), robust to outliers.
Significance:    Mann-Kendall test with the Hamed-Rao correction for autocorrelation. Monthly data are
                 serially correlated, which makes the plain test over-confident; the correction inflates the
                 test's variance by the amount of autocorrelation found in the detrended series.
Both tolerate missing months (cells need >= min_valid of the record).
"""
import numpy as np
from scipy import stats


def deseasonalize(monthly: np.ndarray) -> np.ndarray:
    """Remove the mean seasonal cycle. monthly: (n_months, lat, lon), starts in January."""
    out = monthly.copy()
    for m in range(12):
        out[m::12] -= np.nanmean(monthly[m::12], axis=0)
    return out


def annual_means(monthly: np.ndarray) -> np.ndarray:
    n = monthly.shape[0] // 12
    return np.nanmean(monthly[: n * 12].reshape(n, 12, *monthly.shape[1:]), axis=1)


def _trend_chunk(x: np.ndarray, t: np.ndarray, pairs):
    """x: (T, C) float32 with NaN gaps. Returns Theil-Sen slope, Z, p for each of the C series."""
    T = x.shape[0]
    iu, ju = pairs
    n = (~np.isnan(x)).sum(axis=0).astype(float)

    dx = x[ju] - x[iu]                                           # (pairs, C)
    slope = np.nanmedian(dx / (t[ju] - t[iu])[:, None], axis=0)  # Theil-Sen
    s = np.nansum(np.sign(dx), axis=0)                           # Mann-Kendall S statistic

    # Hamed-Rao: autocorrelation of the ranks of the detrended series
    d = x - slope * t[:, None]
    r = stats.rankdata(d, axis=0, nan_policy="omit")
    rc = np.nan_to_num(r - np.nanmean(r, axis=0))
    denom = (rc ** 2).sum(axis=0)
    acc = np.zeros_like(slope, dtype="float64")
    for k in range(1, T - 2):
        rho = (rc[k:] * rc[:-k]).sum(axis=0) / denom
        m = n - k
        lo, hi = (-1 - 1.96 * np.sqrt(np.maximum(m - 1, 0))) / m, (-1 + 1.96 * np.sqrt(np.maximum(m - 1, 0))) / m
        sig = (rho < lo) | (rho > hi)
        acc += np.where(sig, m * (m - 1) * (m - 2) * rho, 0.0)
    ratio = np.maximum(1.0, 1.0 + 2.0 * acc / (n * (n - 1) * (n - 2)))  # never *less* conservative than plain MK

    sd = np.sqrt(n * (n - 1) * (2 * n + 5) / 18.0 * ratio)
    z = np.where(s > 0, (s - 1) / sd, np.where(s < 0, (s + 1) / sd, 0.0))
    p = 2 * (1 - stats.norm.cdf(np.abs(z)))
    return slope, z, p


def trend_stats(monthly: np.ndarray, years_per_step: float = 1 / 12, min_valid: float = 0.8, chunk: int = 120):
    """Deseasonalise, then return (slope per year, Z, p) maps of shape (lat, lon)."""
    anom = deseasonalize(monthly)
    T, nlat, nlon = anom.shape
    flat = anom.reshape(T, -1).astype("float32")
    t = np.arange(T) * years_per_step
    pairs = np.triu_indices(T, 1)
    ok = (~np.isnan(flat)).mean(axis=0) >= min_valid
    cells = np.flatnonzero(ok)
    slope, z, p = (np.full(flat.shape[1], np.nan) for _ in range(3))
    for a in range(0, len(cells), chunk):
        c = cells[a:a + chunk]
        slope[c], z[c], p[c] = _trend_chunk(flat[:, c], t, pairs)
    return slope.reshape(nlat, nlon), z.reshape(nlat, nlon), p.reshape(nlat, nlon)
