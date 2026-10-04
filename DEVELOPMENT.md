# GPT Live Extension Development Guide

This project combines a Chrome extension, a local Node.js token server, OpenAI Realtime voice, and an optional Playwright browser backend.

The system supports two browser modes:

- **Personal browser mode**: the extension controls the Chrome browser where it is installed.
- **Automated browser mode**: Playwright launches and controls a separate visible browser profile.

## Project Layout

```text
gpt-live-extension/
|-- extension/
|   |-- manifest.json          Chrome extension configuration
|   |-- popup.html             Popup UI
|   |-- popup.js               Connect/disconnect UI and activity log
|   |-- service-worker.js      Browser actions and message routing
|   |-- offscreen.html         Persistent media document host
|   |-- offscreen.js           Microphone, WebRTC, AI events, tool dispatch
|   `-- content.js             Optional page content-script entry point
|-- server/
|   |-- server.mjs             Local token server and action API
|   |-- playwright-controller.mjs Playwright browser automation
|   |-- logger.mjs              File and console logging
|   |-- logging-gpt.log        Runtime log file
|   |-- package.json            Server commands and dependencies
|   |-- start-personal.ps1      Personal Chrome launcher
|   |-- start-automated.ps1     Playwright launcher
|   `-- test-extension.mjs      Selenium smoke test
|-- DEVELOPMENT.md             This guide
`-- gpt-live-v2.zip            Saved project archive, if present
```

## Requirements

- Windows with PowerShell.
- Node.js installed and available as `node` and `npm`.
- Google Chrome for personal browser mode.
- A valid OpenAI API key in `server/.env`.
- Chrome microphone access enabled for the extension.

The `.env` file belongs in `server/`:

```env
OPENAI_API_KEY=your_key_here
```

Do not commit or share the `.env` file. The server uses the API key to create short-lived Realtime client secrets. The browser receives only the temporary client secret.

## Install Dependencies

From the project root:

```powershell
cd server
npm install
```

Playwright is installed as a dependency. The Selenium package is retained for the extension smoke test.

To install Playwright's bundled Chromium runtime:

```powershell
npx playwright install chromium
```

The automated launcher uses this bundled browser runtime rather than relying on the installed Chrome build.

## Browser Modes

### Personal Browser Mode

This is the correct mode when you want the extension to control your regular Chrome browser and its existing tabs.

Start it with:

```powershell
cd C:\Users\yashj\OneDrive\Desktop\gpt-live-extension\server
npm run start:personal
```

Equivalent direct command:

```powershell
cd server
npm start
```

The personal launcher sets:

```text
BROWSER_BACKEND=extension
```

In this mode, browser actions use Chrome extension APIs such as:

- `chrome.tabs.query`
- `chrome.tabs.update`
- `chrome.scripting.executeScript`

The local server still creates the Realtime token, but it does not launch Playwright.

### Automated Playwright Mode

This mode launches a separate visible Chrome profile controlled by Playwright.

Start it with:

```powershell
cd C:\Users\yashj\OneDrive\Desktop\gpt-live-extension\server
npm run start:automated
```

The automated launcher sets:

```text
BROWSER_BACKEND=playwright
USE_PLAYWRIGHT_CHROMIUM=1
```

The automated browser supports stronger automation primitives such as:

- Role- and label-based locators.
- Automatic waiting for visible and enabled elements.
- Mouse and keyboard actions.
- Page scrolling.
- Screenshots and page text extraction.
- Multiple tabs and popup pages.
- Form and contenteditable interaction.
- Browser lifecycle recovery when the controlled browser closes.

Playwright controls its own browser profile. It does not automatically control an already-running personal Chrome window.

### Existing Chrome Through Playwright CDP

Playwright can attach to an existing Chrome session through the Chrome DevTools Protocol (CDP). The existing Chrome must be started with remote debugging before Playwright connects. A normal Chrome process that was started without this flag cannot be attached to after the fact.

Recommended workflow:

Terminal 1, start a visible Chrome profile with CDP enabled:

```powershell
cd server
npm run start:cdp-chrome
```

Log in to Gmail or other sites in that Chrome window. Its cookies and open tabs remain available to Playwright.

Terminal 2, attach the server to that running Chrome:

```powershell
cd server
npm run start:cdp
```

The CDP server uses:

```text
CHROME_CDP_URL=http://127.0.0.1:9222
USE_PLAYWRIGHT_CDP=1
BROWSER_BACKEND=playwright-cdp
```

Voice actions then use Playwright against the already-running CDP Chrome, including navigation, tab switching, clicking, typing, searching, scrolling, and page reading.

To verify the debugging endpoint:

```powershell
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:9222/json/version
```

Security notes:

- Do not expose port `9222` to a network. It gives powerful control over the browser.
- The CDP launcher uses a separate profile at `%LOCALAPPDATA%\gpt-live-cdp-profile` so it does not corrupt the normal Chrome profile.
- Close ordinary Chrome before running `npm run start:cdp-chrome`; Chrome may reuse an existing process and ignore the debugging flag otherwise.

## Starting a Session

1. Start exactly one backend mode.
2. Open or reload the extension in the selected browser.
3. Open the extension popup.
4. Click **Connect Voice**.
5. Allow microphone access when prompted.
6. Speak a browser command.
7. Click **Disconnect** when finished.

For personal Chrome, use `npm run start:personal`.

For automated Chrome, use `npm run start:automated` and use the visible Playwright browser window that it opens.

The backend mode is visible through:

```powershell
Invoke-WebRequest -UseBasicParsing http://localhost:3000/health
```

Expected personal mode response:

```json
{"ok":true,"browserBackend":"extension"}
```

Expected automated mode response:

```json
{"ok":true,"browserBackend":"playwright"}
```

## Voice Capabilities

The Realtime session currently advertises these browser tools:

### `navigateTo`

Navigates the current browser page to an HTTP or HTTPS URL.

Example voice commands:

```text
Go to Gmail.
Open https://example.com.
Navigate to Medium.
```

### `switchTab`

Switches tabs by number or title/URL text.

Example voice commands:

```text
Switch to tab 3.
Switch to the Stack Overflow tab.
Go to the GitHub tab.
```

### `clickElement`

Clicks a visible button, link, input button, or element with `role="button"`.

Example voice commands:

```text
Click Sign in.
Click the Submit button.
Click Continue.
```

In personal browser mode, page access depends on extension permissions and the page being controllable. Chrome internal pages such as `chrome://settings` and the Chrome Web Store are restricted.

### `typeInTextBox`

Finds the most relevant visible editable field. It supports input elements, textareas, and contenteditable fields.

Optional field hints improve selection:

```text
Type my email into the email field.
Fill the subject with Project Update.
Write this message in the description box.
Enter invoices in the search field.
```

The action injects text and dispatches `input` and `change` events. It does not submit the form automatically.

### `typeInSearchBar`

Targets a search-like field without submitting it.

```text
Type OpenAI into the search bar.
```

### `searchPage`

Finds a search field, enters a query, and submits it.

```text
Search Gmail for invoices.
Search this page for Playwright.
```

Gmail and other JavaScript-heavy pages can require a visible search button or application-specific event handling. The implementation tries keyboard events, a visible search button, and form submission.

### `scrollPage`

Scrolls the active page.

```text
Scroll down.
Scroll down 700 pixels.
Scroll up.
Scroll to the top.
Scroll to the bottom.

### `findBestPrice`

This is the multi-site comparison workflow. It is available in Playwright and Playwright-CDP modes because it needs to open several pages, inspect their rendered content, and preserve the selected winner.

Example:

```text
Grab the links on this shopping page, compare iPhone 17 prices, and open the cheapest credible result.
```

The tool:

1. Reads product links from the current page.
2. If no usable links exist, opens a Bing Shopping search for the product.
3. Limits inspection to 3-12 candidate links.
4. Opens each candidate in a temporary Playwright page.
5. Waits for the page to render and extracts visible currency values.
6. Rejects blocked pages, CAPTCHA pages, accessory pages, and pages without product evidence.
7. Groups comparable results by currency.
8. Opens the lowest verified result.
9. Sends the winner, alternatives, price evidence, and skipped candidates back to the voice model.

The tool does not guess currency conversions or claim a price when a page hides the amount. If no credible price is available, it returns `insufficient_evidence` with the inspected candidates and reason.

This workflow still has normal web-automation limits: login walls, bot checks, regional pricing, delivery fees, taxes, coupons, variants, and dynamic prices can make a page unsuitable for comparison. A displayed product price is not necessarily the final checkout price.
```

## How the Code Works

### 1. Popup User Gesture

`extension/popup.js` owns the connect and disconnect controls. The connect click requests microphone permission while Chrome has a user gesture. This is important because offscreen documents cannot always trigger a first-time microphone permission prompt reliably.

The popup then sends:

```text
START_SESSION
```

The disconnect button sends:

```text
DISCONNECT_SESSION
```

The popup also renders the local activity log stored in `chrome.storage.local`.

### 2. Service Worker

`extension/service-worker.js` receives messages and performs browser actions.

It routes actions according to the backend selected by the server:

- `extension`: use native Chrome extension APIs.
- `playwright`: POST an action to `http://localhost:3000/playwright/action`.

Native actions include:

```text
CLICK_ELEMENT
NAVIGATE_TO
SWITCH_TAB
SEARCH_PAGE
TYPE_IN_SEARCH_BAR
TYPE_IN_TEXT_BOX
SCROLL_PAGE
```

The service worker also forwards activity to:

```text
POST http://localhost:3000/extension-log
```

### 3. Offscreen Document

`extension/offscreen.js` owns the persistent voice session.

It performs these steps:

1. Requests a temporary session token from `/session`.
2. Creates an `RTCPeerConnection`.
3. Captures microphone audio.
4. Creates the `oai-events` data channel.
5. Sends the WebRTC SDP offer to OpenAI Realtime.
6. Receives AI events and tool calls.
7. Sends browser actions to the service worker.
8. Stops microphone tracks and closes WebRTC on disconnect.

The offscreen document allows the popup to close without immediately destroying the voice session.

### 4. Local Server

`server/server.mjs` provides:

```text
GET  /health
POST /session
POST /extension-log
POST /playwright/action
```

`/session` creates the short-lived Realtime client secret using `OPENAI_API_KEY`.

`/playwright/action` dispatches actions to `playwright-controller.mjs`.

`/extension-log` receives activity from the extension and writes it to `logging-gpt.log`.

### 5. Playwright Controller

`server/playwright-controller.mjs` owns the visible automated browser. It provides:

```text
navigate
switchTab
click
type
search
scroll
readPage
```

It uses a temporary persistent profile and automatically loads the local extension in bundled Playwright Chrome.

If the browser is closed, the controller detects a stale context and relaunches a fresh browser on the next action.

## Debugging Commands

### Check the Server

```powershell
Invoke-WebRequest -UseBasicParsing http://localhost:3000/health
```

### Check Which Node Server Is Running

```powershell
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
  Select-Object ProcessId,CommandLine
```

### Check Who Owns Port 3000

```powershell
Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue |
  Select-Object LocalAddress,LocalPort,OwningProcess
```

### Stop the Project Server

There is no built-in `npm stop` command. Stop only Node processes whose command line is this project server:

```powershell
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
  Where-Object { $_.CommandLine -match 'server.mjs' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```

Do not use a broad `Stop-Process` against every Node process if other development tools are running.

### Validate JavaScript

```powershell
cd extension
node --check popup.js
node --check content.js
node --check service-worker.js
node --check offscreen.js

cd ..\server
node --check server.mjs
node --check playwright-controller.mjs
node --check logger.mjs
```

### Run the Extension Smoke Test

Start the server first, then:

```powershell
cd server
npm run test:extension
```

This launches Selenium Chrome with an isolated profile and checks the extension popup. It is separate from the Playwright voice backend.

### Inspect Recent Logs

```powershell
Get-Content server\logging-gpt.log -Tail 50
```

Follow the log live:

```powershell
Get-Content server\logging-gpt.log -Wait
```

Search for failures:

```powershell
Select-String -Path server\logging-gpt.log -Pattern 'failed|error|exception|closed|timeout'
```

Search for browser actions:

```powershell
Select-String -Path server\logging-gpt.log -Pattern 'Playwright|scroll|switch|typing|navigation|click'
```

## Activity Logging

The runtime log is:

```text
server/logging-gpt.log
```

The log includes:

- Server requests.
- Session creation stages.
- AI event types.
- AI output transcript fragments.
- AI function calls and arguments.
- Browser action requests.
- Selected tab/page information.
- Search and textbox candidate information.
- Playwright actions and failures.
- Popup events.
- Service-worker messages.
- Offscreen messages.
- Uncaught exceptions and unhandled promise rejections.

Sensitive fields are redacted when serialized. API keys, authorization values, tokens, secrets, and passwords should not be written to the log.

The popup also shows a recent local activity view. Use **Clear activity log** to reset the extension-side view.

## Common Failures

### `EADDRINUSE: address already in use :::3000`

Another server is using port 3000. Check the owner:

```powershell
Get-NetTCPConnection -LocalPort 3000 -State Listen |
  Select-Object OwningProcess
```

Stop the old project server and start the desired mode again.

### `browserContext.newPage: Target page, context or browser has been closed`

The Playwright browser was closed while the server still had an old context reference. The controller now detects this and relaunches the browser. Restarting the server is also safe:

```powershell
cd server
npm run start:automated
```

### `NotAllowedError - Permission dismissed`

Chrome dismissed microphone permission. Reload the extension, click **Connect Voice**, and explicitly choose **Allow**. The permission request must occur from the popup user gesture.

### `Cannot access contents of url`

The extension is trying to inject into a page it cannot access. Normal web pages are covered by `<all_urls>`, but Chrome internal pages and protected browser surfaces cannot be scripted.

For Playwright mode, use `npm run start:automated` instead of native extension injection.

### Search does not submit

Use the activity log to inspect:

```text
AI requested browser tool
search active tab
search field result
search failed
```

For difficult sites, use separate commands:

```text
Type invoices in the search box.
Click the search button.
```

### The extension does not appear in Chrome

For personal Chrome:

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Click Load unpacked.
4. Select:
   ```text
   C:\Users\yashj\OneDrive\Desktop\gpt-live-extension\extension
   ```
5. Click Select Folder.
6. Reload the extension after code changes.

For automated mode, use `npm run start:automated`. It uses Playwright's bundled Chrome and loads the extension automatically.

### Voice connects but actions target the wrong browser

Check the health response:

```powershell
Invoke-WebRequest -UseBasicParsing http://localhost:3000/health
```

Use:

```powershell
npm run start:personal
```

for personal Chrome, or:

```powershell
npm run start:automated
```

for Playwright Chrome.

Disconnect and reconnect voice after changing backend modes because the backend value is selected when the Realtime session token is created.

## Safe Development Practices

- Keep `OPENAI_API_KEY` only in `server/.env`.
- Do not include API keys in logs or ZIP files shared with others.
- Prefer HTTP and HTTPS navigation only.
- Require confirmation before sending email, deleting content, making purchases, or submitting irreversible forms.
- Use a separate Playwright profile for automated testing.
- Do not broadly terminate all Node or Chrome processes.
- Review `logging-gpt.log` before sharing it because it can contain user queries, URLs, and page metadata.
- Reload the extension after changing extension files.
- Restart the server after changing Realtime tool definitions.

## Versioning and ZIP Archives

Create a versioned archive from the project root:

```powershell
$project = 'C:\Users\yashj\OneDrive\Desktop\gpt-live-extension'
$archive = 'C:\Users\yashj\OneDrive\Desktop\gpt-live-v3.zip'
if (Test-Path $archive) { Remove-Item $archive -Force }
Compress-Archive -Path $project -DestinationPath $archive -CompressionLevel Optimal
Get-Item $archive | Select-Object FullName,Length
```

Before sharing an archive, consider excluding:

- `server/.env`
- `server/logging-gpt.log`
- `server/node_modules/`

A safer source archive can be made by copying only source/config files into a temporary staging directory before compression.
