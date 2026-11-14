"""Domain masks and conservative gap filling.

Domain masks keep each variable to where it is physically measured *independently* (e.g. GISTEMP
over oceans is just ERSST, so temperature is land-only to avoid double counting with sea surface
temperature). Gap filling only touches small holes (default <= 4 cells) that are surrounded by data
inside the variable's domain. Large gaps (poles, sea-ice, missing coverage) stay empty.
"""
import numpy as np
from global_land_mask import globe
from scipy import ndimage


def land_fraction(lats, lons, res, n=5):
    """Fraction of each res-degree cell that is land, by sampling an n x n sub-grid."""
    off = (np.arange(n) + 0.5) / n * res - res / 2
    out = np.zeros((len(lats), len(lons)))
    for dy in off:
        for dx in off:
            la = np.clip(lats[:, None] + dy, -89.99, 89.99) + np.zeros((1, len(lons)))
            lo = ((lons[None, :] + dx + 180) % 360 - 180) + np.zeros((len(lats), 1))
            out += globe.is_land(la, lo)
    return out / n ** 2


def domain_mask(kind, lats, lons, res):
    """kind: 'land', 'ocean' or None (everywhere). Cells are land if >= 50% land."""
    if kind is None:
        return np.ones((len(lats), len(lons)), bool)
    land = land_fraction(lats, lons, res) >= 0.5
    return land if kind == "land" else ~land


def fill_small_holes(monthly, domain, max_size=4, min_valid=0.8, min_nbrs=8):
    """Fill small interior holes by inverse-distance weighting of nearby valid cells (5x5 window).

    A cell is "missing" if it is in-domain but has < min_valid of its months. Connected groups of
    missing cells (8-connectivity, wrapping across the dateline) with at most max_size cells are
    filled, provided >= min_nbrs of the 24 surrounding cells have data.
    Returns (filled_monthly, filled_mask).
    """
    nlat, nlon = domain.shape
    valid = (~np.isnan(monthly)).mean(axis=0) >= min_valid
    missing = domain & ~valid
    # label with wrapped longitude padding so holes on the dateline are measured correctly
    pad = max_size
    padded = np.concatenate([missing[:, -pad:], missing, missing[:, :pad]], axis=1)
    lab, n = ndimage.label(padded, structure=np.ones((3, 3)))
    sizes = ndimage.sum(padded, lab, index=np.arange(1, n + 1))
    small = np.isin(lab, 1 + np.flatnonzero(sizes <= max_size))[:, pad:-pad]
    holes = small & missing

    out = monthly.copy()
    filled = np.zeros_like(holes)
    for i, j in zip(*np.nonzero(holes)):
        nb, w = [], []
        for di in range(-2, 3):
            for dj in range(-2, 3):
                ii, jj = i + di, (j + dj) % nlon
                if (di or dj) and 0 <= ii < nlat and valid[ii, jj] and domain[ii, jj]:
                    nb.append((ii, jj)); w.append(1.0 / np.hypot(di, dj))
        if len(nb) < min_nbrs:
            continue
        vals = np.stack([monthly[:, a, b] for a, b in nb], axis=1)  # (T, k)
        w = np.array(w)[None, :] * ~np.isnan(vals)
        with np.errstate(invalid="ignore", divide="ignore"):
            out[:, i, j] = np.where(w.sum(1) > 0, (np.nan_to_num(vals) * w).sum(1) / w.sum(1), np.nan)
        filled[i, j] = True
    return out, filled
