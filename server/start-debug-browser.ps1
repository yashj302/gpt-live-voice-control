$ErrorActionPreference = 'Stop'

$chromeCandidates = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
)
$chrome = $chromeCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $chrome) { throw 'Chrome executable was not found.' }

$extensionPath = Resolve-Path (Join-Path $PSScriptRoot '..\extension')
$profilePath = Join-Path ([System.IO.Path]::GetTempPath()) 'gpt-live-debug-chrome'
New-Item -ItemType Directory -Force -Path $profilePath | Out-Null

Start-Process -FilePath $chrome -ArgumentList @(
  '--remote-debugging-port=9222',
  "--user-data-dir=$profilePath",
  "--load-extension=$extensionPath",
  '--disable-features=DisableLoadExtensionCommandLineSwitch',
  '--no-first-run',
  '--no-default-browser-check',
  '--autoplay-policy=no-user-gesture-required'
)

Write-Host "Debug Chrome started on port 9222."
Write-Host "Use this Chrome window for the voice tab-switch commands."