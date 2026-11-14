"""Read-only server: hands precomputed files from data/processed to the frontend.
No statistics run here; those live in preprocessing/.

Run from repo root:  .venv\\Scripts\\python -m uvicorn backend.app:app --port 8000
"""
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

ROOT = Path(__file__).resolve().parent.parent
PROCESSED = ROOT / "data" / "processed"
DIST = ROOT / "frontend" / "dist"

app = FastAPI(title="Earth Change Detective")


@app.get("/api/health")
def health():
    return {"ok": (PROCESSED / "manifest.json").exists()}


app.mount("/data", StaticFiles(directory=PROCESSED), name="data")

# If the frontend has been built (npm run build), serve it too so one process runs the whole site.
if DIST.exists():
    app.mount("/assets", StaticFiles(directory=DIST / "assets"), name="assets")

    @app.get("/")
    def index():
        return FileResponse(DIST / "index.html")
