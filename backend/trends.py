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


def mann_kendall(x: np.ndarray):
    """Mann-Kendall test along axis 0 for every cell. Returns (Z, p). NaN cells -> NaN."""
    n = x.shape[0]
    s = np.zeros(x.shape[1:])
    for k in range(1, n):
        s += np.sign(x[k:] - x[:-k]).sum(axis=0)
    var = n * (n - 1) * (2 * n + 5) / 18.0  # no tie correction (continuous data)
    z = np.where(s > 0, (s - 1) / np.sqrt(var), np.where(s < 0, (s + 1) / np.sqrt(var), 0.0))
    p = 2 * (1 - stats.norm.cdf(np.abs(z)))
    bad = np.isnan(x).any(axis=0)
    z[bad] = np.nan
    p[bad] = np.nan
    return z, p


def linear_slope(x: np.ndarray, t: np.ndarray) -> np.ndarray:
    """OLS slope per cell (units per unit t)."""
    tc = t - t.mean()
    xc = x - x.mean(axis=0)
    return (tc[:, None, None] * xc).sum(axis=0) / (tc ** 2).sum()


def trend_stats(monthly: np.ndarray, years_per_step: float = 1 / 12):
    """Deseasonalise, then return slope per year, MK Z and p-value per cell."""
    anom = deseasonalize(monthly)
    t = np.arange(anom.shape[0]) * years_per_step
    slope = linear_slope(anom, t)
    z, p = mann_kendall(anom)
    return slope, z, p
