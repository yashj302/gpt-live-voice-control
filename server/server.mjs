import { getLogPath, writeLog } from "./logger.mjs";
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { Builder } from "selenium-webdriver";
import chrome from "selenium-webdriver/chrome.js";
import { performPlaywrightAction, closePlaywrightBrowser } from "./playwright-controller.mjs";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());
let seleniumDriver;

app.use((req, res, next) => {
  console.log(`[Server] ${req.method} ${req.path}`, {
    query: req.query,
    bodyKeys: Object.keys(req.body || {}),
    body: req.path === '/extension-log' ? req.body : undefined
  });
  next();
});

app.post("/extension-log", (req, res) => {
  const { source = "extension", event = "activity", details = {} } = req.body || {};
  writeLog("info", `[Extension] ${source}: ${event}`, details);
  res.json({ ok: true });
});

app.get("/health", (req, res) => {
  res.json({ ok: true, browserBackend: process.env.BROWSER_BACKEND || "extension" });
});

app.post("/playwright/action", async (req, res) => {
  try {
    const { action, args } = req.body || {};
    console.log("[Server] Playwright action", { action, args });
    const result = await performPlaywrightAction(action, args);
    res.json(result);
  } catch (error) {
    console.error("[Server] Playwright action failed", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/selenium/switch-tab", async (req, res) => {
  try {
    const target = String(req.body?.target || "").trim();
    if (!target) return res.status(400).json({ error: "A tab number or title is required." });

    const driver = await getSeleniumDriver();
    const handles = await driver.getAllWindowHandles();
    const normalizedTarget = target.toLowerCase();
    const numberMatch = normalizedTarget.match(/\btab(?:\s+number)?\s*(\d+)\b|^(\d+)$/);
    const requestedIndex = numberMatch ? Number(numberMatch[1] || numberMatch[2]) : NaN;
    let selectedHandle;

    if (Number.isInteger(requestedIndex) && requestedIndex > 0) {
      selectedHandle = handles[requestedIndex - 1];
    } else {
      const textTarget = normalizedTarget
        .replace(/\b(?:switch|change|move|go|to|into|of|the|tab)\b/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      const words = textTarget.split(" ").filter(Boolean);
      for (const handle of handles) {
        await driver.switchTo().window(handle);
        const title = (await driver.getTitle()).toLowerCase();
        const url = (await driver.getCurrentUrl()).toLowerCase();
        if (words.every(word => title.includes(word) || url.includes(word))) {
          selectedHandle = handle;
          break;
        }
      }
    }

    if (!selectedHandle) {
      throw new Error(`Could not find a Selenium tab matching "${target}".`);
    }
    await driver.switchTo().window(selectedHandle);
    res.json({ ok: true });
  } catch (error) {
    console.error("[Selenium tab switch failed]", error);
    res.status(500).json({ error: error.message });
  }
});

async function getSeleniumDriver() {
  if (seleniumDriver) return seleniumDriver;
  const debuggerAddress = process.env.CHROME_DEBUGGER_ADDRESS || "127.0.0.1:9222";
  const options = new chrome.Options().debuggerAddress(debuggerAddress);
  seleniumDriver = await new Builder()
    .forBrowser("chrome")
    .setChromeOptions(options)
    .build();
  return seleniumDriver;
}

app.post("/session", async (req, res) => {
  try {
    console.log("[Server] Fetching an ephemeral token from OpenAI Realtime API...");

    if (!process.env.OPENAI_API_KEY) {
      console.error("[Server Error] Missing OPENAI_API_KEY inside your local .env file!");
      return res.status(500).json({ error: "API Key missing on server" });
    }

    // Create a short-lived client secret for the browser WebRTC session.
    const response = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY.trim()}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        session: {
          type: "realtime",
          model: "gpt-realtime",
          instructions: [
            "You are the user's hands on their Chrome browser. Act on clear spoken requests with the tools.",
            "You can open sites, go back, reload, list and switch tabs, scroll, click, type, press keys, and fill forms.",
            "If you are unsure which control to use, call describePage and then use the returned ref, such as 0:e3.",
            "Call listTabs before switching when the user does not name a tab number or title.",
            "For more than one field, call fillForm once. Use pressKey for Enter, Tab, Escape, arrows, and shortcuts.",
            "navigateTo accepts a full URL, a site name such as gmail, or a search phrase.",
            "When the user asks to open a search result, call clickElement with first link, second link, or the result domain such as cibil.com.",
            "Do not send email, pay, delete, or place an order until the user explicitly asks.",
            "After a tool error, use the nearby controls or describePage and try once more.",
            "After you finish the requested action, say one short confirmation and then stay quiet. Do not ask a follow-up question unless a required detail is missing. Do not read passwords or the whole page aloud."
          ].join(" "),
          audio: { output: { voice: "marin" } },
          tools: [
            {
              type: "function",
              name: "clickElement",
              description: "Clicks a button, link, menu item, checkbox, or other control on the current page. For a search result, pass first link, second link, or the site domain such as cibil.com. Also accepts a visible label or a describePage ref such as 0:e3. Use switchTab for browser tabs.",
              parameters: {
                type: "object",
                properties: {
                  label: { type: "string", description: "Visible label, result phrase such as first link, site domain, or describePage ref." }
                },
                required: ["label"]
              }
            },
            {
              type: "function",
              name: "describePage",
              description: "Lists visible buttons, links, and form fields on the current page, with refs you can click or fill. Call this before guessing a label.",
              parameters: { type: "object", properties: {} }
            },
            {
              type: "function",
              name: "listTabs",
              description: "Lists open browser tabs with 1-based numbers, titles, and URLs.",
              parameters: { type: "object", properties: {} }
            },
            {
              type: "function",
              name: "navigateTo",
              description: "Navigates the active browser tab to a URL.",
              parameters: {
                type: "object",
                properties: {
                  url: { type: "string", description: "A full https URL, a site name such as gmail or github.com, or words to search." },
                  newTab: { type: "boolean", description: "Open the destination in a new tab when the user asks for a new tab." }
                },
                required: ["url"]
              }
            },
            {
              type: "function",
              name: "switchTab",
              description: "Switches the browser to another open tab. Use a number for the 1-based tab position, or text from the tab title or URL, such as Stack Overflow.",
              parameters: {
                type: "object",
                properties: {
                  target: { type: "string", description: "A 1-based tab number or text matching the tab title or URL." }
                },
                required: ["target"]
              }
            },
            {
              type: "function",
              name: "searchPage",
              description: "Searches the currently active webpage for a spoken query. Finds the page's search field automatically, enters the query, and submits it. Use this for requests like searching Gmail for invoices.",
              parameters: {
                type: "object",
                properties: {
                  query: { type: "string", description: "The words to search for on the current webpage." }
                },
                required: ["query"]
              }
            },
            {
              type: "function",
              name: "typeInSearchBar",
              description: "Finds the active webpage's search bar and types text into it without submitting. Use this when the user asks to write or enter something in a search bar.",
              parameters: {
                type: "object",
                properties: {
                  text: { type: "string", description: "The text to type into the search bar." }
                },
                required: ["text"]
              }
            },
            {
              type: "function",
              name: "typeInTextBox",
              description: "Types into one field, or selects a dropdown option, or checks a box. For several fields, use fillForm instead.",
              parameters: {
                type: "object",
                properties: {
                  text: { type: "string", description: "The text or option to enter." },
                  hint: { type: "string", description: "Field label, placeholder, or describePage ref such as email, subject, or 0:e4." }
                },
                required: ["text"]
              }
            },
            {
              type: "function",
              name: "fillForm",
              description: "Fills several form fields in one step. Supports text boxes, dropdowns, checkboxes, and radio buttons. Submit only when the user explicitly asks.",
              parameters: {
                type: "object",
                properties: {
                  fields: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        target: { type: "string", description: "Field label or describePage ref." },
                        value: { type: "string", description: "Text or dropdown option. Omit for a checkbox when checked is set." },
                        checked: { type: "boolean", description: "Whether a checkbox or radio button should be selected." }
                      },
                      required: ["target"]
                    }
                  },
                  submit: { type: "boolean", description: "Click the form submit button after filling. Only when the user explicitly asks to submit, send, or search." },
                  submitLabel: { type: "string", description: "Optional submit button label, such as Sign in or Search." }
                },
                required: ["fields"]
              }
            },
            {
              type: "function",
              name: "pressKey",
              description: "Presses a keyboard key or shortcut on the page, such as Enter, Tab, Escape, Backspace, ArrowDown, Space, or Control+A. Optional target focuses a control first.",
              parameters: {
                type: "object",
                properties: {
                  key: { type: "string", description: "Key or chord, such as Enter, Shift+Tab, or Control+L." },
                  target: { type: "string", description: "Optional label or ref to focus before the key press." }
                },
                required: ["key"]
              }
            },
            {
              type: "function",
              name: "browserControl",
              description: "Controls the browser like the keyboard and mouse: go back, go forward, reload, open a new tab, or close a tab.",
              parameters: {
                type: "object",
                properties: {
                  command: { type: "string", enum: ["back", "forward", "reload", "newTab", "closeTab"], description: "Browser command." },
                  url: { type: "string", description: "Optional destination when opening a new tab." },
                  target: { type: "string", description: "Optional tab number or title when closing a tab." }
                },
                required: ["command"]
              }
            },
            {
              type: "function",
              name: "scrollPage",
              description: "Scrolls the current webpage. Use direction down or up, optionally with a pixel amount, or use top or bottom.",
              parameters: {
                type: "object",
                properties: {
                  direction: { type: "string", enum: ["up", "down", "top", "bottom"], description: "Scroll direction or destination." },
                  amount: { type: "number", description: "Optional scroll distance in pixels. Defaults to about one viewport." }
                },
                required: ["direction"]
              }
            },
            {
              type: "function",
              name: "findBestPrice",
              description: "Collects product links from the current results page, visits a bounded number of them, extracts product prices, ranks the lowest credible price, and opens the cheapest result. Use for requests like finding the cheapest iPhone 17.",
              parameters: {
                type: "object",
                properties: {
                  product: { type: "string", description: "The product to compare, such as iPhone 17." },
                  maxLinks: { type: "number", description: "Maximum number of result links to inspect, from 3 to 12. Defaults to 8." }
                },
                required: ["product"]
              }
            }
          ]
        }
      })
    });

    const responseText = await response.text();
    
    if (!response.ok) {
      console.log(`\n🔴 [OpenAI API Rejection Code ${response.status}]:`, responseText);
      return res.status(response.status).send(responseText);
    }

    const data = JSON.parse(responseText);
    console.log("[Server] Token session created successfully", {
      expires_at: data.expires_at,
      session_type: data.session?.type,
      model: data.session?.model
    });
    data.browser_backend = process.env.BROWSER_BACKEND || "extension";
    res.json(data);

  } catch (error) {
    console.error("[Local Server Script Failure]:", error);
    res.status(500).json({ error: error.message });
  }
});

app.listen(3000, () => console.log("Token server running on http://localhost:3000", { logPath: getLogPath() }));

process.on("SIGINT", async () => {
  await closePlaywrightBrowser();
  process.exit(0);
});
