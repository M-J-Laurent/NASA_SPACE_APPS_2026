"""Build static data files for the frontend.

Offline step: run it whenever raw data changes. The website/backend never computes statistics.
Usage (from repo root):
    .venv\\Scripts\\python preprocessing\\pipeline.py    # data/raw -> data/processed
Input:  data/raw/{grid.json, <var>.npy}  (made by preprocessing/load_real.py)
Output: data/processed/{manifest.json, <var>.bin, combined.bin}
Per-variable .bin = float32 [slope, z, p, filled (1 = interpolated cell), annual(n_years), q] over (nlat*nlon),
                    lat-major, south->north; q = Benjamini-Hochberg adjusted p (false-discovery-rate correction).
combined.bin     = float32 [score, n_significant, n_variables,
                            score_observed, n_variables_observed, n_filled,
                            n_significant_uncorrected]  each nlat*nlon; n_significant uses q < 0.05 (FDR-corrected).
"observed" versions exclude cells whose values were interpolated (see gaps.py).
"""
import json
import sys
from pathlib import Path

import numpy as np
from scipy import stats

import basemap
import marine
from gaps import domain_mask, fill_small_holes
from trends import annual_means, fdr_qvalues, trend_stats

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
OUT = ROOT / "data" / "processed"
ALPHA = 0.05
MAX_HOLE = 16  # largest gap (in 2-degree cells) that may be interpolated

VARIABLES = {
    "temp": dict(name="Land surface air temperature", unit="°C", domain="land",
                 source="NASA GISS GISTEMP v4 (GHCNv4 land stations), anomalies vs 1951-1980",
                 about="Average temperature of the air near the ground over land, shown as change from a long-term average. "
                       "Land only: GISTEMP over oceans is the same data as sea surface temperature, so including it would double count."),
    "precip": dict(name="Precipitation", unit="mm/day", domain=None,
                   source="GPCP v2.3 monthly (NOAA PSL), 2.5° regridded to 2°",
                   about="Rain and snow reaching the ground, combining satellites and rain gauges. Trends can be wetter in one place and drier in another."),
    "aod": dict(name="Aerosol optical depth", unit="unitless", domain=None, trend_from=2002,
                source="NASA MERRA-2 (M2TMNXAER, total aerosol extinction at 550 nm)",
                about="How much sunlight is blocked by haze, smoke, dust and pollution in the air. Higher = more particles. "
                      "Reanalysis: satellite observations blended with a model. The satellites it uses changed around 2000-2001 (creating a false jump), so the trend is measured from 2002 onward."),
    "soilwet": dict(name="Root-zone soil wetness", unit="fraction", domain="land",
                    source="NASA MERRA-2 (M2TMNXLND, GWETROOT)",
                    about="How wet the soil is where plant roots reach, from 0 (dry) to 1 (saturated). Modelled, not directly measured. Falling values hint at drying land."),
    "evap": dict(name="Evaporation", unit="mm/day", domain=None,
                 source="NASA MERRA-2 (M2TMNXFLX, EVAP)",
                 about="Water leaving the land and ocean surface as vapour. More evaporation can mean warmer, drier surfaces and fuels rainfall elsewhere. Modelled (reanalysis), not directly measured."),
    "runoff": dict(name="Runoff", unit="mm/day", domain="land",
                   source="NASA MERRA-2 (M2TMNXLND, RUNOFF)",
                   about="Water running off the land surface toward rivers. A proxy for streamflow: rising values point to more water flowing downhill. Modelled (reanalysis), not gauge measurements."),
    "cloud": dict(name="Cloud cover", unit="fraction", domain=None,
                  source="NASA MERRA-2 (M2TMNXRAD, CLDTOT)",
                  about="Fraction of the sky covered by cloud (0 to 1). Clouds both cool the surface by reflecting sunlight and warm it by trapping heat. Modelled (reanalysis); cloud trends are uncertain."),
    "vapor": dict(name="Atmospheric water vapor", unit="mm", domain=None,
                  source="NASA MERRA-2 (M2TMNXSLV, TQV)",
                  about="Total water vapour in the air column above each point (as an equivalent depth of liquid water). A warmer atmosphere holds more, so this tends to rise with warming."),
    "sst": dict(name="Sea surface temperature", unit="°C", domain="ocean",
                source="NOAA ERSST v5",
                about="Temperature of the top layer of the ocean. Drives weather, storms and marine ecosystems."),
}


def percentile_score(absz: np.ndarray) -> np.ndarray:
    """Rank of |Z| among valid cells, 0..1 (robust to different units / distributions)."""
    out = np.full(absz.shape, np.nan)
    m = ~np.isnan(absz)
    out[m] = stats.rankdata(absz[m]) / m.sum()
    return out


def pack(*arrays):
    return np.concatenate([np.asarray(a, dtype="<f4").ravel() for a in arrays])


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    if not (OUT / "basemap.webp").exists() or "--basemap" in sys.argv:  # slow (~1 min); only when missing or asked
        need = [ROOT / "data" / "downloads" / "bluemarble" / "bluemarble.jpg"]
        miss = [str(p.relative_to(ROOT)) for p in need if not p.exists()]
        if miss:
            sys.exit(f"Base map source missing: {', '.join(miss)}. Run preprocessing/download.py first (public files, no login).")
        basemap.build(OUT)
    mask_w, mask_h = basemap.MASK_W, basemap.MASK_H
    marine_src = ROOT / "data" / "downloads" / "marine" / "marine_50m.geojson"
    if marine_src.exists() and (not (OUT / "marine.json").exists() or "--basemap" in sys.argv):
        marine.build(OUT)
    grid = json.loads((RAW / "grid.json").read_text())
    lats, lons, res = np.array(grid["lats"]), np.array(grid["lons"]), grid["res"]
    scores, scores_obs, sig_flags, sig_raw, filled_flags, manifest_vars = [], [], [], [], [], []
    for key, meta in VARIABLES.items():
        if not (RAW / f"{key}.npy").exists():
            print(f"skipping {key}: no raw file")
            continue
        monthly = np.load(RAW / f"{key}.npy")
        t0 = (meta.get("trend_from", grid["start_year"]) - grid["start_year"]) * 12  # months before the trend window
        monthly = monthly[t0:]
        domain = domain_mask(meta["domain"], lats, lons, res)
        monthly[:, ~domain] = np.nan                                # outside the variable's domain: no data
        monthly, filled = fill_small_holes(monthly, domain, max_size=MAX_HOLE)
        slope, z, p = trend_stats(monthly)
        q = fdr_qvalues(p)
        annual = np.concatenate([np.full((t0 // 12, *monthly.shape[1:]), np.nan), annual_means(monthly)])
        filled &= ~np.isnan(p)                                      # only count fills that produced a trend
        (OUT / f"{key}.bin").write_bytes(pack(slope, z, p, filled, annual, q).tobytes())

        s = percentile_score(np.abs(z))
        scores.append(s)
        scores_obs.append(np.where(filled, np.nan, s))
        sig_flags.append(np.where(np.isnan(q), np.nan, (q < ALPHA).astype(float)))
        sig_raw.append(np.where(np.isnan(p), np.nan, (p < ALPHA).astype(float)))
        filled_flags.append(filled)
        has = ~np.isnan(p)
        manifest_vars.append(dict(
            id=key, **meta,
            slope_p98=float(np.nanpercentile(np.abs(slope), 98)),
            pct_significant=float((p[has] < ALPHA).mean() * 100),            # uncorrected p < 0.05
            pct_significant_fdr=float((q[has] < ALPHA).mean() * 100),        # after false-discovery-rate correction
            n_cells=int(has.sum()), n_filled=int(filled.sum()), trend_years=int(monthly.shape[0] // 12),
        ))
        print(f"{key}: {has.sum()} cells, {filled.sum()} interpolated, {(p[has] < ALPHA).mean() * 100:.0f}% significant (p<0.05), {(q[has] < ALPHA).mean() * 100:.0f}% after FDR correction")

    S, So = np.stack(scores), np.stack(scores_obs)
    combined = np.nanmean(S, axis=0)                  # mean over variables that have data in the cell
    n_valid = (~np.isnan(S)).sum(axis=0)
    combined[n_valid < 2] = np.nan                    # need >= 2 variables for a meaningful mean
    combined_obs = np.nanmean(So, axis=0)
    n_valid_obs = (~np.isnan(So)).sum(axis=0)
    combined_obs[n_valid_obs < 2] = np.nan
    n_sig = np.nansum(np.stack(sig_flags), axis=0)    # how many variables show a significant trend (FDR-corrected)
    n_sig_raw = np.nansum(np.stack(sig_raw), axis=0)  # ... and with plain p < 0.05
    n_filled = np.stack(filled_flags).sum(axis=0)
    pack(combined, n_sig, n_valid, combined_obs, n_valid_obs, n_filled, n_sig_raw).tofile(OUT / "combined.bin")

    manifest = dict(
        format=2,                      # layout of the .bin files; the frontend refuses other versions
        data_version=int(__import__('time').time()),  # changes on every rebuild; used to bypass browser caches
        res=res, nlat=len(lats), nlon=len(lons),
        start_year=grid["start_year"], n_years=grid["n_years"],
        mask_w=mask_w, mask_h=mask_h, basemap_file="basemap.webp", marine_file="marine.json" if (OUT / "marine.json").exists() else None, mask_file="landmask.png", alpha=ALPHA, synthetic=grid.get("synthetic", False), max_hole=MAX_HOLE, variables=manifest_vars,
        combined_cells=int((~np.isnan(combined)).sum()),
        combined_cells_observed=int((~np.isnan(combined_obs)).sum()),
        method=dict(
            trend="Seasonal cycle removed; rate = Theil-Sen slope per year; significance = Mann-Kendall test with Hamed-Rao autocorrelation correction. Because thousands of cells are tested, p-values are also adjusted for the false discovery rate (Benjamini-Hochberg); 'significant' in the app means q < 0.05 unless the uncorrected option is chosen.",
            combined="Each variable's |Mann-Kendall Z| is converted to a percentile rank (0-1) so units don't matter; "
                     "the combined score is the mean over variables with data in that cell (>= 2 required). "
                     "Variables are restricted to where they are measured independently (temperature = land, "
                     "sea surface temperature = ocean) so nothing is counted twice.",
            interpolation=f"Holes of up to {MAX_HOLE} grid cells that are surrounded by data are filled by "
                          "inverse-distance weighting of nearby cells. Larger gaps (poles, sea ice, no coverage) are never filled. "
                          "Filled cells are marked as interpolated, and can be hidden with 'Observed data only'.",
        ),
    )
    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=1), encoding="utf-8")


if __name__ == "__main__":
    main()
