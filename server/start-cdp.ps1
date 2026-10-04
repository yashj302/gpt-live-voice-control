$ErrorActionPreference = 'Stop'
$env:BROWSER_BACKEND = 'playwright-cdp'
$env:USE_PLAYWRIGHT_CDP = '1'
$env:CHROME_CDP_URL = 'http://127.0.0.1:9222'
node server.mjs