# One-command launcher: sets up whatever is missing, then starts backend + frontend.
# Run from anywhere:  .\start.ps1      (Ctrl+C stops everything)
$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
Set-Location $root
$py = Join-Path $root ".venv\Scripts\python.exe"

if (-not (Test-Path $py)) { throw "No .venv found. Create one first: python -m venv .venv" }

# free the ports if an older run is still alive
foreach ($port in 8000, 5173) {
    Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
        ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
}

# Python deps
& $py -c "import numpy, scipy, fastapi, uvicorn" 2>$null
if ($LASTEXITCODE -ne 0) { Write-Host "Installing Python packages..."; & $py -m pip install -q -r requirements.txt }

# Data: build only if missing (delete data/processed/manifest.json to force a rebuild)
if (-not (Test-Path "data\processed\manifest.json")) {
    if (-not (Test-Path "data\raw\temp.npy")) {
        Write-Host ""
        Write-Host "The processed data files are missing and there is no raw data to build them from." -ForegroundColor Yellow
        Write-Host "This app runs locally, so the data has to exist on this machine. Get it once with (from the repo root):" -ForegroundColor Yellow
        Write-Host "  1. .venv\Scripts\python preprocessing\download.py        (public NASA/NOAA files, ~400 MB, no login)"
        Write-Host "  2. .venv\Scripts\python preprocessing\load_real.py        (regrids them onto the common grid)"
        Write-Host "  3. .venv\Scripts\python preprocessing\load_earthdata.py   (MERRA-2 layers; needs a free NASA Earthdata login, see README)"
        Write-Host "  4. .\start.ps1                                           (builds data/processed, then starts the site)"
        Write-Host "The finished data/processed folder is small and is normally committed to git, so a fresh clone does not need this."
        Write-Host "A hosted version would serve those files to every visitor, so visitors would never download anything themselves."
        exit 1
    }
    Write-Host "Running preprocessing..."
    & $py -W ignore preprocessing\pipeline.py
}

# Frontend deps
if (-not (Test-Path "frontend\node_modules")) {
    Write-Host "Installing frontend packages..."
    Push-Location frontend; npm install; Pop-Location
}

# Backend in background, frontend in foreground
$backend = Start-Process $py -ArgumentList "-m", "uvicorn", "backend.app:app", "--port", "8000" -WorkingDirectory $root -PassThru -WindowStyle Hidden
try {
    Start-Job { Start-Sleep 3; Start-Process "http://localhost:5173" } | Out-Null
    Push-Location frontend
    npm run dev
}
finally {
    Pop-Location
    Stop-Process -Id $backend.Id -Force -ErrorAction SilentlyContinue
    Write-Host "Stopped."
}
