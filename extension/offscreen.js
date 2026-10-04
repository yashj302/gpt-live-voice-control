let peerConnection;
let dataChannel;
let localStream;
let remoteAudio;
let browserBackend = 'extension';
let actionQueue = Promise.resolve();
let responseTimer;
let sessionEpoch = 0;
let startToken = 0;
let micPromise = null;

function logActivity(event, details = {}) {
  console.log(`[ai] ${event}`, details);
  chrome.runtime.sendMessage({ type: 'LOG_ACTIVITY', source: 'ai', event, details }).catch(() => {});
}

function sessionStatus() {
  const connection = peerConnection?.connectionState;
  if (!peerConnection || connection === 'closed' || connection === 'failed' || !localStream) return 'Disconnected';
  if (connection === 'connected' || dataChannel?.readyState === 'open') return 'Connected and listening.';
  return 'Connecting...';
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'OFFSCREEN_GET_SESSION_STATE') {
    const status = sessionStatus();
    sendResponse({ ok: true, connected: status === 'Connected and listening.', status });
    return false;
  }
  if (message.type === 'OFFSCREEN_START_SESSION') {
    const session = message.session;
    armMicrophone().then(() => {
      sendResponse({ ok: true, started: true });
      setTimeout(() => startLiveSession(session), 0);
    }).catch(error => {
      sendResponse({ ok: false, error: error?.message || 'Microphone failed.' });
    });
    return true;
  }
  if (message.type === 'OFFSCREEN_DISCONNECT_SESSION') {
    stopSession();
    chrome.runtime.sendMessage({ type: 'DETACH_DEBUGGER' }).catch(() => {});
    sendStatus('Disconnected');
    sendResponse({ ok: true, status: 'Disconnected' });
    return false;
  }
  return false;
});

function silenceRemoteAudio() {
  if (!remoteAudio) return;
  try { remoteAudio.pause(); } catch {}
  try { remoteAudio.srcObject = null; } catch {}
  remoteAudio = undefined;
}

function abortIfStopped(epoch) {
  if (epoch === sessionEpoch) return false;
  silenceRemoteAudio();
  try { peerConnection?.close(); } catch {}
  peerConnection = undefined;
  dataChannel = undefined;
  return true;
}

function attachRemoteAudio(stream, epoch) {
  if (epoch !== sessionEpoch) {
    stream?.getTracks?.().forEach(track => track.stop());
    return;
  }
  silenceRemoteAudio();
  remoteAudio = new Audio();
  remoteAudio.autoplay = true;
  remoteAudio.srcObject = stream;
  remoteAudio.play?.().catch(() => {});
}

function postRealtimeOffer(sdp) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('The voice service did not answer.')), 20000);
    chrome.runtime.sendMessage({ type: 'POST_REALTIME_OFFER', sdp }, response => {
      clearTimeout(timer);
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      if (!response?.ok || !response.answer) {
        reject(new Error(response?.error || 'Realtime connection failed.'));
        return;
      }
      resolve(response.answer);
    });
  });
}

function armMicrophone() {
  if (!micPromise) {
    micPromise = captureMicrophone().catch(error => {
      micPromise = null;
      throw error;
    });
  }
  return micPromise;
}

function captureMicrophone() {
  if (!navigator.mediaDevices?.getUserMedia) {
    return Promise.reject(new Error('Microphone capture is unavailable in this extension context.'));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      reject(new Error('Microphone permission did not arrive. Click Connect Voice again and allow the microphone.'));
    }, 8000);
    navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
      clearTimeout(timer);
      if (settled) {
        stream.getTracks().forEach(track => track.stop());
        return;
      }
      settled = true;
      resolve(stream);
    }).catch(error => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

async function startLiveSession(sessionData) {
  const token = ++startToken;
  sessionEpoch += 1;
  const epoch = sessionEpoch;
  logActivity('voice session starting');
  let stage = 'opening microphone';
  try {
    if (!sessionData) throw new Error('The voice token never arrived. Run npm run start:personal, then connect again.');
    browserBackend = sessionData.browser_backend || 'extension';
    localStream = await armMicrophone();
    if (token !== startToken || epoch !== sessionEpoch) return;
    logActivity('microphone open', { backend: browserBackend });
    sendStatus('Connecting...');

    stage = 'creating peer connection';
    peerConnection = new RTCPeerConnection();
    peerConnection.ontrack = event => attachRemoteAudio(event.streams[0], epoch);
    localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));

    dataChannel = peerConnection.createDataChannel('oai-events');
    logActivity('realtime data channel created');
    dataChannel.addEventListener('message', event => {
      if (epoch !== sessionEpoch) return;
      handleRealtimeEvent(event, epoch);
    });

    stage = 'creating SDP offer';
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    await waitForIceGathering(peerConnection);
    if (token !== startToken || abortIfStopped(epoch)) return;

    stage = 'sending SDP offer';
    const answer = await postRealtimeOffer(peerConnection.localDescription.sdp);
    if (token !== startToken || abortIfStopped(epoch)) return;
    stage = 'applying SDP answer';
    await peerConnection.setRemoteDescription({ type: 'answer', sdp: answer });
    if (token !== startToken || abortIfStopped(epoch)) return;
    sendStatus('Connected and listening.');
    logActivity('voice session connected', { backend: browserBackend });
  } catch (error) {
    if (token !== startToken) return;
    const errorName = error?.name || 'Error';
    const errorMessage = error?.message || String(error);
    console.error(`[Extension] Voice session failed during ${stage}: ${errorName}: ${errorMessage}`, error);
    logActivity('voice session failed', { stage, errorName, errorMessage });
    sendStatus(`Failed during ${stage}: ${errorName} - ${errorMessage}`);
    try { stopSession(); } catch {}
  }
}

function browserAction(name, args) {
  const backend = browserBackend;
  switch (name) {
    case 'clickElement':
      return { type: 'CLICK_ELEMENT', label: args.label || args.ref, backend };
    case 'navigateTo':
      return { type: 'NAVIGATE_TO', url: args.url, newTab: Boolean(args.newTab), backend };
    case 'switchTab':
      return { type: 'SWITCH_TAB', target: args.target, backend };
    case 'listTabs':
      return { type: 'LIST_TABS', backend };
    case 'describePage':
      return { type: 'DESCRIBE_PAGE', backend };
    case 'searchPage':
      return { type: 'SEARCH_PAGE', query: args.query, backend };
    case 'typeInSearchBar':
      return { type: 'TYPE_IN_SEARCH_BAR', text: args.text, backend };
    case 'typeInTextBox':
      return { type: 'TYPE_IN_TEXT_BOX', text: args.text, hint: args.hint, backend };
    case 'fillForm':
      return { type: 'FILL_FORM', fields: args.fields, submit: Boolean(args.submit), submitLabel: args.submitLabel, backend };
    case 'pressKey':
      return { type: 'PRESS_KEY', key: args.key, target: args.target, backend };
    case 'scrollPage':
      return { type: 'SCROLL_PAGE', direction: args.direction, amount: args.amount, backend };
    case 'browserControl':
      return { type: 'BROWSER_CONTROL', command: args.command, url: args.url, target: args.target, backend };
    case 'findBestPrice':
      return { type: 'FIND_BEST_PRICE', product: args.product, maxLinks: args.maxLinks, backend };
    default:
      return null;
  }
}

function enqueue(task) {
  const run = actionQueue.then(task, task);
  actionQueue = run.then(() => {}, () => {});
  return run;
}

function scheduleFollowUp(epoch) {
  clearTimeout(responseTimer);
  responseTimer = setTimeout(() => {
    if (epoch !== sessionEpoch || dataChannel?.readyState !== 'open') return;
    dataChannel.send(JSON.stringify({ type: 'response.create' }));
  }, 350);
}

function sendToolOutput(callId, output, epoch) {
  if (epoch !== sessionEpoch || !callId || dataChannel?.readyState !== 'open') return;
  dataChannel.send(JSON.stringify({
    type: 'conversation.item.create',
    item: {
      type: 'function_call_output',
      call_id: callId,
      output: JSON.stringify(output)
    }
  }));
  scheduleFollowUp(epoch);
  logActivity('browser tool result sent to AI', { callId, ok: output.ok });
}

async function handleRealtimeEvent(event, epoch) {
  let callId;
  try {
    const message = JSON.parse(event.data);
    const noisyAudio = message.type?.endsWith('.delta') || message.type === 'rate_limits.updated';
    if (!noisyAudio) {
      logActivity('AI event received', {
        type: message.type,
        name: message.name,
        callId: message.call_id,
        transcript: message.transcript,
        text: message.text || message.delta
      });
    }
    if (epoch !== sessionEpoch) return;
    if (message.type !== 'response.function_call_arguments.done') return;
    callId = message.call_id;
    const args = typeof message.arguments === 'string' ? JSON.parse(message.arguments || '{}') : (message.arguments || {});
    logActivity('AI requested browser tool', { name: message.name, arguments: args });
    const action = browserAction(message.name, args);
    if (!action) {
      sendToolOutput(callId, { ok: false, error: `Unknown browser tool ${message.name}.` }, epoch);
      return;
    }
    const result = await enqueue(() => chrome.runtime.sendMessage(action));
    if (epoch !== sessionEpoch) return;
    const output = result?.ok
      ? { ok: true, ...(result.result || {}) }
      : { ok: false, error: result?.error || 'The browser action failed.' };
    if (!result?.ok) sendStatus(`Action failed: ${output.error}`);
    else logActivity('browser tool completed', { name: message.name });
    sendToolOutput(callId, output, epoch);
  } catch (error) {
    console.error('[Extension] Invalid realtime event:', error);
    logActivity('AI event handling failed', { error: error.message });
    sendToolOutput(callId, { ok: false, error: error.message || 'The browser action failed.' }, epoch);
  }
}

function waitForIceGathering(connection) {
  if (!connection || connection.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise(resolve => {
    const timeout = setTimeout(resolve, 2500);
    connection.addEventListener('icegatheringstatechange', () => {
      if (connection.iceGatheringState === 'complete' || connection.connectionState === 'closed') {
        clearTimeout(timeout);
        resolve();
      }
    });
  });
}

function sendStatus(status) {
  logActivity('status changed', { status });
  chrome.runtime.sendMessage({ type: 'SESSION_STATUS', status }).catch(() => {});
}

function stopSession() {
  sessionEpoch += 1;
  clearTimeout(responseTimer);
  micPromise = null;
  const audio = remoteAudio;
  const stream = localStream;
  const pc = peerConnection;
  const channel = dataChannel;
  remoteAudio = undefined;
  localStream = undefined;
  peerConnection = undefined;
  dataChannel = undefined;
  try { audio?.pause(); } catch {}
  try { if (audio) audio.srcObject = null; } catch {}
  try { stream?.getTracks().forEach(track => track.stop()); } catch {}
  try { channel?.close(); } catch {}
  try { pc?.close(); } catch {}
}

if (new URLSearchParams(location.search).get('arm') === '1') armMicrophone().catch(() => {});
