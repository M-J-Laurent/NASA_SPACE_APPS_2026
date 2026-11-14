"""Load variables that need a free NASA Earthdata login (MERRA-2 from GES DISC) into data/raw/.

One-time setup:
  1. Create a free account: https://urs.earthdata.nasa.gov/users/new
  2. Authorise the "NASA GESDISC DATA ARCHIVE" application:
     https://urs.earthdata.nasa.gov/profile  ->  Applications  ->  Authorized Apps  ->  Approve More Applications
  3. Run this script in a terminal; it asks for your username/password once and stores them in ~/.netrc
     (or set EARTHDATA_USERNAME / EARTHDATA_PASSWORD environment variables and it will use those).

Run from repo root:  .venv/Scripts/python preprocessing/load_earthdata.py [--force] [key ...]
With no keys it loads every product not already in data/raw; --force reloads. Each product is independent: a failure is
reported and the rest continue.
Needs data/raw/grid.json first (run load_real.py). Only the one variable per product is read (remote subsetting),
but expect it to take several minutes per variable: it opens ~300 monthly files.
"""
import sys

import earthaccess
import numpy as np
import xarray as xr

import load_real as base

DAY = 86400.0  # kg m-2 s-1 -> mm/day
PRODUCTS = {
    # key: (collection short name, variable, multiply by)
    "aod": ("M2TMNXAER", "TOTEXTTAU", 1.0),     # total aerosol extinction optical depth at 550 nm
    "soilwet": ("M2TMNXLND", "GWETROOT", 1.0),  # root-zone soil wetness (0-1)
    "evap": ("M2TMNXFLX", "EVAP", DAY),         # evaporation, mm/day
    "runoff": ("M2TMNXLND", "RUNOFF", DAY),     # overland runoff (a streamflow proxy), mm/day
    "cloud": ("M2TMNXRAD", "CLDTOT", 1.0),      # total cloud fraction (0-1)
    "vapor": ("M2TMNXSLV", "TQV", 1.0),         # total column water vapour, mm
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
    slices = []
    for k, f in enumerate(files):  # one small read per monthly file; no dask needed
        with xr.open_dataset(f, engine="h5netcdf") as d:
            slices.append(d[var].load())
        if (k + 1) % 25 == 0 or k + 1 == len(files):
            print(f"  {k + 1}/{len(files)} months", flush=True)
    da = xr.concat(slices, dim="time").sortby("time")
    if da.sizes["time"] != n:
        raise ValueError(f"{short_name}: expected {n} months, got {da.sizes['time']}")
    v = da.values.astype("float64")
    v[np.abs(v) > 1e10] = np.nan  # MERRA-2 fill value is 1e15
    return v, da["lat"].values, da["lon"].values


def main():
    if not (base.RAW / "grid.json").exists():
        sys.exit("Run preprocessing/load_real.py first (it creates grid.json).")
    force = "--force" in sys.argv
    keys = [a for a in sys.argv[1:] if not a.startswith("--")] or list(PRODUCTS)
    todo = [k for k in keys if force or not (base.RAW / f"{k}.npy").exists()]
    if not todo:
        print("nothing to do (use --force to reload)")
        return
    login()
    failed = []
    for key in todo:
        short, var, scale = PRODUCTS[key]
        print(f"{key}: fetching {short}/{var} ...")
        try:
            v, lats, lons = load(short, var)
            out = base.regrid(v * scale, lats, lons)
            np.save(base.RAW / f"{key}.npy", out)
            print(f"{key}: saved {out.shape}")
        except Exception as e:
            failed.append(key)
            print(f"{key}: FAILED ({type(e).__name__}: {e})")
    if failed:
        print("failed:", ", ".join(failed))


if __name__ == "__main__":
    main()

