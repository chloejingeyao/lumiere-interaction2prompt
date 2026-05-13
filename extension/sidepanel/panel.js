import {
  store,
  escapeHtml,
  getActiveTab, sendToTab, cleanupPageModes, sidepanelLifecyclePort,
  buildStaticRecordingPrompt, CLAUDE_HAIKU_MODEL, GEMINI_FLASH_ENDPOINT,
  getApiKey, saveApiKey, clearApiKey,
  getGeminiApiKey, saveGeminiApiKey, clearGeminiApiKey,
  getSelectedModel, saveSelectedModel,
} from './store.js';

// ─── DOM refs: Settings ──────────────────────────────────────────────────────
const viewMain              = document.getElementById('view-main');
const viewSettings          = document.getElementById('view-settings');
const btnOpenSettings       = document.getElementById('btn-open-settings');
const btnSettingsBack       = document.getElementById('btn-settings-back');
const settingsApiKeyInput   = document.getElementById('settings-api-key-input');
const btnSettingsSave       = document.getElementById('btn-settings-save');
const settingsGeminiInput   = document.getElementById('settings-gemini-key-input');
const btnSettingsSaveGemini = document.getElementById('btn-settings-save-gemini');
const btnSettingsClearKey   = document.getElementById('btn-settings-clear-key');
const settingsSaveStatus    = document.getElementById('settings-save-status');
const modelBtns             = document.querySelectorAll('.model-btn');

// ─── DOM refs: Recorder ─────────────────────────────────────────────────────
const btnRecordingPick       = document.getElementById('btn-recording-pick');
const btnRecordingToggle     = document.getElementById('btn-recording-toggle');
const btnRecordingReset      = document.getElementById('btn-recording-reset');
const recordingEmpty         = document.getElementById('recording-empty');
const recordingSelection     = document.getElementById('recording-selection');
const recordingSelectionBody = document.getElementById('recording-selection-body');
const recordingStatus        = document.getElementById('recording-status');
const recordingEvents        = document.getElementById('recording-events');
const recordingProgressWrap  = document.getElementById('recording-progress-wrap');
const recordingProgressFill  = document.getElementById('recording-progress-fill');
const recordingProgressLabel = document.getElementById('recording-progress-label');
const recordingClipsEl       = document.getElementById('recording-clips');
const btnRecordingGenerate   = document.getElementById('btn-recording-generate');
const recordingPromptOutput  = document.getElementById('recording-prompt-output');
const btnRecordingCopy       = document.getElementById('btn-recording-copy');

// ─── Lifecycle helpers ───────────────────────────────────────────────────────
function syncLifecycleTab(tabId) {
  if (typeof tabId === 'number') sidepanelLifecyclePort.postMessage({ tabId });
}

// ─── Recorder helpers ────────────────────────────────────────────────────────
function setRecordingPickLabel(label) {
  const dot = btnRecordingPick.querySelector('.btn-inspect-dot');
  btnRecordingPick.textContent = label;
  if (dot) btnRecordingPick.prepend(dot);
}

function resetRecordingPromptArea() {
  store.recording.generatedPrompt = null;
  recordingPromptOutput.value = '';
  recordingPromptOutput.classList.add('hidden');
  btnRecordingCopy.classList.add('hidden');
}

function formatRecordingTarget(region) {
  return `<div class="recording-selected-indicator">
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="7" r="6.5" stroke="var(--text)" stroke-width="1.2"/><path d="M4 7l2 2 4-4" stroke="var(--text)" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
    <span>Element selected</span>
  </div>`;
}

function updateRecordingButtons() {
  const hasRegion   = !!store.recording.selectedRegion;
  const isRecording = store.recording.mode === 'recording';
  const hasClip     = store.recording.clips.length > 0;
  btnRecordingToggle.disabled = !hasRegion;
  btnRecordingToggle.textContent = isRecording ? 'Stop' : (hasClip ? 'Record Again' : 'Record Clip');
  btnRecordingGenerate.disabled = !hasClip;
}

function setRecordingError(msg) {
  store.recording.errorMessage = msg;
  recordingStatus.textContent = msg;
  recordingStatus.style.color = msg ? 'var(--destructive, #dc2626)' : '';
}

function clearRecordingError() {
  store.recording.errorMessage = null;
  recordingStatus.style.color = '';
}

function updateRecordingStatus() {
  if (store.recording.errorMessage) return; // keep error visible
  const { mode, clips } = store.recording;
  const labels = {
    idle: '',
    ready: clips.length ? 'Clip recorded' : 'Record a 10-second clip',
    recording: 'Recording…',
    stopped: 'Clip recorded',
  };
  recordingStatus.textContent = labels[mode] || '';
}

function renderRecordingEvents() {
  // Events are rendered inside each clip card — hide the standalone list
  recordingEvents.classList.add('hidden');
  recordingEvents.innerHTML = '';
}

function renderRecordingClips() {
  const clips = store.recording.clips;
  if (clips.length === 0) {
    recordingClipsEl.innerHTML = '';
    return;
  }
  recordingClipsEl.innerHTML = clips.map((clip, i) => `
    <div class="recording-clip" data-clip-index="${i}">
      <div class="recording-clip-header">
        <span class="recording-clip-label">Recording</span>
        <button class="recording-clip-remove" data-remove="${i}">Remove</button>
      </div>
      ${clip.videoDataUrl ? `<video src="${clip.videoDataUrl}" controls playsinline></video>` : '<div class="recording-meta">No video</div>'}
    </div>`).join('');

  recordingClipsEl.querySelectorAll('[data-remove]').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.remove, 10);
      store.recording.clips.splice(idx, 1);
      renderRecordingPane();
    });
  });
}

function renderRecordingPane() {
  const region = store.recording.selectedRegion;
  recordingEmpty.classList.toggle('hidden', !!region);
  recordingSelection.classList.toggle('hidden', !region);
  recordingSelectionBody.innerHTML = region ? formatRecordingTarget(region) : '';
  updateRecordingStatus();
  updateRecordingButtons();
  renderRecordingClips();
  renderRecordingEvents();
}

function stopRecorderPickMode() {
  if (store.recording.mode !== 'picking') return;
  store.recording.mode = store.recording.selectedRegion ? 'ready' : 'idle';
  setRecordingPickLabel('Select Element');
  btnRecordingPick.classList.remove('active');
  sendToTab('STOP_REGION_PICK').catch(console.error);
  renderRecordingPane();
}

// Pick up to `max` frames, prioritizing frames near user actions
function smartSampleFrames(frames, hints, max = 12) {
  if (frames.length === 0) return [];
  if (frames.length <= max) return frames;

  const indices = new Set();
  indices.add(0);
  indices.add(frames.length - 1);

  // Add frames within ±600ms of each interaction hint
  if (hints.length > 0) {
    const startTs = hints[0].ts; // ms absolute
    for (const hint of hints) {
      const hSec = (hint.ts - startTs) / 1000;
      for (let i = 0; i < frames.length; i++) {
        if (Math.abs(frames[i].ts - hSec) <= 0.6) indices.add(i);
      }
    }
  }

  // Fill remaining slots with evenly-spaced frames
  for (let i = 0; i < max && indices.size < max; i++) {
    indices.add(Math.round((i / (max - 1)) * (frames.length - 1)));
  }

  return [...indices].sort((a, b) => a - b).slice(0, max).map(i => frames[i]);
}

const ANALYZE_SYSTEM_PROMPT = `You are an expert UI interaction analyst. From the chronological key frames, write a developer-ready implementation note for the highlighted target element.

Goal: capture the interaction behavior and generate prompts for the coding agents to replicate for high-fidelity implementation.

Context:
- Key frames are shown in chronological order.
- Each frame shows the full page.
- The TARGET ELEMENT is marked with a purple border and overlay.
- User events (hover, click, input, etc.) are annotated next to the relevant frame.
- Ignore unrelated page changes unless they are clearly caused by the target element.

Output format:
- Output exactly in compact paragraphs and short sentences
- Output ONLY the implementation prompt for the coding agent.
- NO preambles, NO closing thoughts, NO frame-by-frame narration, NO Q&A formats.

Core rules:
- First infer the canonical element type (for example: button, dropdown trigger, tab, accordion, menu item, carousel control, input, tooltip trigger, modal trigger, navigation item).
- Analyze visual hierarchy as state: Identify if variations in font size, weight, or scale represent "active," "focused," or "selected" states within a group of elements.
- Describe only behavior that is directly visible and non-standard for that element type.
- Focus only on behavior needed for faithful implementation:
  - trigger -> visible response
  - relationship between the target and any directly controlled UI
  - whether the state persists, resets, collapses, transfers, or closes
  - animation direction and feel only when clearly visible

Do not include:
- frame-by-frame narration
- specific text, labels, values, content, routes, HTML, code, or data seen in the frames
- off-screen behavior, app logic, or anything not visibly confirmed
- static styling such as colors, typography, borders, spacing, or shadows. Do not ignore if the styling changes to indicate a state.
- generic defaults for the element type

Treat these as generic defaults and MUST omit them unless implemented in a clearly UNUSUAL way:
- buttons being clickable
- links navigating
- inputs accepting text
- menus opening on click
- tabs switching panels
- accordions expanding/collapsing
- navigation opening a destination

You MUST mention visual cues, animations, and transitions when they change because of the interaction of the element, such as:
- an indicator appearing/disappearing
- an icon rotating
- an item becoming highlighted/selected
- a panel/menu/tooltip appearing or collapsing from the sidebar
- a preview swapping
- a card sliding out
- a state being pinned, locked, or reset

Decision rules:
- Prefer omission over guessing.
- If a behavior is ambiguous or only partially visible, do not mention it.
- Mention animation only when it is clearly perceptible and important to fidelity.
- Do not mention the frames, annotations, or purple highlight in the output.

Fallback:
- If the interaction is entirely standard, just one sentence summary of that element

Style:
- Be concrete, compressed, and implementation-ready.
- Use direct verbs such as reveals, expands, collapses, persists, resets, anchors, crossfades, slides, snaps, locks.`;

// Build annotated frame list shared by both model callers
function annotatedFrames(frames, interactionHints) {
  const recordingStart = interactionHints.length > 0 ? interactionHints[0].ts : null;
  function eventsNear(ts) {
    if (!recordingStart) return [];
    return interactionHints.filter(h => Math.abs((h.ts - recordingStart) / 1000 - ts) <= 0.3);
  }
  function describeEvent(h) {
    const label = h.target?.textContent
      ? `"${h.target.textContent}" <${h.target.tagName}>`
      : `<${h.target?.tagName || 'element'}>`;
    return `${h.type} on ${label}${h.value ? ` → "${h.value}"` : ''}`;
  }
  return frames.slice(0, 12).flatMap(frame => {
    if (!frame.dataUrl) return [];
    const comma = frame.dataUrl.indexOf(',');
    if (comma === -1) return [];
    const mediaType = frame.dataUrl.slice(0, comma).match(/:(.*?);/)?.[1] || 'image/jpeg';
    const data = frame.dataUrl.slice(comma + 1);
    const nearby = eventsNear(frame.ts);
    const annotation = nearby.length ? ' — ' + nearby.map(describeEvent).join(' | ') : '';
    return [{ ts: frame.ts, annotation, mediaType, data }];
  });
}

async function callAnalyzeClaude(frames, interactionHints, apiKey) {
  const parts = [{ type: 'text', text: ANALYZE_SYSTEM_PROMPT }];
  for (const f of annotatedFrames(frames, interactionHints)) {
    parts.push({ type: 'text', text: `Frame at t=${f.ts.toFixed(1)}s${f.annotation}` });
    parts.push({ type: 'image', source: { type: 'base64', media_type: f.mediaType, data: f.data } });
  }
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: CLAUDE_HAIKU_MODEL,
      max_tokens: 1024,
      messages: [{ role: 'user', content: parts }],
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message || `HTTP ${res.status}`);
  }
  const raw = await res.json();
  return { prompt: raw.content?.[0]?.text || '' };
}

async function callAnalyzeGemini(frames, interactionHints, apiKey) {
  const parts = [{ text: ANALYZE_SYSTEM_PROMPT }];
  for (const f of annotatedFrames(frames, interactionHints)) {
    parts.push({ text: `Frame at t=${f.ts.toFixed(1)}s${f.annotation}` });
    parts.push({ inline_data: { mime_type: f.mediaType, data: f.data } });
  }
  const res = await fetch(`${GEMINI_FLASH_ENDPOINT}?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts }],
      generationConfig: { temperature: 0.3, maxOutputTokens: 1024 },
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message || `HTTP ${res.status}`);
  }
  const raw = await res.json();
  return { prompt: raw.candidates?.[0]?.content?.parts?.[0]?.text || '' };
}

async function callAnalyzeInteraction(frames, metadata, interactionHints) {
  const model = await getSelectedModel();
  if (model === 'gemini') {
    const apiKey = await getGeminiApiKey();
    if (!apiKey) throw new Error('NO_API_KEY');
    return callAnalyzeGemini(frames, interactionHints, apiKey);
  }
  const apiKey = await getApiKey();
  if (!apiKey) throw new Error('NO_API_KEY');
  return callAnalyzeClaude(frames, interactionHints, apiKey);
}

// ─── Settings panel ──────────────────────────────────────────────────────────
function showSettingsStatus(msg, type = '') {
  settingsSaveStatus.textContent = msg;
  settingsSaveStatus.className = `settings-save-status${type ? ' ' + type : ''}`;
  settingsSaveStatus.classList.remove('hidden');
}

async function openSettings(notice = '') {
  const [claudeKey, geminiKey, model] = await Promise.all([getApiKey(), getGeminiApiKey(), getSelectedModel()]);
  settingsApiKeyInput.value = claudeKey ? '•'.repeat(24) : '';
  settingsApiKeyInput.dataset.hasKey = claudeKey ? '1' : '';
  settingsGeminiInput.value = geminiKey ? '•'.repeat(24) : '';
  settingsGeminiInput.dataset.hasKey = geminiKey ? '1' : '';
  setActiveModelBtn(model);
  settingsSaveStatus.className = 'settings-save-status hidden';
  settingsSaveStatus.textContent = '';
  if (notice) showSettingsStatus(notice, 'error');
  viewMain.classList.add('hidden');
  viewSettings.classList.remove('hidden');
}

function closeSettings() {
  viewSettings.classList.add('hidden');
  viewMain.classList.remove('hidden');
}

const keyPanelClaude = document.getElementById('settings-key-claude');
const keyPanelGemini = document.getElementById('settings-key-gemini');

function setActiveModelBtn(model) {
  modelBtns.forEach(btn => btn.classList.toggle('active', btn.dataset.model === model));
  keyPanelClaude.classList.toggle('hidden', model !== 'claude');
  keyPanelGemini.classList.toggle('hidden', model !== 'gemini');
}

btnOpenSettings.addEventListener('click', () => openSettings());
btnSettingsBack.addEventListener('click', closeSettings);

modelBtns.forEach(btn => {
  btn.addEventListener('click', async () => {
    await saveSelectedModel(btn.dataset.model);
    setActiveModelBtn(btn.dataset.model);
    updateApiKeyBanner();
  });
});

function clearInputOnFocus(input) {
  input.addEventListener('focus', () => {
    if (input.dataset.hasKey) { input.value = ''; delete input.dataset.hasKey; }
  });
}
clearInputOnFocus(settingsApiKeyInput);
clearInputOnFocus(settingsGeminiInput);

btnSettingsSave.addEventListener('click', async () => {
  const key = settingsApiKeyInput.value.trim();
  if (!key || key.includes('•')) { showSettingsStatus('Enter a valid API key.', 'error'); return; }
  await saveApiKey(key);
  settingsApiKeyInput.value = '•'.repeat(24);
  settingsApiKeyInput.dataset.hasKey = '1';
  showSettingsStatus('Anthropic key saved.', 'success');
  updateApiKeyBanner();
});

btnSettingsSaveGemini.addEventListener('click', async () => {
  const key = settingsGeminiInput.value.trim();
  if (!key || key.includes('•')) { showSettingsStatus('Enter a valid API key.', 'error'); return; }
  await saveGeminiApiKey(key);
  settingsGeminiInput.value = '•'.repeat(24);
  settingsGeminiInput.dataset.hasKey = '1';
  showSettingsStatus('Gemini key saved.', 'success');
  updateApiKeyBanner();
});

btnSettingsClearKey.addEventListener('click', async () => {
  await Promise.all([clearApiKey(), clearGeminiApiKey()]);
  settingsApiKeyInput.value = '';
  delete settingsApiKeyInput.dataset.hasKey;
  settingsGeminiInput.value = '';
  delete settingsGeminiInput.dataset.hasKey;
  showSettingsStatus('All keys cleared.', '');
  updateApiKeyBanner();
});

// Show/hide "no API key" notice based on which model is active
const apiKeyNotice = document.getElementById('api-key-notice');
async function updateApiKeyBanner() {
  if (!apiKeyNotice) return;
  const [model, claudeKey, geminiKey] = await Promise.all([getSelectedModel(), getApiKey(), getGeminiApiKey()]);
  const hasKey = model === 'gemini' ? !!geminiKey : !!claudeKey;
  apiKeyNotice.classList.toggle('hidden', hasKey);
}
if (apiKeyNotice) apiKeyNotice.addEventListener('click', () => openSettings());

// ─── Recording timers ────────────────────────────────────────────────────────
let recordingAutoStopTimer = null;
let recordingCountdownTimer = null;
const MAX_CLIP_DURATION_MS = 10000;

async function startRecorderSession() {
  if (!store.recording.selectedRegion) return;
  // Clear any previous clip before recording a new one
  store.recording.clips = [];
  clearRecordingError();
  const tab = await getActiveTab();
  if (!tab?.id) return;

  const region = store.recording.selectedRegion;

  const response = await chrome.runtime.sendMessage({
    type: 'START_RECORDING_SESSION',
    tabId: tab.id,
    region,
  });
  if (!response?.ok) throw new Error(response?.error || 'Failed to start recording');

  store.recording.mode          = 'recording';
  store.recording.tabId         = tab.id;
  store.recording.sessionId     = response.sessionId;
  store.recording.startedAt     = Date.now();
  store.recording.stoppedAt     = null;
  store.recording.trackedRects  = [];
  store.recording.interactionHints = [];
  resetRecordingPromptArea();

  let captureRes;
  try {
    captureRes = await chrome.runtime.sendMessage({
      type: 'START_TAB_CAPTURE',
      tabId: tab.id,
      region: null,
      viewport: null,
    });
  } catch (err) {
    captureRes = { ok: false, error: err.message };
  }

  if (!captureRes?.ok) {
    // Revert state — capture never started
    store.recording.mode      = 'ready';
    store.recording.sessionId = null;
    renderRecordingPane();
    setRecordingError(`Recording failed: ${captureRes?.error || 'could not start screen capture'}`);
    return;
  }

  await sendToTab('START_REGION_TRACKING', { sessionId: response.sessionId });
  renderRecordingPane();

  // Progress bar countdown
  const totalSecs = MAX_CLIP_DURATION_MS / 1000;
  let remaining = totalSecs;
  recordingStatus.textContent = 'Recording…';

  // Start fill at 100% width, animate to 0% over the clip duration
  recordingProgressFill.style.transition = 'none';
  recordingProgressFill.style.width = '100%';
  recordingProgressWrap.classList.remove('hidden');
  requestAnimationFrame(() => requestAnimationFrame(() => {
    recordingProgressFill.style.transition = `width ${MAX_CLIP_DURATION_MS}ms linear`;
    recordingProgressFill.style.width = '0%';
  }));

  recordingProgressLabel.textContent = `${remaining}s`;
  recordingCountdownTimer = setInterval(() => {
    remaining = Math.max(0, remaining - 1);
    recordingProgressLabel.textContent = `${remaining}s`;
  }, 1000);

  // Auto-stop after 5 seconds
  recordingAutoStopTimer = setTimeout(async () => {
    if (store.recording.mode === 'recording') {
      await stopRecorderSession();
    }
  }, MAX_CLIP_DURATION_MS);
}

async function stopRecorderSession() {
  if (!store.recording.sessionId) return;

  // Clear timers and progress bar
  if (recordingAutoStopTimer)  { clearTimeout(recordingAutoStopTimer);   recordingAutoStopTimer  = null; }
  if (recordingCountdownTimer) { clearInterval(recordingCountdownTimer); recordingCountdownTimer = null; }
  recordingProgressWrap.classList.add('hidden');
  recordingProgressFill.style.transition = 'none';
  recordingProgressFill.style.width = '100%';

  // Immediately flip UI so the button never feels stuck
  const sessionId = store.recording.sessionId;
  store.recording.mode      = 'stopped';
  store.recording.stoppedAt = Date.now();
  recordingStatus.textContent = 'Processing video…';
  btnRecordingToggle.disabled = true;
  renderRecordingPane();

  // Stop region tracking right away (non-blocking)
  sendToTab('STOP_REGION_TRACKING').catch(() => {});
  chrome.runtime.sendMessage({ type: 'STOP_RECORDING_SESSION', sessionId }).catch(() => {});

  // Collect frames + video from offscreen with a 8-second timeout
  let clipFrames = [];
  let clipVideo  = null;
  try {
    const captureRes = await Promise.race([
      chrome.runtime.sendMessage({ type: 'STOP_TAB_CAPTURE' }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 8000)),
    ]).catch(() => ({ frames: [], videoDataUrl: null }));

    clipFrames = captureRes?.frames || [];
    clipVideo  = captureRes?.videoDataUrl || null;
  } catch (_) { /* empty clip */ }

  // Add clip to list, or tell the user nothing came back
  if (clipVideo || clipFrames.length > 0) {
    store.recording.clips.push({ videoDataUrl: clipVideo, frames: clipFrames });
  } else {
    store.recording.mode = 'ready';
    renderRecordingPane();
    setRecordingError('Recording failed — no video was captured. Try again.');
    return;
  }

  store.recording.mode = 'ready';
  renderRecordingPane();
}

// ─── Recorder controls ──────────────────────────────────────────────────────
function resetRecordingState() {
  clearRecordingError();
  const currentSessionId = store.recording.sessionId;
  const wasRecording     = store.recording.mode === 'recording';
  if (recordingAutoStopTimer)  { clearTimeout(recordingAutoStopTimer);   recordingAutoStopTimer  = null; }
  if (recordingCountdownTimer) { clearInterval(recordingCountdownTimer); recordingCountdownTimer = null; }
  recordingProgressWrap.classList.add('hidden');
  recordingProgressFill.style.transition = 'none';
  recordingProgressFill.style.width = '100%';
  store.recording.mode           = 'idle';
  store.recording.tabId          = null;
  store.recording.sessionId      = null;
  store.recording.selectedRegion = null;
  store.recording.trackedRects   = [];
  store.recording.interactionHints = [];
  store.recording.clips            = [];
  store.recording.startedAt      = null;
  store.recording.stoppedAt      = null;
  setRecordingPickLabel('Select Element');
  if (wasRecording) chrome.runtime.sendMessage({ type: 'STOP_TAB_CAPTURE' }).catch(() => {});
  btnRecordingPick.classList.remove('active');
  sendToTab('STOP_REGION_PICK').catch(console.error);
  sendToTab('STOP_REGION_TRACKING').catch(console.error);
  sendToTab('CLEAR_REGION').catch(console.error);
  if (currentSessionId) chrome.runtime.sendMessage({ type: 'RESET_RECORDING_SESSION', sessionId: currentSessionId }).catch(() => {});
  resetRecordingPromptArea();
  renderRecordingPane();
}

btnRecordingPick.addEventListener('click', () => {
  if (store.recording.mode === 'picking') {
    stopRecorderPickMode();
    return;
  }
  // Clear any previous selection before starting a new pick
  if (store.recording.selectedRegion) {
    sendToTab('CLEAR_REGION').catch(() => {});
    store.recording.selectedRegion = null;
    store.recording.mode = 'idle';
    clearRecordingError();
  }
  store.recording.mode = 'picking';
  setRecordingPickLabel('Cancel');
  btnRecordingPick.classList.add('active');
  sendToTab('START_REGION_PICK').catch(console.error);
  renderRecordingPane();
});

btnRecordingToggle.addEventListener('click', async () => {
  if (btnRecordingToggle.dataset.busy === '1') return;  // guard against double-clicks
  btnRecordingToggle.dataset.busy = '1';
  try {
    if (store.recording.mode === 'recording') {
      await stopRecorderSession();
    } else {
      await startRecorderSession();
    }
  } catch (err) {
    recordingStatus.textContent = `Error: ${err.message}`;
  } finally {
    delete btnRecordingToggle.dataset.busy;
  }
});

btnRecordingReset.addEventListener('click', resetRecordingState);

btnRecordingGenerate.addEventListener('click', async () => {
  const { clips, interactionHints, selectedRegion } = store.recording;
  const clip = clips[0];
  const allFrames = smartSampleFrames(clip?.frames || [], interactionHints, 12);
  const hasFrames = allFrames.length > 0;

  btnRecordingGenerate.disabled     = true;
  btnRecordingGenerate.textContent  = hasFrames ? 'Analyzing…' : 'Generating…';
  recordingPromptOutput.classList.add('hidden');
  btnRecordingCopy.classList.add('hidden');

  try {
    if (hasFrames) {
      const result = await callAnalyzeInteraction(
        allFrames,
        selectedRegion?.metadata ?? {},
        interactionHints,
      );
      store.recording.generatedPrompt = result.prompt || result.summary || JSON.stringify(result);
    } else {
      store.recording.generatedPrompt = buildStaticRecordingPrompt(store.recording);
    }
  } catch (err) {
    if (err.message === 'NO_API_KEY') {
      btnRecordingGenerate.disabled    = false;
      btnRecordingGenerate.textContent = 'Generate Prompt';
      openSettings('Add your Anthropic API key to generate prompts.');
      return;
    }
    console.error('[V2C] analyze-interaction failed:', err);
    store.recording.generatedPrompt = buildStaticRecordingPrompt(store.recording);
  }

  recordingPromptOutput.value = store.recording.generatedPrompt;
  recordingPromptOutput.classList.remove('hidden');
  btnRecordingCopy.classList.remove('hidden');
  btnRecordingGenerate.disabled    = false;
  btnRecordingGenerate.textContent = 'Generate Prompt';
});

btnRecordingCopy.addEventListener('click', () => {
  if (!recordingPromptOutput.value) return;
  navigator.clipboard.writeText(recordingPromptOutput.value).then(() => {
    btnRecordingCopy.textContent = 'Copied!';
    setTimeout(() => { btnRecordingCopy.textContent = 'Copy'; }, 1500);
  });
});

// ─── Keyboard shortcuts ──────────────────────────────────────────────────────
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (store.recording.mode === 'picking') stopRecorderPickMode();
});

// ─── Tab activation ──────────────────────────────────────────────────────────
chrome.tabs.onActivated.addListener(({ tabId }) => {
  if (store.recording.mode === 'recording' && store.recording.tabId !== null && tabId !== store.recording.tabId) {
    sendToTab('STOP_REGION_TRACKING').catch(() => {});
    store.recording.mode = 'stopped';
    store.recording.stoppedAt = Date.now();
    renderRecordingPane();
  }
});

// ─── Lifecycle cleanup ───────────────────────────────────────────────────────
window.addEventListener('pagehide',    cleanupPageModes);
window.addEventListener('beforeunload', cleanupPageModes);
window.addEventListener('unload',       cleanupPageModes);

// ─── Message handler (transport layer) ──────────────────────────────────────
async function handlePanelEvent(message, sender) {
  if (message?.type !== 'V2C_PANEL_EVENT') return;

  const senderTabId = sender.tab?.id;
  const activeTab   = await getActiveTab();
  if (!senderTabId || senderTabId !== activeTab?.id) return;

  if (message.eventType === 'REGION_PICK_CANCELLED') {
    stopRecorderPickMode();
    return;
  }

  if (message.eventType === 'REGION_SELECTED' && message.payload) {
    store.recording.selectedRegion = message.payload;
    store.recording.mode = 'ready';
    store.recording.tabId = senderTabId;
    syncLifecycleTab(senderTabId);
    setRecordingPickLabel('Select Element');
    btnRecordingPick.classList.remove('active');
    resetRecordingPromptArea();
    renderRecordingPane();
    return;
  }

  if (message.eventType === 'REGION_TRACK' && message.payload) {
    if (message.payload.sessionId && store.recording.sessionId && message.payload.sessionId !== store.recording.sessionId) return;
    store.recording.trackedRects.push(message.payload);
    if (store.recording.trackedRects.length > 120) store.recording.trackedRects.shift();
    renderRecordingPane();
    return;
  }

  if (message.eventType === 'INTERACTION_HINT' && message.payload) {
    if (message.payload.sessionId && store.recording.sessionId && message.payload.sessionId !== store.recording.sessionId) return;
    store.recording.interactionHints.push(message.payload);
    if (store.recording.interactionHints.length > 40) store.recording.interactionHints.shift();
    updateRecordingButtons();
    updateRecordingStatus();
    renderRecordingEvents();
    return;
  }

  if (message.eventType === 'RECORDING_STARTED' && message.payload) {
    store.recording.mode = 'recording';
    store.recording.sessionId = message.payload.sessionId;
    store.recording.startedAt = message.payload.startedAt;
    renderRecordingPane();
    return;
  }

  if (message.eventType === 'RECORDING_STOPPED' && message.payload) {
    // Only update if we haven't already transitioned (stopRecorderSession sets mode to ready/stopped)
    if (store.recording.mode === 'recording') {
      store.recording.mode = 'stopped';
      store.recording.stoppedAt = message.payload.stoppedAt;
      renderRecordingPane();
    }
  }
}

chrome.runtime.onMessage.addListener((message, sender) => {
  handlePanelEvent(message, sender).catch(console.error);
});

// ─── Initial render ──────────────────────────────────────────────────────────
renderRecordingPane();
updateApiKeyBanner();
