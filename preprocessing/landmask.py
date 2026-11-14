"""High-resolution land/water mask for the frontend, so colours can be clipped to the real coastline.

Writes data/processed/landmask.bin: uint8, W x H (row 0 = north, lon -180 -> 180), value 0-255 = land fraction
of each pixel (2x2 supersampled for a smooth coastline). Source: global_land_mask (~1 km).
"""
from pathlib import Path

import numpy as np
from global_land_mask import globe

W, H = 2048, 1024


def write(out_dir: Path):
    sub = 2
    acc = np.zeros((H, W))
    for dy in range(sub):
        for dx in range(sub):
            lat = 90 - (np.arange(H) + (dy + 0.5) / sub) / H * 180
            lon = (np.arange(W) + (dx + 0.5) / sub) / W * 360 - 180
            LON, LAT = np.meshgrid(lon, np.clip(lat, -89.99, 89.99))
            acc += globe.is_land(LAT, LON)
    (out_dir / "landmask.bin").write_bytes(np.round(acc / sub ** 2 * 255).astype("uint8").tobytes())
    return W, H


def write_elevation(out_dir: Path, src: Path):
    """data/processed/elevation.bin: int16 metres (land +, sea floor -), same W x H grid/orientation as landmask.bin.
    Source: ETOPO1 (NOAA ERDDAP etopo180) at 10 arc-minutes, bilinearly resampled."""
    import netCDF4 as nc
    from scipy.ndimage import map_coordinates
    d = nc.Dataset(src)
    z = np.ma.filled(d["altitude"][:].astype("float32"), 0)  # (lat south->north, lon -180->180)
    lat_step = float(d["latitude"][1] - d["latitude"][0])
    lat = 90 - (np.arange(H) + 0.5) / H * 180
    lon = (np.arange(W) + 0.5) / W * 360 - 180
    II, JJ = np.meshgrid((lat + 90) / lat_step, (lon + 180) / lat_step, indexing="ij")
    out = map_coordinates(z, [II, JJ], order=1, mode="nearest")
    (out_dir / "elevation.bin").write_bytes(np.round(out).astype("<i2").tobytes())
