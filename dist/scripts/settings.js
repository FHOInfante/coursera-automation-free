(function () {
  const tabs = document.querySelectorAll('.tab');
  const tabContents = document.querySelectorAll('.tab-content');

  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      tabs.forEach((t) => t.classList.remove('active'));
      tabContents.forEach((tc) => tc.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById(tab.dataset.tab).classList.add('active');
    });
  });

  function populateSubtitleLanguages() {
    const select = document.getElementById('subtitle');
    const languages = [
      { code: 'en', name: 'English' }, { code: 'es', name: 'Spanish' },
      { code: 'fr', name: 'French' }, { code: 'de', name: 'German' },
      { code: 'pt', name: 'Portuguese' }, { code: 'zh', name: 'Chinese' },
      { code: 'ja', name: 'Japanese' }, { code: 'ko', name: 'Korean' },
      { code: 'ru', name: 'Russian' }, { code: 'ar', name: 'Arabic' },
      { code: 'hi', name: 'Hindi' }, { code: 'vi', name: 'Vietnamese' },
    ];
    languages.forEach((lang) => {
      const opt = document.createElement('option');
      opt.value = lang.code;
      opt.textContent = lang.name;
      select.appendChild(opt);
    });
  }
  populateSubtitleLanguages();

  function loadSettings() {
    chrome.storage.local.get(null, (settings) => {
      document.getElementById('autoQuizToggle').checked = settings.autoQuiz ?? true;
      document.getElementById('autoSubmitQuizToggle').checked = settings.autoSubmitQuiz ?? false;
      document.getElementById('autoNextToggle').checked = settings.autoNext ?? true;
      document.getElementById('speechToggle').checked = settings.speechEnabled ?? false;
      document.getElementById('skipSpeed').value = settings.skipSpeed ?? 8;
      document.getElementById('skipThreshold').value = settings.skipThreshold ?? 90;
      document.getElementById('concurrency').value = settings.concurrency ?? 5;
      document.getElementById('quality').value = settings.quality ?? '720p';
      document.getElementById('subtitle').value = settings.subtitle ?? 'en';
      document.getElementById('aiProvider').value = settings.aiProvider ?? 'none';
      document.getElementById('apiKey').value = settings.apiKey ?? '';
      document.getElementById('aiModel').value = settings.aiModel ?? 'openai/gpt-4o-mini';
    });
  }

  function saveSettings() {
    const settings = {
      autoQuiz: document.getElementById('autoQuizToggle').checked,
      autoSubmitQuiz: document.getElementById('autoSubmitQuizToggle').checked,
      autoNext: document.getElementById('autoNextToggle').checked,
      speechEnabled: document.getElementById('speechToggle').checked,
      skipSpeed: parseFloat(document.getElementById('skipSpeed').value),
      skipThreshold: parseInt(document.getElementById('skipThreshold').value),
      concurrency: parseInt(document.getElementById('concurrency').value),
      quality: document.getElementById('quality').value,
      subtitle: document.getElementById('subtitle').value,
      aiProvider: document.getElementById('aiProvider').value,
      apiKey: document.getElementById('apiKey').value,
      aiModel: document.getElementById('aiModel').value,
    };

    chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings }, (response) => {
      const status = document.getElementById('generalStatus');
      status.textContent = 'Settings saved!';
      status.style.color = '#00ff88';
      setTimeout(() => { status.textContent = ''; }, 2000);
    });
  }

  function saveBackupSettings() {
    const settings = {
      concurrency: parseInt(document.getElementById('concurrency').value),
      quality: document.getElementById('quality').value,
      subtitle: document.getElementById('subtitle').value,
    };

    chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings }, (response) => {
      const status = document.getElementById('backupStatus');
      status.textContent = 'Backup settings saved!';
      status.style.color = '#00ff88';
      setTimeout(() => { status.textContent = ''; }, 2000);
    });
  }

  document.getElementById('saveGeneralBtn').addEventListener('click', saveSettings);
  document.getElementById('saveBackupBtn').addEventListener('click', saveBackupSettings);

  loadSettings();
})();
