$ErrorActionPreference = 'Stop'
$env:BROWSER_BACKEND = 'extension'
Remove-Item Env:USE_PLAYWRIGHT_CHROMIUM -ErrorAction SilentlyContinue
node server.mjs
