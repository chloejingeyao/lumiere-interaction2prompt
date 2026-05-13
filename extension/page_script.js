// Runs in PAGE context — has full access to React fiber, __reactProps$, etc.
(function () {
  if (window.__v2c_page_injected__) return;
  window.__v2c_page_injected__ = true;

  let overlay = null;
  let regionPicking = false;
  let trackedRegion = null;
  let trackingSessionId = null;
  let trackingTimer = null;
  let trackingListenersBound = false;

  // --- Overlay ---
  function getOrCreateOverlay() {
    let el = document.getElementById('__v2c_overlay__');
    if (!el) {
      el = document.createElement('div');
      el.id = '__v2c_overlay__';
      el.style.cssText = [
        'position:fixed', 'pointer-events:none',
        'background:rgba(99,102,241,0.15)',
        'border:2px solid rgb(99,102,241)',
        'border-radius:3px', 'z-index:2147483647',
        'box-sizing:border-box',
        'transition:top 0.05s,left 0.05s,width 0.05s,height 0.05s',
      ].join(';');
      document.body.appendChild(el);
    }
    return el;
  }

  function moveOverlay(target) {
    const r = target.getBoundingClientRect();
    overlay.style.top    = r.top    + 'px';
    overlay.style.left   = r.left   + 'px';
    overlay.style.width  = r.width  + 'px';
    overlay.style.height = r.height + 'px';
  }

  function removeOverlay() {
    document.getElementById('__v2c_overlay__')?.remove();
    overlay = null;
  }

  function getRectData(el) {
    const rect = el.getBoundingClientRect();
    return {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      top: Math.round(rect.top),
      right: Math.round(rect.right),
      bottom: Math.round(rect.bottom),
      left: Math.round(rect.left),
    };
  }

  // --- Metadata extraction (runs in page context) ---
  function extractMetadata(element) {
    const fiberKey = Object.keys(element).find(k => k.startsWith('__reactFiber$'));
    const propsKey = Object.keys(element).find(k => k.startsWith('__reactProps$'));

    // Component tree
    let componentTree = null;
    if (fiberKey) {
      let fiber = element[fiberKey];
      const tree = [];
      while (fiber) {
        const name = fiber.type?.displayName || fiber.type?.name;
        if (name && typeof name === 'string' && /^[A-Z]/.test(name)) tree.unshift(name);
        fiber = fiber.return;
      }
      if (tree.length) componentTree = tree;
    }

    // Event handlers + props
    let eventHandlers = [];
    let reactProps = {};
    if (propsKey) {
      const raw = element[propsKey];
      eventHandlers = Object.keys(raw)
        .filter(k => /^on[A-Z]/.test(k))
        .map(k => ({ event: k, handlerName: raw[k]?.name || 'anonymous' }));
      reactProps = Object.fromEntries(
        Object.entries(raw).filter(([k, v]) =>
          !/^on[A-Z]/.test(k) && k !== 'children' &&
          typeof v !== 'object' && typeof v !== 'function'
        )
      );
    }

    // Filtered computed styles
    const cs = window.getComputedStyle(element);
    const styleKeys = [
      'display','flexDirection','alignItems','justifyContent','gap',
      'width','height','padding','margin',
      'fontSize','fontWeight','color','backgroundColor',
      'borderRadius','border','cursor','opacity',
    ];
    const styles = {};
    styleKeys.forEach(k => { if (cs[k]) styles[k] = cs[k]; });

    // Text content (trimmed, max 80 chars)
    const textContent = element.textContent?.trim().slice(0, 80) || null;

    // Unique locator: build a CSS selector path to this element
    function buildSelector(el) {
      const parts = [];
      let current = el;
      while (current && current !== document.body) {
        const tag = current.tagName.toLowerCase();
        const id = current.id ? `#${current.id}` : '';
        if (id) { parts.unshift(tag + id); break; }
        // nth-of-type among siblings with the same tag
        const siblings = [...(current.parentElement?.children || [])].filter(s => s.tagName === current.tagName);
        const idx = siblings.indexOf(current) + 1;
        const nth = siblings.length > 1 ? `:nth-of-type(${idx})` : '';
        parts.unshift(tag + nth);
        current = current.parentElement;
      }
      return parts.join(' > ');
    }
    const cssSelector = buildSelector(element);

    // CSS framework detection
    const classes = [...element.classList];
    let cssFramework = 'unknown';
    if (classes.some(c => /^(bg|text|flex|grid|p-|m-|w-|h-|gap|items|justify|font|rounded|border|cursor)-/.test(c))) {
      cssFramework = 'tailwind';
    } else if (classes.some(c => /^Mui/.test(c))) {
      cssFramework = 'mui';
    } else if (classes.some(c => /^mantine/.test(c))) {
      cssFramework = 'mantine';
    } else if (element.getAttribute('style')) {
      cssFramework = 'inline-styles';
    } else if (classes.length > 0) {
      cssFramework = 'css-modules';
    }

    // Semantic attributes
    const semantic = {};
    ['role','aria-label','aria-selected','aria-expanded','type','href'].forEach(attr => {
      const val = element.getAttribute(attr);
      if (val !== null) semantic[attr] = val;
    });
    [...element.attributes]
      .filter(a => a.name.startsWith('data-'))
      .forEach(a => { semantic[a.name] = a.value; });

    return {
      tagName: element.tagName.toLowerCase(),
      textContent,
      cssSelector,
      classes,
      cssFramework,
      htmlSnapshot: element.outerHTML.slice(0, 600),
      componentTree,
      eventHandlers,
      reactProps,
      styles,
      semantic,
    };
  }

  // ─── Recorder region picking + tracking ──────────────────────────────────────
  function emitTrackedRegion(reason = 'sample') {
    if (!trackedRegion?.el?.isConnected) {
      stopRegionTracking();
      return;
    }
    window.postMessage({
      type: 'V2C_REGION_TRACK',
      data: {
        sessionId: trackingSessionId,
        reason,
        ts: Date.now(),
        rect: getRectData(trackedRegion.el),
        scrollX: Math.round(window.scrollX),
        scrollY: Math.round(window.scrollY),
        viewport: {
          width: window.innerWidth,
          height: window.innerHeight,
        },
      },
    }, '*');
  }

  function emitInteractionHint(event) {
    if (!trackedRegion?.el?.isConnected) return;
    const target = event.target instanceof Element ? event.target : null;
    if (!target || !trackedRegion.el.contains(target)) return;

    const metadata = extractMetadata(target);
    const value = typeof target.value === 'string' ? target.value.slice(0, 120) : null;
    window.postMessage({
      type: 'V2C_INTERACTION_HINT',
      data: {
        sessionId: trackingSessionId,
        ts: Date.now(),
        type: event.type,
        value,
        target: {
          tagName: metadata.tagName,
          textContent: metadata.textContent,
          cssSelector: metadata.cssSelector,
          componentTree: metadata.componentTree,
        },
      },
    }, '*');
  }

  // Mouseover: debounced, only fires when the hovered element changes
  let _lastHoverTarget = null;
  let _lastHoverTs = 0;
  const HOVER_DEBOUNCE_MS = 150;

  function emitMouseoverHint(event) {
    if (!trackedRegion?.el?.isConnected) return;
    const target = event.target instanceof Element ? event.target : null;
    if (!target || !trackedRegion.el.contains(target)) return;
    const now = Date.now();
    if (target === _lastHoverTarget && now - _lastHoverTs < HOVER_DEBOUNCE_MS) return;
    _lastHoverTarget = target;
    _lastHoverTs = now;

    const metadata = extractMetadata(target);
    window.postMessage({
      type: 'V2C_INTERACTION_HINT',
      data: {
        sessionId: trackingSessionId,
        ts: now,
        type: 'mouseover',
        value: null,
        target: {
          tagName: metadata.tagName,
          textContent: metadata.textContent,
          cssSelector: metadata.cssSelector,
          componentTree: metadata.componentTree,
        },
      },
    }, '*');
  }

  function bindTrackingListeners() {
    if (trackingListenersBound) return;
    trackingListenersBound = true;
    _lastHoverTarget = null;
    _lastHoverTs = 0;
    window.addEventListener('scroll', onTrackingScroll, true);
    window.addEventListener('resize', onTrackingResize, true);
    document.addEventListener('mouseover', emitMouseoverHint, true);
    document.addEventListener('click', emitInteractionHint, true);
    document.addEventListener('input', emitInteractionHint, true);
    document.addEventListener('change', emitInteractionHint, true);
    document.addEventListener('submit', emitInteractionHint, true);
  }

  function unbindTrackingListeners() {
    if (!trackingListenersBound) return;
    trackingListenersBound = false;
    window.removeEventListener('scroll', onTrackingScroll, true);
    window.removeEventListener('resize', onTrackingResize, true);
    document.removeEventListener('mouseover', emitMouseoverHint, true);
    document.removeEventListener('click', emitInteractionHint, true);
    document.removeEventListener('input', emitInteractionHint, true);
    document.removeEventListener('change', emitInteractionHint, true);
    document.removeEventListener('submit', emitInteractionHint, true);
  }

  function onTrackingScroll() {
    emitTrackedRegion('scroll');
  }

  function onTrackingResize() {
    emitTrackedRegion('resize');
  }

  // ── Recording highlight ───────────────────────────────────────────────────────
  // A persistent purple border pinned to the tracked element during recording.
  let recordingHighlight = null;
  let highlightRafId     = null;

  function createRecordingHighlight(el) {
    removeRecordingHighlight();
    const div = document.createElement('div');
    div.id = '__v2c_rec_highlight__';
    div.style.cssText = [
      'position:fixed', 'pointer-events:none', 'z-index:2147483646',
      'box-sizing:border-box',
      'border:3px solid #7c3aed',
      'border-radius:4px',
      'box-shadow:0 0 0 1px rgba(124,58,237,0.25), inset 0 0 0 1px rgba(124,58,237,0.1)',
      'background:rgba(124,58,237,0.06)',
    ].join(';');
    document.body.appendChild(div);
    recordingHighlight = div;

    function tick() {
      if (!recordingHighlight || !el.isConnected) return;
      const r = el.getBoundingClientRect();
      recordingHighlight.style.top    = r.top    + 'px';
      recordingHighlight.style.left   = r.left   + 'px';
      recordingHighlight.style.width  = r.width  + 'px';
      recordingHighlight.style.height = r.height + 'px';
      highlightRafId = requestAnimationFrame(tick);
    }
    tick();
  }

  function removeRecordingHighlight() {
    if (highlightRafId) { cancelAnimationFrame(highlightRafId); highlightRafId = null; }
    document.getElementById('__v2c_rec_highlight__')?.remove();
    recordingHighlight = null;
  }

  function startRegionTracking(sessionId) {
    if (!trackedRegion?.el) return;
    trackingSessionId = sessionId || null;
    clearInterval(trackingTimer);
    bindTrackingListeners();
    emitTrackedRegion('start');
    trackingTimer = window.setInterval(() => emitTrackedRegion('sample'), 250);
    // Highlight already shown from selection — ensure it's still alive
    if (!recordingHighlight) createRecordingHighlight(trackedRegion.el);
  }

  function stopRegionTracking() {
    clearInterval(trackingTimer);
    trackingTimer = null;
    trackingSessionId = null;
    unbindTrackingListeners();
    // Keep highlight visible between clips — only removed on full reset
  }

  function clearRegion() {
    stopRegionTracking();
    removeRecordingHighlight();
    trackedRegion = null;
  }

  function onRegionPickOver(e) {
    if (e.target.id === '__v2c_overlay__') return;
    moveOverlay(e.target);
  }

  function onRegionPickClick(e) {
    if (e.target.id === '__v2c_overlay__') return;
    e.preventDefault();
    e.stopPropagation();
    const metadata = extractMetadata(e.target);
    trackedRegion = {
      el: e.target,
      selector: metadata.cssSelector,
      metadata,
    };
    // Show highlight immediately on selection — persists until reset
    createRecordingHighlight(e.target);
    window.postMessage({
      type: 'V2C_REGION_SELECTED',
      data: {
        selector: metadata.cssSelector,
        metadata,
        rect: getRectData(e.target),
        viewport: {
          width: window.innerWidth,
          height: window.innerHeight,
        },
        page: {
          url: location.href,
          title: document.title,
        },
      },
    }, '*');
    stopRegionPick();
  }

  function onRegionPickKeyDown(e) {
    if (e.key === 'Escape') {
      stopRegionPick();
      window.postMessage({ type: 'V2C_REGION_PICK_CANCELLED' }, '*');
    }
  }

  function startRegionPick() {
    if (regionPicking) return;
    removeRecordingHighlight(); // clear any previous selection highlight
    regionPicking = true;
    overlay = getOrCreateOverlay();
    document.body.style.cursor = 'crosshair';
    document.addEventListener('mouseover', onRegionPickOver, true);
    document.addEventListener('click', onRegionPickClick, true);
    document.addEventListener('keydown', onRegionPickKeyDown, true);
  }

  function stopRegionPick() {
    if (!regionPicking) return;
    regionPicking = false;
    document.body.style.cursor = '';
    removeOverlay();
    document.removeEventListener('mouseover', onRegionPickOver, true);
    document.removeEventListener('click', onRegionPickClick, true);
    document.removeEventListener('keydown', onRegionPickKeyDown, true);
  }

  // Listen for commands from content script
  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    if (e.data?.type === 'V2C_REGION_PICK_START') startRegionPick();
    if (e.data?.type === 'V2C_REGION_PICK_STOP')  stopRegionPick();
    if (e.data?.type === 'V2C_REGION_TRACK_START') startRegionTracking(e.data.sessionId);
    if (e.data?.type === 'V2C_REGION_TRACK_STOP')  stopRegionTracking();
    if (e.data?.type === 'V2C_REGION_CLEAR')        clearRegion();
  });
})();
