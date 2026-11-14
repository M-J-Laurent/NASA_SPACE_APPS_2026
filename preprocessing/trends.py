"""Vectorised trend statistics on (time, lat, lon) grids."""
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


def mann_kendall(x: np.ndarray, min_valid: float = 0.8):
    """Mann-Kendall test along axis 0 for every cell, tolerating missing values.
    Cells with fewer than min_valid of the time steps present -> NaN. Returns (Z, p)."""
    T = x.shape[0]
    s = np.zeros(x.shape[1:])
    for k in range(1, T):
        s += np.nansum(np.sign(x[k:] - x[:-k]), axis=0)  # NaN pairs contribute 0
    n = (~np.isnan(x)).sum(axis=0).astype(float)
    var = n * (n - 1) * (2 * n + 5) / 18.0  # no tie correction (continuous data)
    with np.errstate(invalid="ignore", divide="ignore"):
        sd = np.sqrt(var)
        z = np.where(s > 0, (s - 1) / sd, np.where(s < 0, (s + 1) / sd, 0.0))
    p = 2 * (1 - stats.norm.cdf(np.abs(z)))
    bad = n < min_valid * T
    z[bad] = np.nan
    p[bad] = np.nan
    return z, p


def linear_slope(x: np.ndarray, t: np.ndarray, min_valid: float = 0.8) -> np.ndarray:
    """OLS slope per cell (units per unit t), ignoring missing values."""
    ok = ~np.isnan(x)
    tt = np.broadcast_to(t[:, None, None], x.shape)
    n = ok.sum(axis=0)
    with np.errstate(invalid="ignore", divide="ignore"):
        tm = np.where(ok, tt, 0).sum(axis=0) / n
        xm = np.where(ok, x, 0).sum(axis=0) / n
        num = np.where(ok, (tt - tm) * (x - xm), 0).sum(axis=0)
        den = np.where(ok, (tt - tm) ** 2, 0).sum(axis=0)
        slope = num / den
    slope[n < min_valid * x.shape[0]] = np.nan
    return slope


def trend_stats(monthly: np.ndarray, years_per_step: float = 1 / 12):
    """Deseasonalise, then return slope per year, MK Z and p-value per cell."""
    anom = deseasonalize(monthly)
    t = np.arange(anom.shape[0]) * years_per_step
    slope = linear_slope(anom, t)
    z, p = mann_kendall(anom)
    return slope, z, p
