"""Build static data files for the frontend.

Usage (from repo root):  .venv\\Scripts\\python backend\\pipeline.py
Output: frontend/public/data/{manifest.json, <var>.bin, combined.bin}
Per-variable .bin = float32 [slope(nlat*nlon), z, p, annual(nyear*nlat*nlon)], lat-major, south->north.
combined.bin = float32 [score, n_significant, n_variables] each nlat*nlon.
"""
import json
from pathlib import Path

import numpy as np
from scipy import stats

import synthetic
from trends import annual_means, deseasonalize, trend_stats

OUT = Path(__file__).resolve().parent.parent / "frontend" / "public" / "data"
RES = 2.0
ALPHA = 0.05

VARIABLES = {
    "temp": dict(name="Surface air temperature", unit="°C", source="MERRA-2 (synthetic demo)",
                 about="Average temperature of the air near the ground. Rising values suggest warming."),
    "precip": dict(name="Precipitation", unit="mm/day", source="GPM IMERG (synthetic demo)",
                   about="Rain and snow reaching the ground. Trends can be wetter in one place and drier in another."),
    "aod": dict(name="Aerosol optical depth", unit="unitless", source="MODIS (synthetic demo)",
                about="How much sunlight is blocked by haze, smoke and dust in the air. Higher = more particles."),
    "ndvi": dict(name="Vegetation greenness (NDVI)", unit="index 0-1", source="MODIS (synthetic demo)",
                 about="How green and healthy plants look from space. Rising = greening, falling = browning."),
    "sst": dict(name="Sea surface temperature", unit="°C", source="MODIS/AIRS (synthetic demo)",
                about="Temperature of the top layer of the ocean. Drives weather, storms and marine ecosystems."),
}


def percentile_score(absz: np.ndarray) -> np.ndarray:
    """Rank of |Z| among valid cells, 0..1 (robust to different units / distributions)."""
    out = np.full(absz.shape, np.nan)
    m = ~np.isnan(absz)
    out[m] = stats.rankdata(absz[m]) / m.sum()
    return out


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    lats, lons, data = synthetic.generate(RES)
    scores, sig_flags, manifest_vars = [], [], []
    for key, meta in VARIABLES.items():
        monthly = data[key]
        slope, z, p = trend_stats(monthly)
        annual = annual_means(monthly)
        blob = np.concatenate([a.astype("<f4").ravel() for a in (slope, z, p, annual)])
        (OUT / f"{key}.bin").write_bytes(blob.tobytes())
        scores.append(percentile_score(np.abs(z)))
        sig_flags.append(np.where(np.isnan(p), np.nan, (p < ALPHA).astype(float)))
        manifest_vars.append(dict(
            id=key, **meta,
            slope_p98=float(np.nanpercentile(np.abs(slope), 98)),
            pct_significant=float(np.nanmean(p < ALPHA) * 100),
        ))
        print(f"{key}: {np.nanmean(p < ALPHA) * 100:.0f}% of cells significant")

    S = np.stack(scores)
    combined = np.nanmean(S, axis=0)                 # mean over variables that have data in the cell
    n_valid = (~np.isnan(S)).sum(axis=0)
    n_sig = np.nansum(np.stack(sig_flags), axis=0)   # how many variables show a significant trend
    combined[n_valid < 2] = np.nan                   # need >= 2 variables for a meaningful mean
    np.concatenate([a.astype("<f4").ravel() for a in (combined, n_sig, n_valid)]).tofile(OUT / "combined.bin")

    manifest = dict(
        res=RES, nlat=len(lats), nlon=len(lons), start_year=synthetic.START_YEAR, n_years=synthetic.N_YEARS,
        alpha=ALPHA, synthetic=True, variables=manifest_vars,
        method=dict(
            trend="Seasonal cycle removed; slope = least-squares rate per year; significance = Mann-Kendall test.",
            combined="Each variable's |Mann-Kendall Z| is converted to a percentile rank (0-1) so units don't matter; "
                     "the combined score is the mean over variables with data in that cell (>= 2 required).",
        ),
    )
    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=1), encoding="utf-8")


if __name__ == "__main__":
    main()
