(function () {
  function loadSettings() {
    chrome.storage.local.get('groqApiKey', (settings) => {
      document.getElementById('groqApiKey').value = settings.groqApiKey || '';
    });
  }

  function saveSettings() {
    const settings = {
      groqApiKey: document.getElementById('groqApiKey').value,
    };
    chrome.storage.local.set(settings, () => {
      const status = document.getElementById('status');
      status.textContent = 'Saved!';
      status.style.color = '#00ff88';
      setTimeout(() => { status.textContent = ''; }, 2000);
    });
  }

  document.getElementById('saveBtn').addEventListener('click', saveSettings);
  loadSettings();
})();
