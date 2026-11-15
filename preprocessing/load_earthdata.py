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
import time

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


def retry(fn, tries=8, what=""):
    """Call fn(); on network errors wait and try again (the connection may come back)."""
    for attempt in range(tries):
        try:
            return fn()
        except Exception as e:
            if attempt == tries - 1:
                raise
            wait = min(60, 5 * (attempt + 1))
            print(f"  {what}: {type(e).__name__}, retrying in {wait}s ({attempt + 1}/{tries})", flush=True)
            time.sleep(wait)


def load(key, short_name, var, scale):
    """Download one regridded month at a time into data/downloads/earthdata_cache/<key>/, so an interrupted run
    resumes where it stopped. Returns the full (months, lat, lon) array on the common grid."""
    results = retry(lambda: earthaccess.search_data(
        short_name=short_name, temporal=(f"{base.START_YEAR}-01-01", f"{base.END_YEAR}-12-31")), what="search")
    n = (base.END_YEAR - base.START_YEAR + 1) * 12
    if len(results) != n:
        raise ValueError(f"{short_name}: expected {n} monthly granules, found {len(results)}")
    cache = base.DL / "earthdata_cache" / key
    cache.mkdir(parents=True, exist_ok=True)

    def one(k):
        f = earthaccess.open([results[k]])[0]
        with xr.open_dataset(f, engine="h5netcdf") as d:
            t = d["time"].dt
            if (int(t.year[0]), int(t.month[0])) != (base.START_YEAR + k // 12, k % 12 + 1):
                raise ValueError(f"granule {k} is {int(t.year[0])}-{int(t.month[0])}, out of order")
            v = d[var].load().values.astype("float64")
            lats, lons = d["lat"].values, d["lon"].values
        v[np.abs(v) > 1e10] = np.nan  # MERRA-2 fill value is 1e15
        np.save(cache / f"{k:03d}.npy", base.regrid(v * scale, lats, lons)[0])

    for k in range(n):
        if not (cache / f"{k:03d}.npy").exists():
            retry(lambda: one(k), what=f"month {k + 1}")
        if (k + 1) % 25 == 0 or k + 1 == n:
            print(f"  {k + 1}/{n} months", flush=True)
    return np.stack([np.load(cache / f"{k:03d}.npy") for k in range(n)])


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
            out = load(key, short, var, scale)
            np.save(base.RAW / f"{key}.npy", out)
            print(f"{key}: saved {out.shape}")
        except Exception as e:
            failed.append(key)
            print(f"{key}: FAILED ({type(e).__name__}: {e})")
    if failed:
        print("failed:", ", ".join(failed))


if __name__ == "__main__":
    main()

