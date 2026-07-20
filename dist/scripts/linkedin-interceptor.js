(() => {
  if (window.__caLnInterceptorLoaded) return;
  window.__caLnInterceptorLoaded = true;

  const PATCH_ENDPOINTS = [
    '/voyager/api/learning/progressEntities',
    '/voyager/api/learning/playerProgress',
    '/voyager/api/learning/learningEntities',
    '/learning/progressEntities',
    '/learning/playerProgress',
  ];

  const PATCH_FIELDS = {
    progress: 1,
    completed: true,
    percentComplete: 100,
    watchedToEnd: true,
    position: 999999,
    duration: 999999,
    progressTimestamp: Date.now(),
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
          if (body.learningContentUrn && !('completed' in body)) {
            body.completed = true;
            modified = true;
          }
          if (body.urn && !('completed' in body)) {
            body.completed = true;
            modified = true;
          }
          if (modified) {
            init.body = JSON.stringify(body);
          }
        }
      }

      if (url.includes('/graphql') && init?.body) {
        let body;
        try { body = typeof init.body === 'string' ? JSON.parse(init.body) : init.body; } catch (e) { body = null; }
        if (body && typeof body === 'object') {
          const patched = patchGraphQLBody(body);
          if (patched) {
            init.body = JSON.stringify(body);
          }
        }
      }
    } catch (e) {}

    return origFetch.apply(this, args);
  };

  function patchGraphQLBody(body) {
    let modified = false;
    const mutate = (obj) => {
      if (!obj || typeof obj !== 'object') return;
      if (Array.isArray(obj)) {
        obj.forEach(mutate);
        return;
      }
      for (const [key, val] of Object.entries(obj)) {
        if (key === 'completed' && val !== true) {
          obj[key] = true;
          modified = true;
        }
        if (key === 'progress' && typeof val === 'number' && val < 1) {
          obj[key] = 1;
          modified = true;
        }
        if (key === 'percentComplete' && typeof val === 'number' && val < 100) {
          obj[key] = 100;
          modified = true;
        }
        if (val && typeof val === 'object') mutate(val);
      }
    };
    mutate(body);
    return modified;
  }

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
          if (parsed.learningContentUrn && !('completed' in parsed)) parsed.completed = true;
          if (parsed.urn && !('completed' in parsed)) parsed.completed = true;
          body = JSON.stringify(parsed);
        }
      }
    } catch (e) {}
    return origXHRSend.call(this, body);
  };
})();
