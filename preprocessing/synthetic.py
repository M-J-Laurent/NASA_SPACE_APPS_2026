"""Synthetic stand-in datasets (clearly NOT real measurements) so the pipeline and UI work end to end.
Replace with real loaders (MERRA-2, GPM, MODIS...) that return a (n_months, lat, lon) array."""
import numpy as np

START_YEAR, N_YEARS = 2003, 22
N_MONTHS = N_YEARS * 12


def make_grid(res: float):
    lats = np.arange(-90 + res / 2, 90, res)
    lons = np.arange(-180 + res / 2, 180, res)
    return lats, lons


def _blob(lat, lon, lat0, lon0, w):
    dlon = (lon - lon0 + 180) % 360 - 180
    return np.exp(-(((lat - lat0) / w) ** 2 + (dlon / (w * 1.4)) ** 2))


def generate(res: float = 2.0, seed: int = 7):
    rng = np.random.default_rng(seed)
    lats, lons = make_grid(res)
    LAT, LON = np.meshgrid(lats, lons, indexing="ij")
    t = np.arange(N_MONTHS)[:, None, None]
    season = np.cos(2 * np.pi * t / 12)
    rad = np.deg2rad(LAT)

    def noise(scale, rho=0.5):
        e = rng.normal(0, scale, (N_MONTHS, *LAT.shape))
        for i in range(1, N_MONTHS):  # AR(1) noise
            e[i] += rho * e[i - 1]
        return e

    out = {}
    # trends below are in units/year
    rate = 0.015 + 0.05 * np.clip((np.abs(LAT) - 40) / 50, 0, 1) ** 1.5 * (LAT > 0) + 0.01 * (LAT > 60)
    out["temp"] = 15 - 30 * np.abs(np.sin(rad)) + 10 * season * np.sin(rad) + rate * t / 12 + noise(0.8)

    prate = (0.004 * _blob(LAT, LON, 0, 150, 18) - 0.005 * _blob(LAT, LON, -25, -60, 12)
             - 0.004 * _blob(LAT, LON, 35, 15, 10) + 0.003 * _blob(LAT, LON, 60, -100, 12))
    out["precip"] = np.clip(3 + 2 * np.cos(rad * 3) + 1.2 * season * np.sin(rad) + prate * t / 12 + noise(0.5, 0.3), 0, None)

    arate = 0.012 * _blob(LAT, LON, 25, 85, 14) - 0.01 * _blob(LAT, LON, 50, 10, 12) - 0.006 * _blob(LAT, LON, 35, 115, 12)
    out["aod"] = np.clip(0.15 + 0.1 * _blob(LAT, LON, 25, 85, 20) + 0.03 * season + arate * t / 12 + noise(0.03, 0.4), 0, None)

    nrate = 0.004 * _blob(LAT, LON, 62, 90, 14) - 0.006 * _blob(LAT, LON, -5, -62, 10) + 0.003 * _blob(LAT, LON, 25, 80, 10)
    ndvi = np.clip(0.5 + 0.2 * season * np.sign(LAT) + nrate * t / 12 + noise(0.04, 0.4), 0, 1)
    ndvi[:, np.abs(LAT[:, 0]) > 70, :] = np.nan  # satellite coverage gap at the poles
    out["ndvi"] = ndvi

    sst_rate = 0.02 + 0.025 * _blob(LAT, LON, 38, -60, 10) + 0.02 * _blob(LAT, LON, -35, 25, 10)
    out["sst"] = 27 - 28 * np.abs(np.sin(rad)) ** 1.3 + 3 * season * np.sin(rad) + sst_rate * t / 12 + noise(0.4)
    return lats, lons, out


def write_raw(res: float = 2.0):
    """Write synthetic data in the same format a real loader should produce:
    data/raw/grid.json + data/raw/<var>.npy, float32 (n_months, nlat, nlon), January first, lat south->north."""
    import json
    from pathlib import Path
    raw = Path(__file__).resolve().parent.parent / "data" / "raw"
    raw.mkdir(parents=True, exist_ok=True)
    lats, lons, data = generate(res)
    for key, arr in data.items():
        np.save(raw / f"{key}.npy", arr.astype("float32"))
    (raw / "grid.json").write_text(json.dumps(dict(
        res=res, lats=lats.tolist(), lons=lons.tolist(), start_year=START_YEAR, n_years=N_YEARS, synthetic=True)))
    print(f"wrote {len(data)} raw variables to {raw}")


if __name__ == "__main__":
    write_raw()
