"""Turn downloaded NetCDF files into data/raw/<var>.npy on the common grid.

Run from repo root:  .venv\\Scripts\\python preprocessing\\load_real.py
Each source is regridded (bilinear, longitude-wrapped) onto one common 2-degree grid and cut to the
same whole-year period, so every variable has shape (n_months, nlat, nlon).
Cells with any missing neighbour stay NaN (we never invent data).
"""
import json
from pathlib import Path

import netCDF4 as nc
import numpy as np
from scipy.ndimage import map_coordinates

ROOT = Path(__file__).resolve().parent.parent
DL = ROOT / "data" / "downloads"
RAW = ROOT / "data" / "raw"

RES = 2.0
START_YEAR, END_YEAR = 1996, 2025  # inclusive; every source covers this fully
DST_LATS = np.arange(-89, 90, RES)      # 90 cells, matches GISTEMP
DST_LONS = np.arange(-179, 180, RES)    # 180 cells

SOURCES = {
    # var: (file, netcdf variable, offset to add [K->C not needed: anomalies], description)
    "temp": ("gistemp/gistemp.nc", "tempanomaly"),
    "precip": ("gpcp/precip.mon.mean.nc", "precip"),
    "sst": ("ersst/sst.mnmean.nc", "sst"),
}


def regrid(arr, src_lats, src_lons, dst_lats=DST_LATS, dst_lons=DST_LONS):
    """Bilinear regrid (t, lat, lon). Longitudes wrap; latitudes outside the source range become NaN."""
    src_lons = np.asarray(src_lons) % 360
    dst = np.asarray(dst_lons) % 360
    order = np.argsort(src_lons)
    src_lons, arr = src_lons[order], arr[:, :, order]
    if np.asarray(src_lats)[0] > np.asarray(src_lats)[-1]:  # make south -> north
        src_lats, arr = np.asarray(src_lats)[::-1], arr[:, ::-1, :]
    src_lats = np.asarray(src_lats)
    # pad one column each side so bilinear interpolation wraps across the dateline
    arr = np.concatenate([arr[:, :, -1:], arr, arr[:, :, :1]], axis=2)
    lons_p = np.concatenate([[src_lons[-1] - 360], src_lons, [src_lons[0] + 360]])
    fi = np.interp(dst_lats, src_lats, np.arange(len(src_lats)))
    fj = np.interp(dst, lons_p, np.arange(len(lons_p)))
    outside = (dst_lats < src_lats[0] - 1e-6) | (dst_lats > src_lats[-1] + 1e-6)
    II, JJ = np.meshgrid(fi, fj, indexing="ij")
    out = np.stack([map_coordinates(a, [II, JJ], order=1, mode="nearest") for a in arr]).astype("float32")
    out[:, outside, :] = np.nan
    return out


def read(path, var):
    d = nc.Dataset(path)
    t = nc.num2date(d["time"][:], d["time"].units, only_use_cftime_datetimes=False, only_use_python_datetimes=True)
    ym = np.array([(x.year, x.month) for x in t])
    keep = (ym[:, 0] >= START_YEAR) & (ym[:, 0] <= END_YEAR)
    v = np.ma.filled(d[var][keep].astype("float64"), np.nan)
    v[np.abs(v) > 1e4] = np.nan  # leftover fill values
    n = (END_YEAR - START_YEAR + 1) * 12
    if v.shape[0] != n or ym[keep][0].tolist() != [START_YEAR, 1]:
        raise ValueError(f"{path}: expected {n} contiguous months starting Jan {START_YEAR}, got {v.shape[0]}")
    return v, d["lat"][:].data, d["lon"][:].data


def main():
    RAW.mkdir(parents=True, exist_ok=True)
    for key, (rel, var) in SOURCES.items():
        v, lats, lons = read(DL / rel, var)
        out = regrid(v, lats, lons)
        np.save(RAW / f"{key}.npy", out)
        print(f"{key}: {rel} {v.shape[1:]} -> {out.shape[1:]}, {np.isnan(out[0]).mean() * 100:.0f}% empty in first month")
    (RAW / "grid.json").write_text(json.dumps(dict(
        res=RES, lats=DST_LATS.tolist(), lons=DST_LONS.tolist(),
        start_year=START_YEAR, n_years=END_YEAR - START_YEAR + 1, synthetic=False)))


if __name__ == "__main__":
    main()
