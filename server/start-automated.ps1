$ErrorActionPreference = 'Stop'
$env:BROWSER_BACKEND = 'playwright'
$env:USE_PLAYWRIGHT_CHROMIUM = '1'
node server.mjs
