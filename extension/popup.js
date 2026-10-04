const statusDiv = document.getElementById('status');
const startButton = document.getElementById('startBtn');
const disconnectButton = document.getElementById('disconnectBtn');
const activityLog = document.getElementById('activityLog');

function logPopup(event, details = {}) {
  chrome.runtime.sendMessage({ type: 'LOG_ACTIVITY', source: 'popup', event, details }).catch(() => {});
}

loadActivityLog();
restoreSessionStatus();

document.getElementById('clearLogBtn').addEventListener('click', async () => {
  logPopup('clear activity log clicked');
  await chrome.storage.local.set({ activityLog: [] });
  renderActivityLog([]);
});

startButton.addEventListener('click', async () => {
  logPopup('connect voice clicked');
  startButton.disabled = true;
  applyStatus('Connecting...');
  try {
    // Request permission from the popup's user gesture before starting offscreen media.
    const permissionStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    permissionStream.getTracks().forEach(track => track.stop());
    const response = await chrome.runtime.sendMessage({ type: 'START_SESSION' });
    if (!response?.ok) {
      applyStatus(response?.error || 'Could not start voice.');
      startButton.disabled = false;
      return;
    }
    window.setTimeout(() => {
      if (statusDiv.innerText === 'Connecting...') {
        applyStatus('Voice did not connect. Reload the extension on chrome://extensions, then try Connect Voice again.');
        startButton.disabled = false;
      }
    }, 20000);
  } catch (error) {
    const detail = error?.name ? `${error.name}: ${error.message}` : String(error);
    applyStatus(`Microphone unavailable: ${detail}`);
    console.error('[Extension] Could not start session:', error);
    logPopup('microphone request failed', { name: error?.name, message: error?.message });
    startButton.disabled = false;
  }
});

disconnectButton.addEventListener('click', async () => {
  logPopup('disconnect clicked');
  disconnectButton.disabled = true;
  await chrome.runtime.sendMessage({ type: 'DISCONNECT_SESSION' });
  updateConnectionControls('Disconnected');
});

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'SESSION_STATUS') applyStatus(message.status);
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local' || !changes.activityLog) {
    logPopup('storage changed', { areaName, keys: Object.keys(changes) });
  }
  if (areaName === 'local' && changes.activityLog) renderActivityLog(changes.activityLog.newValue || []);
  if (areaName === 'local' && changes.voiceStatus) applyStatus(changes.voiceStatus.newValue || 'Disconnected');
});

async function loadActivityLog() {
  const data = await chrome.storage.local.get({ activityLog: [] });
  renderActivityLog(data.activityLog);
}

function applyStatus(status) {
  shownStatus = status || 'Disconnected';
  statusDiv.innerText = shownStatus;
  updateConnectionControls(shownStatus);
}

let shownStatus = 'Disconnected';

async function restoreSessionStatus() {
  const { voiceStatus = 'Disconnected' } = await chrome.storage.local.get({ voiceStatus: 'Disconnected' });
  if (shownStatus === 'Disconnected') applyStatus(voiceStatus);
  try {
    const state = await chrome.runtime.sendMessage({ type: 'GET_SESSION_STATE' });
    if (state?.status && shownStatus !== 'Connecting...' && shownStatus !== 'Connected and listening.') {
      applyStatus(state.status);
    }
  } catch {}
}

function renderActivityLog(entries) {
  activityLog.textContent = entries.slice(-40).map(entry => {
    const time = new Date(entry.time).toLocaleTimeString();
    const details = entry.details && Object.keys(entry.details).length
      ? ` ${JSON.stringify(entry.details)}`
      : '';
    return `${time} [${entry.source}] ${entry.event}${details}`;
  }).join('\n') || 'No activity yet.';
  activityLog.scrollTop = activityLog.scrollHeight;
}

function updateConnectionControls(status) {
  const connected = status === 'Connected and listening.';
  const connecting = status === 'Connecting...';
  startButton.disabled = connecting;
  startButton.style.display = connected ? 'none' : 'block';
  disconnectButton.style.display = connected ? 'block' : 'none';
  disconnectButton.disabled = false;
  const hint = document.getElementById('liveHint');
  if (hint) hint.style.display = connected ? 'block' : 'none';
}
