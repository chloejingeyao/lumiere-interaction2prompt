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

    if (e.data?.type === 'V2C_CAPTURED') {
      emitPanelEvent('CAPTURED', e.data.data);
    }
    if (e.data?.type === 'V2C_CANCELLED') {
      emitPanelEvent('INSPECTION_CANCELLED');
    }
    if (e.data?.type === 'V2C_ANN_ELEMENT_ADDED') {
      emitPanelEvent('ANN_ELEMENT_ADDED', e.data.data);
    }
    if (e.data?.type === 'V2C_ANN_EXISTING_SELECTED') {
      emitPanelEvent('ANN_EXISTING_SELECTED', e.data.data);
    }
    if (e.data?.type === 'V2C_ANN_ENTRY') {
      emitPanelEvent('ANN_ENTRY', e.data.data);
    }
    if (e.data?.type === 'V2C_ANN_CANCELLED') {
      emitPanelEvent('ANN_CANCELLED');
    }
  });

  // --- Relay: background → content script → page script ---
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'START_INSPECTION') {
      injectPageScript(() => {
        window.postMessage({ type: 'V2C_START' }, '*');
      });
    }
    if (message.type === 'STOP_INSPECTION') {
      window.postMessage({ type: 'V2C_STOP' }, '*');
    }
    if (message.type === 'FLASH') {
      window.postMessage({ type: 'V2C_FLASH', selector: message.selector }, '*');
    }
    if (message.type === 'START_ANNOTATOR') {
      injectPageScript(() => {
        window.postMessage({ type: 'V2C_ANN_START' }, '*');
      });
    }
    if (message.type === 'STOP_ANNOTATOR') {
      window.postMessage({ type: 'V2C_ANN_STOP' }, '*');
    }
    if (message.type === 'ANN_REMOVE') {
      window.postMessage({ type: 'V2C_ANN_REMOVE', annId: message.annId }, '*');
    }
    if (message.type === 'STOP_INSPECT') {
      window.postMessage({ type: 'V2C_STOP_INSPECT' }, '*');
    }
    if (message.type === 'ANN_REHIGHLIGHT') {
      window.postMessage({ type: 'V2C_ANN_REHIGHLIGHT', annId: message.annId, selector: message.selector }, '*');
    }
    if (message.type === 'ANN_STOP_COMMENT') {
      window.postMessage({ type: 'V2C_ANN_STOP_COMMENT' }, '*');
    }
  });
}
