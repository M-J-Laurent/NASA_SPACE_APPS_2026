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
    if (-not (Test-Path "data\raw\grid.json")) { Write-Host "Generating demo raw data..."; & $py preprocessing\synthetic.py }
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
