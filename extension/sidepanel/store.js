// ─── Mutable state ─────────────────────────────────────────────────────────
export const store = {
  // Recorder
  recording: {
    mode: 'idle', // idle | picking | ready | recording | stopped
    tabId: null,
    sessionId: null,
    selectedRegion: null,
    trackedRects: [],
    interactionHints: [],
    clips: [],           // [{videoDataUrl, frames: [{dataUrl, ts}]}] — max 3
    generatedPrompt: null,
    startedAt: null,
    stoppedAt: null,
    errorMessage: null,
  },
};

// ─── Lifecycle port (keeps background informed when sidepanel closes) ────────
export const sidepanelLifecyclePort = chrome.runtime.connect({ name: 'v2c-sidepanel-lifecycle' });

// ─── HTML safety helpers ────────────────────────────────────────────────────
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
export function escapeAttr(value) { return escapeHtml(value); }

// ─── Transport ──────────────────────────────────────────────────────────────
export async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

export async function sendToTab(type, extra = {}) {
  const tab = await getActiveTab();
  if (!tab?.id) return;
  // Re-inject content script in case the extension was reloaded without refreshing the page
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content_script.js'] });
  } catch (_) { /* already injected or privileged page — ignore */ }
  try {
    await chrome.tabs.sendMessage(tab.id, { type, ...extra });
  } catch (err) {
    console.error('[V2C] sendMessage failed:', err.message);
  }
}

export function cleanupPageModes() {
  if (store.recording.mode === 'picking') {
    sendToTab('STOP_REGION_PICK').catch(() => {});
    store.recording.mode = 'idle';
  }
  if (store.recording.mode === 'recording') {
    sendToTab('STOP_REGION_TRACKING').catch(() => {});
    store.recording.mode = 'stopped';
  }
}

// ─── Static prompt builder (Recorder mode) ──────────────────────────────────
export function buildStaticRecordingPrompt(recording) {
  const region = recording.selectedRegion;
  if (!region) return 'No recording region selected.';

  const m = region.metadata || {};
  const steps = recording.interactionHints
    .slice(0, 8)
    .map((hint, i) => {
      const target = hint.target?.textContent
        ? `"${hint.target.textContent}" on <${hint.target.tagName}>`
        : `<${hint.target?.tagName || 'element'}>`;
      const detail = hint.value ? ` with value "${hint.value}"` : '';
      return `${i + 1}. ${hint.type} on ${target}${detail}`;
    });

  const rectSamples = recording.trackedRects.length
    ? `${recording.trackedRects.length} tracked position samples were captured for the selected region.`
    : 'No tracked position samples were captured yet.';

  const location = m.componentTree?.length
    ? m.componentTree.map(name => `<${name}>`).join(' > ')
    : `<${m.tagName || 'element'}>`;

  const lines = [
    `Generate an implementation prompt for the interaction that happens within ${location}${m.textContent ? ` around "${m.textContent}"` : ''}.`,
    'Use the observed interaction timeline and preserve the existing interaction intent.',
    '',
    'Observed region',
    `- Selector: ${region.selector || m.cssSelector || 'unknown'}`,
    `- Element: <${m.tagName || 'unknown'}>${m.textContent ? ` with text "${m.textContent}"` : ''}`,
    `- ${rectSamples}`,
    '',
    'Observed interaction hints',
    ...(steps.length ? steps : ['- No interaction hints recorded yet.']),
  ];

  return lines.join('\n');
}

export const CLAUDE_HAIKU_MODEL  = 'claude-haiku-4-5-20251001';
export const GEMINI_FLASH_MODEL  = 'gemini-2.5-flash';
export const GEMINI_FLASH_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_FLASH_MODEL}:generateContent`;

// ─── API key storage ─────────────────────────────────────────────────────────
export async function getApiKey() {
  const result = await chrome.storage.local.get('anthropicApiKey');
  return result.anthropicApiKey || null;
}
export async function saveApiKey(key) {
  await chrome.storage.local.set({ anthropicApiKey: key });
}
export async function clearApiKey() {
  await chrome.storage.local.remove('anthropicApiKey');
}

export async function getGeminiApiKey() {
  const result = await chrome.storage.local.get('geminiApiKey');
  return result.geminiApiKey || null;
}
export async function saveGeminiApiKey(key) {
  await chrome.storage.local.set({ geminiApiKey: key });
}
export async function clearGeminiApiKey() {
  await chrome.storage.local.remove('geminiApiKey');
}

// ─── Model selection ─────────────────────────────────────────────────────────
export async function getSelectedModel() {
  const result = await chrome.storage.local.get('selectedModel');
  return result.selectedModel || 'gemini';
}
export async function saveSelectedModel(model) {
  await chrome.storage.local.set({ selectedModel: model });
}
