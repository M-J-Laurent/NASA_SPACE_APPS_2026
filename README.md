# Earth Change Detective

**What is changing on Earth, where, how fast, and is it statistically significant?**

Earth Change Detective is an interactive 3D globe built for the NASA International Space Apps Challenge 2026. It lets
you switch between nine Earth-science variables (temperature, rainfall, soil moisture, aerosols, and more), see the
rate of change at every place on the planet, click anywhere (a point, a country, or a whole sea) to get a time series
with a proper significance test, and watch the trends build up year by year, with a clearly labelled "if the trend
continued" look-ahead.

It is designed for students and members of the public with some science background: every statistic is summarised in
plain language and linked to its Wikipedia page for anyone who wants the details.


## The challenge

Measured Earth-science variables can trend one way in one region and the opposite way in another, even when the same
process drives both, and there are far too many variables to inspect by hand. The challenge asks for a tool that can
select variables from satellite missions or models, visualise how they change over time for a region, and determine
what is changing, where, how much, and whether the change is statistically significant (for example with a
Mann-Kendall test, a t-test or confidence intervals).

## What it does

| Question | How the app answers it |
| --- | --- |
| **What** is changing? | Nine variables on one switchable globe, plus a **Combined** layer ranking where the whole Earth system is changing most. |
| **Where**? | A colour map of the rate of change over a satellite-style relief map; click a point, or pick a country, a US state, a named sea or ocean, or a circle. |
| **How much**? | Theil-Sen rate per year, total change over the record, a 95% confidence interval, and a yearly time series with the fitted trend. |
| **Is it significant**? | Mann-Kendall test with an autocorrelation correction, then a false-discovery-rate correction because thousands of places are tested at once. Non-significant trends fade out on the map and are greyed in the tables. |
| What if it **continues**? | A timeline that animates the trend and extends it to 2050 as a straight line, with widening uncertainty and "not a forecast" labels. |

Highlights:

- **Rotatable 3D globe** with relief and ocean-floor contours, crisp coastlines and country borders at any zoom.
- **Colour by**: rate of change (blue falling, neutral, red rising), faded where not significant, or by significance alone.
- **Point tool and Region tool.** In Region mode a click analyses a whole country, or a whole named body of water (such as the Baltic Sea). Click the United States, then a state, to drill down. Circles of 500, 1000 and 2000 km are also available, and a search box finds any region by name.
- **Regional analysis**: the area-weighted regional mean, its trend with a confidence interval, how many of the region's cells are individually significant, and a CSV download.
- **Combined view**: every variable on one chart (standardised so units do not matter), and a trend table sorted by strength of evidence with significant trends coloured and the rest greyed.
- **Global overview** of the current layer with its own trend chart.
- **Timeline and projection**, including a *combined change index* showing how the overall picture builds up.
- **Guided demos** (Arctic warming, opposite rainfall trends across the Pacific, an ocean hot spot, and the single place changing most).
- **Honest handling of gaps**: small holes are interpolated (and shown striped, with a warning), and an "Observed data only" switch shows where data truly is missing.
- **My location**: optional; your position stays in your browser and is never sent anywhere.

## Quick start

You need **Python 3** and **Node.js** (developed with Python 3.14 and Node 22; Windows with PowerShell is the tested
setup). The repository already contains the processed data (about 30 MB in
`data/processed/`), so you do not need to download anything to run the site.

```powershell
# 1. one-time setup (from the project folder)
python -m venv .venv
.\.venv\Scripts\python -m pip install -r requirements.txt
cd frontend; npm install; cd ..

# 2. run it
.\start.ps1
```

`start.ps1` (or `start.bat`) frees ports 8000 and 5173, checks the dependencies, starts the data server and the web
app, and opens http://localhost:5173. Press Ctrl+C in that window to stop everything.

> **Why does it run locally?** The site is a static front end plus a tiny read-only server that hands out precomputed
> files. For a public deployment you would host `frontend/dist` and `data/processed/` on any static host, and visitors
> would not need to download or compute anything. See [Deploying](#deploying).

If the page says the data is missing or out of date, press **Ctrl+F5** once. If it still does, rebuild the data with the
steps below.

### URL options

Useful for sharing a view or testing: `?layer=temp` (`combined`, `precip`, `aod`, `soilwet`, `evap`, `runoff`, `cloud`,
`vapor`, `sst`), `&colorBy=fade|rate|sig`, `&base=satellite|plain`, `&lat=40&lon=-100&dist=2.4` (camera),
`&spin=0` (no auto-rotation) and `&demo=1` to `4`.

## Using the site

1. **Pick a layer** on the left (search if the list is long). The legend at the bottom explains the colours.
2. **Click the globe** (Point tool) to see that place: verdict, time series, trend line and significance. Click off the
   globe, or the × above the panel, to return to the global overview.
3. **Switch to Region** in the bottom bar to analyse whole countries and seas with one click. The **▾** next to it picks
   the region type or searches by name.
4. **Press ⏱ Timeline** to play the trend building up and to look ahead. Choose how far (to 2035 or 2050) in the bar.
5. **Settings** holds the colour mode, base map, "observed data only" and the significance mode (corrected or plain p).

## How the numbers are computed

All statistics are computed offline in `preprocessing/`. The web server and the browser never fit models; the browser
only reads the results (plus, for regions, the regional average of the yearly means).

1. **One common grid.** Every source is regridded (bilinear, wrapping at the dateline) onto a 2° latitude-longitude
   grid, monthly, 1996-2025 (360 months). Cells with missing data stay missing; nothing is invented.
2. **Rate of change.** The seasonal cycle is removed, then the rate is the
   [Theil-Sen slope](https://en.wikipedia.org/wiki/Theil%E2%80%93Sen_estimator) (a robust line fit) in units per year.
3. **Significance.** A [Mann-Kendall](https://en.wikipedia.org/wiki/Kendall_rank_correlation_coefficient) trend test
   with the Hamed-Rao correction for [autocorrelation](https://en.wikipedia.org/wiki/Autocorrelation) gives a p-value
   for each cell.
4. **Many tests at once.** About 5% of 16,000 cells would look significant by chance at p < 0.05, so p-values are
   also adjusted for the [false discovery rate](https://en.wikipedia.org/wiki/False_discovery_rate) (Benjamini-Hochberg,
   giving a q-value). "Significant" in the app means q < 0.05 by default, and a Settings switch shows plain p instead.
   Typical effect: precipitation drops from 28% to 14% significant cells, while temperature barely changes (71% to 70%).
5. **Regions.** The cells inside a region (weighted by overlapped area, and by the part of each cell a layer can see:
   land-only layers see only land, ocean-only layers only sea) are averaged year by year and the trend test is re-run on
   that regional series, with a 95% confidence interval.
6. **Combined score.** Each variable's |Z| is converted to a percentile rank so units do not matter, then averaged over
   the variables measured at a place (at least two). Temperature is land-only and sea surface temperature ocean-only so
   the oceans are not counted twice.
7. **Gap filling.** Holes of up to 16 grid cells that are surrounded by data are filled by
   [inverse-distance weighting](https://en.wikipedia.org/wiki/Inverse_distance_weighting). Larger gaps (poles, sea ice,
   no coverage) are never filled. Filled cells are flagged and drawn striped.
8. **Timeline and projection.** The map shows the change since the record began that each trend implies. Years after
   2025 extend the straight-line trend forward, with the 95% confidence range widening. For the Combined layer the
   timeline shows a *combined change index*: per variable, how far its significant trend has moved things as a share of
   a "big" change (what the fastest-changing 2% of places change in 25 years), averaged over the variables at a place.

### Data

| Layer | Source | Notes |
| --- | --- | --- |
| Land surface air temperature | NASA GISS GISTEMP v4 (GHCNv4 land stations) | Anomalies vs 1951-1980, land only |
| Precipitation | NOAA/PSL GPCP v2.3 monthly | 2.5° regridded to 2° |
| Sea surface temperature | NOAA ERSST v5 | Ocean only |
| Aerosol optical depth, root-zone soil wetness, evaporation, runoff, cloud cover, water vapor | NASA MERRA-2 reanalysis (GES DISC, via Earthdata) | Modelled with satellite data assimilated, not direct measurements; aerosol trend measured from 2002 because of an observing-system change around 2000 |
| Relief and ocean-floor shading | NOAA ETOPO1 (via ERDDAP) | 3 arc-minute |
| Land colours | NASA Blue Marble Next Generation (via NASA GIBS) | |
| Named seas and oceans | Natural Earth marine polygons | Public domain |
| Country and US state outlines | `world-atlas` (Natural Earth) and `us-atlas` (US Census) npm packages | |
| Land/sea mask | `global-land-mask` | |

## Rebuilding the data

Only needed if you change the sources, the period, or the methods, or start from a checkout without
`data/processed/`. From the project folder:

```powershell
.\.venv\Scripts\python preprocessing\download.py        # public NOAA/NASA files (about 400 MB, no login)
.\.venv\Scripts\python preprocessing\load_real.py       # regrid temperature, precipitation and SST onto the grid
.\.venv\Scripts\python preprocessing\load_earthdata.py  # the MERRA-2 layers (needs a free NASA Earthdata login)
.\.venv\Scripts\python preprocessing\pipeline.py        # trends, significance, combined score -> data/processed
```

- The Earthdata step needs a free account at https://urs.earthdata.nasa.gov/users/new, with the "NASA GESDISC DATA
  ARCHIVE" application approved. Set `EARTHDATA_USERNAME` and `EARTHDATA_PASSWORD`, or let the script prompt once; it
  stores them in `~/.netrc` in your home folder, **outside** this repository. Downloads resume if interrupted.
- `pipeline.py --basemap` also re-renders the 8192×4096 base map (about a minute).
- To add a variable, add its file to `load_earthdata.py` (or `load_real.py`) and an entry to `VARIABLES` in
  `pipeline.py`; it appears on the globe automatically.
- Colours and look-and-feel are in `frontend/src/palette.js` (hot-reloads); the sea-floor styling is at the top of
  `preprocessing/basemap.py`.

## Project layout

```
backend/app.py              Read-only FastAPI server: serves data/processed (never computes statistics)
frontend/                   Vite + three.js web app
  src/main.js               Globe, layers, panels, charts, timeline, region tool
  src/regions.js            Country / state / sea lookup (rasterised once, so clicks are instant)
  src/regionstats.js        Region cell selection and regional trend statistics
  src/palette.js            All colours and look-and-feel knobs
preprocessing/              Offline data pipeline
  download.py, load_real.py, load_earthdata.py   fetch and regrid sources
  trends.py                 Theil-Sen, Mann-Kendall (Hamed-Rao), false discovery rate
  gaps.py                   Domain masks and small-gap interpolation
  basemap.py, marine.py     Pre-rendered base map and named water bodies
  pipeline.py               Everything -> data/processed
data/raw, data/downloads    Large, reproducible inputs (not committed)
data/processed              Small, committed outputs the site reads
start.ps1, start.bat        One-command launcher
```

## Deploying

The backend only serves files, so the site can be published statically: run `npm run build` in `frontend/`, then host
`frontend/dist` together with `data/processed` at `/data` on any static host (GitHub Pages, Netlify, an S3 bucket).
Alternatively `uvicorn backend.app:app` also serves a built `frontend/dist` from a single process. Not yet tested on a
public host.

## Limitations (please read before drawing conclusions)

- **Short record, coarse grid.** 30 years at 2° (about 220 km) cannot separate long-term trends from natural cycles
  such as El Niño; a trend here may be partly variability. Small countries cover only a handful of cells.
- **Reanalysis is modelled.** MERRA-2 variables blend a model with satellite data; trends in quantities like runoff or
  soil wetness reflect the model too.
- **The projection is not a forecast.** It extends a straight line. Real changes can accelerate, slow down or reverse,
  and uncertainty grows with distance, which is why the look-ahead stops at 25 years.
- **Regional tests use yearly means** (about 30 points) while the per-cell maps use monthly data, so the two agree
  closely but not exactly. The regional p-value is a single test and is not adjusted for multiple testing.
- **Spatial dependence.** Neighbouring cells are correlated; the false-discovery-rate procedure remains valid for
  positively dependent tests, but it is not a full field-significance analysis.
- Not covered yet: sea ice, sea level, vegetation indices, and removing El Niño variability.

## Roadmap

False-discovery and field-significance refinements, El Niño removal, more variables (sea ice, sea level, terrestrial
water storage, vegetation), unit tests for the trend code, and a hosted deployment.

## Credits

Data courtesy of NASA GISS, NASA GMAO and GES DISC, NOAA PSL and NCEI, and Natural Earth. Built with
[three.js](https://threejs.org), [d3-geo](https://github.com/d3/d3-geo), [Vite](https://vite.dev),
[FastAPI](https://fastapi.tiangolo.com), NumPy and SciPy.

Created for the NASA International Space Apps Challenge 2026. **Team:** Project Challenger
**License:** [MIT](LICENSE). You may use, copy and modify the code, but you must keep the copyright notice and license text
with any copy. The underlying datasets keep their own terms; see the data table above and the providers' sites.