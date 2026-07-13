const DEFAULT_SETTINGS = {
  groqApiKey: ''
};

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'keepAlive') {
    port.onMessage.addListener(() => {});
  }
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS), (result) => {
    const updates = {};
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
      if (result[key] === undefined) updates[key] = value;
    }
    if (Object.keys(updates).length > 0) {
      chrome.storage.local.set(updates);
    }
  });
});

chrome.commands.onCommand.addListener((command) => {
  if (command === 'open_popup_1' || command === 'open_popup_2') {
    chrome.action.openPopup();
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case 'GET_SETTINGS':
      chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS), (settings) => {
        sendResponse(settings);
      });
      return true;

    case 'SAVE_SETTINGS':
      chrome.storage.local.set(message.settings, () => {
        sendResponse({ success: true });
      });
      return true;

    case 'QUERY_TAB':
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]) {
          sendResponse({ tabId: tabs[0].id, url: tabs[0].url });
        } else {
          sendResponse(null);
        }
      });
      return true;

    case 'SEND_TO_CONTENT':
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]) {
          chrome.tabs.sendMessage(tabs[0].id, message.payload, (response) => {
            sendResponse(response);
          });
        } else {
          sendResponse({ error: 'No active tab' });
        }
      });
      return true;

    case 'AI_QUIZ':
      chrome.storage.local.get('groqApiKey', async (settings) => {
        const apiKey = settings.groqApiKey || '';
        sendResponse({ apiKey });
      });
      return true;

    case 'START_DOWNLOAD':
      chrome.downloads.download({
        url: message.url,
        filename: message.filename,
        saveAs: false
      }, (downloadId) => {
        sendResponse({ downloadId });
      });
      return true;

    case 'CLOSE_LAB_TABS':
      chrome.tabs.query({}, (tabs) => {
        let closed = 0;
        for (const tab of tabs) {
          if (tab.url && (tab.url.includes('skills.network') || tab.url.includes('lab') && !tab.url.includes('coursera'))) {
            chrome.tabs.remove(tab.id, () => { closed++; });
          }
        }
        sendResponse({ closed });
      });
      return true;
  }
});
