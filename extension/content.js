console.log('GPT Live content script loaded');
chrome.runtime.sendMessage({
  type: 'LOG_ACTIVITY',
  source: 'content-script',
  event: 'content script loaded',
  details: { url: location.href, title: document.title }
}).catch(() => {});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  chrome.runtime.sendMessage({
    type: 'LOG_ACTIVITY',
    source: 'content-script',
    event: 'message received',
    details: { type: message.type, url: location.href }
  }).catch(() => {});
  if (message.type === 'GET_PAGE_TEXT') {
    sendResponse({ text: document.body.innerText || '' });
  }

  return true;
});
