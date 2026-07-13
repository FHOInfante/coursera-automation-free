const DEFAULT_SETTINGS = {
  autoQuiz: true,
  autoSubmitQuiz: false,
  autoNext: true,
  speechEnabled: false,
  skipSpeed: 8,
  skipThreshold: 90,
  concurrency: 5,
  quality: '720p',
  subtitle: 'en',
  aiProvider: 'none',
  apiKey: '',
  aiModel: 'openai/gpt-4o-mini'
};

// Keep service worker alive during automation
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

async function callAI(settings, prompt) {
  if (!settings.apiKey || settings.aiProvider === 'none') return null;

  if (settings.aiProvider === 'openrouter') {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${settings.apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://github.com/coursera-automation',
        'X-Title': 'Course Automation'
      },
      body: JSON.stringify({
        model: settings.aiModel || 'openai/gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1
      })
    });
    const data = await response.json();
    return data.choices?.[0]?.message?.content || null;
  }

  if (settings.aiProvider === 'openai') {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${settings.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: settings.aiModel || 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1
      })
    });
    const data = await response.json();
    return data.choices?.[0]?.message?.content || null;
  }

  if (settings.aiProvider === 'anthropic') {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': settings.apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: settings.aiModel || 'claude-3-5-sonnet-20241022',
        max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }]
      })
    });
    const data = await response.json();
    return data.content?.[0]?.text || null;
  }

  return null;
}

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
      chrome.storage.local.get(['aiProvider', 'apiKey', 'aiModel'], async (settings) => {
        try {
          const answer = await callAI(settings, message.prompt);
          sendResponse({ answer });
        } catch (err) {
          sendResponse({ error: err.message });
        }
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
