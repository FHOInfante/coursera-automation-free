(() => {
  if (window.__caInterceptorLoaded) return;
  window.__caInterceptorLoaded = true;

  const PATCH_ENDPOINTS = [
    '/api/onDemandLearnerMaterials.v1',
    '/api/onDemandCourseMaterials.v2',
    '/api/onDemandGradedLabs.v1',
    '/api/onDemandSpecializations.v1',
  ];

  const PATCH_FIELDS = {
    watchedUpTo: 999999,
    videoProgress: 1,
    percentWatched: 1,
    isCompleted: true,
    video_position: 999999,
    video_percent: 100,
    watched_seconds: 999999,
    percent_watched: 100,
  };

  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    try {
      const [resource, init] = args;
      const url = typeof resource === 'string' ? resource : resource?.url || '';

      if (PATCH_ENDPOINTS.some(ep => url.includes(ep)) && init?.body) {
        let body;
        try { body = typeof init.body === 'string' ? JSON.parse(init.body) : init.body; } catch (e) { body = null; }

        if (body && typeof body === 'object') {
          let modified = false;
          for (const [key, val] of Object.entries(PATCH_FIELDS)) {
            if (key in body && body[key] !== val) {
              body[key] = val;
              modified = true;
            }
          }
          // If it looks like a completion request but missing fields, add them
          if (body.courseId && body.itemId && !('isCompleted' in body)) {
            body.isCompleted = true;
            modified = true;
          }
          if (modified) {
            init.body = JSON.stringify(body);
            console.log('[CA-Interceptor] Patched:', url.split('/').pop(), body);
          }
        }
      }

      // Also intercept video event and batch endpoints
      if (url.includes('/videoEvents') || url.includes('/eventing/info/batch')) {
        let body;
        try { body = typeof init.body === 'string' ? JSON.parse(init.body) : init.body; } catch (e) { body = null; }
        if (body) {
          console.log('[CA-Interceptor] Observed:', url.split('/').pop(), body);
        }
      }
    } catch (e) {}

    return origFetch.apply(this, args);
  };

  const origXHR = XMLHttpRequest.prototype.open;
  const origXHRSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__caUrl = url;
    return origXHR.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (body) {
    try {
      if (this.__caUrl && PATCH_ENDPOINTS.some(ep => this.__caUrl.includes(ep)) && body) {
        let parsed;
        try { parsed = typeof body === 'string' ? JSON.parse(body) : body; } catch (e) { parsed = null; }
        if (parsed && typeof parsed === 'object') {
          for (const [key, val] of Object.entries(PATCH_FIELDS)) {
            if (key in parsed) parsed[key] = val;
          }
          if (parsed.courseId && parsed.itemId && !('isCompleted' in parsed)) {
            parsed.isCompleted = true;
          }
          body = JSON.stringify(parsed);
          console.log('[CA-Interceptor] XHR Patched:', this.__caUrl.split('/').pop());
        }
      }
    } catch (e) {}
    return origXHRSend.call(this, body);
  };

  console.log('[CA-Interceptor] Fetch/XHR interceptor installed');
})();
