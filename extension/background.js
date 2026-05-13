// Only responsibility: open the sidepanel when the extension icon is clicked
chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ tabId: tab.id });
});

// ─── Offscreen document management ──────────────────────────────────────────
async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument().catch(() => false)) return;
  await chrome.offscreen.createDocument({
    url: chrome.runtime.getURL('offscreen.html'),
    reasons: [chrome.offscreen.Reason.USER_MEDIA],
    justification: 'Tab capture for interaction recording',
  });
}

const recordingSessions = new Map();

function sendPanelEvent(tabId, eventType, payload = null) {
  return chrome.tabs.sendMessage(tabId, {
    type: 'V2C_PANEL_EVENT',
    eventType,
    payload,
  }).catch(() => {});
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'v2c-sidepanel-lifecycle') return;
  let sourceTabId = null;

  port.onMessage.addListener((message) => {
    if (typeof message?.tabId === 'number') sourceTabId = message.tabId;
  });

  port.onDisconnect.addListener(() => {
    if (sourceTabId == null) return;
    chrome.tabs.sendMessage(sourceTabId, { type: 'STOP_REGION_PICK' }).catch(() => {});
    chrome.tabs.sendMessage(sourceTabId, { type: 'STOP_REGION_TRACKING' }).catch(() => {});
    chrome.tabs.sendMessage(sourceTabId, { type: 'CLEAR_REGION' }).catch(() => {});
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // ── Tab capture via offscreen document ────────────────────────────────────
  if (message?.type === 'START_TAB_CAPTURE') {
    const tabId = message.tabId ?? sender.tab?.id;
    if (typeof tabId !== 'number') {
      sendResponse({ ok: false, error: 'No tab id available' });
      return false;
    }

    // Run everything in an async IIFE so we can use await safely
    (async () => {
      // Check URL before attempting capture
      try {
        const tab = await chrome.tabs.get(tabId);
        const url = tab.url || '';
        const blocked = !url
          || url.startsWith('chrome://')
          || url.startsWith('chrome-extension://')
          || url.startsWith('about:');
        if (blocked) {
          sendResponse({ ok: false, error: 'This page cannot be recorded. Please navigate to a regular website and try again.' });
          return;
        }
      } catch (_) {}

      // Get stream ID
      chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, async (streamId) => {
        if (!streamId) {
          const raw = chrome.runtime.lastError?.message || '';
          const isPageError = raw.includes('Chrome pages cannot be captured');
          const friendly = isPageError
            ? 'This page cannot be recorded. Please navigate to a regular website and try again.'
            : 'Unable to record. Please reload this extension and try again.';
          sendResponse({ ok: false, error: friendly });
          return;
        }
        try {
          const region   = message.region   || null;
          const viewport = message.viewport || null;
          await ensureOffscreen();
          await chrome.runtime.sendMessage({
            target: 'offscreen',
            type: 'START_RECORDING',
            streamId,
            region,
            viewport,
          });
          sendResponse({ ok: true });
        } catch (err) {
          sendResponse({ ok: false, error: err.message });
        }
      });
    })();
    return true; // async
  }

  if (message?.type === 'STOP_TAB_CAPTURE') {
    (async () => {
      try {
        const hasDoc = await chrome.offscreen.hasDocument().catch(() => false);
        if (!hasDoc) { sendResponse({ ok: true, frames: [], videoDataUrl: null }); return; }
        const res = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'STOP_RECORDING' });
        sendResponse({ ok: true, frames: res?.frames || [], videoDataUrl: res?.videoDataUrl || null });
      } catch (err) {
        sendResponse({ ok: true, frames: [], videoDataUrl: null });
      }
    })();
    return true; // async
  }

  // ── Session bookkeeping ───────────────────────────────────────────────────
  if (message?.type === 'START_RECORDING_SESSION') {
    const tabId = message.tabId ?? sender.tab?.id;
    if (typeof tabId !== 'number') {
      sendResponse({ ok: false, error: 'No tab id available' });
      return false;
    }

    const sessionId = `rec-${Date.now()}`;
    recordingSessions.set(sessionId, {
      sessionId,
      tabId,
      region: message.region ?? null,
      startedAt: Date.now(),
      status: 'recording',
    });
    sendPanelEvent(tabId, 'RECORDING_STARTED', { sessionId, startedAt: Date.now() });
    sendResponse({ ok: true, sessionId });
    return false;
  }

  if (message?.type === 'STOP_RECORDING_SESSION') {
    const sessionId = message.sessionId;
    const session = sessionId ? recordingSessions.get(sessionId) : null;
    if (!session) {
      sendResponse({ ok: false, error: 'Session not found' });
      return false;
    }

    session.status = 'stopped';
    session.stoppedAt = Date.now();
    sendPanelEvent(session.tabId, 'RECORDING_STOPPED', {
      sessionId: session.sessionId,
      startedAt: session.startedAt,
      stoppedAt: session.stoppedAt,
      durationMs: session.stoppedAt - session.startedAt,
    });
    sendResponse({ ok: true, sessionId: session.sessionId });
    return false;
  }

  if (message?.type === 'RESET_RECORDING_SESSION') {
    const sessionId = message.sessionId;
    if (sessionId) recordingSessions.delete(sessionId);
    sendResponse({ ok: true });
    return false;
  }
});
