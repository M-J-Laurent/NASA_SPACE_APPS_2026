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
