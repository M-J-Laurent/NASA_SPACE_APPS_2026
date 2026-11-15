"""Download the public (no login needed) source files into data/downloads/<name>/.

Run from repo root:  .venv\\Scripts\\python preprocessing\\download.py
Resumes interrupted downloads (the NOAA server drops long transfers).
Downloaded files are treated as untrusted input: only read by load_real.py with netCDF4.
"""
import gzip
import shutil
import time
import urllib.request
from pathlib import Path

DL = Path(__file__).resolve().parent.parent / "data" / "downloads"

SOURCES = {
    "gistemp": ("https://data.giss.nasa.gov/pub/gistemp/gistemp1200_GHCNv4_ERSSTv5.nc.gz", "gistemp.nc.gz"),
    "gpcp": ("https://psl.noaa.gov/thredds/fileServer/Datasets/gpcp/precip.mon.mean.nc", "precip.mon.mean.nc"),
    "etopo": ("https://coastwatch.pfeg.noaa.gov/erddap/griddap/etopo180.nc?altitude%5B(-90):10:(90)%5D%5B(-180):10:(180)%5D", "etopo_10arcmin.nc"),
    "bluemarble": ("https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi?SERVICE=WMS&REQUEST=GetMap&VERSION=1.1.1&LAYERS=BlueMarble_NextGeneration&STYLES=&SRS=EPSG:4326&BBOX=-180,-90,180,90&WIDTH=4096&HEIGHT=2048&FORMAT=image/jpeg", "bluemarble.jpg"),  # NASA Blue Marble (satellite colour)
    "ersst": ("https://psl.noaa.gov/thredds/fileServer/Datasets/noaa.ersst.v5/sst.mnmean.nc", "sst.mnmean.nc"),
}


def fetch(url: str, dest: Path, tries: int = 20):
    for _ in range(tries):
        have = dest.stat().st_size if dest.exists() else 0
        req = urllib.request.Request(url, headers={"Range": f"bytes={have}-"} if have else {})
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                if r.status == 200:  # server ignored Range: start over
                    have = 0
                total = have + int(r.headers.get("Content-Length", 0))
                with open(dest, "ab" if have else "wb") as f:
                    shutil.copyfileobj(r, f)
            if dest.stat().st_size >= total:
                return
        except Exception as e:  # dropped connection / 416 when already complete
            if getattr(e, "code", None) == 416:
                return
            time.sleep(2)
    raise RuntimeError(f"could not finish {url}")


def main():
    for name, (url, fname) in SOURCES.items():
        d = DL / name
        d.mkdir(parents=True, exist_ok=True)
        dest = d / fname
        final = d / fname.removesuffix(".gz")
        if final.exists():
            print(f"{name}: already have {final.name}")
            continue
        print(f"{name}: downloading {url}")
        fetch(url, dest)
        if fname.endswith(".gz"):
            with gzip.open(dest, "rb") as src, open(final, "wb") as out:
                shutil.copyfileobj(src, out)
        print(f"{name}: ok")


if __name__ == "__main__":
    main()
