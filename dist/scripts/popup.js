(function () {
  const tabListEl = document.getElementById('tabList');
  const statusEl = document.getElementById('caStatus');
  const statusMsg = document.getElementById('caStatusMsg');
  const statusFill = document.getElementById('caStatusFill');
  let pollTimer = null;

  document.getElementById('settingsBtn').onclick = () => chrome.runtime.openOptionsPage();

  function renderTabEntry(tabId, data) {
    const pct = data.stats && data.stats.total > 0
      ? Math.round((data.stats.completed || 0) / data.stats.total * 100) : 0;
    const isRunning = data.status === 'running';
    const isDone = data.status === 'done';
    const statusClass = isRunning ? 'running' : isDone ? 'done' : 'idle';
    const action = isRunning ? 'stop' : 'run';
    const label = isRunning ? '\u23F9 Stop' : isDone ? '\u21A9 Restart' : '\u25B6 Run';

    const row = document.createElement('div');
    row.className = 'tab-row';
    row.innerHTML = `
      <div class="tab-info">
        <div class="tab-slug" title="${data.slug || 'Unknown'}">${data.slug || 'Unknown course'}</div>
        <div class="tab-status ${statusClass}">${isRunning ? 'Running' : isDone ? 'Done' : 'Idle'}</div>
        <div class="tab-progress">${data.stats ? data.stats.completed + '/' + data.stats.total : '0/0'}</div>
        <div class="tab-bar"><div class="tab-fill" style="width:${pct}%"></div></div>
      </div>
      <button class="tab-btn ${action}-btn" data-tab-id="${tabId}" data-action="${action}">${label}</button>
    `;

    row.querySelector('.tab-btn').onclick = () => {
      const tid = parseInt(tabId);
      const act = action;
      if (act === 'run') {
        chrome.runtime.sendMessage({
          type: 'SEND_TO_CONTENT',
          tabId: tid,
          payload: { action: 'runAll' }
        }, () => { setTimeout(refreshTabList, 1000); });
      } else {
        chrome.runtime.sendMessage({
          type: 'SEND_TO_CONTENT',
          tabId: tid,
          payload: { action: 'stopAutomation' }
        }, () => { setTimeout(refreshTabList, 500); });
      }
    };

    return row;
  }

  function refreshTabList() {
    chrome.runtime.sendMessage({ type: 'GET_REGISTRY' }, (response) => {
      const registry = (response && response.registry) || {};
      const entries = Object.entries(registry);

      if (entries.length === 0) {
        tabListEl.innerHTML = '<div class="empty-state">No Coursera tabs running automation.<br>Open a course page and click <strong>Run</strong>.</div>';
        statusEl.classList.add('hidden');
        if (pollTimer) clearTimeout(pollTimer);
        pollTimer = null;
        return;
      }

      let hasRunning = false;
      tabListEl.innerHTML = '';
      for (const [tid, data] of entries) {
        tabListEl.appendChild(renderTabEntry(tid, data));
        if (data.status === 'running') hasRunning = true;
      }

      if (hasRunning) {
        statusEl.classList.remove('hidden');
        const total = entries.reduce((s, [, d]) => s + (d.stats ? d.stats.total : 0), 0);
        const completed = entries.reduce((s, [, d]) => s + (d.stats ? d.stats.completed : 0), 0);
        statusMsg.textContent = `${completed}/${total} items across ${entries.length} tab${entries.length > 1 ? 's' : ''}`;
        const pct = total > 0 ? Math.round(completed / total * 100) : 0;
        statusFill.style.width = pct + '%';
      } else {
        statusEl.classList.add('hidden');
      }
    });
  }

  function pollLoop() {
    refreshTabList();
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = setTimeout(pollLoop, 3000);
  }

  pollLoop();
})();
