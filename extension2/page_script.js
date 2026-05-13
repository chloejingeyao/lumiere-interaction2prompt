// Runs in PAGE context — has full access to React fiber, __reactProps$, etc.
(function () {
  if (window.__v2c_page_injected__) return;
  window.__v2c_page_injected__ = true;

  let inspecting = false;
  let overlay = null;

  // --- Find the actual scrollable ancestor ---
  function getScrollParent(el) {
    let parent = el.parentElement;
    while (parent && parent !== document.body) {
      const { overflow, overflowY } = getComputedStyle(parent);
      if (/(auto|scroll)/.test(overflow + overflowY)) return parent;
      parent = parent.parentElement;
    }
    return window;
  }

  // --- Scroll to element, flash once scroll event stops firing ---
  function flashAndScroll(selector) {
    const el = selector ? document.querySelector(selector) : null;
    if (!el) return;

    const scrollParent = getScrollParent(el);
    let debounceTimer = null;
    let fallbackTimer = null;
    let scrollFired = false;

    function onScroll() {
      scrollFired = true;
      clearTimeout(debounceTimer);
      // Wait 200ms after the last scroll event — scroll is done
      debounceTimer = setTimeout(() => {
        scrollParent.removeEventListener('scroll', onScroll);
        clearTimeout(fallbackTimer);
        showFlash(el);
      }, 200);
    }

    scrollParent.addEventListener('scroll', onScroll, { passive: true });

    // Fallback: if no scroll event fires within 400ms, element is already in view
    fallbackTimer = setTimeout(() => {
      if (!scrollFired) {
        scrollParent.removeEventListener('scroll', onScroll);
        showFlash(el);
      }
    }, 400);

    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function showFlash(el) {
    const rect = el.getBoundingClientRect();
    const flash = document.createElement('div');
    flash.style.cssText = [
      'position:fixed',
      `top:${rect.top}px`,
      `left:${rect.left}px`,
      `width:${rect.width}px`,
      `height:${rect.height}px`,
      'pointer-events:none',
      'z-index:2147483646',
      'box-sizing:border-box',
      'border:2px solid rgba(194,81,26,0.9)',
      'background:rgba(194,81,26,0.1)',
      'border-radius:3px',
      'opacity:1',
      'transition:opacity 0.8s ease 2.2s',
    ].join(';');
    document.body.appendChild(flash);

    requestAnimationFrame(() => requestAnimationFrame(() => {
      flash.style.opacity = '0';
      flash.addEventListener('transitionend', () => flash.remove(), { once: true });
    }));
  }

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

  // --- Count React component instances on the page ---
  // Starts from a known fiber and traverses up to the HostRoot, then counts down.
  function countFiberInstances(elementFiber, targetName) {
    // Walk up to the root fiber (HostRoot has no return, or return is null)
    let root = elementFiber;
    while (root.return) root = root.return;
    // root is now the HostRoot fiber; its child is the app root component
    let count = 0;
    const stack = [root.child];
    while (stack.length) {
      const fiber = stack.pop();
      if (!fiber) continue;
      const name = fiber.type?.displayName || fiber.type?.name;
      if (name === targetName) count++;
      if (fiber.child)   stack.push(fiber.child);
      if (fiber.sibling) stack.push(fiber.sibling);
    }
    return count || 1;
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

    // Count instances of the nearest named React component
    let instanceCount = 1;
    if (fiberKey && componentTree && componentTree.length > 0) {
      const nearestComponent = componentTree[componentTree.length - 1];
      try {
        instanceCount = countFiberInstances(element[fiberKey], nearestComponent);
        console.log(`[V2C] <${nearestComponent}> instance count:`, instanceCount);
      } catch (err) {
        console.warn('[V2C] countFiberInstances failed:', err);
      }
    }

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
      instanceCount,
    };
  }

  // --- Inspector ---
  function onMouseOver(e) {
    if (e.target.id === '__v2c_overlay__') return;
    moveOverlay(e.target);
  }

  function onClick(e) {
    if (e.target.id === '__v2c_overlay__') return;
    e.preventDefault();
    e.stopPropagation();
    const metadata = extractMetadata(e.target);
    // Send to content script via postMessage
    window.postMessage({ type: 'V2C_CAPTURED', data: metadata }, '*');
    stopInspection();
  }

  function onKeyDown(e) {
    if (e.key === 'Escape') {
      stopInspection();
      window.postMessage({ type: 'V2C_CANCELLED' }, '*');
    }
  }

  function startInspection() {
    if (inspecting) return;
    inspecting = true;
    overlay = getOrCreateOverlay();
    document.body.style.cursor = 'crosshair';
    document.addEventListener('mouseover', onMouseOver, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKeyDown, true);
  }

  function stopInspection() {
    if (!inspecting) return;
    inspecting = false;
    document.body.style.cursor = '';
    removeOverlay();
    document.removeEventListener('mouseover', onMouseOver, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKeyDown, true);
  }

  // ─── Annotator ───────────────────────────────────────────────────────────────
  // Phase 1 = inspect (crosshair + dashed overlay to pick element)
  // Phase 2 = comment (click annotated element to open/close compose; Esc closes compose)
  let annInspecting = false;
  let annCommenting = false;
  let annSelOverlay = null;
  const annEls      = new Map(); // annId → { el, metadata, restore, overlay }

  function isAnnUI(el) { return !!el.closest('#__v2c_compose__'); }

  function syncAnnOverlay(entry) {
    if (!entry?.el || !entry?.overlay) return;
    const r = entry.el.getBoundingClientRect();
    entry.overlay.style.top = r.top + 'px';
    entry.overlay.style.left = r.left + 'px';
    entry.overlay.style.width = r.width + 'px';
    entry.overlay.style.height = r.height + 'px';
  }

  function createAnnOverlay(entry) {
    const overlay = document.createElement('div');
    overlay.className = '__v2c_ann_overlay__';
    overlay.style.cssText = [
      'position:fixed',
      'pointer-events:none',
      'border:2px solid #5B5FEF',
      'border-radius:3px',
      'box-sizing:border-box',
      'background:rgba(91,95,239,0.06)',
      'z-index:2147483646',
      'transition:top .05s,left .05s,width .05s,height .05s',
    ].join(';');
    document.body.appendChild(overlay);
    entry.overlay = overlay;
    syncAnnOverlay(entry);
  }

  function syncAllAnnOverlays() {
    annEls.forEach((entry) => syncAnnOverlay(entry));
  }

  function applyAnnHighlight(el, annId, metadata = null) {
    const existing = annEls.get(annId);
    if (existing?.el === el) {
      existing.metadata = metadata ?? existing.metadata;
      syncAnnOverlay(existing);
      return existing;
    }

    const entry = {
      el,
      metadata,
      restore: {
        hadAnnId: Object.prototype.hasOwnProperty.call(el.dataset, 'annId'),
        annId: el.dataset.annId,
      },
      overlay: null,
    };

    el.dataset.annId = annId;
    createAnnOverlay(entry);
    annEls.set(annId, entry);
    return entry;
  }

  function restoreAnnHighlight(entry) {
    if (!entry?.el) return;
    const { el, restore } = entry;
    entry.overlay?.remove();

    if (restore.hadAnnId) {
      el.dataset.annId = restore.annId;
    } else {
      delete el.dataset.annId;
    }
  }

  // ── Phase 1: crosshair + dashed selection overlay ──────────────────────
  function getAnnSelOverlay() {
    if (annSelOverlay) return annSelOverlay;
    const el = document.createElement('div');
    el.id = '__v2c_ann_sel__';
    el.style.cssText = [
      'position:fixed', 'pointer-events:none',
      'background:rgba(91,95,239,0.07)',
      'border:2px dashed rgba(91,95,239,0.8)',
      'border-radius:3px', 'z-index:2147483646',
      'box-sizing:border-box',
      'transition:top .05s,left .05s,width .05s,height .05s',
    ].join(';');
    document.body.appendChild(el);
    annSelOverlay = el;
    return el;
  }
  function removeAnnSelOverlay() { annSelOverlay?.remove(); annSelOverlay = null; }

  function onInspectOver(e) {
    if (e.target.id === '__v2c_ann_sel__' || isAnnUI(e.target)) return;
    const r = e.target.getBoundingClientRect();
    const ov = getAnnSelOverlay();
    ov.style.top = r.top + 'px'; ov.style.left = r.left + 'px';
    ov.style.width = r.width + 'px'; ov.style.height = r.height + 'px';
  }

  function onInspectClick(e) {
    if (e.target.id === '__v2c_ann_sel__' || isAnnUI(e.target)) return;
    e.preventDefault(); e.stopPropagation();
    const el = e.target;
    const existingAnnId = el.dataset.annId;
    if (existingAnnId && annEls.has(existingAnnId)) {
      stopInspectMode();
      startCommentMode();
      const rect = el.getBoundingClientRect();
      const cx = rect.left + rect.width / 2 - 134;
      showCompose(existingAnnId, cx, rect.bottom - 14);
      window.postMessage({ type: 'V2C_ANN_EXISTING_SELECTED', data: { id: existingAnnId } }, '*');
      return;
    }
    const annId = `ann-${Date.now()}`;
    const metadata = extractMetadata(el);
    applyAnnHighlight(el, annId, metadata);
    stopInspectMode();
    window.postMessage({ type: 'V2C_ANN_ELEMENT_ADDED', data: { id: annId, metadata } }, '*');
    startCommentMode();
    // Auto-open compose immediately below the selected element
    const rect = el.getBoundingClientRect();
    const cx = rect.left + rect.width / 2 - 134; // 134 = half of compose width (268/2), offset by x+10
    showCompose(annId, cx, rect.bottom - 14);
  }

  function onInspectKey(e) {
    if (e.key === 'Escape') { stopInspectMode(); window.postMessage({ type: 'V2C_ANN_CANCELLED' }, '*'); }
  }

  function startInspectMode() {
    if (annInspecting) return;
    stopCommentMode(); // always exit comment mode when starting a new inspection
    annInspecting = true;
    document.body.style.cursor = 'crosshair';
    document.addEventListener('mouseover', onInspectOver,  true);
    document.addEventListener('click',     onInspectClick, true);
    document.addEventListener('keydown',   onInspectKey,   true);
  }

  function stopInspectMode() {
    if (!annInspecting) return;
    annInspecting = false;
    document.body.style.cursor = '';
    removeAnnSelOverlay();
    document.removeEventListener('mouseover', onInspectOver,  true);
    document.removeEventListener('click',     onInspectClick, true);
    document.removeEventListener('keydown',   onInspectKey,   true);
  }

  // ── Phase 2: click-to-compose (default cursor, click annotated element to open/close) ──
  function closeCompose() { document.getElementById('__v2c_compose__')?.remove(); }

  function showCompose(annId, x, y) {
    closeCompose();
    const entry = annEls.get(annId);
    const cw    = 268;
    const left  = Math.min(Math.max(x + 10, 8), window.innerWidth - cw - 8);
    const top   = Math.min(Math.max(y + 14, 8), window.innerHeight - 56);

    const wrap = document.createElement('div');
    wrap.id = '__v2c_compose__';
    wrap.style.cssText = [
      'position:fixed', `left:${left}px`, `top:${top}px`, 'z-index:2147483647',
      'display:flex', 'align-items:center', 'gap:8px',
      'background:#1A1917', 'border-radius:28px',
      'padding:7px 7px 7px 18px',
      'box-shadow:0 4px 24px rgba(0,0,0,0.38)',
      `width:${cw}px`, 'box-sizing:border-box',
      'font-family:"DM Sans",system-ui,sans-serif',
    ].join(';');

    const input = document.createElement('input');
    input.type = 'text'; input.placeholder = 'Add a comment…';
    input.style.cssText = 'flex:1;background:transparent;border:none;outline:none;color:#fff;font-size:13px;min-width:0;font-family:"DM Sans",system-ui,sans-serif';

    const btn = document.createElement('button');
    btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M7 11V3M3 7L7 3L11 7" stroke="white" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    btn.style.cssText = 'background:#3a3937;border:none;border-radius:50%;width:30px;height:30px;min-width:30px;display:flex;align-items:center;justify-content:center;flex-shrink:0';

    function doSubmit() {
      const comment = input.value.trim();
      closeCompose();
      if (!comment) return;
      window.postMessage({ type: 'V2C_ANN_ENTRY', data: { id: annId, metadata: entry?.metadata, comment } }, '*');
    }
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter')  { e.preventDefault(); doSubmit(); }
      if (e.key === 'Escape') { closeCompose(); }
    });
    btn.addEventListener('click', (e) => { e.stopPropagation(); doSubmit(); });

    wrap.appendChild(input); wrap.appendChild(btn);
    document.body.appendChild(wrap);
    setTimeout(() => input.focus(), 30);
  }

  function onCommentClick(e) {
    if (isAnnUI(e.target)) return;
    const annotatedEl = e.target.closest('[data-ann-id]');
    if (!annotatedEl) {
      e.preventDefault();
      e.stopPropagation();
      annStopAll();
      window.postMessage({ type: 'V2C_ANN_CANCELLED' }, '*');
      return;
    }
    e.preventDefault(); e.stopPropagation();
    // Toggle: clicking an annotated element closes compose if open, reopens if closed
    if (document.getElementById('__v2c_compose__')) {
      closeCompose();
    } else {
      showCompose(annotatedEl.dataset.annId, e.clientX, e.clientY);
    }
  }

  function onCommentKey(e) {
    // Esc only closes the compose popup — comment mode stays active so user can click again
    if (e.key === 'Escape') closeCompose();
  }

  function startCommentMode() {
    if (annCommenting) return;
    annCommenting = true;
    document.addEventListener('click',   onCommentClick, true);
    document.addEventListener('keydown', onCommentKey,   true);
    window.addEventListener('scroll', syncAllAnnOverlays, true);
    window.addEventListener('resize', syncAllAnnOverlays, true);
  }

  function stopCommentMode() {
    if (!annCommenting) return;
    annCommenting = false;
    closeCompose();
    document.removeEventListener('click',   onCommentClick, true);
    document.removeEventListener('keydown', onCommentKey,   true);
    window.removeEventListener('scroll', syncAllAnnOverlays, true);
    window.removeEventListener('resize', syncAllAnnOverlays, true);
  }

  // Clear everything — called when switching away from annotator tab
  function annStopAll() {
    stopInspectMode();
    stopCommentMode();
    annEls.forEach((entry) => restoreAnnHighlight(entry));
    annEls.clear();
  }

  function removeAnnEl(annId) {
    const entry = annEls.get(annId);
    if (!entry) return;
    restoreAnnHighlight(entry);
    annEls.delete(annId);
  }

  // Re-highlight a previously annotated element (after switching back to annotator tab)
  function reHighlightEl(annId, selector) {
    try {
      const el = document.querySelector(selector);
      if (!el) return;
      applyAnnHighlight(el, annId, null);
      startCommentMode();
    } catch (_) {}
  }

  // Listen for commands from content script
  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    if (e.data?.type === 'V2C_START')            startInspection();
    if (e.data?.type === 'V2C_STOP')             stopInspection();
    if (e.data?.type === 'V2C_FLASH')            flashAndScroll(e.data.selector);
    if (e.data?.type === 'V2C_ANN_START')        startInspectMode();
    if (e.data?.type === 'V2C_ANN_STOP')         annStopAll();
    if (e.data?.type === 'V2C_ANN_STOP_COMMENT') stopCommentMode();
    if (e.data?.type === 'V2C_ANN_REMOVE')       removeAnnEl(e.data.annId);
    if (e.data?.type === 'V2C_ANN_REHIGHLIGHT')  reHighlightEl(e.data.annId, e.data.selector);
    if (e.data?.type === 'V2C_STOP_INSPECT')     stopInspectMode();
  });
})();
