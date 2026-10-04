import { existsSync, readFileSync } from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { resolveDestination } from '../extension/destination.mjs';

let context;
let connectedBrowser;
let ownsBrowser = true;
let userDataDir;
const extensionPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'extension');
const pageActionsSource = readFileSync(path.join(extensionPath, 'page-actions.js'), 'utf8');
const cdpSessions = new WeakMap();

function log(event, details = {}) {
  console.log(`[Playwright] ${event}`, details);
}

function chromePath() {
  if (process.env.USE_PLAYWRIGHT_CHROMIUM === '1') return undefined;
  return process.env.CHROME_BINARY || [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    `${process.env.ProgramFiles}\Google\Chrome\Application\chrome.exe`,
    `${process.env.LOCALAPPDATA}\Google\Chrome\Application\chrome.exe`
  ].find(candidate => candidate && !candidate.includes('undefined') && existsSync(candidate));
}

export async function ensurePlaywrightBrowser() {
  if (context) {
    try {
      if (context.pages().some(page => !page.isClosed())) return context;
    } catch (error) {
      log('stale browser context detected', { error: error.message });
    }
    context = undefined;
    userDataDir = undefined;
  }

  if (process.env.USE_PLAYWRIGHT_CDP === '1') {
    const cdpUrl = process.env.CHROME_CDP_URL || 'http://127.0.0.1:9222';
    connectedBrowser = await chromium.connectOverCDP(cdpUrl);
    const contexts = connectedBrowser.contexts();
    if (!contexts.length) throw new Error('Connected Chrome has no browser context.');
    context = contexts[0];
    ownsBrowser = false;
    context.on('page', page => log('CDP page opened', { url: page.url() }));
    log('connected to existing Chrome over CDP', { cdpUrl, pages: context.pages().length });
    return context;
  }

  userDataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gpt-live-playwright-'));
  await fsp.mkdir(path.join(userDataDir, 'Default'), { recursive: true });
  await fsp.writeFile(
    path.join(userDataDir, 'Local State'),
    JSON.stringify({ extensions: { ui: { developer_mode: true } } })
  );
  await fsp.writeFile(
    path.join(userDataDir, 'Default', 'Preferences'),
    JSON.stringify({ extensions: { ui: { developer_mode: true } } })
  );
  const executablePath = chromePath();
  context = await chromium.launchPersistentContext(userDataDir, {
    ...(executablePath ? { executablePath } : {}),
    headless: false,
    viewport: null,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [
      '--start-maximized',
      '--enable-extensions',
      '--autoplay-policy=no-user-gesture-required',
      `--load-extension=${extensionPath}`,
      `--disable-extensions-except=${extensionPath}`,
      '--disable-features=DisableLoadExtensionCommandLineSwitch'
    ]
  });
  context.on('page', page => log('new page opened', { url: page.url() }));
  log('browser started', { executablePath: executablePath || 'Playwright Chromium', userDataDir });
  await enableDeveloperMode();
  return context;
}

async function enableDeveloperMode() {
  const page = await activePage();
  await page.goto('chrome://extensions/');
  await page.evaluate(() => {
    const findToggle = root => {
      for (const element of root.querySelectorAll('*')) {
        if (element.id === 'devMode') return element;
        if (element.shadowRoot) {
          const nested = findToggle(element.shadowRoot);
          if (nested) return nested;
        }
      }
      return null;
    };
    const toggle = findToggle(document);
    if (!toggle) throw new Error('Chrome developer-mode toggle was not found.');
    const checked = toggle.checked ?? toggle.getAttribute('aria-pressed') === 'true';
    if (!checked) toggle.click();
  });
  log('developer mode enabled');
}

async function activePage() {
  let browserContext = await ensurePlaywrightBrowser();
  const pages = browserContext.pages().filter(page => !page.isClosed());
  if (pages.length) return pages.at(-1);

  try {
    return await browserContext.newPage();
  } catch (error) {
    if (!/context|browser|closed|target/i.test(error.message)) throw error;
    log('browser closed while creating page; relaunching', { error: error.message });
    context = undefined;
    userDataDir = undefined;
    browserContext = await ensurePlaywrightBrowser();
    return browserContext.newPage();
  }
}

async function pageForAction(browserContext, args = {}) {
  const activeUrl = String(args.activeTabUrl || '').trim();
  const webPages = browserContext.pages()
    .filter(page => !page.isClosed() && /^https?:/i.test(page.url()));
  if (/^https?:/i.test(activeUrl)) {
    const matchingPage = webPages.find(page => page.url() === activeUrl);
    if (matchingPage) {
      await matchingPage.bringToFront().catch(() => {});
      return matchingPage;
    }
  }
  const fallbackPage = webPages.at(-1) || browserContext.pages().find(candidate => !candidate.isClosed());
  if (fallbackPage) {
    await fallbackPage.bringToFront().catch(() => {});
    return fallbackPage;
  }
  return browserContext.newPage();
}

function cleanTarget(target) {
  return String(target ?? '').trim().toLowerCase();
}

function numericTabTarget(target) {
  const normalized = cleanTarget(target);
  const match = normalized.match(/\btab(?:\s+number)?\s*(\d+)\b|^(\d+)$/);
  return match ? Number(match[1] || match[2]) : NaN;
}

function textTabTarget(target) {
  return cleanTarget(target)
    .replace(/\b(?:switch|change|move|go|to|into|of|the|tab)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function productWords(product) {
  return cleanTarget(product)
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter(word => word.length > 1);
}

function parsePrice(raw) {
  const normalized = raw.replace(/\s+/g, ' ').trim();
  const symbol = normalized.match(/[₹$€£]|\b(?:rs\.?|inr|usd|eur|gbp)\b/i)?.[0]?.toUpperCase() || '';
  const numeric = normalized.replace(/[^0-9.]/g, '').replace(/\.(?=.*\.)/g, '');
  const value = Number(numeric.replace(/,/g, ''));
  return Number.isFinite(value) && value > 0 ? { raw: normalized, value, currency: symbol } : null;
}

function extractPriceCandidates(text) {
  const matches = text.match(/(?:₹|\$|€|£|\b(?:Rs\.?|INR|USD|EUR|GBP)\b)\s*[\d,]+(?:\.\d{1,2})?|[\d,]+(?:\.\d{1,2})?\s*(?:₹|\$|€|£|\b(?:Rs\.?|INR|USD|EUR|GBP)\b)/gi) || [];
  return matches.map(parsePrice).filter(Boolean);
}

async function findBestPrice(browserContext, sourcePage, product, maxLinks = 8) {
  const words = productWords(product);
  if (!words.length) throw new Error('A product name is required for price comparison.');
  const limit = Math.min(Math.max(Number(maxLinks) || 8, 3), 12);
  let links = await sourcePage.locator('a[href]').evaluateAll(anchors => anchors.map(anchor => ({
    href: anchor.href,
    text: (anchor.innerText || anchor.textContent || '').trim(),
    rel: anchor.rel
  })));
  const collectCandidates = currentLinks => [...new Map(currentLinks
    .filter(link => /^https?:/i.test(link.href) && link.text)
    .filter(link => !/google\.(com|co\.)?[^/]+\/search|bing\.com\/shop|facebook\.com|instagram\.com/i.test(link.href))
    .map(link => [link.href.split('#')[0], link]))
    .values()]
    .sort((first, second) => {
      const firstScore = words.reduce((score, word) => score + (first.text.toLowerCase().includes(word) || first.href.toLowerCase().includes(word) ? 1 : 0), 0);
      const secondScore = words.reduce((score, word) => score + (second.text.toLowerCase().includes(word) || second.href.toLowerCase().includes(word) ? 1 : 0), 0);
      return secondScore - firstScore;
    })
    .slice(0, limit);
  const candidates = collectCandidates(links);
  if (!candidates.length) {
    const searchUrl = `https://www.bing.com/shop?q=${encodeURIComponent(product)}`;
    log('no product links found; opening shopping search fallback', { product, searchUrl });
    await sourcePage.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await sourcePage.waitForTimeout(1000);
    links = await sourcePage.locator('a[href]').evaluateAll(anchors => anchors.map(anchor => ({
      href: anchor.href,
      text: (anchor.innerText || anchor.textContent || '').trim()
    })));
    candidates.push(...collectCandidates(links));
  }
  if (!candidates.length) throw new Error(`No product links were found for ${product}. Open a shopping results page and try again.`);

  const results = [];
  const pages = [];
  for (const candidate of candidates) {
    let detailPage;
    try {
      detailPage = await browserContext.newPage();
      pages.push(detailPage);
      await detailPage.goto(candidate.href, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await detailPage.waitForTimeout(700);
      const details = await detailPage.evaluate(() => ({
        title: document.title,
        text: (document.body?.innerText || '').slice(0, 30000)
      }));
      const haystack = `${details.title} ${details.text}`.toLowerCase();
      const productMatch = words.filter(word => haystack.includes(word)).length;
      const blocked = /access denied|robot check|captcha|unusual traffic|enable javascript/i.test(haystack);
      const accessory = /phone case|cover case|screen protector|replacement screen|charger only|phone holder/i.test(haystack);
      const prices = blocked || accessory ? [] : extractPriceCandidates(details.text);
      const selectedPrice = prices.sort((first, second) => first.value - second.value)[0];
      if (selectedPrice && productMatch >= Math.min(1, words.length)) {
        results.push({
          url: detailPage.url(),
          title: details.title,
          price: selectedPrice,
          productMatch,
          evidence: details.text.slice(Math.max(0, details.text.indexOf(selectedPrice.raw) - 100), details.text.indexOf(selectedPrice.raw) + 180)
        });
      }
    } catch (error) {
      log('price candidate failed', { url: candidate.href, error: error.message });
      results.push({ url: candidate.href, title: candidate.text, error: error.message });
    }
  }

  const priced = results.filter(result => result.price);
  if (!priced.length) {
    for (const candidatePage of pages) await candidatePage.close().catch(() => {});
    return {
      ok: true,
      product,
      inspected: candidates.length,
      status: 'insufficient_evidence',
      message: `Inspected ${candidates.length} links but could not verify a credible ${product} price. Some sites may require login, block automation, or hide prices dynamically.`,
      candidates: results
    };
  }
  const currencies = new Map();
  for (const result of priced) currencies.set(result.price.currency, (currencies.get(result.price.currency) || 0) + 1);
  const commonCurrency = [...currencies.entries()].sort((first, second) => second[1] - first[1])[0][0];
  const comparable = priced.filter(result => result.price.currency === commonCurrency);
  comparable.sort((first, second) => first.price.value - second.price.value);
  const winner = comparable[0];
  const winnerPage = pages.find(candidatePage => candidatePage.url() === winner.url);
  for (const candidatePage of pages) {
    if (candidatePage !== winnerPage) await candidatePage.close().catch(() => {});
  }
  await winnerPage?.bringToFront();
  log('best price selected', { product, currency: commonCurrency, winner, inspected: candidates.length });
  return {
    ok: true,
    product,
    inspected: candidates.length,
    currency: commonCurrency,
    winner,
    alternatives: comparable.slice(1, 8),
    skipped: results.filter(result => !result.price)
  };
}

async function pageCall(page, operation, payload, retry = true) {
  try {
    let session = cdpSessions.get(page);
    if (!session) {
      session = await page.context().newCDPSession(page);
      cdpSessions.set(page, session);
    }
    await session.send('Runtime.evaluate', { expression: pageActionsSource });
    const response = await session.send('Runtime.evaluate', {
      expression: `globalThis.gptLiveActions[${JSON.stringify(operation)}](${JSON.stringify(payload ?? {})})`,
      returnByValue: true,
      awaitPromise: true
    });
    if (response.exceptionDetails) {
      throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text || 'Page action failed');
    }
    return response.result?.value;
  } catch (error) {
    cdpSessions.delete(page);
    if (retry && /session closed|target closed|execution context/i.test(error.message)) {
      return pageCall(page, operation, payload, false);
    }
    throw error;
  }
}

function clickPoint(rect) {
  return {
    x: Math.max(1, rect.x + rect.width / 2),
    y: Math.max(1, rect.y + rect.height / 2)
  };
}

async function clickTarget(page, target) {
  if (!target?.ok) {
    const error = new Error(target?.error || 'No matching control was found.');
    error.candidates = target?.candidates;
    throw error;
  }
  if (target.href && /^https?:/i.test(target.href)) {
    await page.goto(target.href, { waitUntil: 'domcontentloaded' });
    return { clicked: target.name, role: target.role, href: target.href, ref: target.ref, method: 'navigate' };
  }
  const point = clickPoint(target.rect);
  await page.mouse.click(point.x, point.y);
  return { clicked: target.name, role: target.role, ref: target.ref, method: 'pointer' };
}

async function typeTarget(page, text, hint, extra = {}) {
  const target = await pageCall(page, 'resolve', { label: hint || '', preferEditable: true, ...extra });
  if (!target?.ok) {
    const error = new Error(target?.error || 'Could not find an editable field.');
    error.candidates = target?.candidates;
    throw error;
  }
  if (['select', 'checkbox', 'radio', 'file'].includes(target.kind)) {
    const result = await pageCall(page, 'setValue', { ref: target.ref, value: text, checked: extra.checked });
    if (!result?.ok) throw new Error(result?.error || 'Could not edit that field.');
    return result;
  }
  const point = clickPoint(target.rect);
  await page.mouse.click(point.x, point.y);
  await page.keyboard.press('Control+A');
  await page.keyboard.insertText(String(text ?? ''));
  return { ok: true, field: target.name, entered: target.sensitive ? '[hidden]' : String(text ?? ''), method: 'keyboard' };
}

export async function performPlaywrightAction(action, args = {}) {
  const browserContext = await ensurePlaywrightBrowser();
  if (action === 'listTabs') {
    const pages = browserContext.pages().filter(page => !page.isClosed());
    const tabs = [];
    for (let index = 0; index < pages.length; index += 1) {
      tabs.push({ index: index + 1, title: await pages[index].title(), url: pages[index].url() });
    }
    return { ok: true, tabs };
  }
  if (action === 'newTab' || (action === 'browserControl' && ['newtab', 'new-tab', 'open'].includes(String(args.command || '').toLowerCase()))) {
    const page = await browserContext.newPage();
    const destination = args.url ? resolveDestination(args.url) : '';
    if (destination) await page.goto(destination, { waitUntil: 'domcontentloaded' });
    await page.bringToFront();
    return { ok: true, url: page.url(), title: await page.title(), newTab: true };
  }

  let page = await pageForAction(browserContext, args);

  if (action === 'navigate') {
    let requestedUrl = null;
    try { requestedUrl = new URL(String(args.url || '')); } catch { requestedUrl = null; }
    const destination = requestedUrl?.protocol === 'chrome:' && requestedUrl.hostname === 'extensions'
      ? requestedUrl.href
      : resolveDestination(args.url);
    if (args.newTab) {
      const nextPage = await browserContext.newPage();
      await nextPage.goto(destination, { waitUntil: 'domcontentloaded' });
      await nextPage.bringToFront();
      return { ok: true, url: nextPage.url(), newTab: true };
    }
    await page.goto(destination, { waitUntil: 'domcontentloaded' });
    log('navigated', { url: destination });
    return { ok: true, url: page.url() };
  }

  if (action === 'inspectExtensions') {
    await page.goto('chrome://extensions/');
    const result = await page.evaluate(() => {
      const walk = (root, output = []) => {
        for (const element of root.querySelectorAll('*')) {
          if (element.id) output.push({ type: 'element-id', id: element.id, tag: element.localName });
          if (element.id === 'devMode') output.push({ type: 'developer-toggle', checked: element.checked, pressed: element.getAttribute('aria-pressed') });
          if (element.localName === 'extensions-item') {
            const itemRoot = element.shadowRoot;
            output.push({
              type: 'extension',
              id: element.id,
              name: itemRoot?.querySelector('#name')?.textContent?.trim(),
              errors: itemRoot?.querySelector('#errorsList')?.textContent?.trim(),
              warnings: itemRoot?.querySelector('#warningsList')?.textContent?.trim()
            });
          }
          if (element.shadowRoot) walk(element.shadowRoot, output);
        }
        return output;
      };
      return walk(document);
    });
    log('extension inspection', result);
    return {
      ok: true,
      extensions: result,
      serviceWorkers: browserContext.serviceWorkers().map(worker => worker.url())
    };
  }

  if (action === 'openLoadUnpacked') {
    await page.goto('chrome://extensions/');
    const loadUnpacked = page.getByRole('button', { name: /load unpacked/i }).first();
    await loadUnpacked.waitFor({ state: 'visible', timeout: 5000 });
    await loadUnpacked.click();
    log('load unpacked dialog opened');
    return { ok: true };
  }

  if (action === 'switchTab') {
    const pages = browserContext.pages();
    const requestedIndex = numericTabTarget(args.target);
    let selected;
    if (Number.isInteger(requestedIndex) && requestedIndex > 0) {
      selected = pages[requestedIndex - 1];
    } else {
      const words = textTabTarget(args.target).split(' ').filter(Boolean);
      for (const candidate of pages) {
        const title = (await candidate.title()).toLowerCase();
        const url = candidate.url().toLowerCase();
        if (words.every(word => title.includes(word) || url.includes(word))) {
          selected = candidate;
          break;
        }
      }
    }
    if (!selected) throw new Error(`Could not find a Playwright tab matching "${args.target}".`);
    await selected.bringToFront();
    log('switched tab', { target: args.target, title: await selected.title(), url: selected.url() });
    return { ok: true, url: selected.url(), title: await selected.title() };
  }

  if (action === 'describe') {
    const described = await pageCall(page, 'describe', { limit: 40 });
    return { ok: true, title: described?.title, url: page.url(), elements: described?.elements || [] };
  }

  if (action === 'type' || action === 'search') {
    const typed = await typeTarget(page, args.text || args.query, args.hint || (action === 'search' ? 'search' : ''), {
      prefer: action === 'search' || args.hint === 'search' ? 'search' : undefined
    });
    if (action === 'search') await page.keyboard.press('Enter');
    log(action === 'search' ? 'searched page' : 'typed text', { field: typed.field, url: page.url() });
    return { ok: true, ...typed, url: page.url(), submitted: action === 'search' };
  }

  if (action === 'fillForm') {
    const fields = Array.isArray(args.fields) ? args.fields : [];
    if (!fields.length) throw new Error('Say which form fields to fill.');
    const filled = [];
    const failed = [];
    for (const field of fields) {
      const target = field?.target || field?.label || field?.hint || field?.name;
      try {
        if (!target) throw new Error('A field name is required.');
        if (field.value == null && field.checked == null) throw new Error('Say what to enter.');
        const result = await typeTarget(page, field.value ?? '', target, { checked: field.checked });
        filled.push({ target, ...result });
      } catch (error) {
        failed.push({ target, error: error.message });
      }
    }
    if (!filled.length) throw new Error(failed.map(item => `${item.target}: ${item.error}`).join('; '));
    let submitted = false;
    let submitError;
    if (args.submit) {
      try {
        const button = await pageCall(page, 'submitTarget', { label: args.submitLabel || '' });
        await clickTarget(page, button);
        submitted = true;
      } catch (error) {
        submitError = error.message;
      }
    }
    return { ok: true, filled, failed, submitted, submitError, url: page.url() };
  }

  if (action === 'pressKey') {
    if (args.target) {
      const target = await pageCall(page, 'resolve', { label: args.target });
      await clickTarget(page, target);
    }
    await page.keyboard.press(String(args.key || 'Enter'));
    return { ok: true, key: args.key, url: page.url() };
  }

  if (action === 'browserControl') {
    const command = String(args.command || '').toLowerCase();
    if (command === 'back') {
      await page.goBack({ waitUntil: 'domcontentloaded', timeout: 15000 });
      return { ok: true, action: 'back', url: page.url() };
    }
    if (command === 'forward') {
      await page.goForward({ waitUntil: 'domcontentloaded', timeout: 15000 });
      return { ok: true, action: 'forward', url: page.url() };
    }
    if (command === 'reload' || command === 'refresh') {
      await page.reload({ waitUntil: 'domcontentloaded' });
      return { ok: true, action: 'reload', url: page.url() };
    }
    if (command === 'closetab' || command === 'close-tab' || command === 'close') {
      await page.close();
      return { ok: true, action: 'close' };
    }
    throw new Error(`Unsupported browser control "${args.command}".`);
  }

  if (action === 'scroll') {
    const direction = String(args.direction || 'down').toLowerCase();
    const amount = Number(args.amount) > 0 ? Number(args.amount) : Math.max(await page.evaluate(() => window.innerHeight * 0.8), 400);
    if (direction === 'top') await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'auto' }));
    else if (direction === 'bottom') await page.evaluate(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'auto' }));
    else if (direction === 'up' || direction === 'down') await page.mouse.wheel(0, direction === 'up' ? -amount : amount);
    else throw new Error(`Unsupported scroll direction: ${direction}`);
    log('scrolled page', { direction, amount, url: page.url() });
    return { ok: true, direction, amount, url: page.url() };
  }

  if (action === 'findBestPrice') {
    return findBestPrice(browserContext, page, args.product, args.maxLinks);
  }

  if (action === 'click') {
    const target = await pageCall(page, 'resolve', { label: args.label });
    const clicked = await clickTarget(page, target);
    log('clicked element', { label: args.label, clicked, url: page.url() });
    return { ok: true, ...clicked, url: page.url() };
  }

  if (action === 'readPage') {
    return { ok: true, title: await page.title(), url: page.url(), text: (await page.locator('body').innerText()).slice(0, 12000) };
  }

  throw new Error(`Unknown Playwright action: ${action}`);
}

export async function closePlaywrightBrowser() {
  if (ownsBrowser) await context?.close();
  else connectedBrowser?.disconnect();
  context = undefined;
  connectedBrowser = undefined;
  ownsBrowser = true;
  if (userDataDir) await fsp.rm(userDataDir, { recursive: true, force: true });
  userDataDir = undefined;
}
