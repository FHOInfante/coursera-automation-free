(function () {
  const FEATURES = [
    { id: 'quizAutomation', label: 'Quiz Automation', icon: '✅', desc: 'Answer quiz on current page' },
  ];

  const featureGrid = document.getElementById('featureGrid');
  const statusEl = document.getElementById('caStatus');
  const statusMsg = document.getElementById('caStatusMsg');
  const statusFill = document.getElementById('caStatusFill');
  let pollTimer = null;

  FEATURES.forEach((f) => {
    const w = document.createElement('div');
    w.className = 'featureBtnWrapper';
    const b = document.createElement('button');
    b.className = 'featureBtn';
    b.id = f.id;
    b.innerHTML = `<span>${f.icon} ${f.label}</span><span class="featureBadge">FREE</span>`;
    b.onclick = () => handleFeatureClick(f.id);
    const t = document.createElement('div');
    t.className = 'featureTooltip';
    t.textContent = f.desc;
    w.appendChild(b);
    w.appendChild(t);
    featureGrid.appendChild(w);
  });

  document.getElementById('settingsBtn').onclick = () => chrome.runtime.openOptionsPage();
  document.getElementById('runAllBtn').onclick = () => handleFeatureClick('runAll');

  function pollStatus() {
    chrome.runtime.sendMessage({ type: 'SEND_TO_CONTENT', payload: { action: 'getStatus' } }, (r) => {
      if (r && r.status === 'running') {
        statusEl.classList.remove('hidden');
        statusMsg.textContent = `${r.stats.completed}/${r.stats.total} items (M${r.currentModule})`;
        const pct = r.stats.total > 0 ? Math.round(r.stats.completed / r.stats.total * 100) : 0;
        statusFill.style.width = pct + '%';
      } else if (r && r.status === 'done') {
        statusEl.classList.remove('hidden');
        statusMsg.textContent = `\u2705 Done \u2014 ${r.stats.completed} items completed`;
        statusFill.style.width = '100%';
        if (pollTimer) clearTimeout(pollTimer);
        return;
      } else {
        statusEl.classList.add('hidden');
      }
      if (pollTimer) pollTimer = setTimeout(pollStatus, 2000);
    });
  }

  function setStatus(text, isError) {
    const existing = document.getElementById('statusMsg');
    if (existing) existing.remove();
    const d = document.createElement('div');
    d.id = 'statusMsg';
    d.style.cssText = `padding:10px 12px;border-radius:10px;font-size:12px;text-align:center;${
      isError ? 'background:rgba(255,68,68,0.1);border:1px solid rgba(255,68,68,0.3);color:#ff4444;' : 'background:var(--glass);border:1px solid var(--glass-border);color:var(--text-dim);'
    }`;
    d.textContent = text;
    featureGrid.parentNode.insertBefore(d, featureGrid.nextSibling);
    setTimeout(() => d.remove(), 4000);
  }

  function handleFeatureClick(featureId) {
    const btn = document.getElementById(featureId);
    const originalText = btn ? btn.innerHTML : '';
    if (btn) { btn.disabled = true; btn.innerHTML = '<span>\u23F3 Processing...</span>'; }

    chrome.runtime.sendMessage({ type: 'QUERY_TAB' }, (response) => {
      if (!response || !response.url) {
        if (btn) { btn.disabled = false; if (originalText) btn.innerHTML = originalText; }
        setStatus('No active tab found', true);
        return;
      }
      if (!response.url.includes('coursera.org')) {
        if (btn) { btn.disabled = false; if (originalText) btn.innerHTML = originalText; }
        setStatus('Open a Coursera course page first', true);
        return;
      }

      chrome.runtime.sendMessage({
        type: 'SEND_TO_CONTENT',
        payload: { action: featureId }
      }, (result) => {
        if (btn) { btn.disabled = false; if (originalText) btn.innerHTML = originalText; }
        if (featureId === 'runAll') {
          setStatus('\u25B6\uFE0F Running... Check Coursera page overlay');
          statusEl.classList.remove('hidden');
          statusMsg.textContent = 'Running...';
          pollStatus();
          return;
        }
        if (result && result.success) setStatus('\u2705 ' + (result.message || 'Done!'));
        else if (result && result.error) setStatus('\u26A0\uFE0F ' + result.error, true);
        else if (chrome.runtime.lastError) setStatus('\u26A0\uFE0F Reload Coursera page and try again', true);
        else setStatus('\u2705 Sent!');
      });
    });
  }

  pollStatus();
})();
