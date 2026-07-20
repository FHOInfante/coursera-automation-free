(() => {
  const DELAY = 800;
  const TIMEOUT = 30000;

  const TOC_ITEM_SELECTORS = [
    '[class*="toc-item"] a, [class*="toc-entry"] a',
    '[class*="syllabus-item"] a, [class*="chapter-item"] a',
    '[data-control-name*="toc"] a, [data-control-name*="chapter"] a',
    '[class*="course-navigation"] a[href*="/learning/"]',
    '[class*="sidebar"] a[href*="/learning/"]',
    '[class*="table-of-contents"] a[href*="/learning/"]',
    '[class*="course-contents"] a[href*="/learning/"]',
    'li a[href*="/learning/"][href*="/"]:not([href$="/learning/"])',
    '[role="treeitem"] a, [role="listitem"] a[href*="/learning/"]',
  ];

  const COMPLETED_SELECTORS = [
    '[class*="completed"]', '[class*="viewed"]',
    '[aria-label*="completed" i]', '[data-test="completed"]',
    '[data-control-name="completed"]', '[class*="check"] svg',
    'svg[class*="check"]', '[class*="progress-icon"][class*="complete"]',
    '[class*="status"][class*="done"]',
  ];

  const PAGE_COMPLETE_SELECTORS = [
    'button[aria-label*="mark complete" i]',
    'button[aria-label*="Mark as completed" i]',
    '[data-control-name="mark_complete"]',
    'button[class*="mark-complete"]', 'button[class*="mark_complete"]',
    'button[class*="complete"]',
  ];

  const QUIZ_SELECTORS = [
    '[class*="quiz-question"]', '[class*="question"]',
    '[data-test="question"]', '[role="listitem"]',
    '[class*="QuizQuestion"]', '[class*="multiple-choice"]',
  ];

  const COURSE_ITEM_PATH_RE = /\/([^/]+)\/([^/?#]+)(?:\/quiz\/(\d+))?/;

  let C = {
    status: 'idle',
    slug: '',
    currentChapter: 1,
    totalChapters: 0,
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
  let lastUrl = location.href;
  let urlCheckTimer = null;

  function log(msg) { console.log(`[CA-LI] ${msg}`); C.currentItem = msg; }

  function storageKey() { return `caLnState_${tabId || slotId()}`; }
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
      currentModule: C.currentChapter,
      totalModules: C.totalChapters,
    }).catch(() => {});
  }

  async function load() {
    const key = storageKey();
    const data = await chrome.storage.local.get(key);
    if (data[key]) C = { ...C, ...data[key] };
  }

  async function clearState() {
    const key = storageKey();
    C = { ...C, status: 'idle', phase: 'idle', items: [], completedItems: [], stats: { total: 0, completed: 0, failed: 0, skipped: 0 }, lastPageUrl: '', samePageCount: 0, navigatingToItem: '', rateLimited: false };
    if (key) await chrome.storage.local.remove(key);
  }

  function getStatus() {
    return { phase: C.phase, stats: C.stats, currentItem: C.currentItem || '--', totalModules: C.totalChapters, currentModule: C.currentChapter, status: C.status };
  }

  function delay(ms) { return new Promise(r => setTimeout(r, ms)); }
  function throwIfStopped() { if (C.status !== 'running') throw new Error('__STOPPED__'); }

  function isOnLearning() { return location.hostname.includes('linkedin.com') && location.pathname.startsWith('/learning/'); }

  function getCourseSlug() { const m = location.pathname.match(/\/learning\/([^/?#]+)/); return m ? m[1] : null; }

  function getCurrentItemSlug() {
    const parts = location.pathname.split('/').filter(Boolean);
    if (parts.length < 3) return null;
    return parts.slice(2).join('/');
  }

  function getPageType() {
    if (!isOnLearning()) return 'other';
    const path = location.pathname;
    if (/\/quiz\//.test(path)) return 'quiz';
    if (/\/learning\/[^/]+\/?$/.test(path) || path === `/learning/${getCourseSlug()}`) return 'home';
    if (document.querySelector('video')) return 'video';
    if (document.querySelector('[class*="video-player"], [class*="VideoPlayer"], [data-control-name="video-player"]')) return 'video';
    const viewLinks = document.querySelectorAll('a[href*="/learning/"]');
    if (viewLinks.length > 5) return 'home';
    return 'other';
  }

  function getItemTypeFromHref(href) {
    if (!href) return 'other';
    if (href.includes('/quiz/')) return 'quiz';
    if (href.includes('/article/')) return 'article';
    return 'video';
  }

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

  function findPageCompleteButton() {
    for (const sel of PAGE_COMPLETE_SELECTORS) {
      const btn = document.querySelector(sel);
      if (btn && btn.offsetParent !== null) return btn;
    }
    const buttons = [...document.querySelectorAll('button, a, [role="button"]')];
    return buttons.find(b =>
      /mark as completed|mark complete|complete/i.test(b.textContent.trim()) ||
      /complete/i.test(b.getAttribute('aria-label') || '')
    ) || null;
  }

  async function clickMarkComplete(item) {
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
    if (!btn) { log(`No completion button for ${item.id}`); return false; }
    log('Clicking mark-as-complete button');
    clickElement(btn);
    for (let i = 0; i < 10; i++) {
      await delay(500);
      if (!document.contains(btn) || btn.disabled || btn.getAttribute('aria-disabled') === 'true') { log(`Completion confirmed for ${item.id}`); return true; }
    }
    log(`Completion clicked for ${item.id}`);
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
    if (video.readyState < 2) {
      video.play().catch(() => {});
      await delay(2000);
    }
    video.pause();
    const seekTime = Math.max(0, video.duration - 0.5);
    video.currentTime = seekTime;
    video.dispatchEvent(new Event('timeupdate'));
    log(`Video seeked to ${seekTime.toFixed(1)}s / ${video.duration.toFixed(1)}s`);
    await delay(1500);
    video.currentTime = seekTime;
    video.dispatchEvent(new Event('timeupdate'));
    video.dispatchEvent(new Event('ended'));
    await delay(1000);
    return true;
  }

  async function completeItem(item) {
    throwIfStopped();
    log(`Completing ${item.type}: ${item.id}`);
    await delay(2000);

    if (item.type === 'video') {
      if (await seekVideoToEnd()) {
        log('Video seeked, waiting for auto-completion...');
        await delay(3000);
      } else {
        log('Could not seek video, waiting 8s...');
        await delay(8000);
      }
      await clickMarkComplete(item);
      return true;
    }

    if (item.type === 'article') {
      if (await clickMarkComplete(item)) return true;
      log('No mark-complete for article, visit assumed complete');
      return true;
    }

    await clickMarkComplete(item);
    return true;
  }

  function extractItemsFromTOC() {
    const seen = new Set();
    const items = [];

    const allLinks = new Set();
    for (const sel of TOC_ITEM_SELECTORS) {
      for (const el of document.querySelectorAll(sel)) {
        allLinks.add(el);
      }
    }
    if (allLinks.size === 0) {
      document.querySelectorAll('a[href*="/learning/"]').forEach(el => allLinks.add(el));
    }

    for (const link of allLinks) {
      const href = link.getAttribute('href') || link.getAttribute('data-href') || '';
      if (!href || !href.includes('/learning/')) continue;
      const slug = getCourseSlug();
      if (!slug || !href.includes(slug)) continue;
      if (href === `/learning/${slug}` || href === `/learning/${slug}/`) continue;

      const parts = href.split('/').filter(Boolean);
      if (parts.length < 3) continue;

      const itemId = parts.slice(2).join('/');
      if (!itemId || seen.has(itemId)) continue;
      seen.add(itemId);

      const text = (link.getAttribute('aria-label') || link.textContent || '').trim();
      if (!text || text.length < 2) continue;

      const parent = link.closest('[class*="toc-item"], [class*="toc-entry"], [class*="chapter-item"], li, [role="treeitem"], [role="listitem"], [class*="item"]');
      const isCompleted = parent ? isElementCompleted(parent) : false;

      items.push({
        id: itemId,
        type: getItemTypeFromHref(href),
        name: text,
        href,
        completed: isCompleted,
      });
    }

    return items;
  }

  function isElementCompleted(el) {
    for (const sel of COMPLETED_SELECTORS) {
      if (el.querySelector(sel)) return true;
    }
    if (el.getAttribute('aria-current') === 'step') {
      const completed = el.querySelector('[class*="completed"], [class*="check"]');
      if (completed) return true;
    }
    const text = el.textContent.toLowerCase();
    if (/completed|viewed|done/i.test(text) && el.querySelector('svg, [class*="icon"]')) return true;
    return false;
  }

  function findCompletedItems() {
    const completed = new Set();
    const allItems = extractItemsFromTOC();
    for (const item of allItems) {
      if (item.completed) completed.add(item.id);
    }
    const alreadyDone = document.querySelectorAll(COMPLETED_SELECTORS.map(s => s + ', a ' + s).join(', '));
    for (const el of alreadyDone) {
      const link = el.closest('a') || el.querySelector('a');
      if (link) {
        const href = link.getAttribute('href') || '';
        const parts = href.split('/').filter(Boolean);
        if (parts.length >= 3) {
          const itemId = parts.slice(2).join('/');
          if (itemId) completed.add(itemId);
        }
      }
    }
    if (completed.size > 0) log(`Found ${completed.size} completed items`);
    return completed;
  }

  function navigateTo(url) { log(`Navigating to: ${url}`); window.location.href = url; }

  async function navigateToNextItem() {
    const remaining = C.items.filter(i => !C.completedItems.includes(i.id));
    if (remaining.length > 0) {
      const next = remaining[0];
      C.navigatingToItem = next.href; await save();
      navigateTo(next.href); return true;
    }
    log('All items completed!');
    C.phase = 'done'; C.status = 'done'; C.currentItem = 'All done!'; await save();
    return false;
  }

  async function solveQuiz() {
    throwIfStopped();
    log('Solving quiz...');
    await delay(2000);

    for (let i = 0; i < 15; i++) {
      throwIfStopped();
      const startBtn = document.querySelector('button[aria-label*="Start" i], button[aria-label*="Begin" i]') ||
        [...document.querySelectorAll('button')].find(b => /start|begin|take quiz/i.test(b.textContent.trim()) && !b.disabled);
      if (startBtn) { clickElement(startBtn); await delay(2000); break; }
      await delay(1000);
    }

    let questions = [];
    for (let i = 0; i < 20; i++) {
      throwIfStopped();
      for (const sel of QUIZ_SELECTORS) {
        const els = document.querySelectorAll(sel);
        if (els.length > 0) { questions = [...els]; break; }
      }
      if (questions.length > 0) break;
      await delay(1000);
    }
    if (questions.length === 0) throw new Error('Could not find quiz questions');

    const extracted = questions.map((qEl, idx) => {
      const clone = qEl.cloneNode(true);
      clone.querySelectorAll('input, button, textarea, select').forEach(e => e.remove());
      const questionText = clone.textContent.replace(/\s+/g, ' ').trim();
      const choices = [];
      const inputs = qEl.querySelectorAll('input[type="radio"], input[type="checkbox"]');
      inputs.forEach((input, ci) => {
        let label = qEl.querySelector(`label[for="${input.id}"]`) || input.closest('label');
        if (!label) {
          const parent = input.closest('[class*="option"], [class*="choice"], label, [role="radio"], [role="checkbox"]');
          if (parent) {
            const txtEl = parent.querySelector('span, [class*="text"], [class*="label"]');
            label = txtEl || parent;
          }
        }
        const choiceText = label ? label.textContent.replace(questionText, '').trim() : `Option ${String.fromCharCode(65 + ci)}`;
        choices.push({ index: ci, letter: String.fromCharCode(65 + ci), text: choiceText, element: input, clickTarget: label || input, isCheckbox: input.type === 'checkbox' });
      });
      return { questionText, choices, textareas: [...qEl.querySelectorAll('textarea')], textInputs: [...qEl.querySelectorAll('input[type="text"]')] };
    });

    if (!extracted.some(q => q.choices.length > 0 || q.textareas.length > 0 || q.textInputs.length > 0)) {
      throw new Error('No answerable questions found');
    }

    const answerable = extracted.filter(q => q.choices.length > 0 || q.textareas.length > 0 || q.textInputs.length > 0);
    C.stats.total += answerable.length;
    await save();

    const promptParts = answerable.map((q, i) => {
      const num = i + 1;
      if (q.textareas.length > 0 || q.textInputs.length > 0) return `Question ${num} (type: text): ${q.questionText}`;
      if (q.choices.length === 0) return null;
      const isMulti = q.choices.some(c => c.isCheckbox);
      const choicesText = q.choices.map(c => `${c.letter}) ${c.text}`).join('\n');
      return `Question ${num} (type: ${isMulti ? 'multi' : 'single'}): ${q.questionText}\nChoices:\n${choicesText}`;
    }).filter(Boolean);

    if (promptParts.length === 0) throw new Error('No answerable questions found');

    const batchPrompt = `You are taking a LinkedIn Learning course quiz. Answer each question accurately. Return ONLY valid JSON, no other text.

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
        const retryRaw = await callGroq(`Return ONLY a valid JSON object. No markdown. No backticks.\n\nFormat: {"answers":[{"question":1,"answer":"A"}]}\n\n${promptParts.join('\n\n')}`);
        const retryCleaned = retryRaw.replace(/```json\s*|\s*```/g, '').trim();
        try { result = JSON.parse(retryCleaned); if (result?.answers || result?.answer) break; } catch {}
      }
      result = null;
    }

    if (!result) throw new Error('Failed to parse quiz response from Groq');

    const answerMap = (result?.answers || (result?.answer ? [{ question: 1, answer: result.answer }] : [])).reduce((map, entry) => {
      map[entry.question] = entry.answers || (entry.answer ? [entry.answer] : []);
      return map;
    }, {});

    if (Object.keys(answerMap).length < answerable.length) {
      log(`LLM only answered ${Object.keys(answerMap).length}/${answerable.length} questions — skipping`);
      throw new Error('SKIP_ITEM: LLM could not answer all questions');
    }

    for (let qIdx = 0; qIdx < answerable.length; qIdx++) {
      throwIfStopped();
      const q = answerable[qIdx];
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

    let submitBtn = null;
    for (let i = 0; i < 15; i++) {
      throwIfStopped();
      submitBtn = [...document.querySelectorAll('button:not([disabled])')].find(b =>
        /submit|check answer|check your answer|submit answers/i.test(b.textContent.trim()) ||
        b.getAttribute('data-control-name') === 'submit_quiz'
      );
      if (submitBtn) break;
      await delay(1000);
    }

    if (submitBtn) {
      clickElement(submitBtn);
      for (let i = 0; i < 20; i++) {
        throwIfStopped(); await delay(1000);
        const nextBtn = [...document.querySelectorAll('button:not([disabled])')].find(b =>
          /continue|next|view results|see results|close/i.test(b.textContent.trim())
        );
        if (nextBtn) { clickElement(nextBtn); await delay(1500); break; }
        const done = document.querySelector('[class*="quiz-result"], [class*="QuizResult"], [data-test="quiz-result"]');
        if (done) break;
      }
    }
  }

  function setReactInputValue(el, value) {
    const nativeSetter = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value')?.set;
    if (nativeSetter) nativeSetter.call(el, value); else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
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
      <span id="ca-li-retry-msg">Groq API rate-limited. Waiting ${waitSec}s before retry...</span>
      <button id="ca-li-dismiss-retry" style="background:transparent;border:1px solid #fff;color:#fff;border-radius:4px;padding:4px 16px;cursor:pointer;font-size:14px;margin-left:16px;white-space:nowrap;">Dismiss</button>`;
    document.body.prepend(retryOverlay);
    document.getElementById('ca-li-dismiss-retry')?.addEventListener('click', () => { retryOverlay?.remove(); retryOverlay = null; });
  }

  function updateRetryOverlay(waitSec) {
    const msg = document.getElementById('ca-li-retry-msg');
    if (msg) msg.textContent = `Groq API rate-limited. Waiting ${waitSec}s before retry...`;
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
      <span>Groq API daily usage has expired. Use a different API key.
      <a href="https://console.groq.com/usage" target="_blank" style="color:#ffeb3b;margin-left:8px;">Check usage &rarr;</a></span>
      <button id="ca-li-dismiss-expired" style="background:transparent;border:1px solid #fff;color:#fff;border-radius:4px;padding:4px 16px;cursor:pointer;font-size:14px;margin-left:16px;white-space:nowrap;">Dismiss</button>`;
    document.body.prepend(retryOverlay);
    document.getElementById('ca-li-dismiss-expired')?.addEventListener('click', () => { retryOverlay?.remove(); retryOverlay = null; });
    groqConsecutiveRateLimits = 0;
  }

  async function handleQuizPage() {
    const itemId = getCurrentItemSlug();
    if (!itemId) { log('On quiz page but no item ID found'); return; }
    log(`Handling quiz: ${itemId}`);
    try {
      await solveQuiz();
      if (!C.completedItems.includes(itemId)) C.completedItems.push(itemId);
      C.stats.completed++;
    } catch (err) {
      if (err.message === '__STOPPED__') { log('Quiz stopped'); await save(); return; }
      if (err.message && err.message.startsWith('SKIP_ITEM:')) { console.warn('[CA-LI] quiz skipped —', err.message); C.stats.skipped++; }
      else { console.error('[CA-LI] quiz failed', err); C.stats.failed++; }
      if (!C.completedItems.includes(itemId)) C.completedItems.push(itemId);
      await save(); await delay(500);
      return;
    }
    await save(); await delay(1500);
    await navigateToNextItem();
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

    await save();

    if (C.navigatingToItem) {
      const currentSlug = getCurrentItemSlug();
      const navSlug = C.navigatingToItem.split('/').filter(Boolean).slice(2).join('/');
      if (navSlug && currentSlug && navSlug === currentSlug) {
        C.navigatingToItem = ''; await save();
        const pageType = getPageType();
        if (pageType === 'quiz') {
          await handleQuizPage(); return;
        }
        await delay(1500);
        await completeItem({ id: currentSlug, type: pageType, name: C.currentItem });
        C.stats.completed++; if (!C.completedItems.includes(currentSlug)) C.completedItems.push(currentSlug); await save(); await delay(DELAY);
        if (await navigateToNextItem()) return;
        C.phase = 'done'; C.status = 'done'; C.currentItem = 'All done!'; await save(); return;
      }
      C.navigatingToItem = ''; await save();
    }

    const pageType = getPageType();

    if (pageType === 'quiz') {
      await handleQuizPage(); return;
    }

    if (pageType === 'video' || pageType === 'article') {
      const currentSlug = getCurrentItemSlug();
      if (currentSlug) {
        await completeItem({ id: currentSlug, type: pageType, name: C.currentItem });
        if (!C.completedItems.includes(currentSlug)) C.completedItems.push(currentSlug);
        C.stats.completed++; await save(); await delay(DELAY);
        if (await navigateToNextItem()) return;
        C.phase = 'done'; C.status = 'done'; C.currentItem = 'All done!'; await save(); return;
      }
    }

    if (pageType === 'home' || pageType === 'other') {
      await delay(2000);
      const items = extractItemsFromTOC();
      const completedIds = findCompletedItems();
      const newItems = items.filter(it => !completedIds.has(it.id) && !C.completedItems.includes(it.id));
      C.items = items;
      C.stats.total = items.length;
      await save();

      for (const item of newItems) {
        if (C.status !== 'running') return;
        updateOverlay(`${C.stats.completed + 1}/${C.stats.total} ${item.name}...`);

        if (completedIds.has(item.id) || C.completedItems.includes(item.id)) {
          C.stats.completed++; C.completedItems.push(item.id); await save(); continue;
        }

        C.navigatingToItem = item.href; await save();
        navigateTo(item.href); return;
      }

      if (C.items.length === C.completedItems.length) {
        C.phase = 'done'; C.status = 'done'; C.currentItem = 'All done!'; await save(); return;
      }

      log('No new items found, scanning again in 3s...');
      await delay(3000);
      if (C.status === 'running') navigateTo(`/learning/${C.slug}`);
    }
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
    if (overlayEl) { overlayEl.querySelector('#ca-li-msg').textContent = msg; return; }
    overlayEl = document.createElement('div');
    overlayEl.id = 'ca-li-overlay';
    overlayEl.innerHTML = `<div id="ca-li-box"><div id="ca-li-title">Course Automation — LinkedIn</div><div id="ca-li-msg"></div><div id="ca-li-bar"><div id="ca-li-fill"></div></div><div id="ca-li-btns"><button id="ca-li-stop">Stop</button></div></div>`;
    overlayStyle = document.createElement('style');
    overlayStyle.id = 'ca-li-style';
    overlayStyle.textContent = `
      #ca-li-overlay{position:fixed;bottom:20px;right:20px;z-index:999999;font-family:system-ui,sans-serif}
      #ca-li-box{background:#0a0a0a;border:1px solid #0a66c2;border-radius:12px;padding:14px;min-width:280px;max-width:340px;box-shadow:0 0 30px rgba(10,102,194,0.2)}
      #ca-li-title{color:#0a66c2;font-weight:700;font-size:13px;margin-bottom:4px}
      #ca-li-msg{color:#ccc;font-size:11px;margin-bottom:6px;word-break:break-word;min-height:16px}
      #ca-li-bar{height:5px;background:#222;border-radius:3px;overflow:hidden;margin-bottom:8px}
      #ca-li-fill{height:100%;width:0%;background:linear-gradient(90deg,#0a66c2,#00ccff);border-radius:3px;transition:width .3s}
      #ca-li-btns{display:flex}
      #ca-li-stop{flex:1;background:#ff4444;color:#fff;border:none;border-radius:6px;padding:8px 0;font-size:12px;cursor:pointer;font-weight:700}
      #ca-li-stop:hover{background:#cc3333}`;
    document.head.appendChild(overlayStyle);
    document.body.appendChild(overlayEl);
    overlayEl.querySelector('#ca-li-msg').textContent = msg;
    overlayEl.querySelector('#ca-li-stop').onclick = () => { C.status = 'done'; save(); log('STOPPED by user'); removeOverlay(); };
  }

  function updateOverlay(msg, pct) {
    const el = document.getElementById('ca-li-overlay');
    if (!el) return;
    el.querySelector('#ca-li-msg').textContent = msg;
    el.querySelector('#ca-li-fill').style.width = (pct !== undefined ? Math.min(pct, 100) : Math.min(Math.round((C.stats.completed / (C.stats.total || 1)) * 100), 100)) + '%';
  }

  function removeOverlay() {
    if (overlayEl) { overlayEl.remove(); overlayEl = null; }
    if (overlayStyle) { overlayStyle.remove(); overlayStyle = null; }
  }

  function checkUrlChange() {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      if (C.status === 'running') {
        log(`URL changed to: ${location.pathname}`);
        resumeOrStart().catch(err => { console.error('[CA-LI] resume error:', err); if (err.message !== '__STOPPED__') { C.status = 'error'; save(); } });
      }
    }
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
    if (msg.action === 'ping') { sendResponse({ pong: true }); return true; }
  });

  (async function init() {
    if (!isOnLearning()) return;
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
      currentModule: C.currentChapter,
      totalModules: C.totalChapters,
    }).catch(() => {});

    if (C.status === 'running' && groqApiKey) {
      await waitForBody();
      await addOverlay('Resuming...');
      resumeOrStart().catch(err => { console.error('[CA-LI] auto-resume error:', err); C.status = 'error'; save(); });
    } else if (C.status === 'running') { C.status = 'paused'; await save(); }

    urlCheckTimer = setInterval(checkUrlChange, 2000);
    window.addEventListener('popstate', checkUrlChange);
  })();
})();
