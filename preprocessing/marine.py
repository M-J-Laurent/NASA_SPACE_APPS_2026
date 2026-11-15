"""Named oceans, seas, gulfs and bays (Natural Earth marine polygons, public domain) for the region tool.

Reads data/downloads/marine/marine_50m.geojson (see download.py) and writes data/processed/marine.json:
{"features": [{"name", "class", "geometry"}]} with coordinates rounded to 2 decimals. Rivers, reefs, straits and channels are
dropped; the browser draws smaller bodies on top of the oceans that contain them.
"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
KEEP = {"ocean", "sea", "gulf", "bay"}
SKIP = {"Inner Sea", "Inner Seas"}


def _round(c):
    return [round(c[0], 2), round(c[1], 2)] if isinstance(c[0], (int, float)) else [_round(x) for x in c]


def build(out_dir: Path, src: Path = ROOT / "data" / "downloads" / "marine" / "marine_50m.geojson"):
    d = json.loads(src.read_text(encoding="utf-8"))
    feats = []
    for f in d["features"]:
        p = f["properties"]
        name, cls = p.get("name") or "", p.get("featurecla")
        if cls not in KEEP or name in SKIP:
            continue
        if name.isupper():
            name = name.title()
        feats.append({"name": name, "class": cls, "geometry": {"type": f["geometry"]["type"], "coordinates": _round(f["geometry"]["coordinates"])}})
    (out_dir / "marine.json").write_text(json.dumps({"features": feats}, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    print("marine.json:", len(feats), "named water bodies")


if __name__ == "__main__":
    build(ROOT / "data" / "processed")
