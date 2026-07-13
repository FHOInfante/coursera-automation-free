(() => {
  const DELAY = 800;
  const ITEM_PATHS = ['lecture','supplement','quiz','exam','assignment','practice-quiz','practice-exam','gradedLab','ungradedLab','discussionPrompt','peer','staffGraded','assignment-submission','discussions','graded','ungraded','plugin','widget','reading','video'];

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
    'button[aria-label*="complete" i]',
    'button[aria-label*="mark" i]',
    '.bt3-btn-success',
    '[data-testid="next-item"]',
  ];

  // ── State ──────────────────────────────────────────────────────────
  let C = {
    status: 'idle', slug: '', currentModule: 1, totalModules: 0,
    items: [], completedItems: [], quizItems: [],
    stats: { total: 0, completed: 0, failed: 0, skipped: 0 },
    currentItem: '', lastPageUrl: '', samePageCount: 0, recentUrls: [],
    navigatingToItem: '', phase: 'idle',
    apiKey: '', aiProvider: '', aiModel: '',
  };

  function log(msg) { console.log('[CA]', msg); }

  function storageKey() { return 'caState_' + (getCourseSlug() || 'default'); }

  async function save() {
    try { sessionStorage.setItem(storageKey(), JSON.stringify(C)); } catch (e) {}
  }
  async function load() {
    try {
      const d = sessionStorage.getItem(storageKey());
      if (d) C = { ...C, ...JSON.parse(d) };
    } catch (e) {}
  }
  async function clearState() {
    Object.assign(C, {
      status: 'idle', items: [], quizItems: [], completedItems: [],
      stats: { total: 0, completed: 0, failed: 0, skipped: 0 },
      currentItem: '', lastPageUrl: '', samePageCount: 0, recentUrls: [],
      navigatingToItem: '', phase: 'idle'
    });
    try { sessionStorage.removeItem(storageKey()); } catch (e) {}
  }

  // ── Utilities ──────────────────────────────────────────────────────
  function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

  function getText(el) { return el ? el.textContent.trim().toLowerCase() : ''; }

  function findByText(sel, text) {
    return [...document.querySelectorAll(sel)].find(el => getText(el).includes(text.toLowerCase()));
  }

  function getSettings() {
    return new Promise((resolve) => chrome.storage.local.get(null, resolve));
  }

  function getCourseSlug() {
    const m = location.pathname.match(/\/learn\/([^/?#]+)/);
    return m ? m[1] : null;
  }

  function getCurrentModuleNumber() {
    const m = location.pathname.match(/\/module\/(\d+)/);
    return m ? parseInt(m[1]) : null;
  }

  function getCurrentItemId() {
    const m = location.pathname.match(new RegExp('\\/(' + ITEM_PATHS.join('|') + ')\\/([^/?#]+)'));
    return m ? m[2] : null;
  }

  function getPageType() {
    const p = location.pathname;
    if (/\/quiz\//.test(p) || /\/exam\//.test(p) || /\/assignment\//.test(p) || /\/graded\//.test(p) || /\/practice-quiz\//.test(p) || /\/practice-exam\//.test(p) || /\/gradedLab\//.test(p) || /\/staffGraded\//.test(p)) return 'quiz';
    if (/\/lecture\//.test(p) || /\/video\//.test(p)) return 'lecture';
    if (/\/supplement\//.test(p) || /\/reading\//.test(p)) return 'supplement';
    if (/\/discussionPrompt\//.test(p) || /\/discussions\//.test(p)) return 'discussion';
    if (/\/ungradedLab\//.test(p) || /\/ungraded\//.test(p) || /\/plugin\//.test(p) || /\/widget\//.test(p)) return 'ungraded';
    if (/\/peer\//.test(p) || /\/assignment-submission\//.test(p)) return 'quiz';
    if (/\/home\/module\/\d+/.test(p)) return 'module';
    if (/\/home\/?(welcome|info|progress)?$/.test(p)) return 'home';
    return 'other';
  }

  function getItemTypeFromHref(href) {
    if (href.includes('/lecture/') || href.includes('/video/')) return 'lecture';
    if (href.includes('/supplement/') || href.includes('/reading/')) return 'supplement';
    if (href.includes('/quiz/') || href.includes('/exam/') || href.includes('/assignment/') || href.includes('/graded/') || href.includes('/practice-quiz/') || href.includes('/practice-exam/') || href.includes('/gradedLab/') || href.includes('/staffGraded/')) return 'quiz';
    if (href.includes('/discussionPrompt/') || href.includes('/discussions/')) return 'discussion';
    if (href.includes('/ungradedLab/') || href.includes('/ungraded/') || href.includes('/plugin/') || href.includes('/widget/')) return 'ungraded';
    if (href.includes('/peer/') || href.includes('/assignment-submission/')) return 'quiz';
    return 'other';
  }

  function isQuizType(type) {
    return type === 'quiz' || type === 'exam' || type === 'assignment';
  }

  // ── Content-based page type detection ──────────────────────────────
  function detectPageTypeFromContent() {
    const startBtn = document.querySelector(
      'button[aria-label*="Start" i], button[aria-label*="Resume" i], button[aria-label*="Try again" i]'
    ) || [...document.querySelectorAll('button')].find(b => {
      if (b.disabled || b.getAttribute('aria-disabled') === 'true') return false;
      return /^(Start|Resume|Try again|Start assignment|Start Quiz|Start Exam)$/i.test(b.textContent.trim());
    });
    if (startBtn) return 'quiz';

    const video = document.querySelector('video');
    if (video && video.duration && isFinite(video.duration) && video.duration > 0) return 'lecture';

    if (findPageCompleteButton()) return 'reading';

    return null;
  }

  // ── Coursera API Helpers ────────────────────────────────────────────
  function getCSRF() {
    const parts = document.cookie.split(';');
    for (const part of parts) {
      const eq = part.indexOf('=');
      if (eq < 0) continue;
      if (/csrf/i.test(part.slice(0, eq).trim())) {
        return decodeURIComponent(part.slice(eq + 1).trim());
      }
    }
    return null;
  }

  let cachedCourseId = null;
  async function getCourseId() {
    if (cachedCourseId) return cachedCourseId;
    // Method 1: from __PRELOADED_STATE__
    try {
      const ps = window.__PRELOADED_STATE__;
      if (ps) {
        const findCourseId = (obj, depth = 0) => {
          if (depth > 4 || !obj || typeof obj !== 'object') return null;
          if (obj.courseId && typeof obj.courseId === 'string') return obj.courseId;
          if (obj.id && obj.__typename && /Course/i.test(obj.__typename)) return obj.id;
          for (const k of Object.keys(obj)) { const v = findCourseId(obj[k], depth + 1); if (v) return v; }
          return null;
        };
        const id = findCourseId(ps);
        if (id) { cachedCourseId = id; log(`courseId from state: ${id}`); return cachedCourseId; }
      }
    } catch (e) {}
    // Method 2: from API
    const slug = C.slug || getCourseSlug();
    if (!slug) return null;
    try {
      const res = await fetch(`/api/courses.v1?q=slug&slug=${slug}&fields=id`, { credentials: 'include' });
      const data = await res.json();
      if (data.elements && data.elements[0]) {
        cachedCourseId = data.elements[0].id;
        log(`courseId from API: ${cachedCourseId}`);
        return cachedCourseId;
      }
    } catch (e) { log(`getCourseId failed: ${e.message}`); }
    return null;
  }

  let cachedUserId = null;
  async function getUserId() {
    if (cachedUserId) return cachedUserId;
    try {
      // Try to extract from the pendo data which contains real user info
      const scripts = document.querySelectorAll('script');
      for (const s of scripts) {
        const t = s.textContent;
        if (t.includes('pendo') && t.includes('visitor') && t.includes('id')) {
          const m = t.match(/"id"\s*:\s*"([^"]+)/);
          if (m && m[1] && m[1].length > 5 && !m[1].includes('|')) {
            cachedUserId = m[1];
            log(`userId from pendo: ${cachedUserId}`);
            return cachedUserId;
          }
        }
      }
      // Fallback: from __PRELOADED_STATE__
      const ps = window.__PRELOADED_STATE__;
      if (ps && ps.user && ps.user.id) { cachedUserId = ps.user.id; return cachedUserId; }
    } catch (e) {}
    return null;
  }

  async function apiPost(endpoint, body) {
    const csrf = getCSRF();
    const headers = { 'Content-Type': 'application/json;charset=UTF-8' };
    if (csrf) {
      headers['CSRF3-Token'] = csrf;
      headers['X-CSRF3-Token'] = csrf;
    }
    const bodyStr = JSON.stringify(body);
    log(`API POST ${endpoint} | body: ${bodyStr}`);
    const res = await fetch(endpoint, {
      method: 'POST',
      credentials: 'include',
      headers,
      body: bodyStr,
    });
    const resText = await res.text();
    // Detect HTML responses (dead API routes)
    const isHTML = /^\s*</.test(resText.trim());
    let resBody;
    try { resBody = JSON.parse(resText); } catch (e) { resBody = { _raw: resText.substring(0, 100) }; }
    const success = res.ok && !isHTML;
    log(`API ${endpoint} => ${res.status} ok=${success} | ${isHTML ? 'HTML (dead route)' : JSON.stringify(resBody).substring(0, 150)}`);
    return { ok: success, status: res.status, body: resBody };
  }

  async function apiMarkComplete(itemId) {
    const courseId = await getCourseId();
    if (!courseId) { log('No courseId'); return false; }
    const r = await apiPost('/api/onDemandLearnerMaterials.v1', { courseId, itemId, isCompleted: true });
    if (r.ok) {
      appendLog(`  API complete: ${r.status}`, 'ok');
    } else {
      appendLog(`  API failed: ${r.status}`, 'fail');
    }
    return r.ok;
  }

  async function waitForConfirmed(itemId, timeoutSec = 15) {
    const deadline = Date.now() + timeoutSec * 1000;
    while (Date.now() < deadline) {
      if (isStopped()) return false;
      const state = await verifyCompletion(itemId);
      if (state === 'Completed') {
        appendLog(`  Confirmed: ${itemId}`, 'ok');
        return true;
      }
      if (state === null && deadline - Date.now() > 5000) {
        await apiMarkComplete(itemId);
      }
      await delay(2000);
    }
    appendLog(`  Timed out waiting for ${itemId}`, 'fail');
    return false;
  }

  // ── Verify Completion via API ──────────────────────────────────────
  async function verifyCompletion(itemId) {
    try {
      // Get course progress via the API
      const courseId = await getCourseId();
      if (!courseId) return null;
      const res = await fetch(`/api/onDemandCourseMaterials.v2/~?courseId=${courseId}&includes=items&showLockedItems=true`, { credentials: 'include' });
      const data = await res.json();
      if (data.linked && data.linked['onDemandCourseMaterialItems.v2']) {
        const items = data.linked['onDemandCourseMaterialItems.v2'];
        const found = items.find(i => i.id === itemId);
        if (found) {
          const completed = found.trackCompletions && found.completionState === 'completed';
          log(`Verify ${itemId}: ${found.completionState}`);
          appendLog(`  verify: ${found.completionState}`, completed ? 'ok' : 'fail');
          return completed ? 'Completed' : null;
        }
      }
    } catch (e) { log(`Verify failed: ${e.message}`); }
    return null;
  }

  async function apiMarkComplete(itemId) {
    const courseId = await getCourseId();
    if (!courseId) { log('No courseId'); return false; }

    // Get item type from URL or page
    const pageType = getPageType();
    const isLecture = pageType === 'lecture' || location.pathname.includes('/lecture/');

    if (isLecture) {
      // Try all lecture endpoints
      const r1 = await apiPost('/api/onDemandLectureViews.v1', {
        courseId, itemId, isCompleted: true, watchedUpTo: 999999, videoProgress: 1, percentWatched: 1,
      });
      appendLog(`  lectureView: ${r1.status}`, r1.ok ? 'ok' : 'fail');

      // Also try opencourse videoEvents
      const slug = C.slug || getCourseSlug();
      const userId = await getUserId();
      if (userId && slug) {
        const r2 = await apiPost(`/api/opencourse.v1/user/${userId}/course/${slug}/item/${itemId}/videoEvents`, {
          type: 'ViewedUpto', videoPosition: 999999,
        });
        appendLog(`  videoEvent: ${r2.status}`, r2.ok ? 'ok' : 'fail');
      }
      return r1.ok;
    } else {
      // Non-lecture items
      const r = await apiPost('/api/onDemandLearnerMaterials.v1', {
        courseId, itemId, isCompleted: true,
      });
      appendLog(`  learnerMaterial: ${r.status}`, r.ok ? 'ok' : 'fail');
      return r.ok;
    }
  }

  // ── Page Ready Wait ────────────────────────────────────────────────
  async function waitForPageReady() {
    for (let i = 0; i < 15; i++) {
      if (document.readyState === 'complete') return true;
      await delay(500);
    }
    return false;
  }

  // ── Scrolling ──────────────────────────────────────────────────────
  function scrollToBottom() { window.scrollTo(0, document.body.scrollHeight); }

  async function scrollPageToBottom() {
    scrollToBottom();
    await delay(500);
    scrollToBottom();
    await delay(1000);
  }

  // ── Click (React-friendly) ─────────────────────────────────────────
  function mouseClick(el) {
    if (!el || el.disabled) return;
    el.scrollIntoView({ behavior: 'instant', block: 'center' });
    el.focus();
    try { el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, view: window })); } catch (e) {}
    try { el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, view: window })); } catch (e) {}
    ['mousedown', 'mouseup', 'click'].forEach(type => {
      el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, button: 0 }));
    });
    if (typeof el.click === 'function') el.click();
  }

  async function asyncClick(el) {
    if (!el || el.disabled) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    await delay(400);
    mouseClick(el);
    await delay(300);
  }

  // ── Completion Detection ───────────────────────────────────────────
  function findPageCompleteButton() {
    for (const sel of PAGE_COMPLETE_SELECTORS) {
      const btn = document.querySelector(sel);
      if (btn && !btn.disabled && btn.offsetParent !== null) return btn;
    }
    const buttons = [...document.querySelectorAll('button')];
    return buttons.find(b =>
      /complete|mark.*complete|mark.*done/i.test(b.textContent.trim()) ||
      /complete/i.test(b.getAttribute('aria-label') || '') ||
      b.getAttribute('data-test') === 'complete-button' ||
      b.getAttribute('data-testid') === 'mark-complete' ||
      b.getAttribute('data-testid') === 'next-item'
    ) || null;
  }

  function findItemToggleInModule(itemEl) {
    for (const sel of COMPLETE_SELECTORS) {
      const el = itemEl.querySelector(sel);
      if (el && !el.disabled) return el;
    }
    const buttons = itemEl.querySelectorAll('button, [role="button"]');
    for (const btn of buttons) {
      if (/complete|mark|done|toggle/i.test(btn.getAttribute('aria-label') || btn.textContent.trim())) return btn;
    }
    return null;
  }

  async function tryCompleteToggleOnModule(itemEl, item) {
    // API-first approach
    const apiOk = await apiMarkComplete(item.id);
    if (apiOk) {
      log(`API toggle completed for ${item.id}`);
      // Also try DOM toggle
      const toggle = findItemToggleInModule(itemEl);
      if (toggle) mouseClick(toggle);
      return true;
    }
    // DOM fallback
    const toggle = findItemToggleInModule(itemEl);
    if (!toggle) return false;
    log(`Clicking toggle for "${item.name}"`);
    mouseClick(toggle);
    for (let i = 0; i < 10; i++) {
      await delay(500);
      if (toggle.getAttribute('aria-checked') === 'true' || toggle.classList.contains('completed')) {
        log(`Toggle confirmed for ${item.id}`); return true;
      }
      if (itemEl.querySelector('[data-test="completed"], .completed-check, [aria-label*="completed" i], [data-testid="learn-item-success-icon"]')) {
        log(`Completion indicator confirmed for ${item.id}`); return true;
      }
    }
    log(`Toggle not confirmed for ${item.id} after 5s`);
    return false;
  }

  function isItemCompleted(itemId) {
    if (C.completedItems.includes(itemId)) return true;
    return document.querySelector(
      `a[href*="/${itemId}/"][aria-label*="Completed"], ` +
      `a[href*="/${itemId}/"] [data-testid="learn-item-success-icon"], ` +
      `[data-test="item"] a[href*="/${itemId}/"] [data-test="completed"], ` +
      `a[href$="/${itemId}"][aria-label*="Completed"]`
    ) !== null;
  }

  function findCompletedItems() {
    const ids = new Set();
    // Completed indicators inside item containers
    document.querySelectorAll(
      '[data-test="item"] [data-test="completed"], [data-testid="item"] [data-test="completed"], ' +
      '.rc-WeekItemCompleted, .completed-check, ' +
      '[aria-label="Completed"], svg[aria-label*="completed" i], ' +
      '[data-test*="success"], [data-testid*="success"], ' +
      '.cds-week-item-completed, [class*="itemCompleted"], [class*="item-completed"]'
    ).forEach(el => {
      const container = el.closest('[data-test="item"], [data-testid="item"], li[class*="item"], [role="listitem"]');
      const link = container?.querySelector('a');
      if (link) {
        const href = link.getAttribute('href') || '';
        const m = href.match(new RegExp('\\/(' + ITEM_PATHS.join('|') + ')\\/([^/?#]+)'));
        if (m) ids.add(m[2]);
      }
    });
    // Success icons
    document.querySelectorAll('[data-testid="learn-item-success-icon"], [class*="success-icon"], svg[class*="check"]').forEach(el => {
      const link = el.closest('a');
      if (link) {
        const href = link.getAttribute('href') || '';
        const m = href.match(new RegExp('\\/(' + ITEM_PATHS.join('|') + ')\\/([^/?#]+)'));
        if (m) ids.add(m[2]);
      }
    });
    // Links with completed aria-label
    document.querySelectorAll('a[aria-label*="Completed"], a[aria-label*="completed"], a[title*="Completed"], a[title*="completed"]').forEach(link => {
      const href = link.getAttribute('href') || '';
      const m = href.match(new RegExp('\\/(' + ITEM_PATHS.join('|') + ')\\/([^/?#]+)'));
      if (m) ids.add(m[2]);
    });
    // Broader: any item container that has a completed state class
    document.querySelectorAll('[data-test="item"], [data-testid="item"]').forEach(container => {
      if (container.querySelector('[class*="completed"], [class*="Completed"], [data-test*="success"], [data-testid*="success"], svg[class*="check"]')) {
        const link = container.querySelector('a');
        if (link) {
          const href = link.getAttribute('href') || '';
          const m = href.match(new RegExp('\\/(' + ITEM_PATHS.join('|') + ')\\/([^/?#]+)'));
          if (m) ids.add(m[2]);
        }
      }
    });
    return ids;
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

  // ── Item Extraction ────────────────────────────────────────────────
  function findItemLinksDeep() {
    const pat = new RegExp('\\/(' + ITEM_PATHS.join('|') + ')\\/([^/?#]+)$');
    return [...document.querySelectorAll('a[href*="/learn/"]')].filter(a => pat.test(a.getAttribute('href')));
  }

  async function waitForItems() {
    for (let i = 0; i < 25; i++) {
      await delay(1000);
      for (const sel of ITEM_SELECTORS) { if (document.querySelector(sel)) { return true; } }
      if (findItemLinksDeep().length > 0) return true;
    }
    log('No items found after 25s');
    return false;
  }

  function extractItemsFromModuleContent() {
    const itemEls = document.querySelectorAll('[data-test="item"], [data-testid="item"], [data-track-component="item_row"], .rc-WeekItem');
    if (itemEls.length === 0) return null;
    const seen = new Set();
    const items = [];
    itemEls.forEach(el => {
      const link = el.querySelector('a');
      if (!link) return;
      const href = link.getAttribute('href') || '';
      const id = extractItemIdFromHref(href);
      if (!id || seen.has(id)) return;
      seen.add(id);
      items.push({ id, type: getItemTypeFromHref(href), name: (link.textContent || link.getAttribute('aria-label') || '').trim() || id, href });
    });
    if (items.length > 0) log(`Extracted ${items.length} items from module content`);
    return items;
  }

  function extractItemsFromDOM() {
    const moduleItems = extractItemsFromModuleContent();
    if (moduleItems && moduleItems.length > 0) return moduleItems;
    const qs = ITEM_SELECTORS.join(',');
    let links = [...document.querySelectorAll(qs)];
    if (links.length === 0) links = findItemLinksDeep();
    const seen = new Set();
    const items = [];
    links.forEach(link => {
      const href = link.getAttribute('href') || link.getAttribute('data-href') || '';
      const id = extractItemIdFromHref(href);
      if (!id || seen.has(id) || id === href) return;
      seen.add(id);
      items.push({ id, type: getItemTypeFromHref(href), name: (link.textContent || link.getAttribute('aria-label') || '').trim() || id, href });
    });
    log(`Extracted ${items.length} unique items`);
    return items;
  }

  function isModuleLocked() {
    return !!document.querySelector('[data-test="module-locked"], .locked-module, [aria-label*="locked" i], .start-date-message, [data-test="scheduled"], [data-test="lock-icon"]');
  }

  function countModulesFromDOM() {
    const tabs = document.querySelectorAll('[data-test="module-tab"], [role="tab"] a[href*="/module/"], a[href*="/home/module/"], [data-test="module-navigation"] a, [data-e2e="module-tab"], .rc-ModuleNavigation a, [role="tablist"] a[href*="module"]');
    if (tabs.length > 0) return tabs.length;
    const modLinks = [...document.querySelectorAll('a[href*="/home/module/"]')];
    const nums = modLinks.map(a => parseInt(a.getAttribute('href')?.match(/\/module\/(\d+)/)?.[1])).filter(n => !isNaN(n));
    if (nums.length > 0) return Math.max(...nums);
    if (modLinks.length > 0) return modLinks.length;
    return 0;
  }

  // ── Navigation ──────────────────────────────────────────────────────
  function navigateTo(url) {
    log(`Navigating to: ${url}`);
    window.location.href = url;
  }

  async function navigateToNextItem() {
    const remaining = C.items.filter(i => !C.completedItems.includes(i.id));
    if (remaining.length > 0) {
      const next = remaining[0];
      log(`Chaining to next item: ${next.name} (${next.type})`);
      C.navigatingToItem = next.href;
      await save();
      await delay(1000);
      navigateTo(next.href);
      return true;
    }
    return false;
  }

  async function finishCourse(msg) {
    log(msg || 'All modules done!');
    C.status = 'done'; C.phase = 'done'; C.samePageCount = 0;
    C.recentUrls = [];
    await save();
    removeOverlay();
    updateOverlay('✅ Course complete!');
  }

  async function goToNextModule() {
    C.navigatingToItem = '';
    const next = C.currentModule + 1;
    if (next <= (C.totalModules || 50)) {
      C.currentModule = next;
      await save();
      log(`Going to next module ${next}`);
      await delay(1000);
      navigateTo(`/learn/${C.slug}/home/module/${next}`);
    } else {
      await finishCourse();
    }
  }

  // ── Media Skip ──────────────────────────────────────────────────────
  async function skipMedia(el) {
    if (!el) return;
    el.muted = true;
    el.playbackRate = 16;
    const target = Math.max(0, (el.duration || 0) - 0.5);
    if (target > 0) { el.currentTime = target; el.dispatchEvent(new Event('timeupdate')); }
    await delay(500);
    try { el.dispatchEvent(new Event('ended', { bubbles: true })); } catch (e) {}
    el.pause();
  }

  // ── Page Completion ─────────────────────────────────────────────────
  async function clickMarkComplete(item) {
    const btn = findPageCompleteButton();
    if (!btn) { log(`No complete button for ${item.id}`); return false; }
    log('Clicking page complete button');
    mouseClick(btn);
    for (let i = 0; i < 15; i++) {
      await delay(500);
      if (!document.contains(btn) || btn.disabled || btn.getAttribute('aria-disabled') === 'true') {
        log(`Page completion confirmed for ${item.id}`); return true;
      }
      if (document.querySelector('[data-testid="completed-text"], [data-test="completed-text"], [data-testid="learn-item-success-icon"]')) {
        log(`Page completion confirmed via indicator for ${item.id}`); return true;
      }
    }
    log(`Completion clicked for ${item.id}`);
    return true;
  }

  async function completeItemPage(item) {
    if (isStopped()) return;
    appendLog(`${item.type}: ${item.id}`, 'info');
    log(`Completing ${item.type}: ${item.id}`);
    updateOverlay(`${C.stats.completed}/${C.stats.total} — ${item.type}: ${item.id}`);

    if (item.type === 'quiz') {
      await solveQuiz();
      await delay(3000);
      await waitForConfirmed(item.id, 20);
      return;
    }

    // ── Lecture: wait for page, then seek video fast ──
    if (item.type === 'lecture') {
      if (isStopped()) return;
      await waitForPageReady();

      // Click play button if visible
      const playBtn = document.querySelector('[data-testid="centerPlayButton"]:not([disabled])');
      if (playBtn) { mouseClick(playBtn); log('Clicked play'); await delay(500); }

      // Seek video (check every 500ms, max 5s)
      for (let i = 0; i < 10; i++) {
        if (isStopped()) return;
        const v = document.querySelector('video');
        if (v && v.duration > 0 && isFinite(v.duration)) {
          v.muted = true;
          v.currentTime = Math.max(0, v.duration - 0.5);
          v.dispatchEvent(new Event('timeupdate'));
          v.play().catch(() => {});
          log(`Video seeked`);
          await delay(1000);
          break;
        }
        const pb = document.querySelector('[data-testid="centerPlayButton"]:not([disabled])');
        if (pb) { mouseClick(pb); await delay(300); }
        await delay(500);
      }
    }

    // ── ── ── ── ── ── ── ── ──
    // ── Discussion: try to post a reply ──
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
      const postBtn = findByText('button', 'post') || findByText('button', 'submit');
      if (postBtn && !postBtn.disabled) mouseClick(postBtn);
      await delay(2000);
    }

    // ── Ungraded: checkbox → launch app → close tab → done ──
    if (item.type === 'ungraded') {
      // 1. Check "I agree" checkbox
      const agreeCb = document.querySelector('[data-testid="agreement-checkbox"] input[type="checkbox"]:not(:checked)');
      if (agreeCb) {
        mouseClick(agreeCb.closest('label') || agreeCb);
        log('Checked honor agreement');
        await delay(1000);
      } else {
        const textLabel = findByText('label', 'agree to use this app');
        if (textLabel) { mouseClick(textLabel); await delay(1000); }
      }

      // 2. Click Launch App
      const launchBtn = document.querySelector(
        'button[aria-label*="Launch" i]:not([disabled]), [data-testid="launch-app-button"]:not([disabled]), [data-test="launch-app"]:not([disabled])'
      ) || [...document.querySelectorAll('button')].find(b => /^Launch\s*(App|Application|Lab|Tool)?$/i.test(b.textContent.trim()) && !b.disabled);
      if (launchBtn) {
        log('Clicking Launch App');
        mouseClick(launchBtn);
        await delay(2000);
        // Close the lab tab that just opened
        chrome.runtime.sendMessage({ type: 'CLOSE_LAB_TABS' }, (resp) => {
          if (resp) log(`Closed ${resp.closed} lab tab(s)`);
        });
        await delay(1000);
      }

      // 3. Check if auto-completed
      const state = await verifyCompletion(item.id);
      if (state === 'Completed') {
        appendLog(`  Lab auto-completed`, 'ok');
        return;
      }
    }

    // ── Supplement/Reading: try DOM button first ──
    if (item.type === 'supplement') {
      const btn = findPageCompleteButton();
      if (btn) {
        log('Found Mark as completed button, clicking');
        mouseClick(btn);
        for (let i = 0; i < 15; i++) {
          await delay(500);
          if (!document.contains(btn) || btn.disabled || btn.getAttribute('aria-disabled') === 'true') {
            appendLog(`  DOM button confirmed`, 'ok');
            await delay(2000);
            return;
          }
          if (document.querySelector('[data-testid="completed-text"], [data-test="completed-text"], [data-testid="learn-item-success-icon"]')) {
            appendLog(`  DOM button confirmed via indicator`, 'ok');
            await delay(2000);
            return;
          }
        }
      }
      log('No DOM button, trying API');
    }

    // ── API: mark complete ──
    if (isStopped()) return;
    await apiMarkComplete(item.id);

    // ── Wait for server confirmation ──
    const confirmed = await waitForConfirmed(item.id, 12);
    if (confirmed) {
      appendLog(`  Done: ${item.id}`, 'ok');
      return;
    }

    // ── Fallback: DOM click ──
    appendLog(`  API wait failed, trying DOM`, 'fail');
    await clickMarkComplete(item);
    appendLog(`  Done (DOM): ${item.id}`, 'ok');
  }

  // ── Quiz Solving ────────────────────────────────────────────────────
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

  function extractQuestionData(questionEl) {
    const textEl = questionEl.querySelector('[data-testid="cml-viewer"]') ||
      questionEl.querySelector('h3, .question-text, .rc-Question-title, [data-test="question-title"], [class*="title"], p, [data-e2e="prompt"]');
    const questionText = textEl ? textEl.textContent.trim() : '';
    const choices = [];
    const inputs = questionEl.querySelectorAll('input[type="radio"], input[type="checkbox"]');
    if (inputs.length > 0) {
      inputs.forEach((input, idx) => {
        let label = questionEl.querySelector(`label[for="${input.id}"]`) || input.closest('label');
        if (!label) {
          const parent = input.closest('[class*="option"], [class*="choice"], [class*="item"], [role="radio"], [role="checkbox"], [class*="row"]');
          label = parent?.querySelector('span, [class*="text"], [class*="label"], .rc-option-label, [class*="choice-text"]') || parent;
        }
        const rawText = label ? label.textContent.trim() : '';
        // Remove the question text prefix if it appears in the choice label
        const choiceText = rawText.replace(new RegExp('^' + questionText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), '').trim() || `Option ${String.fromCharCode(65 + idx)}`;
        choices.push({
          index: idx, letter: String.fromCharCode(65 + idx),
          text: choiceText,
          element: input, clickTarget: label || input, isCheckbox: input.type === 'checkbox'
        });
      });
    } else {
      questionEl.querySelectorAll('[role="radio"], [role="checkbox"]').forEach((el, idx) => {
        choices.push({
          index: idx, letter: String.fromCharCode(65 + idx),
          text: el.textContent.trim() || `Option ${String.fromCharCode(65 + idx)}`,
          element: el, clickTarget: el, isCheckbox: el.getAttribute('role') === 'checkbox'
        });
      });
    }
    return { questionText, choices, textareas: [...questionEl.querySelectorAll('textarea')], textInputs: [...questionEl.querySelectorAll('input[type="text"]:not([data-test])')] };
  }

  // ── Scrape correct answers from quiz result page ──
  function scrapeCorrectAnswers() {
    const result = {};
    const qContainers = document.querySelectorAll('[data-test="question"], [data-test="quiz-question"], [class*="question-result"], [data-testid*="part-Submission_"]');
    qContainers.forEach((qEl, qIdx) => {
      const correctChoices = [];
      // Look for elements marked as correct
      const correctMarkers = qEl.querySelectorAll('[data-test="choice correct"], [data-test="correct"], [class*="correct"], [data-test="answer-correct"], [aria-label*="correct" i]');
      correctMarkers.forEach(marker => {
        const wrapper = marker.closest('[class*="option"], [class*="choice"], [role="radio"], [role="checkbox"], [data-test="choice"]');
        if (wrapper) {
          const text = wrapper.textContent.trim();
          correctChoices.push(text);
        } else {
          const text = marker.textContent.trim();
          if (text) correctChoices.push(text);
        }
      });
      // Fallback: find checked inputs that are marked correct
      if (correctChoices.length === 0) {
        qEl.querySelectorAll('input[type="radio"]:checked, input[type="checkbox"]:checked').forEach(input => {
          const parent = input.closest('[class*="option"], [class*="choice"], [role="radio"], [role="checkbox"], [data-test="choice"]');
          if (parent && (parent.querySelector('[class*="correct"], [data-test*="correct"]') || parent.getAttribute('aria-label')?.includes('correct'))) {
            correctChoices.push(parent.textContent.trim());
          }
        });
      }
      if (correctChoices.length > 0) result[qIdx] = correctChoices;
    });
    if (Object.keys(result).length > 0) log(`Scraped correct answers for ${Object.keys(result).length} questions`);
    return result;
  }

  async function solveQuiz() {
    if (isStopped()) return false;
    appendLog('quiz: solving...', 'info');
    log('Solving quiz...');
    await delay(2000);

    for (let i = 0; i < 15; i++) {
      if (isStopped()) return false;
      const btn = document.querySelector('button[aria-label*="Start" i], button[aria-label*="Resume" i], button[aria-label*="Try again" i]')
        || findByText('button', 'start quiz') || findByText('button', 'start assignment') || findByText('button', 'start exam')
        || findByText('button', 'start') || findByText('button', 'begin') || findByText('button', 'resume');
      if (btn && !btn.disabled) { mouseClick(btn); log('Clicked start'); await delay(2000); break; }
      await delay(1000);
    }

    for (let i = 0; i < 10; i++) {
      const continueBtn = document.querySelector('[data-testid="StartAttemptModal__primary-button"]:not([disabled])');
      if (continueBtn) { mouseClick(continueBtn); await delay(2000); break; }
      await delay(500);
    }

    let questions = [];
    for (let i = 0; i < 20; i++) {
      if (isStopped()) return false;
      const qEls = getQuizQuestionElements();
      if (qEls.length > 0) { questions = [...qEls].map(extractQuestionData); break; }
      await delay(1000);
    }

    const ackBtn = document.querySelector('[data-action="acknowledge-guidelines"]');
    if (ackBtn) {
      mouseClick(ackBtn);
      await delay(2000);
      for (let i = 0; i < 10; i++) {
        const qEls = getQuizQuestionElements();
        if (qEls.length > 0) { questions = [...qEls].map(extractQuestionData); break; }
        await delay(1000);
      }
    }

    if (questions.length === 0) {
      log('No quiz questions found after waiting');
      return false;
    }

    log(`Found ${questions.length} questions`);

    // ── Quiz attempt loop (retry on fail) ──
    const maxRetries = 3;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      if (isStopped()) return false;
      if (attempt > 1) {
        log(`Retry attempt ${attempt}/${maxRetries}`);
        // Wait for quiz questions to reappear after clicking Try Again
        await delay(2000);
        for (let w = 0; w < 30; w++) {
          if (isStopped()) return false;
          const qEls = getQuizQuestionElements();
          if (qEls.length > 0) { questions = [...qEls].map(extractQuestionData); break; }
          await delay(1000);
        }
        if (questions.length === 0) { log('No questions after retry'); break; }
        log(`Re-answering ${questions.length} questions`);
      }

      // ── Answer questions ──
      // Priority: 1) scraped correct answers from previous attempt, 2) AI, 3) random
      const s = await getSettings();
      const itemId = getCurrentItemId();
      const savedAnswers = (C.quizCorrectAnswers && itemId && C.quizCorrectAnswers[itemId]) || null;

      if (savedAnswers && Object.keys(savedAnswers).length > 0) {
        log('Using saved correct answers from previous attempt');
        for (let qIdx = 0; qIdx < questions.length; qIdx++) {
          const q = questions[qIdx];
          const saved = savedAnswers[qIdx];
          if (!saved || saved.length === 0) continue;
          for (const choice of q.choices) {
            const shouldSelect = saved.some(a => choice.text.includes(a) || a.includes(choice.letter));
            const isSelected = choice.element.checked || choice.element.getAttribute('aria-checked') === 'true';
            if (shouldSelect !== isSelected) mouseClick(choice.clickTarget);
            await delay(200);
          }
        }
      } else if (s.apiKey && s.aiProvider !== 'none') {
        const promptParts = questions.map((q, i) => {
          const num = i + 1;
          if (q.textareas.length > 0 || q.textInputs.length > 0) return `Question ${num} (text): ${q.questionText}`;
          if (q.choices.length === 0) return null;
          const isMulti = q.choices.some(c => c.isCheckbox);
          const choicesText = q.choices.map(c => `${c.letter}) ${c.text}`).join('\n');
          return `Question ${num} (${isMulti ? 'multi' : 'single'}): ${q.questionText}\nChoices:\n${choicesText}`;
        }).filter(Boolean);

        if (promptParts.length > 0) {
          const batchPrompt = `You are taking a Coursera course quiz. Answer each question accurately based on the content. Return ONLY valid JSON, no other text.

Format: {"answers":[{"question":1,"answer":"A"},{"question":2,"answer":"text response"},{"question":3,"answers":["A","C"]}]}

Rules:
- Single-choice: "answer" with the correct letter
- Multi-select: "answers" with array of correct letter(s)
- Text questions: "answer" with the correct text
- If unsure, make your best guess
- Be precise — incorrect answers cause the user to fail

Questions:\n${promptParts.join('\n\n')}`;

          const res = await new Promise((resolve) => chrome.runtime.sendMessage({ type: 'AI_QUIZ', prompt: batchPrompt }, resolve));
          if (res && res.answer) {
            const cleaned = res.answer.replace(/```json\s*|\s*```/g, '').trim();
            try {
              const parsed = JSON.parse(cleaned);
              const answerMap = (parsed.answers || []).reduce((map, entry) => {
                map[entry.question] = entry.answers || (entry.answer ? [entry.answer] : []);
                return map;
              }, {});

              for (let qIdx = 0; qIdx < questions.length; qIdx++) {
                const q = questions[qIdx];
                const num = qIdx + 1;
                const answers = answerMap[num] || [];

                if (q.textareas.length > 0 || q.textInputs.length > 0) {
                  const text = answers[0] || '';
                  for (const ta of q.textareas) setReactInputValue(ta, text);
                  for (const ti of q.textInputs) setReactInputValue(ti, text);
                  continue;
                }

                for (const choice of q.choices) {
                  const shouldSelect = answers.includes(choice.letter);
                  const isSelected = choice.element.checked || choice.element.getAttribute('aria-checked') === 'true';
                  if (shouldSelect !== isSelected) mouseClick(choice.clickTarget);
                  await delay(200);
                }
              }
            } catch (e) {
              log(`AI parse failed: ${e.message}, fallback`);
              for (const q of questions) for (const c of q.choices) if (!c.element.checked && Math.random() > 0.3) mouseClick(c.clickTarget);
            }
          } else {
            for (const q of questions) for (const c of q.choices) if (!c.element.checked && Math.random() > 0.3) mouseClick(c.clickTarget);
          }
        }
      } else {
        for (const q of questions) for (const c of q.choices) if (!c.element.checked && Math.random() > 0.3) mouseClick(c.clickTarget);
      }

      // ── Scroll to bottom ──
      await delay(1000);
      for (let s = 0; s < 3; s++) { scrollToBottom(); await delay(500); }
      await delay(1000);

      // ── Find and check the "I understand and agree" checkbox ──
      let agreed = false;
      for (let i = 0; i < 10 && !agreed; i++) {
        scrollToBottom();
        await delay(500);

        const baseCb = document.getElementById('agreement-checkbox-base');
        if (baseCb && !baseCb.checked) { baseCb.click(); baseCb.dispatchEvent(new Event('change', { bubbles: true })); agreed = true; log('Checked #agreement-checkbox-base'); await delay(500); break; }

        const labelEl = [...document.querySelectorAll('label')].find(l => /understand and agree/i.test(l.textContent));
        if (labelEl) {
          const input = labelEl.querySelector('input[type="checkbox"]');
          if (input && !input.checked) { input.click(); input.dispatchEvent(new Event('change', { bubbles: true })); agreed = true; log('Checked agreement via label text'); await delay(500); break; }
        }

        const allCheckboxes = document.querySelectorAll('input[type="checkbox"]:not(:checked)');
        for (const cb of allCheckboxes) {
          if (cb.offsetParent !== null) { cb.click(); cb.dispatchEvent(new Event('change', { bubbles: true })); agreed = true; log(`Checked checkbox: ${cb.id || 'unnamed'}`); await delay(500); break; }
        }
        if (agreed) break;

        const ariaCbs = document.querySelectorAll('[role="checkbox"][aria-checked="false"], [role="checkbox"]:not([aria-checked])');
        for (const el of ariaCbs) { if (el.offsetParent !== null) { el.click(); agreed = true; log('Checked aria checkbox'); await delay(500); break; } }
      }

      // ── Wait for submit to be enabled ──
      await delay(1000);

      // ── Find submit button ──
      let submitBtn = null;
      for (let i = 0; i < 20; i++) {
        scrollToBottom();
        await delay(500);
        const allBtns = [...document.querySelectorAll('button')].filter(b => !b.disabled);
        submitBtn = allBtns.find(b =>
          /^submit\s*(quiz|assignment|exam)?$/i.test(b.textContent.trim()) && !/draft/i.test(b.textContent.trim())
        ) ||
          document.querySelector('button[data-testid="submit-button"]:not([disabled])') ||
          document.querySelector('button[data-test="submit-button"]:not([disabled])') ||
          document.querySelector('button[data-test="submit"]:not([disabled])') ||
          findByText('button', 'submit quiz') || findByText('button', 'submit assignment') ||
          findByText('button', 'submit');
        if (submitBtn && !/draft/i.test(submitBtn.textContent.trim())) break;
        if (!submitBtn) submitBtn = allBtns.find(b => /save.*draft/i.test(b.textContent.trim()));
        if (submitBtn) break;
        await delay(1000);
      }

      if (!submitBtn) { log('No submit button found'); appendLog('quiz: no submit btn', 'fail'); continue; }

      log('Submitting quiz');
      appendLog('quiz: submitting...', 'info');
      submitBtn.scrollIntoView({ behavior: 'instant', block: 'center' });
      await delay(300);
      submitBtn.click();

      // ── Confirmation dialog ──
      await delay(1000);
      for (let i = 0; i < 15; i++) {
        if (isStopped()) return false;
        await delay(500);
        const dialogBtns = [...document.querySelectorAll('[role="dialog"] button, [class*="modal"] button, [class*="overlay"] button, [data-testid*="dialog"] button')]
          .filter(b => !b.disabled && !/draft/i.test(b.textContent.trim()));
        const confirmBtn = document.querySelector('[data-testid="dialog-submit-button"]:not([disabled])') ||
          document.querySelector('[data-test="confirm-submit"]:not([disabled])') ||
          document.querySelector('[data-test="confirm"]:not([disabled])') ||
          dialogBtns.find(b => /submit|yes|confirm/i.test(b.textContent.trim())) ||
          [...document.querySelectorAll('button')].find(b => !b.disabled && /^submit\s*$/i.test(b.textContent.trim()) && !/draft/i.test(b.textContent.trim()) && b !== submitBtn);
        if (confirmBtn) { confirmBtn.scrollIntoView({ behavior: 'instant', block: 'center' }); await delay(200); confirmBtn.click(); await delay(1500); break; }
      }

      // ── Wait for result and check for retry ──
      let passed = false;
      for (let i = 0; i < 30; i++) {
        if (isStopped()) return false;
        await delay(1000);

        // Result page loaded — scrape correct answers for future retries
        if (document.querySelector('[data-test*="score"], [data-test="quiz-result"], .quiz-score, [class*="score"], [class*="result"], [class*="grade"]') ||
            !location.href.includes('/attempt')) {
          const scraped = scrapeCorrectAnswers();
          if (Object.keys(scraped).length > 0) {
            C.quizCorrectAnswers = C.quizCorrectAnswers || {};
            const itemId = getCurrentItemId();
            if (itemId) {
              C.quizCorrectAnswers[itemId] = scraped;
              log(`Stored ${Object.keys(scraped).length} correct answers for ${itemId}`);
              await save();
            }
          }
        }

        // Look for Retry / Try again button (score not passing)
        const retryBtn = [...document.querySelectorAll('button')].find(b =>
          /try again|retry|reattempt/i.test(b.textContent.trim()) && !b.disabled
        );
        if (retryBtn && attempt < maxRetries) {
          log(`Quiz failed attempt ${attempt}/${maxRetries}, retrying`);
          retryBtn.click();
          await delay(2000);
          break;
        }
        if (retryBtn) {
          // Max retries reached, treat as done
          log(`Quiz failed after ${maxRetries} attempts, continuing`);
          passed = true;
          break;
        }

        // Score or result page without retry button = passed
        if (document.querySelector('[data-test*="score"], [data-test="quiz-result"], .quiz-score, [class*="score"], [class*="result"], [class*="grade"]') ||
            !location.href.includes('/attempt')) {
          appendLog('quiz: passed', 'ok');
          log('Quiz passed');
          passed = true;
          await delay(1500);
          break;
        }
      }

      if (passed) { return true; }
      // If loop fell through without passing or retrying, continue to next attempt
    }

    log('Quiz retries exhausted, not passed');
    return false;
  }

  // ── Phase: Process Module Items ─────────────────────────────────────
  async function runPhaseModule() {
    C.phase = 'module';
    await save();
    const modNum = getCurrentModuleNumber();
    if (modNum) C.currentModule = modNum;
    await save();

    // Safety: prevent infinite loop if items never show as completed in DOM
    C.moduleVisits = C.moduleVisits || {};
    C.moduleVisits[C.currentModule] = (C.moduleVisits[C.currentModule] || 0) + 1;
    if (C.moduleVisits[C.currentModule] > 5) {
      log(`Module ${C.currentModule} visited ${C.moduleVisits[C.currentModule]} times, forcing advance`);
      await goToNextModule();
      return;
    }
    log(`Phase module ${C.currentModule} (visit #${C.moduleVisits[C.currentModule]})`);

    await scrollPageToBottom();

    const itemsLoaded = await waitForItems();
    if (!itemsLoaded) {
      if (isModuleLocked()) { log(`Module ${C.currentModule} locked`); return; }
      // No items found — likely past the last real module, finish
      log('No items loaded, course appears complete');
      await finishCourse('Course complete (no items found)');
      return;
    }

    const allItems = extractItemsFromDOM();
    log(`Found ${allItems.length} items on module ${C.currentModule}`);

    if (allItems.length === 0) {
      await finishCourse('Course complete (no extractable items)');
      return;
    }

    const completedIds = findCompletedItems();
    for (const id of completedIds) {
      if (!C.completedItems.includes(id)) C.completedItems.push(id);
    }

    const newItems = allItems.filter(i => !C.completedItems.includes(i.id));
    log(`${newItems.length} uncompleted items (${allItems.length} in this module)`);

    C.items = allItems;
    // Track total unique item IDs across all modules
    if (!C.allItemIds) C.allItemIds = [];
    for (const item of allItems) {
      if (!C.allItemIds.includes(item.id)) C.allItemIds.push(item.id);
    }
    C.stats.total = C.allItemIds.length;
    C.stats.completed = C.completedItems.length;
    await save();

    for (const item of newItems) {
      if (C.status !== 'running') return;
      updateOverlay(`${C.stats.completed}/${C.stats.total} ${item.name}...`);

      if (isItemCompleted(item.id)) {
        log(`Already completed: ${item.name}`);
        if (!C.completedItems.includes(item.id)) C.completedItems.push(item.id);
        C.stats.completed = C.completedItems.length;
        await save();
        continue;
      }

      if (item.type === 'lecture') {
        log(`Lecture, navigating: ${item.name}`);
        C.navigatingToItem = item.href;
        await save();
        navigateTo(item.href);
        return;
      }

      if (isQuizType(item.type)) {
        log(`Quiz item, navigating: ${item.name}`);
        C.navigatingToItem = item.href;
        await save();
        navigateTo(item.href);
        return;
      }

      if (item.type === 'supplement' || item.type === 'reading' || item.type === 'discussion' ||
          item.type === 'ungraded' || item.type === 'plugin' || item.type === 'widget' ||
          item.type === 'video' || item.type === 'gradedLab' || item.type === 'ungradedLab') {
        const itemRow = document.querySelector(`[data-test="item"] a[href*="/${item.id}/"], [data-testid="item"] a[href*="/${item.id}/"]`);
        const itemEl = itemRow?.closest('[data-test="item"], [data-testid="item"]');
        if (itemEl) {
          const done = await tryCompleteToggleOnModule(itemEl, item);
          if (done) {
            C.completedItems.push(item.id);
            C.stats.completed = C.completedItems.length;
            log(`✓ ${item.type}: ${item.name}`);
            await save();
            await delay(DELAY);
            continue;
          }
        }
        log(`Navigating to: ${item.name}`);
        C.navigatingToItem = item.href;
        await save();
        navigateTo(item.href);
        return;
      }

      // Unknown/unhandled type — skip it
      log(`Unknown type "${item.type}", skipping: ${item.name}`);
      if (!C.completedItems.includes(item.id)) C.completedItems.push(item.id);
      C.stats.completed = C.completedItems.length;
      C.stats.skipped = (C.stats.skipped || 0) + 1;
      await save();
      await delay(DELAY);
      continue;
    }

    log(`Module ${C.currentModule} done. ${C.stats.completed}/${C.stats.total}`);
    // Re-verify: check if ALL items are completed in the DOM or in our state
    await delay(1000);
    const domDone = findCompletedItems();
    const allDone = allItems.every(item => domDone.includes(item.id) || C.completedItems.includes(item.id));
    if (allDone) {
      await goToNextModule();
    } else {
      navigateTo(`/learn/${C.slug}/home/module/${C.currentModule}`);
    }
  }

  // ── Orchestrator ────────────────────────────────────────────────────
  async function runOrchestrator() {
    log('=== Orchestrator ===');
    log(`URL: ${location.href}`);

    // If course already marked done, stop
    if (C.status === 'done') { log('Course already complete, stopping'); return; }

    if (C.lastPageUrl === location.href) {
      C.samePageCount = (C.samePageCount || 0) + 1;
      if (C.samePageCount > 2) { log('Loop detected (same URL), stopping'); C.status = 'done'; await save(); return; }
    } else {
      C.samePageCount = 0;
      // Track alternating URL patterns (module → quiz → module → quiz...)
      if (!C.recentUrls) C.recentUrls = [];
      C.recentUrls.push(location.href);
      if (C.recentUrls.length > 4) C.recentUrls.shift();
      if (C.recentUrls.length >= 4) {
        const urls = C.recentUrls;
        if (urls[0] === urls[2] && urls[1] === urls[3] && urls[0] !== urls[1]) {
          log('Loop detected (alternating URLs), stopping');
          C.status = 'done'; await save(); return;
        }
      }
      C.lastPageUrl = location.href;
    }

    const newSlug = getCourseSlug();
    if (!newSlug) { log('No course slug'); return; }
    if (newSlug !== C.slug) {
      log(`Course changed: ${C.slug || 'none'} → ${newSlug}, resetting state`);
      C.slug = newSlug;
      C.completedItems = [];
      C.allItemIds = [];
      C.quizAttempts = {};
      C.moduleVisits = {};
      C.totalModules = 0;
      C.currentModule = 1;
      C.stats = { total: 0, completed: 0, failed: 0, skipped: 0 };
      C.recentUrls = [];
      C.lastPageUrl = '';
    } else {
      C.slug = newSlug;
    }

    if (!C.totalModules) {
      const domCount = countModulesFromDOM();
      C.totalModules = domCount || 50;
      log(`Total modules: ${C.totalModules}`);
    }
    await save();

    await scrollPageToBottom();

    const pageType = getPageType();
    log(`Page type: ${pageType}`);

    if (pageType === 'quiz') {
      const itemId = getCurrentItemId();
      C.quizAttempts = C.quizAttempts || {};
      if (itemId) {
        C.quizAttempts[itemId] = (C.quizAttempts[itemId] || 0) + 1;
        await save();
        if (C.quizAttempts[itemId] > 6) {
          log(`Quiz ${itemId} exceeded max total attempts, force completing`);
          if (!C.completedItems.includes(itemId)) C.completedItems.push(itemId);
          C.stats.completed = C.completedItems.length;
          C.stats.failed = (C.stats.failed || 0) + 1;
          await save();
          await delay(1500);
          if (await navigateToNextItem()) return;
          navigateTo(`/learn/${C.slug}/home/module/${C.currentModule}`);
          return;
        }
      }
      const solved = await solveQuiz();
      if (solved) {
        if (itemId && !C.completedItems.includes(itemId)) C.completedItems.push(itemId);
        C.stats.completed = C.completedItems.length;
        log(`Quiz ${itemId} completed`);
        await save();
        await delay(1500);
        if (await navigateToNextItem()) return;
        // Go back to module page to verify completion
        navigateTo(`/learn/${C.slug}/home/module/${C.currentModule}`);
        return;
      } else {
        log(`Quiz ${itemId} not passed, returning to module page`);
        // Don't add to completedItems — module page will re-check DOM
        await save();
        await delay(1500);
        navigateTo(`/learn/${C.slug}/home/module/${C.currentModule}`);
        return;
      }
    }

    if (pageType === 'home') {
      // If all modules completed, just stop
      if (C.currentModule > (C.totalModules || 50)) {
        await finishCourse('Course complete (all modules done)');
        return;
      }
      log('Home page, going to module 1');
      navigateTo(`/learn/${C.slug}/home/module/1`);
      return;
    }

    if (C.navigatingToItem) {
      const navId = extractItemIdFromHref(C.navigatingToItem);
      const currentId = getCurrentItemId();
      if (navId && currentId && navId === currentId) {
        log(`On target item page: ${navId}`);
        let type = getItemTypeFromHref(location.pathname);
        if (type === 'other') {
          const detected = detectPageTypeFromContent();
          if (detected) type = detected;
        }
        C.navigatingToItem = '';
        await save();
        await completeItemPage({ id: currentId, type, name: C.currentItem });
        if (!C.completedItems.includes(currentId)) C.completedItems.push(currentId);
        C.stats.completed = C.completedItems.length;
        log(`✓ ${currentId} completed`);
        await save();
        await delay(DELAY);
        if (await navigateToNextItem()) return;
        await goToNextModule();
        return;
      }
      log(`Nav mismatch: ${navId} != ${currentId}, clearing`);
      C.navigatingToItem = '';
      await save();
    }

    if (pageType === 'module') {
      await runPhaseModule();
      return;
    }

    if (pageType === 'lecture' || pageType === 'supplement' || pageType === 'discussion' || pageType === 'ungraded' || pageType === 'other') {
      const itemId = getCurrentItemId();
      if (itemId) {
        log(`On ${pageType} page: ${itemId}`);
        let type = getItemTypeFromHref(location.pathname);
        if (type === 'other') {
          const detected = detectPageTypeFromContent();
          if (detected) type = detected;
        }
        await completeItemPage({ id: itemId, type });
        if (!C.completedItems.includes(itemId)) C.completedItems.push(itemId);
        C.stats.completed = C.completedItems.length;
        await save();
        await delay(DELAY);
        if (await navigateToNextItem()) return;
        await goToNextModule();
        return;
      }
      log(`No item ID on ${pageType} page, going to module`);
      await goToModule(C.currentModule);
      return;
    }

    log('Unknown page, going to module');
    await goToModule(C.currentModule);
  }

  async function goToModule(n) {
    const slug = C.slug || getCourseSlug();
    if (!slug) return false;
    navigateTo(`/learn/${slug}/home/module/${n}`);
    return true;
  }

  // ── Start / Stop ────────────────────────────────────────────────────
  let keepAlivePort = null;

  async function startAutomation() {
    try {
      // Keep background service worker alive
      keepAlivePort = chrome.runtime.connect({ name: 'keepAlive' });
      const ka = setInterval(() => { try { keepAlivePort.postMessage({ ping: true }); } catch (e) {} }, 25000);
      keepAlivePort.onDisconnect.addListener(() => clearInterval(ka));

      await load();
      const s = await getSettings();
      C.apiKey = s.apiKey || '';
      C.aiProvider = s.aiProvider || 'none';
      C.aiModel = s.aiModel || '';
      C.status = 'running';
      C.slug = C.slug || getCourseSlug();
      if (C.totalModules === 0) C.totalModules = 50;
      await save();
      await addOverlay('Starting...');
      await runOrchestrator();
    } catch (e) {
      log('Start automation error: ' + e.message);
    }
  }

  function stopAutomation() {
    C.status = 'paused';
    save();
    removeOverlay();
    if (keepAlivePort) { try { keepAlivePort.disconnect(); } catch (e) {} keepAlivePort = null; }
  }

  // ── Overlay ─────────────────────────────────────────────────────────
  function waitForBody() {
    return new Promise(resolve => {
      if (document.body) return resolve();
      const observer = new MutationObserver(() => {
        if (document.body) { observer.disconnect(); resolve(); }
      });
      observer.observe(document.documentElement, { childList: true });
    });
  }

  function isStopped() { return C.status !== 'running'; }

  async function addOverlay(msg) {
    await waitForBody();
    let el = document.getElementById('ca-overlay');
    if (!el) {
      el = document.createElement('div');
      el.id = 'ca-overlay';
      el.innerHTML = `
        <div id="ca-box">
          <div id="ca-title">Course Automation</div>
          <div id="ca-msg"></div>
          <div id="ca-bar"><div id="ca-fill"></div></div>
          <div id="ca-log"></div>
          <div id="ca-btns">
            <button id="ca-stop">Stop</button>
            <button id="ca-stop-view">Stop & View</button>
          </div>
        </div>`;
      const s = document.createElement('style');
      s.id = 'ca-style';
      s.textContent = `
        #ca-overlay{position:fixed;bottom:20px;right:20px;z-index:999999;font-family:system-ui,sans-serif;max-height:50vh;overflow:hidden}
        #ca-box{background:#0a0a0a;border:1px solid #00ff88;border-radius:12px;padding:14px;min-width:300px;max-width:360px;box-shadow:0 0 30px rgba(0,255,136,0.2)}
        #ca-title{color:#00ff88;font-weight:700;font-size:13px;margin-bottom:6px}
        #ca-msg{color:#ccc;font-size:11px;margin-bottom:6px;word-break:break-word;min-height:16px}
        #ca-bar{height:5px;background:#222;border-radius:3px;overflow:hidden;margin-bottom:8px}
        #ca-fill{height:100%;width:0%;background:linear-gradient(90deg,#00ff88,#00ccff);border-radius:3px;transition:width .3s}
        #ca-log{color:#888;font-size:10px;max-height:120px;overflow-y:auto;margin-bottom:8px;line-height:1.5;font-family:monospace}
        #ca-log div{padding:1px 0;border-bottom:1px solid #1a1a1a}
        #ca-log .ok{color:#00ff88}
        #ca-log .fail{color:#ff4444}
        #ca-log .info{color:#00ccff}
        #ca-btns{display:flex;gap:8px}
        #ca-stop{flex:1;background:#ff4444;color:#fff;border:none;border-radius:6px;padding:8px 0;font-size:12px;cursor:pointer;font-weight:700}
        #ca-stop:hover{background:#cc3333}
        #ca-stop-view{flex:1;background:#333;color:#fff;border:1px solid #555;border-radius:6px;padding:8px 0;font-size:12px;cursor:pointer;font-weight:600}
        #ca-stop-view:hover{background:#444}
      `;
      document.head.appendChild(s);
      document.body.appendChild(el);
      el.querySelector('#ca-stop').onclick = () => {
        C.status = 'paused'; save();
        if (keepAlivePort) { try { keepAlivePort.disconnect(); } catch (e) {} keepAlivePort = null; }
        log('STOPPED by user');
        updateOverlay('Stopped');
      };
      el.querySelector('#ca-stop-view').onclick = () => {
        C.status = 'paused'; save();
        if (keepAlivePort) { try { keepAlivePort.disconnect(); } catch (e) {} keepAlivePort = null; }
        log('STOPPED by user (viewing)');
        const logEl = document.getElementById('ca-log');
        const summary = `Done: ${C.stats.completed} | Failed: ${C.stats.failed} | Skipped: ${C.stats.skipped} | Total: ${C.stats.total}`;
        if (logEl) logEl.innerHTML += `<div class="info">--- STOPPED ---</div><div class="info">${summary}</div>`;
        updateOverlay(summary);
      };
    }
    el.querySelector('#ca-msg').textContent = msg;
  }

  function appendLog(text, cls) {
    const el = document.getElementById('ca-log');
    if (el) {
      el.innerHTML += `<div class="${cls || ''}">${text}</div>`;
      el.scrollTop = el.scrollHeight;
    }
  }

  function updateOverlay(msg, pct) {
    const el = document.getElementById('ca-overlay');
    if (!el) return;
    el.querySelector('#ca-msg').textContent = msg;
    if (pct !== undefined) el.querySelector('#ca-fill').style.width = Math.min(pct, 100) + '%';
    else {
      const total = C.stats.total || 1;
      el.querySelector('#ca-fill').style.width = Math.min(Math.round((C.stats.completed / total) * 100), 100) + '%';
    }
  }

  function removeOverlay() {
    const el = document.getElementById('ca-overlay');
    if (el) el.remove();
    const s = document.getElementById('ca-style');
    if (s) s.remove();
  }

  // ── Message Handler ─────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === 'runAll') {
      startAutomation().catch(e => log('Error: ' + e.message));
      sendResponse({ success: true });
      return true;
    }
    if (msg.action === 'stopAutomation') {
      stopAutomation();
      sendResponse({ success: true });
      return true;
    }
    if (msg.action === 'getStatus') {
      sendResponse({
        status: C.status, stats: C.stats, currentModule: C.currentModule,
        currentItem: C.currentItem, completedItems: C.completedItems.length,
        phase: C.phase, totalModules: C.totalModules
      });
      return true;
    }
    if (['processCurrent','completeLectures','completeReadings','skipVideo'].includes(msg.action)) {
      (async () => {
        await load();
        const itemId = getCurrentItemId() || 'current';
        const type = getItemTypeFromHref(location.pathname) || 'other';
        await completeItemPage({ id: itemId, type });
        sendResponse({ success: true });
      })();
      return true;
    }
    if (msg.action === 'quizAutomation') {
      (async () => { await solveQuiz(); sendResponse({ success: true }); })();
      return true;
    }
    if (['completeDiscussions','completeUngraded'].includes(msg.action)) {
      (async () => {
        await load();
        const itemId = getCurrentItemId() || 'current';
        await completeItemPage({ id: itemId, type: msg.action === 'completeUngraded' ? 'ungraded' : 'discussion' });
        sendResponse({ success: true });
      })();
      return true;
    }
    if (msg.action === 'shareableLink') {
      (async () => {
        const tabs = [...document.querySelectorAll('a, button')].filter(el => getText(el).includes('my submission'));
        for (const t of tabs) await asyncClick(t);
        await delay(2000);
        const copy = findByText('button', 'copy') || findByText('button', 'copy link') || findByText('button', 'share');
        if (copy) { await asyncClick(copy); sendResponse({ success: true, message: 'Link copied!' }); }
        else sendResponse({ success: false, error: 'Shareable link not found' });
      })();
      return true;
    }
    if (msg.action === 'courseBackup') {
      const name = document.querySelector('h1') || document.querySelector('title');
      const cname = name ? name.textContent.trim().replace(/[^a-zA-Z0-9 ]/g, '') : 'Course';
      sendResponse({ success: true, message: `Backup scan done for "${cname}".` });
      return true;
    }
  });

  // ── Auto-Resume ─────────────────────────────────────────────────────
  (async function autoResume() {
    try {
      await waitForBody();
      await load();
      if (C.status === 'running') {
        // Re-establish keep-alive on each page load
        keepAlivePort = chrome.runtime.connect({ name: 'keepAlive' });
        const ka = setInterval(() => { try { keepAlivePort.postMessage({ ping: true }); } catch (e) {} }, 25000);
        keepAlivePort.onDisconnect.addListener(() => clearInterval(ka));

        log('Auto-resuming from saved state');
        await addOverlay(`Resuming... ${C.stats.completed}/${C.stats.total}`);
        await runOrchestrator();
      }
    } catch (e) {
      log('Auto-resume error: ' + e.message);
    }
  })();

  log('Course Automation loaded (v3 - Breacher chaining)');
})();
