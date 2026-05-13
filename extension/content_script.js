// Guard against double-injection
if (!window.__v2c_injected__) {
  window.__v2c_injected__ = true;

  // --- Inject page_script.js into page context, call back when ready ---
  function injectPageScript(callback) {
    const existing = document.getElementById('__v2c_page_script__');

    if (existing) {
      // Script tag exists — check if it already finished loading
      if (existing.dataset.loaded === 'true') {
        // Already loaded, call back immediately
        callback();
      } else {
        // Still loading, wait for it
        existing.addEventListener('load', callback, { once: true });
      }
      return;
    }

    // First time — inject the script
    const script = document.createElement('script');
    script.id = '__v2c_page_script__';
    script.src = chrome.runtime.getURL('page_script.js');
    script.onload = () => {
      script.dataset.loaded = 'true';
      callback();
    };
    script.onerror = () => console.error('[V2C] Failed to load page_script.js');
    document.documentElement.appendChild(script);
  }

  function emitPanelEvent(eventType, payload = null) {
    try {
      chrome.runtime.sendMessage({ type: 'V2C_PANEL_EVENT', eventType, payload });
    } catch (_) {}
  }

  // --- Relay: page script → content script → extension ---
  window.addEventListener('message', (e) => {
    if (e.source !== window) return;

    // Guard: chrome runtime may be invalidated if extension was reloaded
    if (!chrome?.runtime?.id) return;

    if (e.data?.type === 'V2C_REGION_SELECTED') {
      emitPanelEvent('REGION_SELECTED', e.data.data);
    }
    if (e.data?.type === 'V2C_REGION_TRACK') {
      emitPanelEvent('REGION_TRACK', e.data.data);
    }
    if (e.data?.type === 'V2C_INTERACTION_HINT') {
      emitPanelEvent('INTERACTION_HINT', e.data.data);
    }
    if (e.data?.type === 'V2C_REGION_PICK_CANCELLED') {
      emitPanelEvent('REGION_PICK_CANCELLED');
    }
  });

  // --- Relay: background → content script → page script ---
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'START_REGION_PICK') {
      injectPageScript(() => {
        window.postMessage({ type: 'V2C_REGION_PICK_START' }, '*');
      });
    }
    if (message.type === 'STOP_REGION_PICK') {
      window.postMessage({ type: 'V2C_REGION_PICK_STOP' }, '*');
    }
    if (message.type === 'START_REGION_TRACKING') {
      window.postMessage({ type: 'V2C_REGION_TRACK_START', sessionId: message.sessionId }, '*');
    }
    if (message.type === 'STOP_REGION_TRACKING') {
      window.postMessage({ type: 'V2C_REGION_TRACK_STOP' }, '*');
    }
    if (message.type === 'CLEAR_REGION') {
      window.postMessage({ type: 'V2C_REGION_CLEAR' }, '*');
    }
  });
}
