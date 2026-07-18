(() => {
  const DELAY = 800;
  const TIMEOUT = 30000;

  const ITEM_PATHS = ['lecture','supplement','quiz','exam','assignment','practice-quiz','practice-exam','gradedLab','ungradedLab','discussionPrompt','peer','staffGraded','assignment-submission','discussions','lab','appItem','dialogue'];
  const ITEM_SELECTORS = ITEM_PATHS.map(p => `a[href*="/${p}/"]`);
  ITEM_SELECTORS.push(
    '[data-track-component="item_row"] a',
    '.rc-WeekItemName a', '.item-link', '[data-test="item"] a', '[data-testid="item"] a',
    '[data-testid="start-button"]', '[data-testid="resume-button"]'
  );

  const COMPLETE_SELECTORS = [
    '[data-test="complete-button"]',
    '[data-e2e="complete-button"]',
    'button[aria-label*="complete" i]',
    'button[aria-label*="mark" i]',
    '.rc-ItemProgressIcon',
    '.completed-toggle',
    '[data-test="toggle-completion"]',
    'button[class*="complete"]',
    'button[class*="toggle"]',
    'svg[class*="completed"]',
    'svg[class*="Progress"]',
  ];

  const PAGE_COMPLETE_SELECTORS = [
    '.rc-ItemCompletionButton button',
    '[data-test="complete-button"]',
    '[data-testid="mark-complete"]',
    '[data-testid="complete-button"]',
    '[data-e2e="complete-button"]',
    'button[aria-label*="complete" i]',
    'button[aria-label*="mark" i]',
    '.bt3-btn-success',
    'button:has(svg)',
    '[class*="markComplete"]',
    '[class*="itemComplete"]',
    '[data-test*="complete"]',
  ];

  const itemPathPattern = new RegExp('\\/(' + ITEM_PATHS.join('|') + ')\\/([^/?#]+)');

  let C = {
    status: 'idle',
    slug: '',
    currentModule: 1,
    totalModules: 0,
    phase: 'idle',
    items: [],
    completedItems: [],
    stats: { total: 0, completed: 0, failed: 0, skipped: 0 },
    currentItem: '',
    apiKey: '',
    lastPageUrl: '',
    samePageCount: 0,
    navigatingToItem: '',
    rateLimited: false,
  };

  let groqApiKey = '';
  let groqConsecutiveRateLimits = 0;
  let retryOverlay = null;
  let overlayEl = null;
  let overlayStyle = null;
  let tabId = null;

  function log(msg) {
    console.log(`[CA] ${msg}`);
    C.currentItem = msg;
  }

  function storageKey(slug) { return `caState_${tabId || slotId()}`; }
  function slotId() { return C._slot || (C._slot = Math.random().toString(36).slice(2, 10)); }

  async function save() {
    const key = storageKey();
    if (key) await chrome.storage.local.set({ [key]: C });
    chrome.runtime.sendMessage({
      type: 'UPDATE_TAB',
      slug: C.slug,
      status: C.status,
      phase: C.phase,
      stats: C.stats,
      currentItem: C.currentItem,
      currentModule: C.currentModule,
      totalModules: C.totalModules
    }).catch(() => {});
  }

  async function load(slug) {
    const key = storageKey();
    const data = await chrome.storage.local.get(key);
    if (data[key]) {
      C = { ...C, ...data[key] };
      for (const k of ['scanPhase','allScannedItems','scannedModules','quizCorrectAnswers','quizAttempts','moduleVisits','allItemIds','recentUrls']) delete C[k];
    }
  }

  async function clearState() {
    const key = storageKey();
    C = { ...C, status: 'idle', phase: 'idle', items: [], completedItems: [], stats: { total: 0, completed: 0, failed: 0, skipped: 0 }, lastPageUrl: '', samePageCount: 0, navigatingToItem: '', rateLimited: false };
    if (key) await chrome.storage.local.remove(key);
  }

  function getStatus() {
    return { phase: C.phase, stats: C.stats, currentItem: C.currentItem || '--', totalModules: C.totalModules, currentModule: C.currentModule, status: C.status };
  }

  function delay(ms) { return new Promise(r => setTimeout(r, ms)); }
  function throwIfStopped() { if (C.status !== 'running') throw new Error('__STOPPED__'); }

  function getCourseSlug() { const m = location.pathname.match(/\/learn\/([^/]+)/); return m ? m[1] : null; }
  function getCurrentModuleNumber() { const m = location.pathname.match(/\/module\/(\d+)/); return m ? parseInt(m[1]) : null; }
  function getCurrentItemId() { const m = location.pathname.match(itemPathPattern); return m ? m[2] : null; }

  function getPageType() {
    if (/\/quiz\//.test(location.pathname) || /\/exam\//.test(location.pathname) || /\/assignment-submission\//.test(location.pathname) || /\/assignment\//.test(location.pathname) || /\/practice-quiz\//.test(location.pathname) || /\/practice-exam\//.test(location.pathname) || /\/staffGraded\//.test(location.pathname) || /\/peer\//.test(location.pathname)) return 'quiz';
    if (/\/home\/module\/\d+/.test(location.pathname)) return 'module';
    if (/\/lecture\//.test(location.pathname) || /\/video\//.test(location.pathname)) return 'lecture';
    if (/\/supplement\//.test(location.pathname) || /\/reading\//.test(location.pathname)) return 'supplement';
    if (/\/discussionPrompt\//.test(location.pathname) || /\/discussions\//.test(location.pathname)) return 'discussion';
    if (/\/gradedLab\//.test(location.pathname)) return 'graded_lab';
    if (/\/ungradedLab\//.test(location.pathname) || /\/ungraded\//.test(location.pathname) || /\/plugin\//.test(location.pathname) || /\/widget\//.test(location.pathname) || /\/lab\//.test(location.pathname) || /\/appItem\//.test(location.pathname)) return 'ungraded';
    if (/\/dialogue\//.test(location.pathname)) return 'dialogue';
    if (/\/home\/?(welcome|info|progress)?$/.test(location.pathname)) return 'home';
    return 'other';
  }

  function getItemTypeFromHref(href) {
    if (href.includes('/lecture/') || href.includes('/video/')) return 'lecture';
    if (href.includes('/supplement/') || href.includes('/reading/')) return 'supplement';
    if (href.includes('/quiz/') || href.includes('/exam/') || href.includes('/assignment/') || href.includes('/practice-quiz/') || href.includes('/practice-exam/') || href.includes('/staffGraded/')) return 'quiz';
    if (href.includes('/gradedLab/')) return 'graded_lab';
    if (href.includes('/discussionPrompt/') || href.includes('/discussions/')) return 'discussion';
    if (href.includes('/ungradedLab/') || href.includes('/ungraded/') || href.includes('/plugin/') || href.includes('/widget/') || href.includes('/lab/') || href.includes('/appItem/')) return 'ungraded';
    if (href.includes('/dialogue/')) return 'dialogue';
    if (href.includes('/peer/') || href.includes('/assignment-submission/')) return 'quiz';
    return 'other';
  }

  function isQuizType(type) { return type === 'quiz' || type === 'exam' || type === 'assignment'; }
  function isOnCourseHomePage() { return /\/home\/?(welcome|info|progress)?$/.test(location.pathname); }

  function scrollToBottom() { window.scrollTo(0, document.body.scrollHeight); }

  async function scrollPageToBottom() {
    scrollToBottom();
    await delay(500);
    scrollToBottom();
    await delay(500);
  }

  function clickElement(el) {
    el.scrollIntoView({ behavior: 'instant', block: 'center' });
    el.focus();
    ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(type => {
      el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    });
  }

  function clickBackButton() {
    const backBtn = document.querySelector(
      '[data-testid="tunnel-vision-back-button"], [data-testid="exit-button"], [data-testid="back-button"], [data-e2e="back-button"], .back-button, [class*="backButton"], [class*="back-button"], button[class*="Back"], a[class*="Back"], [aria-label*="Back" i], [aria-label*="back to" i]'
    ) || [...document.querySelectorAll('button, a, [role="button"]')].find(el => {
      if (el.disabled || el.getAttribute('aria-disabled') === 'true' || el.offsetParent === null) return false;
      const text = el.textContent.trim();
      return /^Back$/i.test(text) || /^<[\s\u00AB]/i.test(text) || /[\u2190\u2199]/i.test(text);
    });
    if (backBtn) { log('Clicking back button'); clickElement(backBtn); return true; }
    const nav = document.querySelector('nav[class*="top"], [class*="header"]');
    if (nav) {
      const links = [...nav.querySelectorAll('a')];
      const courseLink = links.find(a => /coursera\.org\/learn/i.test(a.href) && !a.href.includes(location.pathname.split('/').filter(Boolean).slice(0, 4).join('/')));
      if (courseLink) { log('Navigating back via course link'); navigateTo(`/learn/${C.slug}/home/module/${C.currentModule}`); return true; }
    }
    log('No back button found, navigating to module page');
    navigateTo(`/learn/${C.slug}/home/module/${C.currentModule}`);
    return true;
  }

  function findCompletionToggleInItem(itemEl) {
    for (const sel of COMPLETE_SELECTORS) {
      const el = itemEl.querySelector(sel);
      if (el) return el;
    }
    const buttons = itemEl.querySelectorAll('button, [role="button"]');
    for (const btn of buttons) {
      const label = btn.getAttribute('aria-label') || btn.textContent.trim();
      if (/complete|mark|done|toggle/i.test(label)) return btn;
    }
    return null;
  }

  async function tryCompleteItemOnModule(itemEl, item) {
    const toggle = findCompletionToggleInItem(itemEl);
    if (!toggle) return false;
    log(`Clicking toggle for "${item.name}"`);
    clickElement(toggle);
    for (let i = 0; i < 10; i++) {
      await delay(500);
      const ariaChecked = toggle.getAttribute('aria-checked');
      if (ariaChecked === 'true' || toggle.classList.contains('completed')) { log(`Toggle confirmed for ${item.id}`); return true; }
      const completedNow = itemEl.querySelector('[data-test="completed"], .completed-check, [aria-label*="completed" i], [data-testid="learn-item-success-icon"]');
      if (completedNow) { log(`Completion indicator confirmed for ${item.id}`); return true; }
    }
    log(`Toggle not confirmed for ${item.id} after 5s`);
    return false;
  }

  function findPageCompleteButton() {
    for (const sel of PAGE_COMPLETE_SELECTORS) {
      const btn = document.querySelector(sel);
      if (btn && btn.offsetParent !== null) return btn;
    }
    const buttons = [...document.querySelectorAll('button, a, [role="button"]')];
    return buttons.find(b =>
      /complete|mark.*complete|mark.*done/i.test(b.textContent.trim()) ||
      /continue|next/i.test(b.textContent.trim()) ||
      /complete/i.test(b.getAttribute('aria-label') || '') ||
      b.getAttribute('data-test') === 'complete-button' ||
      b.getAttribute('data-testid') === 'mark-complete' ||
      b.getAttribute('data-testid') === 'next-item' ||
      b.id?.includes('complete')
    ) || null;
  }

  async function clickMarkCompleteButton(item) {
    let btn = null;
    for (let s = 0; s < 5; s++) {
      throwIfStopped();
      window.scrollTo(0, document.body.scrollHeight * (s + 1) / 5);
      await delay(600);
      btn = findPageCompleteButton();
      if (btn) break;
    }
    if (!btn) {
      window.scrollTo(0, 0);
      btn = findPageCompleteButton();
    }
    if (!btn) { log(`No completion button on page for ${item.id}`); return false; }
    log('Clicking page complete button');
    clickElement(btn);
    for (let i = 0; i < 10; i++) {
      await delay(500);
      if (!document.contains(btn) || btn.disabled || btn.getAttribute('aria-disabled') === 'true') { log(`Page completion confirmed for ${item.id}`); return true; }
      const completedText = document.querySelector('[data-testid="completed-text"], [data-test="completed-text"], [class*="completed-text"], [data-test="completed"]');
      if (completedText && completedText.textContent.trim().length > 0) { log(`Page completion confirmed via banner for ${item.id}`); return true; }
    }
    log(`Page completion clicked for ${item.id}`);
    return true;
  }

  async function seekVideoToEnd() {
    let video;
    for (let i = 0; i < 15; i++) {
      throwIfStopped();
      video = document.querySelector('video');
      if (video && video.duration && isFinite(video.duration) && video.duration > 0) break;
      await delay(1000);
    }
    if (!video || !video.duration || !isFinite(video.duration) || video.duration <= 0) { log('Video not ready after 15s'); return false; }
    const seekTime = Math.max(0, video.duration - 0.5);
    video.currentTime = seekTime;
    video.dispatchEvent(new Event('timeupdate'));
    log(`Video seeked to ${seekTime.toFixed(1)}s / ${video.duration.toFixed(1)}s`);
    await delay(500);
    video.play().catch(() => {});
    return true;
  }

  async function completeItemOnPage(item) {
    throwIfStopped();
    log(`Completing ${item.type}: ${item.id}`);
    await delay(2000);

    if (item.type === 'lecture') {
      if (await seekVideoToEnd()) { log('Video seeked, waiting for auto-completion...'); await delay(5000); }
      else { log('Could not seek video, waiting 8s anyway...'); await delay(8000); }
      return true;
    }

    if (item.type === 'supplement' || item.type === 'reading') {
      if (await clickMarkCompleteButton(item)) return true;
      log('No mark-complete button for supplement, visit assumed complete');
      return true;
    }

    if (item.type === 'discussion') {
      const ta = document.querySelector('textarea, div[contenteditable="true"]');
      if (ta) {
        ta.focus();
        const text = 'Great insights! This module covers the topic very well.';
        if (ta.tagName === 'TEXTAREA' || ta.tagName === 'INPUT') ta.value = text;
        else ta.textContent = text;
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        await delay(300);
      }
      const postBtn = [...document.querySelectorAll('button')].find(b => /post|submit/i.test(b.textContent.trim()) && !b.disabled);
      if (postBtn) clickElement(postBtn);
      await delay(2000);
      await clickMarkCompleteButton(item);
      return true;
    }

    if (item.type === 'graded_lab') {
      await clickLabAgreeAndLaunch();
      await delay(1000);
      chrome.runtime.sendMessage({ type: 'CLOSE_LAB_TABS' }).catch(() => {});
      await clickMarkCompleteButton(item);
      return true;
    }

    if (item.type === 'ungraded' || item.type === 'plugin' || item.type === 'widget') {
      if (findLaunchAppButton()) {
        await clickLabAgreeAndLaunch();
        await delay(1000);
        chrome.runtime.sendMessage({ type: 'CLOSE_LAB_TABS' }).catch(() => {});
      }
      await clickMarkCompleteButton(item);
      return true;
    }

    await clickMarkCompleteButton(item);
    return true;
  }

  function findLaunchAppButton() {
    return document.querySelector(
      'button[aria-label*="Launch" i], [data-testid="launch-app-button"], [data-test="launch-app"], a[aria-label*="Launch" i][role="button"]'
    ) || [...document.querySelectorAll('button')].find(b => /^Launch\s*(App|Application|Lab|Tool)?$/i.test(b.textContent.trim())) || null;
  }

  async function clickLabAgreeAndLaunch() {
    const agreeCheckbox = document.querySelector('[data-testid="agreement-checkbox"] input[type="checkbox"], input[value="agree"]') ||
      [...document.querySelectorAll('.rc-HonorCodeAgreement input[type="checkbox"], form input[type="checkbox"]')].find(cb => !cb.checked);
    if (agreeCheckbox && !agreeCheckbox.checked) {
      log('Checking lab honor agreement...');
      clickElement(agreeCheckbox);
      await delay(1000);
    }
    for (let i = 0; i < 15; i++) {
      const launchBtn = findLaunchAppButton();
      if (launchBtn && !launchBtn.disabled && launchBtn.getAttribute('aria-disabled') !== 'true') {
        log(`Clicking "${launchBtn.textContent.trim()}"`);
        launchBtn.click();
        await delay(3000);
        return true;
      }
      await delay(1000);
    }
    log('No Launch App button found');
    return false;
  }

  function detectPageTypeFromContent() {
    if (findLaunchAppButton()) return 'lab';
    if ([...document.querySelectorAll('button')].find(b => /^Start Dialogue$/i.test(b.textContent.trim()) && !b.disabled)) return 'dialogue';
    const startBtn = document.querySelector(
      'button[aria-label*="Start" i], button[aria-label*="Resume" i], button[aria-label*="Try again" i]'
    ) || [...document.querySelectorAll('button')].find(b => {
      if (b.disabled || b.getAttribute('aria-disabled') === 'true') return false;
      return /^(Start assignment|Start Quiz|Start Exam|Resume quiz|Resume|Try again)$/i.test(b.textContent.trim());
    });
    if (startBtn) return 'quiz';
    const video = document.querySelector('video');
    if (video && video.duration && isFinite(video.duration) && video.duration > 0) return 'lecture';
    if (findPageCompleteButton()) return 'reading';
    return null;
  }

  async function callGroq(prompt) {
    if (!groqApiKey) {
      const data = await new Promise(r => chrome.storage.local.get('groqApiKey', r));
      groqApiKey = data.groqApiKey || '';
    }
    if (!groqApiKey) throw new Error('Groq API key not set. Set it in extension settings.');
    const url = 'https://api.groq.com/openai/v1/chat/completions';
    const body = { model: 'llama-3.3-70b-versatile', messages: [{ role: 'user', content: prompt }], temperature: 0.2, max_tokens: 4096 };
    for (;;) {
      throwIfStopped();
      const controller = new AbortController();
      const stopCheck = setInterval(() => { if (C.status !== 'running') controller.abort(); }, 400);
      let r;
      try { r = await fetch(url, { signal: controller.signal, method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${groqApiKey}` }, body: JSON.stringify(body) }); }
      catch (e) { clearInterval(stopCheck); if (e.name === 'AbortError') { log('Groq fetch aborted — stopped by user'); throw new Error('__STOPPED__'); } throw e; }
      clearInterval(stopCheck);
      if (r.ok) {
        groqConsecutiveRateLimits = 0;
        clearRetryOverlay();
        const data = await r.json();
        if (data?.choices?.[0]?.message?.content) return data.choices[0].message.content.trim();
        throw new Error('Groq: unexpected response format');
      }
      const errText = await r.text();
      if (r.status !== 429 && r.status !== 403) { groqConsecutiveRateLimits = 0; throw new Error(`Groq API: ${r.status} ${errText.slice(0, 300)}`); }
      groqConsecutiveRateLimits++;
      C.rateLimited = true;
      if (groqConsecutiveRateLimits >= 2) { showExpiredOverlay(); throw new Error('Groq API daily usage expired — use a different API key'); }
      showRetryOverlay(30);
      log(`Groq quota hit (attempt ${groqConsecutiveRateLimits}), waiting 30s... (${errText.slice(0, 120)})`);
      for (let i = 30; i > 0; i--) { throwIfStopped(); updateRetryOverlay(i); await delay(1000); }
    }
  }

  function showRetryOverlay(waitSec) {
    if (retryOverlay) return;
    retryOverlay = document.createElement('div');
    Object.assign(retryOverlay.style, {
      position: 'fixed', top: '0', left: '0', right: '0',
      background: '#f57c00', color: '#fff',
      padding: '16px 24px', fontSize: '16px',
      fontWeight: 'bold', zIndex: '999999',
      display: 'flex', justifyContent: 'space-between',
      alignItems: 'center', boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
      fontFamily: 'Arial, sans-serif',
    });
    retryOverlay.innerHTML = `
      <span id="ca-retry-msg">⏳ Groq API rate-limited. Waiting ${waitSec}s before retry...</span>
      <button id="ca-dismiss-retry" style="background:transparent;border:1px solid #fff;color:#fff;border-radius:4px;padding:4px 16px;cursor:pointer;font-size:14px;margin-left:16px;white-space:nowrap;">Dismiss</button>`;
    document.body.prepend(retryOverlay);
    document.getElementById('ca-dismiss-retry')?.addEventListener('click', () => { retryOverlay?.remove(); retryOverlay = null; });
  }

  function updateRetryOverlay(waitSec) {
    const msg = document.getElementById('ca-retry-msg');
    if (msg) msg.textContent = `⏳ Groq API rate-limited. Waiting ${waitSec}s before retry...`;
  }

  function clearRetryOverlay() {
    if (retryOverlay) { retryOverlay.remove(); retryOverlay = null; }
  }

  function showExpiredOverlay() {
    if (retryOverlay) { retryOverlay.remove(); retryOverlay = null; }
    retryOverlay = document.createElement('div');
    Object.assign(retryOverlay.style, {
      position: 'fixed', top: '0', left: '0', right: '0',
      background: '#d32f2f', color: '#fff',
      padding: '16px 24px', fontSize: '16px',
      fontWeight: 'bold', zIndex: '999999',
      display: 'flex', justifyContent: 'space-between',
      alignItems: 'center', boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
      fontFamily: 'Arial, sans-serif',
    });
    retryOverlay.innerHTML = `
      <span>🚫 Groq API daily usage has expired. Use a different API key.
      <a href="https://console.groq.com/usage" target="_blank" style="color:#ffeb3b;margin-left:8px;">Check usage &rarr;</a></span>
      <button id="ca-dismiss-retry" style="background:transparent;border:1px solid #fff;color:#fff;border-radius:4px;padding:4px 16px;cursor:pointer;font-size:14px;margin-left:16px;white-space:nowrap;">Dismiss</button>`;
    document.body.prepend(retryOverlay);
    document.getElementById('ca-dismiss-retry')?.addEventListener('click', () => { retryOverlay?.remove(); retryOverlay = null; });
    groqConsecutiveRateLimits = 0;
  }

  function setReactInputValue(el, value) {
    const nativeSetter = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value')?.set;
    if (nativeSetter) nativeSetter.call(el, value); else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function getQuizQuestionElements() {
    for (const sel of [
      '[data-test="quiz-question"]', '[data-test="question"]',
      '[data-test="assignment-question"]', '[data-testid^="part-Submission_"]',
      '.rc-Question', '.rc-MCQQuestion', '.quiz-question',
      '[data-e2e="question"]', '[data-test="question-container"]',
      '.rc-AssignmentItem', '[class*="assignment"] [class*="question"]',
    ]) {
      const els = document.querySelectorAll(sel);
      if (els.length > 0) return els;
    }
    return [];
  }

  function getChoiceText(el) {
    const txtEl = el.querySelector('span, [class*="text"], [class*="label"], .rc-option-label, label');
    if (txtEl) return txtEl.textContent.trim();
    const cloned = el.cloneNode(true);
    cloned.querySelectorAll('input, button, textarea, select, [role="radio"], [role="checkbox"]').forEach(e => e.remove());
    return cloned.textContent.trim() || '';
  }

  function getFullQuestionText(questionEl) {
    const viewer = questionEl.querySelector('[data-testid="cml-viewer"]');
    const root = viewer || questionEl;
    const clone = root.cloneNode(true);
    clone.querySelectorAll('input, button, textarea, select, [role="radio"], [role="checkbox"], [class*="option"], [class*="choice"]').forEach(e => e.remove());
    for (const el of clone.querySelectorAll('pre')) {
      const txt = el.textContent.trim();
      if (txt) el.textContent = '\n```\n' + txt + '\n```\n';
    }
    for (const el of clone.querySelectorAll('code, [class*="code"], [class*="snippet"]')) {
      if (el.closest('pre')) continue;
      const txt = el.textContent.trim();
      if (txt) el.textContent = '\n```\n' + txt + '\n```\n';
    }
    const monacoLines = root.querySelectorAll('.monaco-editor .view-line');
    if (monacoLines.length > 0) {
      const code = Array.from(monacoLines).map(l => l.textContent).join('\n');
      if (code.trim()) clone.textContent += '\n```\n' + code.trim() + '\n```\n';
    }
    return clone.textContent.replace(/\s*\n\s*/g, '\n').trim();
  }

  function extractQuestionData(questionEl) {
    const questionText = getFullQuestionText(questionEl);
    const choices = [];

    const inputs = questionEl.querySelectorAll('input[type="radio"], input[type="checkbox"]');
    if (inputs.length > 0) {
      inputs.forEach((input, idx) => {
        let label = questionEl.querySelector(`label[for="${input.id}"]`) || input.closest('label');
        if (!label) {
          const parent = input.closest('[class*="option"], [class*="choice"], [class*="item"], [role="radio"], [role="checkbox"], [class*="row"]');
          if (parent) {
            label = parent.querySelector('span, [class*="text"], [class*="label"], .rc-option-label');
            if (!label) {
              const cloned = parent.cloneNode(true);
              cloned.querySelectorAll('input, button, textarea, select').forEach(el => el.remove());
              const txt = cloned.textContent.trim();
              if (txt) label = { textContent: txt };
            }
          }
        }
        if (!label) {
          const container = input.parentElement;
          if (container) {
            const txt = container.textContent.replace(input.value || '', '').trim();
            if (txt) label = { textContent: txt };
          }
        }
        const rawText = label ? label.textContent.trim() : '';
        const choiceText = rawText.replace(new RegExp('^' + questionText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), '').trim() || `Option ${String.fromCharCode(65 + idx)}`;
        choices.push({ index: idx, letter: String.fromCharCode(65 + idx), text: choiceText, element: input, clickTarget: label || input, isCheckbox: input.type === 'checkbox' });
      });
    } else {
      questionEl.querySelectorAll('[role="radio"], [role="checkbox"]').forEach((el, idx) => {
        choices.push({ index: idx, letter: String.fromCharCode(65 + idx), text: getChoiceText(el) || `Option ${String.fromCharCode(65 + idx)}`, element: el, clickTarget: el, isCheckbox: el.getAttribute('role') === 'checkbox' });
      });
    }
    return { questionText, choices, textareas: [...questionEl.querySelectorAll('textarea')], textInputs: [...questionEl.querySelectorAll('input[type="text"]:not([data-test])')] };
  }

  async function clickStartButton() {
    for (let i = 0; i < 15; i++) {
      throwIfStopped();
      const btn = document.querySelector('button[aria-label*="Start" i], button[aria-label*="Resume" i], button[aria-label*="Try again" i]');
      if (btn && !btn.disabled && btn.getAttribute('aria-disabled') !== 'true') { btn.click(); await delay(2000); return true; }
      const textMatch = [...document.querySelectorAll('button')].find(b => {
        if (b.disabled || b.getAttribute('aria-disabled') === 'true') return false;
        return /^(Start assignment|Start Quiz|Start Exam|Resume quiz|Resume|Try again)$/i.test(b.textContent.trim());
      });
      if (textMatch) { textMatch.click(); await delay(2000); return true; }
      await delay(1000);
    }
    return false;
  }

  async function solveQuizOnPage() {
    throwIfStopped();
    log('Solving quiz...');
    await delay(2000);
    await clickStartButton();

    for (let i = 0; i < 10; i++) {
      throwIfStopped();
      const continueBtn = document.querySelector('[data-testid="StartAttemptModal__primary-button"]:not([disabled])');
      if (continueBtn) { clickElement(continueBtn); await delay(2000); break; }
      await delay(500);
    }

    let questions = [];
    for (let i = 0; i < 20; i++) {
      throwIfStopped();
      const qEls = getQuizQuestionElements();
      if (qEls.length > 0) { questions = [...qEls].map(extractQuestionData); break; }
      await delay(1000);
    }
    if (questions.length === 0) {
      const hasMonaco = document.querySelector('.monaco-editor');
      if (hasMonaco) throw new Error('SKIP_ITEM: Quiz has code blocks (Monaco editor) that cannot be read automatically');
      throw new Error('Could not find quiz questions on page');
    }

    const hasUnreadableCode = questions.some(q => !q.questionText.trim() && document.querySelector('.monaco-editor'));
    if (hasUnreadableCode) throw new Error('SKIP_ITEM: Question has code blocks that could not be extracted');

    const ackBtn = document.querySelector('[data-action="acknowledge-guidelines"]');
    if (ackBtn) {
      ackBtn.click();
      await delay(2000);
      for (let i = 0; i < 10; i++) {
        throwIfStopped();
        const qEls = getQuizQuestionElements();
        if (qEls.length > 0) { questions = [...qEls].map(extractQuestionData); break; }
        await delay(1000);
      }
    }

    log(`Solving quiz with ${questions.length} questions`);
    C.stats.total += questions.length;
    await save();

    const promptParts = questions.map((q, i) => {
      const num = i + 1;
      if (q.textareas.length > 0 || q.textInputs.length > 0) return `Question ${num} (type: text): ${q.questionText}`;
      if (q.choices.length === 0) return null;
      const isMulti = q.choices.some(c => c.isCheckbox);
      const choicesText = q.choices.map(c => `${c.letter}) ${c.text}`).join('\n');
      return `Question ${num} (type: ${isMulti ? 'multi' : 'single'}): ${q.questionText}\nChoices:\n${choicesText}`;
    }).filter(Boolean);

    if (promptParts.length === 0) throw new Error('No answerable questions found');

    const batchPrompt = `You are taking a Coursera course quiz. Answer each question accurately. Return ONLY valid JSON, no other text.

Format: {"answers":[{"question":1,"answer":"A"},{"question":2,"answer":"text response"},{"question":3,"answers":["A","C"]}]}

Rules:
- Single-choice: "answer" with the correct letter
- Multi-select: "answers" with array of correct letter(s)
- Text questions: "answer" with the correct text
- If unsure, make your best guess

Questions:
${promptParts.join('\n\n')}`;

    log('Sending batch prompt to Groq...');
    const raw = await callGroq(batchPrompt);
    const cleaned = raw.replace(/```json\s*|\s*```/g, '').trim();

    let result = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try { result = JSON.parse(cleaned); if (result?.answers || result?.answer) break; } catch {}
      if (attempt === 0) {
        log('JSON parse failed, retrying with stricter prompt...');
        const retryRaw = await callGroq(`Return ONLY a valid JSON object. No markdown. No backticks.\n\nFormat: {"answers":[{"question":1,"answer":"A"}]}\n\n${promptParts.join('\n\n')}`);
        const retryCleaned = retryRaw.replace(/```json\s*|\s*```/g, '').trim();
        try { result = JSON.parse(retryCleaned); if (result?.answers || result?.answer) break; } catch { log(`Retry parse failed`); }
      }
      result = null;
    }

    if (!result) throw new Error('Failed to parse batch quiz response from Groq');

    const answerMap = (result?.answers || (result?.answer ? [{ question: 1, answer: result.answer }] : [])).reduce((map, entry) => {
      map[entry.question] = entry.answers || (entry.answer ? [entry.answer] : []);
      return map;
    }, {});

    const answeredCount = Object.keys(answerMap).length;
    if (answeredCount < questions.length) {
      log(`LLM only answered ${answeredCount}/${questions.length} questions — skipping`);
      throw new Error('SKIP_ITEM: LLM could not answer all questions');
    }

    for (let qIdx = 0; qIdx < questions.length; qIdx++) {
      throwIfStopped();
      const q = questions[qIdx];
      const num = qIdx + 1;
      const answers = answerMap[num] || [];

      if (q.textareas.length > 0 || q.textInputs.length > 0) {
        const text = answers[0] || '';
        for (const ta of q.textareas) setReactInputValue(ta, text);
        for (const ti of q.textInputs) setReactInputValue(ti, text);
        C.stats.completed++; await save(); continue;
      }

      if (q.choices.length === 0) { C.stats.skipped++; await save(); continue; }

      for (const choice of q.choices) {
        const shouldSelect = answers.includes(choice.letter);
        const isSelected = choice.element.checked || choice.element.getAttribute('aria-checked') === 'true';
        if (shouldSelect !== isSelected) { clickElement(choice.clickTarget); await delay(300); }
      }
      C.stats.completed++; await save(); await delay(500);
    }

    await delay(1000);

    const honorCheckbox = document.querySelector('#agreement-checkbox-base') ||
      document.querySelector('[data-testid="agreement-checkbox"] input[type="checkbox"]');
    if (honorCheckbox && !honorCheckbox.checked) { honorCheckbox.click(); await delay(1000); }

    let submitBtn = null;
    for (let i = 0; i < 15; i++) {
      throwIfStopped();
      submitBtn = document.querySelector('button[data-testid="submit-button"]:not([disabled])') ||
        document.querySelector('button[data-test="submit-button"]:not([disabled])') ||
        document.querySelector('button[data-test="submit"]:not([disabled])') ||
        document.querySelector('[data-e2e="submit-button"] button:not([disabled])') ||
        document.querySelector('[data-e2e="submit"] button:not([disabled])') ||
        document.querySelector('.rc-QuizSubmit button:not([disabled])') ||
        document.querySelector('button.primary:not([disabled])') ||
        [...document.querySelectorAll('button:not([disabled])')].find(b => /submit|check your answer|submit your answer|submit assignment/i.test(b.textContent.trim()));
      if (submitBtn) break;
      await delay(1000);
    }

    if (submitBtn) {
      submitBtn.click();
      let incompleteDetected = false;
      for (let i = 0; i < 10; i++) { throwIfStopped(); await delay(500); const cb = document.querySelector('[data-testid="dialog-submit-button"]:not([disabled])'); if (cb) { cb.click(); await delay(1500); break; } }
      for (let i = 0; i < 8; i++) {
        throwIfStopped(); await delay(500);
        const dialog = document.querySelector('[data-testid="scroll-container"][role="alertdialog"], [role="alertdialog"][data-testid*="dialog"], [data-e2e="SubmitDialog__heading"]') ||
          [...document.querySelectorAll('[role="alertdialog"], [role="dialog"], [data-testid*="dialog"]')].find(d => /missing or invalid|incomplete|unanswered/i.test(d.textContent));
        if (dialog) {
          const cancelBtn = dialog.querySelector('[data-testid="dialog-cancel-button"]') ||
            [...dialog.querySelectorAll('button')].find(b => /cancel|go back/i.test(b.textContent.trim()) && !b.disabled);
          if (cancelBtn) { log('Incomplete answers dialog — cancelling submission'); clickElement(cancelBtn); await delay(1000); incompleteDetected = true; break; }
        }
        if (document.querySelector('[data-testid="grading-in-progress-screen"], [data-test="grading"], [class*="grading"]')) break;
      }
      if (incompleteDetected) throw new Error('SKIP_ITEM: Quiz has incomplete answers — cancelled submission');
      for (let i = 0; i < 20; i++) { throwIfStopped(); await delay(1000); if (document.querySelector('[data-testid="grading-in-progress-screen"], [data-test="grading"], [class*="grading"], [data-test="correct"], .correct-feedback, [data-test="quiz-result"]')) break; }
      for (let i = 0; i < 60; i++) {
        throwIfStopped();
        await delay(1000);
        const cb = [...document.querySelectorAll('button')].find(b => /continue|next|view score|try again/i.test(b.textContent.trim()) && !b.disabled);
        if (cb) { cb.click(); await delay(2000); break; }
        if (document.querySelector('[data-test="correct"], .correct-feedback, [data-test="quiz-result"], .quiz-result') && !document.querySelector('[data-testid="grading-in-progress-screen"]')) break;
      }
    }
  }

  function findItemLinksDeep() {
    const pat = new RegExp('\\/(' + ITEM_PATHS.join('|') + ')\\/([^/?#]+)$');
    return [...document.querySelectorAll('a[href*="/learn/"]')].filter(a => pat.test(a.getAttribute('href')));
  }

  async function waitForItems() {
    for (let i = 0; i < 25; i++) {
      throwIfStopped();
      await delay(1000);
      for (const sel of ITEM_SELECTORS) { if (document.querySelector(sel)) return true; }
      if (findItemLinksDeep().length > 0) return true;
    }
    log('No items found after 25s');
    return false;
  }

  function extractItemIdFromHref(href) {
    const parts = href.split('/');
    for (const path of ITEM_PATHS) {
      const idx = parts.indexOf(path);
      if (idx >= 0 && idx + 1 < parts.length) {
        const candidate = parts[idx + 1];
        const qIdx = candidate.indexOf('?');
        return qIdx >= 0 ? candidate.substring(0, qIdx) : candidate;
      }
    }
    const last = parts[parts.length - 1];
    const qIdx = last.indexOf('?');
    return qIdx >= 0 ? last.substring(0, qIdx) : last;
  }

  function extractItemsFromModuleContent() {
    const itemEls = document.querySelectorAll('[data-test="item"], [data-testid="item"], [data-track-component="item_row"], .rc-WeekItem, [data-e2e="week-item"], [class*="weekItem"], [data-test="week-item"]');
    if (itemEls.length === 0) return null;
    const seen = new Set();
    const items = [];
    itemEls.forEach(el => {
      const link = el.querySelector('a[href*="/learn/"]') || el.querySelector('a');
      if (!link) return;
      const href = link.getAttribute('href') || link.getAttribute('data-href') || '';
      const itemId = extractItemIdFromHref(href);
      if (!itemId || seen.has(itemId)) return;
      seen.add(itemId);
      items.push({ id: itemId, type: getItemTypeFromHref(href), name: (link.getAttribute('aria-label') || link.textContent || '').trim() || `Item ${itemId}`, href });
    });
    if (items.length > 0) log(`Extracted ${items.length} items from module content`);
    return items;
  }

  function extractItemsFromDOM() {
    const moduleItems = extractItemsFromModuleContent();
    if (moduleItems && moduleItems.length > 0) return moduleItems;
    const qs = ITEM_SELECTORS.join(',');
    let itemLinks = [...document.querySelectorAll(qs)];
    if (itemLinks.length === 0) itemLinks = findItemLinksDeep();
    const seen = new Set();
    const items = [];
    itemLinks.forEach(link => {
      const href = link.getAttribute('href') || link.getAttribute('data-href') || '';
      const itemId = extractItemIdFromHref(href);
      if (!itemId || seen.has(itemId) || itemId === href) return;
      seen.add(itemId);
      items.push({ id: itemId, type: getItemTypeFromHref(href), name: (link.textContent || link.getAttribute('aria-label') || '').trim() || `Item ${itemId}`, href });
    });
    return items;
  }

  function findCompletedItems() {
    const completed = new Set();
    document.querySelectorAll('[data-test="item"] [data-test="completed"], [data-testid="item"] [data-test="completed"], .rc-WeekItemCompleted, .completed-check, [aria-label="Completed"], svg[aria-label*="completed" i]').forEach(el => {
      const c = el.closest('[data-test="item"], [data-testid="item"]')?.querySelector('a');
      if (c) { const id = extractItemIdFromHref(c.getAttribute('href') || ''); if (id) completed.add(id); }
    });
    document.querySelectorAll('[data-testid="learn-item-success-icon"]').forEach(el => {
      const link = el.closest('a');
      if (link) { const id = extractItemIdFromHref(link.getAttribute('href') || ''); if (id) completed.add(id); }
    });
    document.querySelectorAll('a[aria-label*="Completed"]').forEach(link => {
      const id = extractItemIdFromHref(link.getAttribute('href') || ''); if (id) completed.add(id);
    });
    if (completed.size > 0) log(`Found ${completed.size} already completed items`);
    return completed;
  }

  function isModuleLocked() { return !!document.querySelector('[data-test="module-locked"], .locked-module, [aria-label*="locked" i], .start-date-message, [data-test="scheduled"], [data-test="lock-icon"]'); }

  function countModulesFromDOM() {
    const tabs = document.querySelectorAll('[data-test="module-tab"], [role="tab"] a[href*="/module/"], a[href*="/home/module/"], [data-test="module-navigation"] a, [data-e2e="module-tab"], .rc-ModuleNavigation a, [role="tablist"] a[href*="module"]');
    if (tabs.length > 0) return tabs.length;
    const modLinks = [...document.querySelectorAll('a[href*="/home/module/"]')];
    const nums = modLinks.map(a => parseInt(a.getAttribute('href')?.match(/\/module\/(\d+)/)?.[1])).filter(n => !isNaN(n));
    if (nums.length > 0) return Math.max(...nums);
    if (modLinks.length > 0) return modLinks.length;
    return 0;
  }

  function navigateTo(url) { log(`Navigating to: ${url}`); window.location.href = url; }

  async function navigateToNextItem() {
    const remaining = C.items.filter(i => !C.completedItems.includes(i.id));
    if (remaining.length > 0) {
      const next = remaining[0];
      C.navigatingToItem = next.href; await save();
      navigateTo(next.href); return true;
    }
    log('No remaining items in C.items — navigating to module page to re-scan');
    C.items = []; await save();
    navigateTo(`/learn/${C.slug}/home/module/${C.currentModule}`);
    return true;
  }

  async function runPhase1() {
    throwIfStopped();
    C.phase = 'api'; await save();
    log(`Phase 1 on module ${getCurrentModuleNumber() || C.currentModule}`);
    const moduleNum = getCurrentModuleNumber();
    if (moduleNum) C.currentModule = moduleNum; await save();

    await expandAllSections();
    await scrollPageToBottom();

    if (!await waitForItems()) {
      if (isModuleLocked()) { log(`Module ${C.currentModule} locked, skipping`); return; }
      if (isOnCourseHomePage()) { navigateTo(`/learn/${C.slug}/home/module/1`); return; }
      return;
    }

    const allItems = extractItemsFromDOM();
    const completedIds = findCompletedItems();
    const newItems = allItems.filter(it => !completedIds.has(it.id) && !C.completedItems.includes(it.id));
    C.items = allItems;
    C.stats.total += newItems.length;
    await save();

    for (const item of newItems) {
      if (C.status !== 'running') return;
      updateOverlay(`${C.stats.completed + 1}/${C.stats.total || allItems.length} ${item.name}...`);

      if (document.querySelector(`a[href*="/${item.id}/"][aria-label*="Completed"], a[href*="/${item.id}/"] [data-testid="learn-item-success-icon"], a[href$="/${item.id}"][aria-label*="Completed"], a[href$="/${item.id}"] [data-testid="learn-item-success-icon"]`)) {
        C.stats.completed++; C.completedItems.push(item.id); await save(); continue;
      }

      if (item.type === 'lecture' || isQuizType(item.type) || item.type === 'graded_lab' || item.type === 'ungraded' || item.type === 'plugin' || item.type === 'widget' || item.type === 'dialogue') {
        C.navigatingToItem = item.href; await save(); navigateTo(item.href); return;
      }

      const itemRow = document.querySelector(`[data-test="item"] a[href*="/${item.id}/"], [data-testid="item"] a[href*="/${item.id}/"]`);
      const itemEl = itemRow?.closest('[data-test="item"], [data-testid="item"]');
      if (itemEl && await tryCompleteItemOnModule(itemEl, item)) {
        C.stats.completed++; C.completedItems.push(item.id); await save(); await delay(DELAY); continue;
      }

      C.navigatingToItem = item.href; await save(); navigateTo(item.href); return;
    }
    log(`Phase 1 done for module ${C.currentModule}. ${C.stats.completed}/${C.stats.total}`);
  }

  async function expandAllSections() {
    const tabSelectors = [
      '[data-test="module-tab"]', '[data-e2e="module-tab"]', '[role="tab"]',
      '.rc-ModuleNavigation a', '[data-track-component*="module"]',
      '[data-test="week-header"]', '[data-testid="week-header"]',
      'button[class*="week"]', 'button[class*="Week"]',
      'button[class*="section"]', 'button[class*="Section"]',
      'button[class*="accordion"]', 'button[class*="collapse"]',
      'button[class*="expand"]', 'button[class*="toggle"]',
      '[data-e2e="week-card"] button', '[data-testid*="collapse"] button',
      'button[aria-label*="expand"]', 'button[aria-label*="Week"]',
      'button[aria-label*="module"]',
    ];
    for (const sel of tabSelectors) {
      for (const el of document.querySelectorAll(sel)) {
        if (el.getAttribute('aria-expanded') !== 'true' && el.offsetParent !== null && !el.disabled) { clickElement(el); await delay(250); }
      }
    }
    for (const card of document.querySelectorAll('[data-e2e="week-card"]')) {
      if (card.getAttribute('aria-expanded') !== 'true') {
        const header = card.querySelector('button, [role="button"]');
        if (header && !header.disabled) { clickElement(header); await delay(250); }
      }
    }
  }

  async function handleQuizPage() {
    const itemId = getCurrentItemId();
    if (!itemId) { log('On quiz page but no item ID found'); return; }
    log(`Handling quiz page: ${itemId}`); await save();
    try {
      await solveQuizOnPage();
      if (!C.completedItems.includes(itemId)) C.completedItems.push(itemId);
      C.stats.completed++; log(`Quiz ${itemId} completed`);
    } catch (err) {
      if (err.message === '__STOPPED__') { log('Quiz stopped by user'); await save(); return; }
      if (err.message && err.message.startsWith('SKIP_ITEM:')) {
        console.warn('CA: quiz skipped —', err.message);
        C.stats.skipped++;
      } else {
        console.error('CA: quiz failed', err);
        C.stats.failed++;
      }
      if (!C.completedItems.includes(itemId)) C.completedItems.push(itemId);
      log(`Quiz ${itemId} skipped/failed: ${err.message}`);
      await save(); await delay(500);
      clickBackButton();
      return;
    }
    await save(); await delay(1500);
    if (await navigateToNextItem()) return;
    const nextM = C.currentModule + 1;
    if (nextM <= C.totalModules) { C.currentModule = nextM; await save(); navigateTo(`/learn/${C.slug}/home/module/${nextM}`); return; }
    C.phase = 'done'; C.status = 'done'; C.currentItem = 'All done!'; await save();
  }

  async function resumeOrStart(apiKey) {
    if (apiKey) { groqApiKey = apiKey; C.apiKey = apiKey; }
    C.status = 'running';
    C.slug = C.slug || getCourseSlug();
    if (!C.slug) { C.status = 'error'; await save(); return; }

    if (C.lastPageUrl === location.href) {
      C.samePageCount = (C.samePageCount || 0) + 1;
      if (C.samePageCount > 2) { log('Loop detected, stopping'); C.status = 'done'; await save(); return; }
    } else { C.lastPageUrl = location.href; C.samePageCount = 0; }

    if (!C.totalModules) { C.totalModules = countModulesFromDOM() || 50; log(`Total modules: ${C.totalModules}`); }
    await save();
    await scrollPageToBottom();

    const pageType = getPageType();
    if (pageType === 'quiz') { await handleQuizPage(); return; }
    if (pageType === 'dialogue') {
      const currentId = getCurrentItemId();
      if (currentId) { C.completedItems.push(currentId); C.stats.skipped++; log(`Dialogue ${currentId} — skipped`); await save(); }
      if (C.navigatingToItem) C.navigatingToItem = ''; await save();
      if (await navigateToNextItem()) return;
      const nextM = C.currentModule + 1;
      if (nextM <= C.totalModules) { C.currentModule = nextM; await save(); navigateTo(`/learn/${C.slug}/home/module/${nextM}`); return; }
      C.phase = 'done'; C.status = 'done'; C.currentItem = 'All done!'; await save(); return;
    }

    if (pageType === 'graded_lab') {
      const currentId = getCurrentItemId();
      if (currentId) {
        await clickLabAgreeAndLaunch();
        chrome.runtime.sendMessage({ type: 'CLOSE_LAB_TABS' }).catch(() => {});
        if (!C.completedItems.includes(currentId)) C.completedItems.push(currentId);
        C.stats.completed++; await save(); await delay(DELAY);
        if (await navigateToNextItem()) return;
        navigateTo(`/learn/${C.slug}/home/module/${C.currentModule}`); return;
      }
    }

    if (pageType === 'ungraded') {
      const currentId = getCurrentItemId();
      if (currentId) {
        let launchFound = false;
        for (let i = 0; i < 15; i++) { throwIfStopped(); if (findLaunchAppButton()) { launchFound = true; break; } await delay(1000); }
        if (launchFound) {
          await clickLabAgreeAndLaunch();
          chrome.runtime.sendMessage({ type: 'CLOSE_LAB_TABS' }).catch(() => {});
          await clickMarkCompleteButton({ id: currentId });
        } else {
          await completeItemOnPage({ id: currentId, type: 'ungraded', name: C.currentItem });
        }
        if (!C.completedItems.includes(currentId)) C.completedItems.push(currentId);
        C.stats.completed++; C.navigatingToItem = ''; await save(); await delay(DELAY);
        if (await navigateToNextItem()) return;
        navigateTo(`/learn/${C.slug}/home/module/${C.currentModule}`); return;
      }
    }

    if (C.navigatingToItem) {
      const navId = extractItemIdFromHref(C.navigatingToItem);
      const currentId = getCurrentItemId();
      if (navId && currentId && navId === currentId) {
        await delay(1500);
        const contentType = detectPageTypeFromContent();
        C.navigatingToItem = ''; await save();

        if (contentType === 'quiz') {
          try {
            await solveQuizOnPage();
            if (!C.completedItems.includes(currentId)) C.completedItems.push(currentId);
            C.stats.completed++;
          } catch (err) {
            if (err.message === '__STOPPED__') { log('Quiz stopped by user'); await save(); return; }
            if (err.message && err.message.startsWith('SKIP_ITEM:')) { console.warn('CA: quiz skipped —', err.message); C.stats.skipped++; }
            else { console.error('CA: quiz failed', err); C.stats.failed++; }
            if (!C.completedItems.includes(currentId)) C.completedItems.push(currentId);
            await save(); await delay(500);
            clickBackButton(); return;
          }
        } else if (contentType === 'lab') {
          await clickLabAgreeAndLaunch();
          chrome.runtime.sendMessage({ type: 'CLOSE_LAB_TABS' }).catch(() => {});
          if (!C.completedItems.includes(currentId)) C.completedItems.push(currentId);
          C.stats.completed++; await save(); await delay(DELAY);
        } else {
          await completeItemOnPage({ id: currentId, type: contentType || getItemTypeFromHref(location.pathname) || 'other', name: C.currentItem });
          C.stats.completed++; if (!C.completedItems.includes(currentId)) C.completedItems.push(currentId); await save(); await delay(DELAY);
        }

        if (await navigateToNextItem()) return;
        const nextM = C.currentModule + 1;
        if (nextM <= C.totalModules) { C.currentModule = nextM; await save(); navigateTo(`/learn/${C.slug}/home/module/${nextM}`); return; }
        C.phase = 'done'; C.status = 'done'; C.currentItem = 'All done!'; await save(); return;
      }
      C.navigatingToItem = ''; await save();
    }

    if (isOnCourseHomePage()) { navigateTo(`/learn/${C.slug}/home/module/1`); return; }

    if (pageType === 'module' || pageType === 'lecture' || pageType === 'supplement') {
      const modNum = getCurrentModuleNumber();
      if (modNum) C.currentModule = modNum; await save();
      await runPhase1();
      if (C.status !== 'running') return;
      if (C.navigatingToItem) return;
      await delay(2000);
      const nextModule = C.currentModule + 1;
      if (nextModule <= C.totalModules) { C.currentModule = nextModule; await save(); navigateTo(`/learn/${C.slug}/home/module/${nextModule}`); return; }
      C.phase = 'done'; C.status = 'done'; C.currentItem = 'All done!'; await save(); return;
    }

    const contentType = detectPageTypeFromContent();
    if (contentType === 'quiz') {
      const currentId = getCurrentItemId() || Date.now().toString();
      try { await solveQuizOnPage(); if (!C.completedItems.includes(currentId)) C.completedItems.push(currentId); C.stats.completed++; }
      catch (err) {
        if (err.message === '__STOPPED__') { log('Quiz stopped by user'); await save(); return; }
        if (err.message && err.message.startsWith('SKIP_ITEM:')) { console.warn('CA: quiz skipped —', err.message); C.stats.skipped++; }
        else { C.stats.failed++; }
        if (!C.completedItems.includes(currentId)) C.completedItems.push(currentId);
      }
      if (C.status !== 'running') { C.phase = 'paused'; await save(); return; }
      await save(); await delay(500);
      clickBackButton(); return;
    }
    if (contentType === 'dialogue') {
      const currentId = getCurrentItemId() || Date.now().toString();
      C.completedItems.push(currentId); C.stats.skipped++; log(`Content-detected dialogue — skipped`); await save();
      if (await navigateToNextItem()) return;
      navigateTo(`/learn/${C.slug}/home/module/${C.currentModule}`); return;
    }
    if (contentType === 'lecture') { await completeItemOnPage({ id: getCurrentItemId() || Date.now().toString(), type: 'lecture', name: C.currentItem }); return; }
    if (contentType === 'reading') { await completeItemOnPage({ id: getCurrentItemId() || Date.now().toString(), type: 'reading', name: C.currentItem }); return; }
    if (contentType === 'lab') {
      const currentId = getCurrentItemId() || Date.now().toString();
      await clickLabAgreeAndLaunch();
      chrome.runtime.sendMessage({ type: 'CLOSE_LAB_TABS' }).catch(() => {});
      if (!C.completedItems.includes(currentId)) C.completedItems.push(currentId);
      C.stats.completed++; await save(); await delay(DELAY);
      if (await navigateToNextItem()) return;
      navigateTo(`/learn/${C.slug}/home/module/${C.currentModule}`); return;
    }

    navigateTo(`/learn/${C.slug}/home/module/${C.currentModule}`);
  }

  function waitForBody() {
    return new Promise(resolve => {
      if (document.body) return resolve();
      const o = new MutationObserver(() => { if (document.body) { o.disconnect(); resolve(); } });
      o.observe(document.documentElement, { childList: true });
    });
  }

  async function addOverlay(msg) {
    await waitForBody();
    if (overlayEl) { overlayEl.querySelector('#ca-msg').textContent = msg; return; }
    overlayEl = document.createElement('div');
    overlayEl.id = 'ca-overlay';
    overlayEl.innerHTML = `<div id="ca-box"><div id="ca-title">Course Automation</div><div id="ca-msg"></div><div id="ca-bar"><div id="ca-fill"></div></div><div id="ca-btns"><button id="ca-stop">Stop</button></div></div>`;
    overlayStyle = document.createElement('style');
    overlayStyle.id = 'ca-style';
    overlayStyle.textContent = `
      #ca-overlay{position:fixed;bottom:20px;right:20px;z-index:999999;font-family:system-ui,sans-serif}
      #ca-box{background:#0a0a0a;border:1px solid #00ff88;border-radius:12px;padding:14px;min-width:280px;max-width:340px;box-shadow:0 0 30px rgba(0,255,136,0.2)}
      #ca-title{color:#00ff88;font-weight:700;font-size:13px;margin-bottom:4px}
      #ca-msg{color:#ccc;font-size:11px;margin-bottom:6px;word-break:break-word;min-height:16px}
      #ca-bar{height:5px;background:#222;border-radius:3px;overflow:hidden;margin-bottom:8px}
      #ca-fill{height:100%;width:0%;background:linear-gradient(90deg,#00ff88,#00ccff);border-radius:3px;transition:width .3s}
      #ca-btns{display:flex}
      #ca-stop{flex:1;background:#ff4444;color:#fff;border:none;border-radius:6px;padding:8px 0;font-size:12px;cursor:pointer;font-weight:700}
      #ca-stop:hover{background:#cc3333}`;
    document.head.appendChild(overlayStyle);
    document.body.appendChild(overlayEl);
    overlayEl.querySelector('#ca-msg').textContent = msg;
    overlayEl.querySelector('#ca-stop').onclick = () => { C.status = 'done'; save(); log('STOPPED by user'); removeOverlay(); };
  }

  function updateOverlay(msg, pct) {
    const el = document.getElementById('ca-overlay');
    if (!el) return;
    el.querySelector('#ca-msg').textContent = msg;
    el.querySelector('#ca-fill').style.width = (pct !== undefined ? Math.min(pct, 100) : Math.min(Math.round((C.stats.completed / (C.stats.total || 1)) * 100), 100)) + '%';
  }

  function removeOverlay() {
    if (overlayEl) { overlayEl.remove(); overlayEl = null; }
    if (overlayStyle) { overlayStyle.remove(); overlayStyle = null; }
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === 'runAll') {
      (async () => {
        await load();
        const data = await new Promise(r => chrome.storage.local.get('groqApiKey', r));
        if (data.groqApiKey) groqApiKey = data.groqApiKey;
        await addOverlay('Starting...');
        await resumeOrStart(groqApiKey);
      })().catch(e => log('Error: ' + e.message));
      sendResponse({ success: true }); return true;
    }
    if (msg.action === 'stopAutomation') { C.status = 'paused'; save(); removeOverlay(); sendResponse({ success: true }); return true; }
    if (msg.action === 'getStatus') { sendResponse(getStatus()); return true; }
    if (msg.action === 'quizAutomation') {
      (async () => {
        const data = await new Promise(r => chrome.storage.local.get('groqApiKey', r));
        if (data.groqApiKey) groqApiKey = data.groqApiKey;
        try { await solveQuizOnPage(); sendResponse({ success: true }); } catch (e) { sendResponse({ success: false, error: e.message }); }
      })(); return true;
    }
    if (msg.action === 'ping') { sendResponse({ pong: true }); return true; }
  });

  (async function init() {
    const currentSlug = getCourseSlug();
    if (!currentSlug) return;

    try {
      const info = await new Promise(resolve => {
        chrome.runtime.sendMessage({ type: 'GET_TAB_INFO' }, r => resolve(r || null));
        setTimeout(() => resolve(null), 2000);
      });
      if (info) tabId = info.tabId;
    } catch (e) {}

    await load();

    if (C.slug && C.slug !== currentSlug) {
      await clearState();
      await load();
    }
    C.slug = currentSlug;

    const keyData = await new Promise(r => chrome.storage.local.get('groqApiKey', r));
    if (keyData.groqApiKey) groqApiKey = keyData.groqApiKey;

    chrome.runtime.sendMessage({
      type: 'REGISTER_TAB',
      tabId,
      slug: C.slug,
      status: C.status,
      phase: C.phase,
      stats: C.stats,
      currentItem: C.currentItem,
      currentModule: C.currentModule,
      totalModules: C.totalModules
    }).catch(() => {});

    if (C.status === 'running' && groqApiKey) {
      await waitForBody();
      await addOverlay('Resuming...');
      resumeOrStart().catch(err => { console.error('CA auto-resume error:', err); C.status = 'error'; save(); });
    } else if (C.status === 'running') { C.status = 'paused'; await save(); }
  })();
})();
