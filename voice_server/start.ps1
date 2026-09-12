param(
    [ValidateSet('cache', 'live')][string]$Mode = 'cache',
    [string]$Bundle,
    [string]$Python,
    [string]$Assets = (Join-Path $PSScriptRoot 'private')
)
$ErrorActionPreference = 'Stop'
$env:PYTHONUTF8 = '1'
if ($Bundle) { $Bundle = [System.IO.Path]::GetFullPath($Bundle) }
$Assets = [System.IO.Path]::GetFullPath($Assets)
if ($Python) { $Python = [System.IO.Path]::GetFullPath($Python) }
Set-Location -LiteralPath $PSScriptRoot
if (-not $Python) {
    if (Get-Command py -ErrorAction SilentlyContinue) {
        $Python = & py -3 -c 'import sys; print(sys.executable)'
    } elseif (Get-Command python -ErrorAction SilentlyContinue) {
        $Python = & python -c 'import sys; print(sys.executable)'
    }
}
if (-not $Python -or -not (Test-Path -LiteralPath $Python)) {
    throw 'Install free Python 3 from python.org, or pass -Python C:\path\python.exe.'
}
& $Python -c 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)'
if ($LASTEXITCODE -ne 0) { throw 'Python 3.9 or newer is required.' }
if ($Bundle) {
    & $Python voice_assets.py $Bundle $Assets
    if ($LASTEXITCODE -ne 0) { throw 'Private bundle import failed.' }
}
if ($Mode -eq 'cache') {
    & $Python cache_server.py --assets $Assets
    exit $LASTEXITCODE
}
if (-not (Test-Path -LiteralPath (Join-Path $Assets 'target_se.pth'))) {
    throw 'Import your PRIVATE notebook bundle first with -Bundle C:\path\manhua-private.zip.'
}
# uv downloads a dedicated Python 3.10; system Python/Kaggle packages stay intact.
$Tools = Join-Path $PSScriptRoot '.tools'
$env:PYTHONPATH = $Tools
$Runtime = Join-Path $PSScriptRoot '.runtime'
$RuntimePython = Join-Path $Runtime 'Scripts\python.exe'
if (-not (Test-Path -LiteralPath $RuntimePython)) {
    & $Python -m pip install --target $Tools uv==0.6.17
    if ($LASTEXITCODE -ne 0) { throw 'uv installation failed.' }
    & $Python -m uv venv --python 3.10 --seed $Runtime
    if ($LASTEXITCODE -ne 0) { throw 'Python 3.10 environment creation failed.' }
}
if (-not (Test-Path -LiteralPath (Join-Path $Runtime 'manhua-ready.json'))) {
    & $RuntimePython setup_runtime.py --torch-index cpu
    if ($LASTEXITCODE -ne 0) { throw 'Model setup failed; cache mode remains available.' }
}
$env:MANHUA_VOICE_ASSETS = $Assets
$env:MANHUA_VOICE_DEVICE = 'cpu'
& $RuntimePython -m uvicorn server:app --host 127.0.0.1 --port 8765 --no-access-log
exit $LASTEXITCODE
