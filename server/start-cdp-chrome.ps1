$ErrorActionPreference = 'Stop'

$chromeCandidates = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
)
$chrome = $chromeCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $chrome) { throw 'Chrome executable was not found.' }

$existingChrome = Get-Process chrome -ErrorAction SilentlyContinue
if ($existingChrome) {
  throw 'Chrome is already running. Close it before starting CDP Chrome, or launch your existing Chrome with --remote-debugging-port=9222.'
}

$profilePath = Join-Path $env:LOCALAPPDATA 'gpt-live-cdp-profile'
$extensionPath = Resolve-Path (Join-Path $PSScriptRoot '..\extension')
New-Item -ItemType Directory -Force -Path $profilePath | Out-Null

Start-Process -FilePath $chrome -ArgumentList @(
  '--remote-debugging-port=9222',
  "--user-data-dir=$profilePath",
  '--no-first-run',
  '--no-default-browser-check',
  '--start-maximized',
  "--load-extension=$extensionPath"
)

Write-Host "CDP Chrome started on http://127.0.0.1:9222"
Write-Host "Log in to the sites you want to automate, then run npm run start:cdp in another terminal."