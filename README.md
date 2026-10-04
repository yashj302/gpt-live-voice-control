# GPT Live Voice Control

Speak to Chrome and it acts on the page in front of you: open a site, switch tabs, click, type, scroll, and fill a form.

The extension runs in your own Chrome window. A small local server creates a short-lived OpenAI Realtime token. Your API key stays on that server and is never stored in the extension.

## What you need

- Google Chrome
- Node.js
- An OpenAI API key with access to the Realtime API

## Setup

1. Clone this repo and install the server dependencies:

```powershell
cd server
npm install
```

2. Create `server/.env` from the example and put your own key in it:

```powershell
copy .env.example .env
```

```env
OPENAI_API_KEY=your_openai_api_key_here
```

Do not commit `server/.env`. Only the placeholder file belongs in git.

3. Load the extension:

- Open `chrome://extensions`
- Turn on **Developer mode**
- Click **Load unpacked**
- Choose the `extension` folder in this repo

4. Start the server and leave that terminal open:

```powershell
cd server
npm run start:personal
```

The server listens on `http://localhost:3000`. A healthy personal session looks like this:

```json
{"ok":true,"browserBackend":"extension"}
```

You can check it with:

```powershell
Invoke-WebRequest -UseBasicParsing http://localhost:3000/health
```

## Connect

1. Click the extension icon.
2. Click **Connect Voice**.
3. Allow the microphone if Chrome asks.
4. Wait until the status says **Connected and listening.**

You can close the popup after that. Voice keeps listening until you click **Disconnect**.

Chrome shows a bar that says the extension started debugging the browser. That is expected. Debugging is what lets clicks and typing count as real input. Do not dismiss it while a session is running.

After you change extension files, click **Reload** on the extension card at `chrome://extensions`, then connect again. Restart the server only when you change server files.

## What you can say

Talk the way you would tell someone at the keyboard:

- "Open Gmail."
- "Search for CIBIL site."
- "Open the first link."
- "Go to cibil.com."
- "Switch to the GitHub tab."
- "Scroll down."
- "Click Sign in."
- "Fill the email with name@example.com and the message with Hello."
- "Press Enter."

It will ask before sending email, paying, deleting something, or placing an order. It does not read passwords aloud.

## Stop

Open the extension popup and click **Disconnect**, then stop the server terminal with Ctrl+C.

## If it will not connect

- The server terminal must still be running `npm run start:personal`.
- `server/.env` must contain a real `OPENAI_API_KEY`.
- Reload the extension on `chrome://extensions` and click **Connect Voice** again.
- The activity log in the popup shows the step that failed.

More detail on the code and the optional Playwright browser mode is in [DEVELOPMENT.md](DEVELOPMENT.md).
