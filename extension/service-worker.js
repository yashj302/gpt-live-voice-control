import { resolveDestination } from './destination.mjs';

const MAX_ACTIVITY_LOG_ENTRIES = 200;
const debuggers = new Set();
let realtimeClientSecret = '';

const KEY_CODES = {
  Enter: { code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { code: 'Tab', keyCode: 9 },
  Escape: { code: 'Escape', keyCode: 27 },
  Backspace: { code: 'Backspace', keyCode: 8 },
  Delete: { code: 'Delete', keyCode: 46 },
  ArrowDown: { code: 'ArrowDown', keyCode: 40 },
  ArrowUp: { code: 'ArrowUp', keyCode: 38 },
  ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { code: 'ArrowRight', keyCode: 39 },
  Space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  Home: { code: 'Home', keyCode: 36 },
  End: { code: 'End', keyCode: 35 },
  PageUp: { code: 'PageUp', keyCode: 33 },
  PageDown: { code: 'PageDown', keyCode: 34 }
};

function logActivity(source, event, details = {}) {
  const entry = { time: new Date().toISOString(), source, event, details };
  console.log(`[${source}] ${event}`, details);
  fetch('http://localhost:3000/extension-log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source, event, details })
  }).catch(error => console.error('[Extension] Could not send activity to server log:', error));
  chrome.storage.local.get({ activityLog: [] })
    .then(({ activityLog }) => chrome.storage.local.set({
      activityLog: [...activityLog, entry].slice(-MAX_ACTIVITY_LOG_ENTRIES)
    }))
    .catch(error => console.error('[Extension] Could not save activity log:', error));
}

function redactMessage(message) {
  if (!message || typeof message !== 'object') return message;
  const copy = { ...message };
  if (copy.text && /password|passcode|secret/i.test(`${copy.hint || ''} ${copy.label || ''}`)) copy.text = '[hidden]';
  if (Array.isArray(copy.fields)) {
    copy.fields = copy.fields.map(field => (
      /password|passcode|secret/i.test(`${field?.target || ''} ${field?.label || ''} ${field?.hint || ''}`)
        ? { ...field, value: '[hidden]' }
        : field
    ));
  }
  return copy;
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 20000, timeoutMessage = 'The voice server did not answer. Run npm run start:personal, then connect again.') {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error(timeoutMessage);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function requestVoiceSession() {
  logActivity('browser', 'requesting session token');
  const response = await fetchWithTimeout('http://localhost:3000/session', { method: 'POST' });
  const body = await response.text();
  if (!response.ok) throw new Error((body || `Token server returned ${response.status}.`).slice(0, 180));
  const session = JSON.parse(body);
  const key = session.value || session.client_secret?.value || session.client_secret;
  if (!key || typeof key !== 'string') throw new Error('Token server response did not include a client secret.');
  realtimeClientSecret = key;
  const backend = session.browser_backend || 'extension';
  logActivity('browser', 'session token received', { backend });
  return { browser_backend: backend };
}

async function postRealtimeOffer(sdp) {
  if (!realtimeClientSecret) throw new Error('Voice session expired. Connect again.');
  if (!sdp || typeof sdp !== 'string') throw new Error('The voice offer was empty.');
  const response = await fetchWithTimeout('https://api.openai.com/v1/realtime/calls', {
    method: 'POST',
    body: sdp,
    headers: {
      Authorization: `Bearer ${realtimeClientSecret}`,
      'Content-Type': 'application/sdp'
    }
  }, 20000, 'OpenAI did not answer the voice connection. Try Connect Voice again.');
  const answer = await response.text();
  if (!response.ok) throw new Error((answer || `Realtime connection returned ${response.status}.`).slice(0, 180));
  return answer;
}

function failureMessage(error) {
  const names = (error?.candidates || []).map(item => item?.name).filter(Boolean).slice(0, 6);
  if (!names.length) return error?.message || 'The browser action failed.';
  return `${error.message} Nearby controls: ${names.join(', ')}.`;
}

function complete(sendResponse, operation) {
  Promise.resolve()
    .then(operation)
    .then(result => sendResponse({ ok: true, result }))
    .catch(error => {
      const message = failureMessage(error);
      logActivity('browser', 'action failed', { error: message });
      sendResponse({ ok: false, error: message });
    });
  return true;
}

function isOffscreenDocument(context) {
  return context.documentUrl?.includes('/offscreen.html');
}

async function recreateOffscreen() {
  await Promise.race([
    chrome.offscreen.closeDocument().catch(() => {}),
    delay(2000)
  ]);
  try {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html?arm=1',
      reasons: ['USER_MEDIA', 'AUDIO_PLAYBACK'],
      justification: 'Capture the microphone and play the voice reply while the popup is closed.'
    });
  } catch (error) {
    const message = error?.message || String(error);
    if (/exists|single offscreen|currently being created|closing/i.test(message)) {
      throw new Error('The voice page is stuck. Click Reload on chrome://extensions, then Connect Voice again.');
    }
    throw error;
  }
}

async function ensureOffscreenDocument() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (contexts.some(isOffscreenDocument)) return;
  await recreateOffscreen();
}

chrome.debugger.onDetach.addListener(source => {
  if (source.tabId) debuggers.delete(source.tabId);
});

function messageWithTimeout(message, timeoutMs = 4000) {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve({ ok: false, error: 'The voice service did not answer.' }), timeoutMs);
    chrome.runtime.sendMessage(message, response => {
      clearTimeout(timer);
      const error = chrome.runtime.lastError;
      if (response) {
        resolve(response);
        return;
      }
      if (error && /port closed|receiving end does not exist/i.test(error.message)) {
        resolve({ ok: false, error: 'The voice page closed before it could answer. Reload the extension and try again.' });
        return;
      }
      if (error) resolve({ ok: false, error: error.message });
      else resolve({ ok: false, error: 'The voice page did not answer. Reload the extension and try again.' });
    });
  });
}

async function waitForOffscreen() {
  await ensureOffscreenDocument();
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const state = await messageWithTimeout({ type: 'OFFSCREEN_GET_SESSION_STATE' }, 700);
    if (state?.ok && state.status) return;
    await delay(100);
  }
}

async function readLiveSession() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  const alive = contexts.some(isOffscreenDocument);
  if (!alive) {
    await chrome.storage.local.set({ voiceStatus: 'Disconnected' });
    return { connected: false, status: 'Disconnected' };
  }
  try {
    const state = await messageWithTimeout({ type: 'OFFSCREEN_GET_SESSION_STATE' }, 2000);
    const status = state?.status || 'Disconnected';
    await chrome.storage.local.set({ voiceStatus: status });
    return { connected: status === 'Connected and listening.', status };
  } catch {
    const { voiceStatus = 'Disconnected' } = await chrome.storage.local.get({ voiceStatus: 'Disconnected' });
    return { connected: voiceStatus === 'Connected and listening.', status: voiceStatus };
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'OFFSCREEN_GET_SESSION_STATE' || message.type === 'OFFSCREEN_START_SESSION' || message.type === 'OFFSCREEN_DISCONNECT_SESSION') {
    return false;
  }

  if (message.type === 'POST_REALTIME_OFFER') {
    postRealtimeOffer(message.sdp)
      .then(answer => sendResponse({ ok: true, answer }))
      .catch(error => {
        logActivity('browser', 'realtime offer failed', { error: error.message });
        sendResponse({ ok: false, error: error.message });
      });
    return true;
  }

  if (message.type === 'GET_SESSION_STATE') {
    readLiveSession().then(state => sendResponse({ ok: true, ...state }));
    return true;
  }

  if (message.type === 'SESSION_STATUS') {
    chrome.storage.local.set({ voiceStatus: message.status || 'Disconnected' });
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === 'LOG_ACTIVITY') {
    logActivity(message.source || 'extension', message.event || 'activity', message.details || {});
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === 'DETACH_DEBUGGER') {
    detachDebuggers().then(() => sendResponse({ ok: true }));
    return true;
  }

  logActivity('runtime', 'message received', {
    message: redactMessage(message),
    sender: { id: sender?.id, url: sender?.url, tabId: sender?.tab?.id }
  });

  if (message.type === 'START_SESSION') {
    logActivity('browser', 'start session requested');
    const connectAttempt = Date.now();
    setTimeout(async () => {
      const { voiceStatus = '' } = await chrome.storage.local.get({ voiceStatus: '' });
      const { voiceConnectAttempt = 0 } = await chrome.storage.local.get({ voiceConnectAttempt: 0 });
      if (voiceConnectAttempt === connectAttempt && voiceStatus === 'Connecting...') {
        const error = 'Voice did not finish connecting. Click Reload on chrome://extensions, then try Connect Voice again.';
        logActivity('browser', 'connect timed out');
        chrome.storage.local.set({ voiceStatus: error });
      }
    }, 18000);
    chrome.storage.local.set({ voiceConnectAttempt: connectAttempt, voiceStatus: 'Connecting...' });
    recreateOffscreen()
      .then(() => waitForOffscreen())
      .then(() => requestVoiceSession())
      .then(session => messageWithTimeout({ type: 'OFFSCREEN_START_SESSION', session }, 12000))
      .then(result => {
        if (result?.ok === false) {
          realtimeClientSecret = '';
          const error = result.error || 'Could not start voice.';
          logActivity('browser', 'start session failed', { error });
          chrome.storage.local.set({ voiceStatus: error });
          sendResponse({ ok: false, error });
          return;
        }
        sendResponse({ ok: true, result });
      })
      .catch(error => {
        realtimeClientSecret = '';
        logActivity('browser', 'start session failed', { error: error.message });
        chrome.storage.local.set({ voiceStatus: error.message });
        sendResponse({ ok: false, error: error.message });
      });
    return true;
  }

  if (message.type === 'DISCONNECT_SESSION') {
    realtimeClientSecret = '';
    logActivity('browser', 'disconnect requested');
    chrome.runtime.sendMessage({ type: 'OFFSCREEN_DISCONNECT_SESSION' })
      .then(result => sendResponse({ ok: true, result }))
      .catch(error => {
        logActivity('browser', 'disconnect failed', { error: error.message });
        sendResponse({ ok: false, error: error.message });
      })
      .finally(() => chrome.storage.local.set({ voiceStatus: 'Disconnected' }));
    return true;
  }

  if (message.type === 'CLICK_ELEMENT') {
    return complete(sendResponse, () => (
      isPlaywrightBackend(message.backend)
        ? playwrightAction('click', { label: message.label })
        : clickInActiveTab(message.label)
    ));
  }

  if (message.type === 'NAVIGATE_TO') {
    return complete(sendResponse, () => (
      isPlaywrightBackend(message.backend)
        ? playwrightAction('navigate', { url: message.url, newTab: message.newTab })
        : navigateActiveTab(message.url, message.newTab)
    ));
  }

  if (message.type === 'SWITCH_TAB') {
    return complete(sendResponse, () => (
      isPlaywrightBackend(message.backend)
        ? playwrightAction('switchTab', { target: message.target })
        : message.selenium ? switchTabWithSelenium(message.target) : switchTab(message.target)
    ));
  }

  if (message.type === 'LIST_TABS') {
    return complete(sendResponse, () => (
      isPlaywrightBackend(message.backend) ? playwrightAction('listTabs', {}) : listTabs()
    ));
  }

  if (message.type === 'DESCRIBE_PAGE') {
    return complete(sendResponse, () => (
      isPlaywrightBackend(message.backend) ? playwrightAction('describe', {}) : describePage()
    ));
  }

  if (message.type === 'SEARCH_PAGE') {
    return complete(sendResponse, () => (
      isPlaywrightBackend(message.backend)
        ? playwrightAction('search', { query: message.query })
        : searchActivePage(message.query)
    ));
  }

  if (message.type === 'TYPE_IN_SEARCH_BAR') {
    return complete(sendResponse, () => (
      isPlaywrightBackend(message.backend)
        ? playwrightAction('type', { text: message.text, hint: 'search' })
        : typeInto(message.text, 'search', { prefer: 'search' })
    ));
  }

  if (message.type === 'TYPE_IN_TEXT_BOX') {
    return complete(sendResponse, () => (
      isPlaywrightBackend(message.backend)
        ? playwrightAction('type', { text: message.text, hint: message.hint })
        : typeInto(message.text, message.hint)
    ));
  }

  if (message.type === 'FILL_FORM') {
    return complete(sendResponse, () => (
      isPlaywrightBackend(message.backend)
        ? playwrightAction('fillForm', { fields: message.fields, submit: message.submit, submitLabel: message.submitLabel })
        : fillForm(message.fields, message.submit, message.submitLabel)
    ));
  }

  if (message.type === 'PRESS_KEY') {
    return complete(sendResponse, () => (
      isPlaywrightBackend(message.backend)
        ? playwrightAction('pressKey', { key: message.key, target: message.target })
        : pressKey(message.key, message.target)
    ));
  }

  if (message.type === 'SCROLL_PAGE') {
    return complete(sendResponse, () => (
      isPlaywrightBackend(message.backend)
        ? playwrightAction('scroll', { direction: message.direction, amount: message.amount })
        : scrollActivePage(message.direction, message.amount)
    ));
  }

  if (message.type === 'BROWSER_CONTROL') {
    return complete(sendResponse, () => (
      isPlaywrightBackend(message.backend)
        ? playwrightAction('browserControl', { command: message.command, url: message.url, target: message.target })
        : browserControl(message.command, message.url, message.target)
    ));
  }

  if (message.type === 'FIND_BEST_PRICE') {
    return complete(sendResponse, () => (
      isPlaywrightBackend(message.backend)
        ? playwrightAction('findBestPrice', { product: message.product, maxLinks: message.maxLinks })
        : Promise.reject(new Error('Price comparison requires the Playwright or Playwright-CDP backend.'))
    ));
  }

  return false;
});

function isPlaywrightBackend(backend) {
  return backend === 'playwright' || backend === 'playwright-cdp';
}

async function playwrightAction(action, args) {
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const response = await fetch('http://localhost:3000/playwright/action', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action,
      args: { ...args, activeTabUrl: active?.url, activeTabTitle: active?.title }
    })
  });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(result.error || `Playwright returned ${response.status}.`);
  logActivity('playwright', `${action} completed`, result);
  return result;
}

async function switchTabWithSelenium(target) {
  const response = await fetch('http://localhost:3000/selenium/switch-tab', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ target })
  });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(result.error || `Selenium returned ${response.status}.`);
  return result;
}

async function activeTab() {
  const focused = await chrome.windows.getLastFocused({ populate: true, windowTypes: ['normal'] });
  const tab = focused?.tabs?.find(item => item.active) || focused?.tabs?.[0];
  if (tab?.id) return tab;
  const [fallback] = await chrome.tabs.query({ active: true });
  if (!fallback?.id) throw new Error('No active browser tab is available.');
  return fallback;
}

async function focusTab(tab) {
  await chrome.tabs.update(tab.id, { active: true });
  if (tab.windowId != null) await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
}

function compoundRef(label) {
  const match = String(label || '').trim().match(/^(?:(\d+):)?(e\d+)$/i);
  if (!match) return null;
  return { frameId: match[1] ? Number(match[1]) : null, ref: match[2].toLowerCase() };
}

function friendlyPageError(error) {
  const message = error?.message || String(error);
  if (/cannot access contents|the extensions gallery|chrome:\/\//i.test(message)) {
    return new Error('This page cannot be controlled. Open a normal website tab and try again.');
  }
  return error instanceof Error ? error : new Error(message);
}

async function runPage(tabId, operation, payload, { allFrames = false, frameId = null } = {}) {
  const target = frameId == null ? { tabId, allFrames } : { tabId, frameIds: [frameId] };
  await chrome.scripting.executeScript({ target, files: ['page-actions.js'] });
  return chrome.scripting.executeScript({
    target,
    func: (operationName, operationPayload) => globalThis.gptLiveActions[operationName](operationPayload),
    args: [operation, payload || {}]
  });
}

async function runPageSafe(tabId, operation, payload, allFrames) {
  try {
    return await runPage(tabId, operation, payload, { allFrames });
  } catch (error) {
    if (!allFrames) throw friendlyPageError(error);
    try {
      return await runPage(tabId, operation, payload, { allFrames: false });
    } catch (fallbackError) {
      throw friendlyPageError(fallbackError);
    }
  }
}

function bestMatch(results) {
  const matches = (results || [])
    .map(entry => (entry?.result ? { ...entry.result, frameId: entry.frameId } : null))
    .filter(Boolean);
  const found = matches.filter(item => item.ok).sort((first, second) => (second.score || 0) - (first.score || 0));
  if (found.length >= 2 && found[0].score - found[1].score < 12 && (found[0].score < 1000 || found[0].score === found[1].score)) {
    const error = new Error(`Several controls match. Say which one: ${found.slice(0, 4).map(item => `${item.frameId}:${item.ref} ${item.name}`).join('; ')}.`);
    error.candidates = found.slice(0, 5);
    throw error;
  }
  if (found[0]) return found[0];
  const failure = matches.find(item => item.ambiguous) || matches.find(item => item.error);
  const error = new Error(failure?.error || 'No matching control was found.');
  error.candidates = failure?.candidates || [];
  throw error;
}

async function locate(tabId, label, extra = {}) {
  const parsed = compoundRef(label);
  if (parsed?.frameId != null) {
    return bestMatch(await runPage(tabId, 'resolve', { ref: parsed.ref, ...extra }, { frameId: parsed.frameId }));
  }
  const payload = parsed ? { ref: parsed.ref, ...extra } : { label, ...extra };
  return bestMatch(await runPageSafe(tabId, 'resolve', payload, true));
}

async function attachDebugger(tabId) {
  if (debuggers.has(tabId)) return;
  await chrome.debugger.attach({ tabId }, '1.3');
  debuggers.add(tabId);
}

async function detachDebuggers() {
  const targets = await chrome.debugger.getTargets().catch(() => []);
  for (const target of targets) {
    if (!target.tabId || !target.attached) continue;
    await chrome.debugger.detach({ tabId: target.tabId }).catch(() => {});
  }
  debuggers.clear();
}

async function freshTarget(tab, target) {
  try {
    return await locate(tab.id, `${target.frameId}:${target.ref}`);
  } catch {
    return target;
  }
}

async function trustedClick(tabId, rect) {
  const x = Math.max(1, rect.x + rect.width / 2);
  const y = Math.max(1, rect.y + rect.height / 2);
  await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
    type: 'mousePressed', x, y, button: 'left', clickCount: 1
  });
  await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
    type: 'mouseReleased', x, y, button: 'left', clickCount: 1
  });
}

function parseChord(chord) {
  const parts = String(chord || 'Enter').split('+').map(part => part.trim()).filter(Boolean);
  const modifiers = [];
  let key = parts.pop() || 'Enter';
  for (const part of parts) {
    const name = part.toLowerCase();
    if (name === 'ctrl' || name === 'control') modifiers.push('Control');
    else if (name === 'shift') modifiers.push('Shift');
    else if (name === 'alt' || name === 'option') modifiers.push('Alt');
    else if (name === 'meta' || name === 'cmd' || name === 'command') modifiers.push('Meta');
  }
  if (key.length === 1) key = modifiers.includes('Shift') ? key.toUpperCase() : key.toLowerCase();
  else if (key.toLowerCase() === 'esc') key = 'Escape';
  else if (key.toLowerCase() === 'space' || key.toLowerCase() === 'spacebar') key = 'Space';
  else key = key.charAt(0).toUpperCase() + key.slice(1);
  return { key, modifiers };
}

function modifierMask(modifiers) {
  let mask = 0;
  if (modifiers.includes('Alt')) mask |= 1;
  if (modifiers.includes('Control')) mask |= 2;
  if (modifiers.includes('Meta')) mask |= 4;
  if (modifiers.includes('Shift')) mask |= 8;
  return mask;
}

function keyDefinition(key) {
  if (KEY_CODES[key]) return { key: KEY_CODES[key].key || key, ...KEY_CODES[key] };
  if (key.length === 1) {
    const upper = key.toUpperCase();
    return {
      key,
      code: /[a-z]/i.test(key) ? `Key${upper}` : `Digit${key}`,
      keyCode: upper.charCodeAt(0),
      text: key
    };
  }
  return { key, code: key, keyCode: 0 };
}

async function pressChord(tabId, chord) {
  const { key, modifiers } = parseChord(chord);
  const definition = keyDefinition(key);
  const base = {
    key: definition.key,
    code: definition.code,
    windowsVirtualKeyCode: definition.keyCode,
    nativeVirtualKeyCode: definition.keyCode,
    modifiers: modifierMask(modifiers)
  };
  await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
    ...base,
    type: 'keyDown',
    text: definition.text
  });
  await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
  return { key: chord };
}

async function clickResolved(tab, target) {
  await focusTab(tab);
  if (target.href && /^https?:/i.test(target.href)) {
    await chrome.tabs.update(tab.id, { url: target.href });
    return { clicked: target.name, role: target.role, href: target.href, ref: `${target.frameId}:${target.ref}`, method: 'navigate' };
  }
  if (target.isTop && target.rect) {
    try {
      await attachDebugger(tab.id);
      const refreshed = await freshTarget(tab, target);
      await trustedClick(tab.id, refreshed.rect || target.rect);
      return { clicked: target.name, role: target.role, ref: `${target.frameId}:${target.ref}`, method: 'pointer' };
    } catch (error) {
      logActivity('browser', 'trusted click fell back', { error: error.message });
    }
  }
  const [activated] = await runPage(tab.id, 'activate', { ref: target.ref }, { frameId: target.frameId });
  if (!activated?.result?.ok) throw new Error(activated?.result?.error || `Could not click "${target.name}".`);
  return activated.result;
}

async function clickInActiveTab(label) {
  if (!String(label || '').trim()) throw new Error('Say which button, link, or control to click.');
  const tab = await activeTab();
  const target = await locate(tab.id, label);
  logActivity('browser', 'click target', { label, name: target.name, role: target.role, ref: target.ref });
  return clickResolved(tab, target);
}

async function applyDomValue(tab, target, value, checked) {
  const [entry] = await runPage(tab.id, 'setValue', {
    ref: target.ref,
    value,
    checked
  }, { frameId: target.frameId });
  if (!entry?.result?.ok) throw new Error(entry?.result?.error || 'Could not edit that field.');
  return entry.result;
}

async function typeInto(text, hint, options = {}) {
  if (text == null && options.checked == null) {
    throw new Error('Say the text to type or whether to check the field.');
  }
  const tab = await activeTab();
  const target = await locate(tab.id, hint || '', {
    preferEditable: true,
    prefer: options.prefer
  });
  if (target.sensitive) logActivity('browser', 'editing sensitive field', { field: target.name });
  else logActivity('browser', 'editing field', { field: target.name, hint });
  if (['select', 'checkbox', 'radio', 'file'].includes(target.kind)) {
    return applyDomValue(tab, target, text, options.checked);
  }
  await focusTab(tab);
  try {
    await attachDebugger(tab.id);
    const refreshed = await freshTarget(tab, target);
    await trustedClick(tab.id, refreshed.rect || target.rect);
    await delay(40);
    const [focused] = await runPage(tab.id, 'focusedMatches', { ref: target.ref }, { frameId: target.frameId });
    if (focused?.result?.ok) {
      await pressChord(tab.id, 'Control+A');
      await chrome.debugger.sendCommand({ tabId: tab.id }, 'Input.insertText', { text: String(text) });
      return { field: target.name, entered: target.sensitive ? '[hidden]' : String(text), method: 'keyboard' };
    }
  } catch (error) {
    logActivity('browser', 'trusted typing fell back', { error: error.message });
  }
  return applyDomValue(tab, target, text, options.checked);
}

async function fillForm(fields, submit = false, submitLabel = '') {
  if (!Array.isArray(fields) || !fields.length) throw new Error('Say which form fields to fill.');
  const filled = [];
  const failed = [];
  for (const field of fields) {
    const target = field?.target || field?.label || field?.hint || field?.name;
    try {
      if (!target) throw new Error('A field name is required.');
      if (field.value == null && field.checked == null) throw new Error(`Say what to enter in ${target}.`);
      const result = await typeInto(field.value ?? '', target, {
        checked: field.checked,
        prefer: /search/i.test(target) ? 'search' : undefined
      });
      filled.push({ target, ...result });
    } catch (error) {
      failed.push({ target, error: error.message });
    }
  }
  if (!filled.length) {
    throw new Error(failed.map(item => `${item.target}: ${item.error}`).join('; ') || 'Could not fill the form.');
  }
  let submitted = false;
  let submitError;
  if (submit) {
    try {
      const tab = await activeTab();
      const button = bestMatch(await runPageSafe(tab.id, 'submitTarget', { label: submitLabel || '' }, true));
      await clickResolved(tab, button);
      submitted = true;
    } catch (error) {
      submitError = failureMessage(error);
    }
  }
  return { filled, failed, submitted, submitError };
}

async function pressKey(key, target) {
  if (!String(key || '').trim()) throw new Error('Say which key to press.');
  const tab = await activeTab();
  await focusTab(tab);
  if (target) {
    const located = await locate(tab.id, target);
    await clickResolved(tab, located);
  }
  try {
    await attachDebugger(tab.id);
    const pressed = await pressChord(tab.id, key);
    return pressed;
  } catch (error) {
    logActivity('browser', 'trusted key fell back', { error: error.message });
    const [entry] = await runPageSafe(tab.id, 'dispatchKey', parseChord(key), false);
    if (!entry?.result?.ok) throw new Error(entry?.result?.error || `Could not press ${key}.`);
    return entry.result;
  }
}

async function listTabs() {
  const tabs = await chrome.tabs.query({ lastFocusedWindow: true });
  return {
    tabs: tabs
      .slice()
      .sort((first, second) => first.index - second.index)
      .map(tab => ({ index: tab.index + 1, title: tab.title, url: tab.url, active: Boolean(tab.active) }))
  };
}

async function describePage() {
  const tab = await activeTab();
  const results = await runPageSafe(tab.id, 'describe', { limit: 40 }, true);
  const elements = [];
  for (const entry of results) {
    for (const element of entry.result?.elements || []) {
      elements.push({ ...element, ref: `${entry.frameId}:${element.ref}` });
    }
  }
  return { title: tab.title, url: tab.url, elements: elements.slice(0, 50) };
}

async function switchTab(target) {
  const tabs = await chrome.tabs.query({ lastFocusedWindow: true });
  logActivity('browser', 'tabs discovered', {
    count: tabs.length,
    tabs: tabs.map(tab => ({ index: tab.index, title: tab.title, url: tab.url }))
  });
  if (!tabs.length) throw new Error('No browser tabs are available.');

  const rawTarget = String(target ?? '').trim();
  const normalizedTarget = rawTarget.toLowerCase();
  const numberMatch = normalizedTarget.match(/\btab(?:\s+number)?\s*(\d+)\b|^(\d+)$/);
  const requestedIndex = numberMatch ? Number(numberMatch[1] || numberMatch[2]) : NaN;
  const textTarget = normalizedTarget
    .replace(/\b(?:switch|change|move|go|to|into|of|the|tab)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const targetWords = textTarget.split(' ').filter(Boolean);
  const ordered = tabs.slice().sort((first, second) => first.index - second.index);
  const selectedTab = Number.isInteger(requestedIndex) && requestedIndex > 0
    ? ordered[requestedIndex - 1]
    : ordered.find(tab => [tab.title, tab.url].filter(Boolean).some(value => targetWords.every(word => value.toLowerCase().includes(word))));

  if (!selectedTab?.id) {
    const available = ordered.map(tab => `${tab.index + 1}. ${tab.title || tab.url}`).join('; ');
    throw new Error(`Could not find an open tab matching "${rawTarget}". Open tabs: ${available}`);
  }
  logActivity('browser', 'tab selected', { index: selectedTab.index, title: selectedTab.title, url: selectedTab.url });
  await chrome.tabs.update(selectedTab.id, { active: true });
  if (selectedTab.windowId != null) await chrome.windows.update(selectedTab.windowId, { focused: true }).catch(() => {});
  return { index: selectedTab.index + 1, title: selectedTab.title, url: selectedTab.url };
}

async function navigateActiveTab(url, newTab = false) {
  if (newTab && !String(url || '').trim()) {
    const created = await chrome.tabs.create({ active: true });
    return { newTab: true, tabId: created.id };
  }
  const destination = resolveDestination(url);
  if (newTab) {
    const created = await chrome.tabs.create({ url: destination, active: true });
    return { url: destination, tabId: created.id, newTab: true };
  }
  const tab = await activeTab();
  await chrome.tabs.update(tab.id, { url: destination });
  return { url: destination, tabId: tab.id };
}

async function searchActivePage(query) {
  if (!String(query || '').trim()) throw new Error('Search query cannot be empty.');
  const typed = await typeInto(query, 'search', { prefer: 'search' });
  await pressKey('Enter');
  return { ...typed, submitted: true, query };
}

async function scrollActivePage(direction, amount) {
  const tab = await activeTab();
  const [entry] = await runPageSafe(tab.id, 'scrollPage', { direction, amount }, false);
  if (!entry?.result?.ok) throw new Error(entry?.result?.error || 'Could not scroll this page.');
  logActivity('browser', 'page scrolled', { tabId: tab.id, result: entry.result });
  return entry.result;
}

async function browserControl(command, url, target) {
  const name = String(command || '').toLowerCase();
  const tab = await activeTab();
  if (name === 'back') {
    await chrome.tabs.goBack(tab.id);
    return { action: 'back' };
  }
  if (name === 'forward') {
    await chrome.tabs.goForward(tab.id);
    return { action: 'forward' };
  }
  if (name === 'reload' || name === 'refresh') {
    await chrome.tabs.reload(tab.id);
    return { action: 'reload' };
  }
  if (['newtab', 'new-tab', 'open'].includes(name)) return navigateActiveTab(url, true);
  if (['closetab', 'close-tab', 'close'].includes(name)) {
    const selected = target ? await switchTab(target).then(async () => activeTab()) : tab;
    await chrome.tabs.remove(selected.id);
    return { action: 'close', title: selected.title };
  }
  throw new Error(`Unsupported browser control "${command}". Use back, forward, reload, newTab, or closeTab.`);
}
