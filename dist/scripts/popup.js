(function () {
  const FEATURES = [
    { id: 'completeLectures', label: 'Complete Lectures', icon: '🎬', desc: 'Mark current page as complete' },
    { id: 'quizAutomation', label: 'Quiz Automation', icon: '✅', desc: 'Answer quiz on current page' },
    { id: 'completeDiscussions', label: 'Discussions', icon: '💬', desc: 'Complete discussion on current page' },
    { id: 'completeUngraded', label: 'Ungraded Plugins', icon: '🧩', desc: 'Complete ungraded plugin on current page' },
    { id: 'shareableLink', label: 'Shareable Link', icon: '🔗', desc: 'Generate shareable submission link' },
    { id: 'courseBackup', label: 'Course Backup', icon: '💾', desc: 'Download course materials' },
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
        statusMsg.textContent = `✅ Done — ${r.stats.completed} items completed`;
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
    if (btn) { btn.disabled = true; btn.innerHTML = '<span>⏳ Processing...</span>'; }

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
          setStatus('▶️ Running... Check Coursera page overlay');
          statusEl.classList.remove('hidden');
          statusMsg.textContent = 'Running...';
          pollStatus();
          return;
        }
        if (result && result.success) setStatus('✅ ' + (result.message || 'Done!'));
        else if (result && result.error) setStatus('⚠️ ' + result.error, true);
        else if (chrome.runtime.lastError) setStatus('⚠️ Reload Coursera page and try again', true);
        else setStatus('✅ Sent!');
      });
    });
  }

  pollStatus();
})();
