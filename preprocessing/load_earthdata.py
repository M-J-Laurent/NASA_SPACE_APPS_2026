"""Load variables that need a free NASA Earthdata login (MERRA-2 from GES DISC) into data/raw/.

One-time setup:
  1. Create a free account: https://urs.earthdata.nasa.gov/users/new
  2. Authorise the "NASA GESDISC DATA ARCHIVE" application:
     https://urs.earthdata.nasa.gov/profile  ->  Applications  ->  Authorized Apps  ->  Approve More Applications
  3. Run this script in a terminal; it asks for your username/password once and stores them in ~/.netrc
     (or set EARTHDATA_USERNAME / EARTHDATA_PASSWORD environment variables and it will use those).

Run from repo root:  .venv/Scripts/python preprocessing/load_earthdata.py
Needs data/raw/grid.json first (run load_real.py). Only the one variable per product is read (remote subsetting),
but expect it to take several minutes per variable: it opens ~300 monthly files.
"""
import sys

import earthaccess
import numpy as np
import xarray as xr

import load_real as base

PRODUCTS = {
    # key: (collection short name, variable)
    "aod": ("M2TMNXAER", "TOTEXTTAU"),     # total aerosol extinction optical depth at 550 nm
    "soilwet": ("M2TMNXLND", "GWETROOT"),  # root-zone soil wetness (0-1)
}


def login():
    for strategy in ("environment", "netrc", "interactive"):
        try:
            auth = earthaccess.login(strategy=strategy, persist=(strategy == "interactive"))
        except Exception as e:  # strategy not available (no env vars / no ~/.netrc yet) or bad credentials
            print(f"login via {strategy}: {type(e).__name__}")
            continue
        if auth.authenticated:
            return
    sys.exit("Earthdata login failed.")


def load(short_name, var):
    results = earthaccess.search_data(short_name=short_name,
                                      temporal=(f"{base.START_YEAR}-01-01", f"{base.END_YEAR}-12-31"))
    n = (base.END_YEAR - base.START_YEAR + 1) * 12
    if len(results) != n:
        raise ValueError(f"{short_name}: expected {n} monthly granules, found {len(results)}")
    files = earthaccess.open(results)
    ds = xr.open_mfdataset(files, engine="h5netcdf", combine="by_coords", preprocess=lambda d: d[[var]])
    da = ds[var].sortby("time")
    if da.sizes["time"] != n:
        raise ValueError(f"{short_name}: expected {n} months, got {da.sizes['time']}")
    v = da.values.astype("float64")
    v[np.abs(v) > 1e10] = np.nan  # MERRA-2 fill value is 1e15
    return v, da["lat"].values, da["lon"].values


def main():
    if not (base.RAW / "grid.json").exists():
        sys.exit("Run preprocessing/load_real.py first (it creates grid.json).")
    login()
    for key, (short, var) in PRODUCTS.items():
        print(f"{key}: fetching {short}/{var} ...")
        v, lats, lons = load(short, var)
        out = base.regrid(v, lats, lons)
        np.save(base.RAW / f"{key}.npy", out)
        print(f"{key}: saved {out.shape}")


if __name__ == "__main__":
    main()

