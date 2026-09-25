# Optional Windows installer for the eight user-selected design skill repositories.
# No cloned third-party code is committed into Manhua Lens.
param(
  [string]$Destination = (Join-Path $env:USERPROFILE "Documents\frontend-skills")
)
$ErrorActionPreference = "Stop"
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  throw "Git is required. Install Git for Windows and reopen PowerShell."
}
New-Item -ItemType Directory -Force -Path $Destination | Out-Null
$skills = [ordered]@{
  "emil-kowalski" = "https://github.com/emilkowalski/skills.git"
  "anthropic" = "https://github.com/anthropics/skills.git"
  "ui-ux-pro-max" = "https://github.com/nextlevelbuilder/ui-ux-pro-max-skill.git"
  "material-3" = "https://github.com/hamen/material-3-skill.git"
  "karpathy" = "https://github.com/multica-ai/andrej-karpathy-skills.git"
  "animate" = "https://github.com/delphi-ai/animate-skill.git"
  "design-motion" = "https://github.com/kylezantos/design-motion-principles.git"
  "design-engineering" = "https://github.com/AgentsORG/design-engineering.git"
}
foreach ($name in $skills.Keys) {
  $target = Join-Path $Destination $name
  if (Test-Path (Join-Path $target ".git")) {
    Write-Host "[skip] $name already cloned at $target"
    continue
  }
  if (Test-Path $target) {
    Write-Warning "Skipping $name: path exists but is not a Git checkout: $target"
    continue
  }
  Write-Host "[clone] $name"
  & git clone --depth 1 $skills[$name] $target
  if ($LASTEXITCODE -ne 0) {
    Write-Warning "Clone failed for $name. Check network/repository access and retry."
  }
}
Write-Host "Finished. Inspect the skill docs in: $Destination"
