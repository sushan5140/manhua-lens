# Start the actual interactive Manhua Multiverse app.
# Execute from the preview worktree: .\multiverse\scripts\start-local.ps1
$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$envPath = Join-Path $root "multiverse\.env"
$example = Join-Path $root "multiverse\.env.example"
if (!(Test-Path $envPath)) {
    Copy-Item $example $envPath
    Write-Host "Created multiverse\.env. Optional: add a Groq or OpenRouter key for LIVE AI."
    Write-Host "You can still explore the stateful OFFLINE world without a key."
}
$python = Get-Command py -ErrorAction SilentlyContinue
if (!$python) {
    throw "The Python launcher 'py' is missing. Install Python 3.10+."
}
Write-Host "Opening Manhua Multiverse at http://localhost:8080/multiverse/"
Write-Host "Press Ctrl+C to stop. If port 8080 is in use, stop your previous 'py -m http.server' terminal."
Set-Location $root
& py (Join-Path $root "multiverse\server.py")
