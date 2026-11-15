"""Bake the high-resolution base map the globe is drawn over.

Writes into data/processed/:
  basemap.webp   8192x4096 RGB: NASA Blue Marble satellite colours on land (light hillshade, no contour lines),
                 depth-tinted, hillshaded, contoured sea floor in the ocean.
  landmask.png   4096x2048 grey: land fraction per pixel (255 = land). The browser clips land-only / ocean-only data to
                 this so colours follow the real coastline.
Re-run just this step after changing the styling constants below:  .venv/Scripts/python preprocessing/basemap.py
"""
from pathlib import Path

import numpy as np
from global_land_mask import globe
from PIL import Image
from scipy.ndimage import distance_transform_edt, map_coordinates

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "processed"
DL = ROOT / "data" / "downloads"

W, H = 8192, 4096          # base map texture size (halve both for faster load / less GPU memory)
MASK_W, MASK_H = 4096, 2048

# ---- styling (edit and re-run) ----
OCEAN_STOPS = [(0, "#86a8b8"), (200, "#7195a8"), (1000, "#587b8f"), (2500, "#456579"), (4000, "#375367"),
               (6000, "#2b4154"), (10000, "#1e2e3e")]           # depth in metres -> colour
OCEAN_CONTOURS = [200, 1000, 2000, 3000, 4000, 5000, 6000]
CONTOUR_DARKEN = 0.18
SHADE_OCEAN, SHADE_LAND = 0.35, 0.28                              # 0 = flat
EXAG_OCEAN, EXAG_LAND = 5.0, 10.0                                 # vertical exaggeration for the hillshade
SUN_AZ, SUN_ALT = 315, 40


def hexrgb(h):
    return np.array([int(h[i:i + 2], 16) for i in (1, 3, 5)], dtype="float32")


def ramp(stops, x):
    xs = [s[0] for s in stops]
    cols = np.stack([hexrgb(s[1]) for s in stops])
    return np.stack([np.interp(x, xs, cols[:, k]) for k in range(3)], axis=-1).astype("float32")


def land_fraction(w, h, sub=2, rows=256):
    out = np.zeros((h, w), dtype="uint8")
    for y0 in range(0, h, rows):
        y1 = min(h, y0 + rows)
        acc = np.zeros((y1 - y0, w), dtype="float32")
        for dy in range(sub):
            for dx in range(sub):
                lat = 90 - (np.arange(y0, y1) + (dy + 0.5) / sub) / h * 180
                lon = (np.arange(w) + (dx + 0.5) / sub) / w * 360 - 180
                LON, LAT = np.meshgrid(lon, np.clip(lat, -89.99, 89.99))
                acc += globe.is_land(LAT, LON)
        out[y0:y1] = np.round(acc / sub ** 2 * 255)
    return out


def elevation(w, h, rows=256):
    import netCDF4 as nc
    src = next(p for p in (DL / "etopo3" / "etopo_3arcmin.nc", DL / "etopo" / "etopo_10arcmin.nc") if p.exists())
    d = nc.Dataset(src)
    z = np.ma.filled(d["altitude"][:].astype("float32"), 0)  # lat south->north, lon -180->180
    step = float(d["latitude"][1] - d["latitude"][0])
    print("elevation source:", src.name)
    out = np.zeros((h, w), dtype="float32")
    lon = (np.arange(w) + 0.5) / w * 360 - 180
    for y0 in range(0, h, rows):
        y1 = min(h, y0 + rows)
        lat = 90 - (np.arange(y0, y1) + 0.5) / h * 180
        II, JJ = np.meshgrid((lat + 90) / step, (lon + 180) / step, indexing="ij")
        out[y0:y1] = map_coordinates(z, [II, JJ], order=3, mode="nearest")
    return out


def hillshade(E, exag, dy_m, rows=512):
    az, alt = np.radians(SUN_AZ), np.radians(SUN_ALT)
    L = np.array([np.cos(alt) * np.sin(az), np.cos(alt) * np.cos(az), np.sin(alt)], dtype="float32")
    h, w = E.shape
    out = np.empty((h, w), dtype="float32")
    for y0 in range(0, h, rows):
        y1 = min(h, y0 + rows)
        a, b = max(0, y0 - 1), min(h, y1 + 1)
        e = E[a:b]
        lat = 90 - (np.arange(a, b) + 0.5) / h * 180
        dx = (np.maximum(0.05, np.cos(np.radians(lat))) * (111320 * 360 / w)).astype("float32")[:, None]
        zE = (np.roll(e, -1, 1) - np.roll(e, 1, 1)) / (2 * dx)
        zN = np.zeros_like(e)
        zN[1:-1] = (e[:-2] - e[2:]) / (2 * dy_m)
        nx, ny = -exag * zE, -exag * zN
        f = np.maximum(0, (nx * L[0] + ny * L[1] + L[2]) / np.sqrt(nx * nx + ny * ny + 1)) / L[2]
        out[y0:y1] = f[y0 - a:y0 - a + (y1 - y0)]
    return out


def build(out_dir: Path = OUT):
    out_dir.mkdir(parents=True, exist_ok=True)
    print("land mask ...")
    land = land_fraction(W, H)
    Image.fromarray(land).resize((MASK_W, MASK_H), Image.BOX).save(out_dir / "landmask.png", optimize=True)
    landf = land.astype("float32") / 255

    print("elevation ...")
    E = elevation(W, H)
    isl = land >= 128
    E[isl & (E <= 0)] = 1       # keep the coast consistent with the land mask
    E[~isl & (E >= 0)] = -1

    print("satellite colours ...")
    bm = Image.open(DL / "bluemarble" / "bluemarble.jpg").convert("RGB")
    sat = np.asarray(bm.resize((W, H), Image.LANCZOS) if bm.size != (W, H) else bm).astype("float32")
    lum = 0.3 * sat[..., 0] + 0.59 * sat[..., 1] + 0.11 * sat[..., 2]
    water = (sat[..., 2] >= sat[..., 1]) & (sat[..., 2] >= sat[..., 0] * 0.9) & (lum < 70)
    good = isl & ~water
    bad = isl & water
    del lum, water
    if bad.any():  # coastal water pixels inside the land mask: borrow the nearest real land colour (found at 1/4 scale)
        s = 4
        gs = good[::s, ::s]
        idx = distance_transform_edt(~gs, return_distances=False, return_indices=True)
        small = sat[::s, ::s][idx[0], idx[1]]
        fill = np.repeat(np.repeat(small, s, 0), s, 1)[:H, :W]
        sat[bad] = fill[bad]
        del fill, small
    dy = 111320 * 180 / H
    print("shading ...")
    shade_l = 1 + SHADE_LAND * (hillshade(E, EXAG_LAND, dy) - 1)
    land_rgb = sat * shade_l[..., None]
    del sat, shade_l

    depth = np.maximum(-E, 0)
    ocean = ramp(OCEAN_STOPS, depth)
    shade_o = 1 + SHADE_OCEAN * (hillshade(E, EXAG_OCEAN, dy) - 1)
    ocean *= shade_o[..., None]
    del shade_o
    lvl = np.zeros(E.shape, dtype="int8")
    for t in OCEAN_CONTOURS:
        lvl += (depth >= t).astype("int8")
    edge = np.zeros(E.shape, dtype=bool)
    edge[:, :-1] |= lvl[:, :-1] != lvl[:, 1:]
    edge[:-1, :] |= lvl[:-1, :] != lvl[1:, :]
    edge[:, 1:] |= edge[:, :-1].copy()  # thicken the line to ~2 px so it survives mipmapping
    edge &= landf < 0.5
    ocean[edge] *= 1 - CONTOUR_DARKEN
    del lvl, E, depth

    rgb = ocean * (1 - landf[..., None]) + land_rgb * landf[..., None]
    img = Image.fromarray(np.clip(rgb, 0, 255).astype("uint8"))
    img.save(out_dir / "basemap.webp", quality=88, method=4)
    print("wrote", out_dir / "basemap.webp", (out_dir / "basemap.webp").stat().st_size // 1024, "KB")
    return MASK_W, MASK_H


if __name__ == "__main__":
    build()
