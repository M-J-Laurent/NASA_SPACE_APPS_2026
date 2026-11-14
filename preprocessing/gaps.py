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


def fill_small_holes(monthly, domain, max_size=16, min_valid=0.8, min_nbrs=3):
    """Fill interior holes by working inward from their edges (inverse-distance weighting).

    A cell is "missing" if it is in-domain but has < min_valid of its months. Connected groups of
    missing cells (8-connectivity, wrapping across the dateline) with at most max_size cells are
    filled. Each pass fills the hole cells that have >= min_nbrs data cells among their 8 neighbours
    (using cells filled on earlier passes too), so big holes fill smoothly from the rim inward.
    Groups that cannot be reached this way (touching a large gap or the domain edge) are left empty.
    Returns (filled_monthly, filled_mask).
    """
    nlat, nlon = domain.shape
    valid = (~np.isnan(monthly)).mean(axis=0) >= min_valid
    missing = domain & ~valid
    pad = max_size
    padded = np.concatenate([missing[:, -pad:], missing, missing[:, :pad]], axis=1)
    lab, n = ndimage.label(padded, structure=np.ones((3, 3)))
    sizes = ndimage.sum(padded, lab, index=np.arange(1, n + 1))
    holes = np.isin(lab, 1 + np.flatnonzero(sizes <= max_size))[:, pad:-pad] & missing

    out = monthly.copy()
    have = valid & domain          # cells with usable series (grows as we fill)
    filled = np.zeros_like(holes)
    todo = holes.copy()
    offsets = [(di, dj) for di in (-1, 0, 1) for dj in (-1, 0, 1) if di or dj]
    for _ in range(max_size):
        batch = []
        for i, j in zip(*np.nonzero(todo)):
            nb = [(i + di, (j + dj) % nlon) for di, dj in offsets
                  if 0 <= i + di < nlat and have[i + di, (j + dj) % nlon]]
            if len(nb) >= min_nbrs:
                batch.append((i, j, nb))
        if not batch:
            break
        for i, j, nb in batch:  # all cells of a pass use only previous-pass data
            w = np.array([1.0 / np.hypot(a - i, ((b - j + nlon // 2) % nlon) - nlon // 2) for a, b in nb])
            vals = np.stack([out[:, a, b] for a, b in nb], axis=1)
            ww = w[None, :] * ~np.isnan(vals)
            with np.errstate(invalid="ignore", divide="ignore"):
                out[:, i, j] = np.where(ww.sum(1) > 0, (np.nan_to_num(vals) * ww).sum(1) / ww.sum(1), np.nan)
        for i, j, _ in batch:
            have[i, j] = True; filled[i, j] = True; todo[i, j] = False
    # a group is only acceptable if it was filled completely; otherwise undo it (partial fills look odd)
    lab2, n2 = ndimage.label(holes, structure=np.ones((3, 3)))
    for k in range(1, n2 + 1):
        grp = lab2 == k
        if (grp & todo).any():
            out[:, grp] = monthly[:, grp]
            filled &= ~grp
    return out, filled
