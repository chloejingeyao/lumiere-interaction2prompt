import {
  store,
  escapeHtml, escapeAttr,
  getActiveTab, sendToTab, cleanupPageModes, sidepanelLifecyclePort,
  buildStaticPrompt, buildStaticAnnotatorPrompt, callClaudeHaiku, PROXY_URL,
  hsvToRgba, rgbaToHex, parseColor,
  FONT_LIST, weightLabel,
} from './store.js';

// ─── DOM refs: Main view ────────────────────────────────────────────────────
const viewMain       = document.getElementById('view-main');
const btnInspect     = document.getElementById('btn-inspect');
const itemsLabel     = document.getElementById('items-label');
const btnReset       = document.getElementById('btn-reset');
const itemsEmpty     = document.getElementById('items-empty');
const itemsContainer = document.getElementById('items-container');
const btnAddElement  = document.getElementById('btn-add-element');
const btnGenerate    = document.getElementById('btn-generate');
const promptPreview  = document.getElementById('prompt-text');
const btnCopy        = document.getElementById('btn-copy');

// ─── DOM refs: Annotator ────────────────────────────────────────────────────
const modeTabs        = document.querySelector('.mode-tabs');
const modePrompt      = document.getElementById('mode-prompt');
const modeAnnotator   = document.getElementById('mode-annotator');
const btnAnnPick      = document.getElementById('btn-ann-pick');
const annLabelEl      = document.getElementById('ann-label');
const btnAnnReset     = document.getElementById('btn-ann-reset');
const annListEl       = document.getElementById('ann-list');
const annEmptyEl      = document.getElementById('ann-empty');
const btnAnnGenerate  = document.getElementById('btn-ann-generate');
const annPromptOutput = document.getElementById('ann-prompt-output');
const btnAnnCopy      = document.getElementById('btn-ann-copy');
const btnAnnAdd       = document.getElementById('btn-ann-add');

// ─── DOM refs: Picker view ──────────────────────────────────────────────────
const viewPicker   = document.getElementById('view-picker');
const btnBack      = document.getElementById('btn-back');
const pickerTitle  = document.getElementById('picker-title');
const pickerSearch = document.getElementById('picker-search');
const pickerList   = document.getElementById('picker-list');

// ─── DOM refs: Color picker view ────────────────────────────────────────────
const viewColor     = document.getElementById('view-color');
const btnColorBack  = document.getElementById('btn-color-back');
const cpCanvas      = document.getElementById('cp-canvas');
const cpCursor      = document.getElementById('cp-cursor');
const cpHueCanvas   = document.getElementById('cp-hue');
const cpHueThumb    = document.getElementById('cp-hue-thumb');
const cpAlphaCanvas = document.getElementById('cp-alpha');
const cpAlphaThumb  = document.getElementById('cp-alpha-thumb');
const cpPreview     = document.getElementById('cp-preview');
const cpHexInput    = document.getElementById('cp-hex');
const cpAlphaInput  = document.getElementById('cp-alpha-val');
const btnColorApply = document.getElementById('btn-color-apply');
const cpPickerTitle = document.getElementById('color-picker-title');

// ─── Init: load components ──────────────────────────────────────────────────
fetch(chrome.runtime.getURL('../ui-components.json'))
  .then(r => r.json())
  .then(data => { store.components = data; });

// ─── HTML builder helpers ───────────────────────────────────────────────────
function buildMetadataRows(m) {
  const componentRow = m.componentTree?.length
    ? `<div class="source-row">
         <span class="source-key">Component</span>
         <span class="source-val mono">${m.componentTree.map(n => `&lt;${escapeHtml(n)}&gt;`).join(' › ')}</span>
       </div>`
    : '';
  const elementRow = `<div class="source-row">
    <span class="source-key">Element</span>
    <span class="source-val mono">&lt;${escapeHtml(m.tagName)}&gt;</span>
  </div>`;
  const textRow = m.textContent
    ? `<div class="source-row">
         <span class="source-key">Text</span>
         <span class="source-val">&ldquo;${escapeHtml(m.textContent)}&rdquo;</span>
       </div>`
    : '';
  const handlersRow = m.eventHandlers?.length
    ? `<div class="source-row">
         <span class="source-key">Handlers</span>
         <div class="chips-row">${m.eventHandlers.map(h => `<span class="handler-chip">${escapeHtml(h.event)}: ${escapeHtml(h.handlerName)}</span>`).join('')}</div>
       </div>`
    : '';
  return componentRow + elementRow + textRow + handlersRow;
}

function buildStylingRow(m, options = {}) {
  const { expandable = false, stylesOpen = false, toggleIndex = null } = options;
  if (!m.cssFramework || m.cssFramework === 'unknown') return '';
  const hasStyles     = m.styles && Object.keys(m.styles).length > 0;
  const stylesListHtml = hasStyles
    ? `<div class="styles-list chips-indent${stylesOpen ? '' : ' hidden'}">
         ${Object.entries(m.styles).map(([k, v]) =>
           `<div class="style-row"><span class="style-key">${escapeHtml(k)}</span><span class="style-val">${escapeHtml(v)}</span></div>`
         ).join('')}
       </div>`
    : '';
  if (!expandable) {
    return `<div class="source-row">
      <span class="source-key">Styling</span>
      <span class="chip-tag">${escapeHtml(m.cssFramework)}</span>
    </div>`;
  }
  return `<div class="source-row">
    <span class="source-key">Styling</span>
    <div class="styling-col">
      <div class="styling-framework-row">
        <span class="chip-tag">${escapeHtml(m.cssFramework)}</span>
        ${hasStyles ? `<button class="item-styles-toggle" data-index="${toggleIndex}">
          <span class="toggle-arrow" style="transform:rotate(${stylesOpen ? 90 : 0}deg)">›</span>
        </button>` : ''}
      </div>
      ${stylesListHtml}
    </div>
  </div>`;
}

function renderSharedCard({ cardClass = '', dataAttrs = '', removeClass = '', removeAttrs = '', removeTitle = 'Remove', bodyHtml = '', footerHtml = '' }) {
  return `
    <div class="item-card ${cardClass}" ${dataAttrs}>
      <div class="item-card-body">
        <button class="item-remove ${removeClass}" ${removeAttrs} title="${escapeAttr(removeTitle)}">×</button>
        ${bodyHtml}
      </div>
      ${footerHtml}
    </div>`;
}

// ─── Navigation ─────────────────────────────────────────────────────────────
function showMain() {
  viewMain.classList.remove('hidden');
  viewPicker.classList.add('hidden');
  pickerSearch.value = '';
}

function showPicker(index) {
  store.pickerForIndex = index;
  pickerTitle.textContent = '';
  viewMain.classList.add('hidden');
  viewPicker.classList.remove('hidden');
  pickerSearch.value = '';
  renderPickerList('');
  pickerSearch.focus();
}

btnBack.addEventListener('click', showMain);

// ─── Mode tabs ───────────────────────────────────────────────────────────────
modeTabs.addEventListener('click', (e) => {
  const tab = e.target.closest('.mode-tab');
  if (!tab) return;
  const mode = tab.dataset.mode;
  modeTabs.querySelectorAll('.mode-tab').forEach(t => t.classList.toggle('active', t === tab));

  if (mode === 'prompt') {
    modePrompt.classList.remove('hidden');
    modeAnnotator.classList.add('hidden');
    btnInspect.classList.remove('hidden');
    btnAnnPick.classList.add('hidden');
    store.annMode = 'off';
    store.activeAnnotationId = null;
    setAnnPickLabel('Annotate Element');
    btnAnnPick.classList.remove('active');
    sendToTab('STOP_ANNOTATOR').catch(console.error);
    renderAnnotations();
  } else if (mode === 'annotator') {
    modePrompt.classList.add('hidden');
    modeAnnotator.classList.remove('hidden');
    btnInspect.classList.add('hidden');
    btnAnnPick.classList.remove('hidden');
    if (store.inspecting) {
      store.inspecting      = false;
      store.inspectingTabId = null;
      setInspectLabel('Select Element');
      btnInspect.classList.remove('active');
      sendToTab('STOP_INSPECTION').catch(console.error);
    }
    store.annMode = 'off';
    setAnnPickLabel('Annotate Element');
    btnAnnPick.classList.remove('active');
  }
});

// ─── Label helpers ───────────────────────────────────────────────────────────
function setInspectLabel(label) {
  const dot = btnInspect.querySelector('.btn-inspect-dot');
  btnInspect.textContent = label;
  if (dot) btnInspect.prepend(dot);
}

function setAnnPickLabel(label) {
  const dot = btnAnnPick.querySelector('.btn-inspect-dot');
  btnAnnPick.textContent = label;
  if (dot) btnAnnPick.prepend(dot);
}

function syncLifecycleTab(tabId) {
  if (typeof tabId === 'number') sidepanelLifecyclePort.postMessage({ tabId });
}

// ─── Annotator controls ──────────────────────────────────────────────────────
function updateAnnHeader() {
  annLabelEl.classList.toggle('hidden', store.annAnnotations.length === 0);
}

function stopAnnotatorMode() {
  if (store.annMode === 'inspect') {
    if (store.annotatingTabId != null) chrome.tabs.sendMessage(store.annotatingTabId, { type: 'STOP_INSPECT' }).catch(() => {});
    else sendToTab('STOP_INSPECT').catch(console.error);
  } else if (store.annMode === 'comment') {
    if (store.annotatingTabId != null) chrome.tabs.sendMessage(store.annotatingTabId, { type: 'ANN_STOP_COMMENT' }).catch(() => {});
    else sendToTab('ANN_STOP_COMMENT').catch(console.error);
  }
  store.annMode = 'off';
  store.annotatingTabId = null;
  store.activeAnnotationId = null;
  setAnnPickLabel('Annotate Element');
  btnAnnPick.classList.remove('active');
}

btnAnnPick.addEventListener('click', () => {
  if (store.annMode === 'inspect') {
    store.annMode = 'off';
    store.annotatingTabId = null;
    setAnnPickLabel('Annotate Element');
    btnAnnPick.classList.remove('active');
    sendToTab('STOP_INSPECT').catch(console.error);
  } else {
    if (store.annMode === 'comment') sendToTab('ANN_STOP_COMMENT').catch(console.error);
    store.annMode = 'inspect';
    setAnnPickLabel('Cancel');
    btnAnnPick.classList.add('active');
    getActiveTab().then(tab => {
      store.annotatingTabId = tab?.id ?? null;
      syncLifecycleTab(store.annotatingTabId);
    });
    sendToTab('START_ANNOTATOR').catch(console.error);
  }
});

btnAnnReset.addEventListener('click', () => {
  store.annAnnotations = [];
  store.annStylesExpanded = new Set();
  store.activeAnnotationId = null;
  store.annMode = 'off';
  store.annotatingTabId = null;
  setAnnPickLabel('Annotate Element');
  btnAnnPick.classList.remove('active');
  sendToTab('STOP_ANNOTATOR').catch(console.error);
  renderAnnotations();
  updateAnnHeader();
});

btnAnnAdd.addEventListener('click', () => {
  if (store.annMode === 'comment') sendToTab('ANN_STOP_COMMENT').catch(console.error);
  store.annMode = 'inspect';
  setAnnPickLabel('Cancel');
  btnAnnPick.classList.add('active');
  getActiveTab().then(tab => {
    store.annotatingTabId = tab?.id ?? null;
    syncLifecycleTab(store.annotatingTabId);
  });
  sendToTab('START_ANNOTATOR').catch(console.error);
});

// ─── Annotator render ────────────────────────────────────────────────────────
function updateAnnGenerateButton() {
  btnAnnGenerate.disabled = !store.annAnnotations.some(a => a.comments.length > 0);
}

function renderAnnotations() {
  if (store.annAnnotations.length === 0) {
    annListEl.innerHTML = '';
    annEmptyEl.classList.remove('hidden');
    btnAnnAdd.classList.add('hidden');
    annPromptOutput.classList.add('hidden');
    btnAnnCopy.classList.add('hidden');
    btnAnnGenerate.disabled = true;
    return;
  }
  annEmptyEl.classList.add('hidden');
  btnAnnAdd.classList.remove('hidden');

  annListEl.innerHTML = store.annAnnotations.map((ann) => {
    const m          = ann.metadata;
    const stylesOpen = store.annStylesExpanded.has(ann.id);
    const stylingRow = buildStylingRow(m, {
      expandable: true,
      stylesOpen,
      toggleIndex: ann.id,
    });
    const commentsHtml = ann.comments.length
      ? ann.comments.map((c, ci) => `
          <div class="ann-comment-row">
            <div class="ann-comment-inner">
              <span class="ann-comment-label">Comment ${ci + 1}</span>
              <p class="ann-comment-text">${escapeHtml(c)}</p>
            </div>
            <button class="ann-comment-del" data-ann="${escapeAttr(ann.id)}" data-ci="${ci}">×</button>
          </div>`).join('')
      : `<p class="ann-card-no-comment">Click the element on the page to add comments</p>`;

    return renderSharedCard({
      cardClass:    `ann-card${ann.id === store.activeAnnotationId ? ' active' : ''}`,
      dataAttrs:    `data-id="${escapeAttr(ann.id)}"`,
      removeClass:  'ann-card-remove',
      removeAttrs:  `data-id="${escapeAttr(ann.id)}"`,
      removeTitle:  'Remove annotation',
      bodyHtml:     `${buildMetadataRows(m)}${stylingRow}`,
      footerHtml:   `<div class="ann-comments-section">${commentsHtml}</div>`,
    });
  }).join('');

  updateAnnGenerateButton();

  annListEl.querySelectorAll('.ann-card').forEach(card => {
    card.addEventListener('click', (e) => {
      if (e.target.closest('.ann-card-remove, .ann-comment-del')) return;
      const ann = store.annAnnotations.find(a => a.id === card.dataset.id);
      if (!ann?.metadata?.cssSelector) return;
      store.activeAnnotationId = ann.id;
      sendToTab('ANN_REHIGHLIGHT', { annId: ann.id, selector: ann.metadata.cssSelector }).catch(console.error);
      store.annMode = 'comment';
      renderAnnotations();
    });
  });

  annListEl.querySelectorAll('.item-styles-toggle').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.dataset.index;
      if (store.annStylesExpanded.has(id)) store.annStylesExpanded.delete(id);
      else store.annStylesExpanded.add(id);
      renderAnnotations();
    });
  });

  annListEl.querySelectorAll('.ann-card-remove').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.dataset.id;
      sendToTab('ANN_REMOVE', { annId: id }).catch(console.error);
      store.annAnnotations = store.annAnnotations.filter(a => a.id !== id);
      if (store.activeAnnotationId === id) store.activeAnnotationId = null;
      store.annStylesExpanded.delete(id);
      renderAnnotations();
      updateAnnHeader();
    });
  });

  annListEl.querySelectorAll('.ann-comment-del').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const ann = store.annAnnotations.find(a => a.id === btn.dataset.ann);
      if (!ann) return;
      ann.comments.splice(parseInt(btn.dataset.ci), 1);
      if (ann.comments.length === 0) {
        sendToTab('ANN_REMOVE', { annId: ann.id }).catch(console.error);
        store.annAnnotations = store.annAnnotations.filter(a => a.id !== ann.id);
        if (store.activeAnnotationId === ann.id) store.activeAnnotationId = null;
        store.annStylesExpanded.delete(ann.id);
        updateAnnHeader();
      }
      renderAnnotations();
    });
  });
}

btnAnnGenerate.addEventListener('click', async () => {
  sendToTab('ANN_STOP_COMMENT').catch(console.error);
  store.activeAnnotationId = null;
  store.annMode = 'off';
  store.annotatingTabId = null;

  if (PROXY_URL.includes('YOUR_SUBDOMAIN')) {
    // Proxy not yet deployed — use static fallback
    annPromptOutput.value = buildStaticAnnotatorPrompt(store.annAnnotations);
  } else {
    btnAnnGenerate.disabled    = true;
    btnAnnGenerate.textContent = 'Generating…';
    annPromptOutput.classList.add('hidden');
    btnAnnCopy.classList.add('hidden');
    try {
      annPromptOutput.value = await callClaudeHaiku(store.annAnnotations);
    } catch (err) {
      annPromptOutput.value = `Error: ${err.message}`;
    }
    btnAnnGenerate.disabled    = false;
    btnAnnGenerate.textContent = 'Generate Prompt';
  }

  annPromptOutput.classList.remove('hidden');
  btnAnnCopy.classList.remove('hidden');
  renderAnnotations();
});

btnAnnCopy.addEventListener('click', () => {
  if (!annPromptOutput.value) return;
  navigator.clipboard.writeText(annPromptOutput.value).then(() => {
    btnAnnCopy.textContent = 'Copied!';
    setTimeout(() => { btnAnnCopy.textContent = 'Copy'; }, 1500);
  });
});


// ─── Builder: picker list ────────────────────────────────────────────────────
function renderPickerList(query) {
  const q        = query.toLowerCase();
  const filtered = q
    ? store.components.filter(c => c.ui_name.toLowerCase().includes(q) || c.description.toLowerCase().includes(q))
    : store.components;
  pickerList.innerHTML = '';
  filtered.forEach(comp => {
    const li = document.createElement('li');
    const isSelected = store.pickerForIndex !== null && store.items[store.pickerForIndex]?.component?.ui_name === comp.ui_name;
    li.className = isSelected ? 'selected' : '';
    li.innerHTML = `<div class="comp-name">${escapeHtml(comp.ui_name)}</div>
                    <div class="comp-desc">${escapeHtml(comp.description)}</div>`;
    li.addEventListener('click', () => {
      if (store.pickerForIndex === null) return;
      store.items[store.pickerForIndex].component = comp;
      store.activeIndex = store.pickerForIndex;
      showMain();
      renderItems();
      updateGenerateButton();
    });
    pickerList.appendChild(li);
  });
}

pickerSearch.addEventListener('input', () => renderPickerList(pickerSearch.value));

// ─── Builder: render items ────────────────────────────────────────────────────
const TEXT_TAGS = new Set([
  'p','span','h1','h2','h3','h4','h5','h6','label','a','li','td','th',
  'strong','em','b','i','u','s','del','ins','small','sub','sup','mark',
  'code','kbd','samp','pre','abbr','cite','q','time',
  'dt','dd','figcaption','caption','legend','blockquote','summary',
]);

function renderItems() {
  if (store.items.length === 0) {
    itemsLabel.classList.add('hidden');
    itemsEmpty.classList.remove('hidden');
    itemsContainer.innerHTML = '';
    btnAddElement.classList.add('hidden');
    return;
  }

  itemsLabel.classList.remove('hidden');
  itemsEmpty.classList.add('hidden');

  itemsContainer.innerHTML = store.items.map((item, i) => {
    const m          = item.metadata;
    const isActive   = i === store.activeIndex;
    const stylesOpen = store.stylesExpanded.has(i);
    const stylingRow = buildStylingRow(m, { expandable: true, stylesOpen, toggleIndex: i });

    const colorProp    = TEXT_TAGS.has(m.tagName) ? 'text' : 'background';
    const colorObj     = colorProp === 'text' ? item.textColor : item.bgColor;
    const colorLabel   = colorProp === 'text' ? 'Text color' : 'Background';
    const swatchBg     = colorObj ? `background:${colorObj.hex}` : '';
    const typo         = item.typography;
    const typoSummary  = typo
      ? [typo.family, typo.weight ? weightLabel(typo.weight) : null, typo.size ? `${typo.size}px` : null].filter(Boolean).join(' · ')
      : null;
    const compSummary  = item.component ? item.component.ui_name : null;

    const expectedChangeHtml = `
      <div class="expected-change">
        <span class="expected-change-label">Expected Change</span>
        <div class="scope-row">
          <span class="scope-label">Apply to</span>
          <div class="scope-toggle">
            <button class="scope-btn${item.scope === 'all' ? ' active' : ''}" data-index="${i}" data-scope="all">All instances</button>
            <button class="scope-btn${item.scope === 'one' ? ' active' : ''}" data-index="${i}" data-scope="one">This one</button>
          </div>
        </div>
        <div class="ec-row">
          <span class="ec-row-label">Component</span>
          <button class="ec-nav-btn ec-comp-btn${compSummary ? ' ec-has-value' : ''}" data-index="${i}">
            <span>${compSummary ? escapeHtml(compSummary) : '<span class="ec-placeholder">Select component</span>'}</span>
            <svg class="ec-chevron" width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M4.5 3L7.5 6L4.5 9" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
          </button>
          ${compSummary ? `<button class="ec-clear-btn" data-index="${i}" data-clear="component">×</button>` : ''}
        </div>
        <div class="ec-row">
          <span class="ec-row-label">${colorLabel}</span>
          <button class="ec-nav-btn color-swatch-btn${colorObj ? ' ec-has-value' : ''}" data-index="${i}" data-prop="${colorProp}">
            ${colorObj
              ? `<div class="color-swatch"><div class="color-swatch-inner" style="${swatchBg}"></div></div><span>${escapeHtml(colorObj.hex)}</span>`
              : `<span><span class="ec-placeholder">Select color</span></span>`
            }
            <svg class="ec-chevron" width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M4.5 3L7.5 6L4.5 9" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
          </button>
          ${colorObj ? `<button class="ec-clear-btn" data-index="${i}" data-clear="${colorProp}">×</button>` : ''}
        </div>
        ${TEXT_TAGS.has(m.tagName) ? `
        <div class="ec-row">
          <span class="ec-row-label">Text font</span>
          <button class="ec-nav-btn ec-font-btn${typoSummary ? ' ec-has-value' : ''}" data-index="${i}">
            <span>${typoSummary || '<span class="ec-placeholder">Select font</span>'}</span>
            <svg class="ec-chevron" width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M4.5 3L7.5 6L4.5 9" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
          </button>
          ${typoSummary ? `<button class="ec-clear-btn" data-index="${i}" data-clear="typography">×</button>` : ''}
        </div>` : item.includeText ? `
        <div class="ec-row">
          <span class="ec-row-label">Text color</span>
          <button class="ec-nav-btn color-swatch-btn${item.textColor ? ' ec-has-value' : ''}" data-index="${i}" data-prop="text">
            ${item.textColor
              ? `<div class="color-swatch"><div class="color-swatch-inner" style="background:${item.textColor.hex}"></div></div><span>${escapeHtml(item.textColor.hex)}</span>`
              : `<span><span class="ec-placeholder">Select color</span></span>`
            }
            <svg class="ec-chevron" width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M4.5 3L7.5 6L4.5 9" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
          </button>
          ${item.textColor ? `<button class="ec-clear-btn" data-index="${i}" data-clear="text">×</button>` : ''}
        </div>
        <div class="ec-row">
          <span class="ec-row-label">Text font</span>
          <button class="ec-nav-btn ec-font-btn${typoSummary ? ' ec-has-value' : ''}" data-index="${i}">
            <span>${typoSummary || '<span class="ec-placeholder">Select font</span>'}</span>
            <svg class="ec-chevron" width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M4.5 3L7.5 6L4.5 9" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
          </button>
          ${typoSummary ? `<button class="ec-clear-btn" data-index="${i}" data-clear="typography">×</button>` : ''}
        </div>
        <button class="ec-text-toggle" data-index="${i}" data-action="remove">− Remove text change</button>
        ` : `
        <button class="ec-text-toggle" data-index="${i}" data-action="add">+ Change text inside</button>
        `}
      </div>`;

    return renderSharedCard({
      cardClass:  isActive ? 'active' : '',
      dataAttrs:  `data-index="${i}"`,
      removeAttrs:`data-index="${i}"`,
      bodyHtml:   `${buildMetadataRows(m)}${stylingRow}`,
      footerHtml: expectedChangeHtml,
    });
  }).join('');

  // Wire events after render
  itemsContainer.querySelectorAll('.color-swatch-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      showColorPicker(parseInt(btn.dataset.index), btn.dataset.prop);
    });
  });

  itemsContainer.querySelectorAll('.ec-font-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      showFontPicker(parseInt(btn.dataset.index));
    });
  });

  itemsContainer.querySelectorAll('.ec-comp-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const idx = parseInt(btn.dataset.index);
      store.activeIndex = idx;
      showPicker(idx);
    });
  });

  itemsContainer.querySelectorAll('.ec-clear-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const idx   = parseInt(btn.dataset.index);
      const field = btn.dataset.clear;
      if (field === 'component')  store.items[idx].component  = null;
      if (field === 'text')       store.items[idx].textColor  = null;
      if (field === 'background') store.items[idx].bgColor    = null;
      if (field === 'typography') store.items[idx].typography = null;
      renderItems();
      updateGenerateButton();
    });
  });

  itemsContainer.querySelectorAll('.scope-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      store.items[parseInt(btn.dataset.index)].scope = btn.dataset.scope;
      renderItems();
    });
  });

  itemsContainer.querySelectorAll('.ec-text-toggle').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const idx    = parseInt(btn.dataset.index);
      const adding = btn.dataset.action === 'add';
      store.items[idx].includeText = adding;
      if (!adding) { store.items[idx].textColor = null; store.items[idx].typography = null; }
      renderItems();
      updateGenerateButton();
    });
  });

  itemsContainer.querySelectorAll('.item-card').forEach(card => {
    card.addEventListener('click', (e) => {
      if (e.target.closest('.item-remove, .item-styles-toggle, .color-swatch-btn, .ec-font-btn, .ec-comp-btn, .ec-text-toggle, .scope-btn, .ec-clear-btn')) return;
      const idx = parseInt(card.dataset.index);
      store.activeIndex = idx;
      flashItem(idx);
      renderItems();
    });
  });

  itemsContainer.querySelectorAll('.item-styles-toggle').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const idx = parseInt(btn.dataset.index);
      if (store.stylesExpanded.has(idx)) store.stylesExpanded.delete(idx);
      else store.stylesExpanded.add(idx);
      renderItems();
    });
  });

  itemsContainer.querySelectorAll('.item-remove').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const idx = parseInt(btn.dataset.index);
      store.items.splice(idx, 1);
      function remapSet(s) {
        const next = new Set();
        s.forEach(n => {
          if (n < idx) next.add(n);
          else if (n > idx) next.add(n - 1);
        });
        return next;
      }
      store.expandedSet    = remapSet(store.expandedSet);
      store.stylesExpanded = remapSet(store.stylesExpanded);
      store.activeIndex    = store.items.length === 0 ? null : Math.min(store.activeIndex ?? 0, store.items.length - 1);
      renderItems();
      updateGenerateButton();
      resetPromptArea();
    });
  });

  btnAddElement.classList.remove('hidden');
  btnInspect.disabled = false;
}

// ─── Builder: state helpers ──────────────────────────────────────────────────
function updateGenerateButton() {
  const canGenerate = store.items.length > 0 && store.items.every(item =>
    item.component || item.textColor || item.bgColor || item.typography
  );
  btnGenerate.disabled = !canGenerate;
}

function resetAll() {
  store.items            = [];
  store.activeIndex      = null;
  store.activeAnnotationId = null;
  store.generatedPrompt  = null;
  store.expandedSet      = new Set();
  store.stylesExpanded   = new Set();
  renderItems();
  updateGenerateButton();
  resetPromptArea();
  showMain();
}

function resetPromptArea() {
  store.generatedPrompt = null;
  promptPreview.classList.add('hidden');
  promptPreview.value = '';
  btnCopy.classList.add('hidden');
}

btnReset.addEventListener('click', resetAll);

btnGenerate.addEventListener('click', () => {
  store.generatedPrompt = buildStaticPrompt(store.items);
  promptPreview.value   = store.generatedPrompt;
  promptPreview.classList.remove('hidden');
  btnCopy.classList.remove('hidden');
});

btnCopy.addEventListener('click', () => {
  if (!promptPreview.value) return;
  navigator.clipboard.writeText(promptPreview.value).then(() => {
    btnCopy.textContent = 'Copied!';
    setTimeout(() => { btnCopy.textContent = 'Copy to Clipboard'; }, 1500);
  });
});

// ─── Builder: inspection ─────────────────────────────────────────────────────
function flashItem(index) {
  const selector = store.items[index]?.metadata?.cssSelector;
  if (!selector) return;
  chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
    if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: 'FLASH', selector }).catch(() => {});
  });
}

function startInspection() {
  if (store.inspecting) return;
  store.inspecting = true;
  setInspectLabel('Cancel');
  btnInspect.classList.add('active');
  getActiveTab().then(tab => { store.inspectingTabId = tab?.id ?? null; });
  sendToTab('START_INSPECTION').catch(console.error);
}

btnInspect.addEventListener('click', () => {
  if (store.inspecting) {
    store.inspecting      = false;
    store.inspectingTabId = null;
    setInspectLabel('Select Element');
    btnInspect.classList.remove('active');
    sendToTab('STOP_INSPECTION').catch(console.error);
  } else {
    startInspection();
  }
});

btnAddElement.addEventListener('click', startInspection);

// ─── Keyboard shortcuts ──────────────────────────────────────────────────────
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!viewPicker.classList.contains('hidden')) { showMain(); return; }
  if (store.inspecting) {
    store.inspecting      = false;
    store.inspectingTabId = null;
    setInspectLabel('Select Element');
    btnInspect.classList.remove('active');
    sendToTab('STOP_INSPECTION').catch(console.error);
  }
  if (store.annMode !== 'off') stopAnnotatorMode();
});

// ─── Tab activation ──────────────────────────────────────────────────────────
chrome.tabs.onActivated.addListener(({ tabId }) => {
  if (store.inspecting && store.inspectingTabId !== null && tabId !== store.inspectingTabId) {
    chrome.tabs.sendMessage(store.inspectingTabId, { type: 'STOP_INSPECTION' }).catch(() => {});
    store.inspecting      = false;
    store.inspectingTabId = null;
    setInspectLabel('Select Element');
    btnInspect.classList.remove('active');
  }
  if (store.annMode !== 'off' && store.annotatingTabId !== null && tabId !== store.annotatingTabId) {
    chrome.tabs.sendMessage(store.annotatingTabId, { type: 'STOP_ANNOTATOR' }).catch(() => {});
    store.annMode = 'off';
    store.annotatingTabId = null;
    store.activeAnnotationId = null;
    store.annStylesExpanded = new Set();
    setAnnPickLabel('Annotate Element');
    btnAnnPick.classList.remove('active');
    renderAnnotations();
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

  if (message.eventType === 'INSPECTION_CANCELLED') {
    store.inspecting      = false;
    store.inspectingTabId = null;
    setInspectLabel('Select Element');
    btnInspect.classList.remove('active');
    return;
  }

  if (message.eventType === 'CAPTURED' && message.payload) {
    const metadata = message.payload;
    store.inspecting      = false;
    store.inspectingTabId = null;
    setInspectLabel('Select Element');
    btnInspect.classList.remove('active');
    store.items.push({ metadata, component: null, textColor: null, bgColor: null, typography: null, includeText: false, scope: 'all' });
    store.activeIndex = store.items.length - 1;
    renderItems();
    updateGenerateButton();
    resetPromptArea();
    return;
  }

  if (message.eventType === 'ANN_ELEMENT_ADDED' && message.payload) {
    const { id, metadata } = message.payload;
    if (!store.annAnnotations.find(a => a.id === id)) {
      store.annAnnotations.push({ id, metadata, comments: [] });
      renderAnnotations();
      updateAnnHeader();
    }
    store.annMode = 'comment';
    if (senderTabId != null) {
      store.annotatingTabId = senderTabId;
      syncLifecycleTab(senderTabId);
    }
    setAnnPickLabel('Annotate Element');
    btnAnnPick.classList.remove('active');
    return;
  }

  if (message.eventType === 'ANN_EXISTING_SELECTED' && message.payload) {
    const { id } = message.payload;
    store.activeAnnotationId = id;
    store.annMode = 'comment';
    renderAnnotations();
    return;
  }

  if (message.eventType === 'ANN_ENTRY' && message.payload) {
    const { id, metadata, comment } = message.payload;
    const existing = store.annAnnotations.find(a => a.id === id);
    if (existing) {
      existing.comments.push(comment);
    } else {
      store.annAnnotations.push({ id, metadata, comments: [comment] });
      updateAnnHeader();
    }
    renderAnnotations();
    return;
  }

  if (message.eventType === 'ANN_CANCELLED') {
    store.annMode = 'off';
    store.annotatingTabId = null;
    store.activeAnnotationId = null;
    setAnnPickLabel('Annotate Element');
    btnAnnPick.classList.remove('active');
    return;
  }
}

chrome.runtime.onMessage.addListener((message, sender) => {
  handlePanelEvent(message, sender).catch(console.error);
});

// ─── Font picker ─────────────────────────────────────────────────────────────
function showFontPicker(index) {
  store.fontForIndex = index;
  const item = store.items[index];
  document.getElementById('font-weight-select').value = item.typography?.weight || '';
  document.getElementById('font-size-input').value    = item.typography?.size   || '';
  renderFontList('', item.typography?.family);
  document.getElementById('font-search').value = '';
  viewMain.classList.add('hidden');
  document.getElementById('view-font').classList.remove('hidden');
  document.getElementById('font-search').focus();
}

function hideFontPicker() {
  document.getElementById('view-font').classList.add('hidden');
  viewMain.classList.remove('hidden');
}

function renderFontList(q, selected) {
  const list     = document.getElementById('font-list');
  const filtered = q ? FONT_LIST.filter(f => f.toLowerCase().includes(q.toLowerCase())) : FONT_LIST;
  list.innerHTML = filtered.map(f => `
    <li class="${f === selected ? 'selected' : ''}" data-font="${escapeAttr(f)}" style="font-family:'${escapeAttr(f)}',sans-serif">
      <div class="comp-name">${escapeHtml(f)}</div>
      <div class="comp-desc" style="font-family:'${escapeAttr(f)}',sans-serif">The quick brown fox jumps over the lazy dog</div>
    </li>`).join('');
  list.querySelectorAll('li').forEach(li => {
    li.addEventListener('click', () => {
      list.querySelectorAll('li').forEach(l => l.classList.remove('selected'));
      li.classList.add('selected');
    });
  });
}

document.getElementById('font-search').addEventListener('input', (e) => {
  renderFontList(e.target.value, store.items[store.fontForIndex]?.typography?.family);
});

document.getElementById('btn-font-back').addEventListener('click', hideFontPicker);

document.getElementById('btn-font-apply').addEventListener('click', () => {
  const selectedLi = document.getElementById('font-list').querySelector('li.selected');
  const family     = selectedLi?.dataset.font || null;
  const weight     = document.getElementById('font-weight-select').value || null;
  const size       = document.getElementById('font-size-input').value   || null;
  store.items[store.fontForIndex].typography = (family || weight || size)
    ? { ...(family ? { family } : {}), ...(weight ? { weight } : {}), ...(size ? { size } : {}) }
    : null;
  hideFontPicker();
  renderItems();
  updateGenerateButton();
});

// ─── Color picker ────────────────────────────────────────────────────────────
function showColorPicker(itemIndex, property) {
  store.cpItemIndex = itemIndex;
  store.cpProperty  = property;
  cpPickerTitle.textContent = property === 'text' ? 'Text Color' : 'Background Color';
  const item          = store.items[itemIndex];
  const existingColor = property === 'text' ? item.textColor : item.bgColor;
  const computedColor = property === 'text' ? item.metadata.styles?.color : item.metadata.styles?.backgroundColor;
  const initColor     = existingColor?.hex || computedColor || (property === 'text' ? '#000000' : '#ffffff');
  const parsed        = parseColor(initColor);
  store.cpHue   = parsed.h;
  store.cpSat   = parsed.s;
  store.cpBri   = parsed.v;
  store.cpAlpha = existingColor ? parsed.a : 1;
  viewMain.classList.add('hidden');
  viewColor.classList.remove('hidden');
  cpDraw();
  cpUpdateUI();
}

function hideColorPicker() {
  viewColor.classList.add('hidden');
  viewMain.classList.remove('hidden');
}

btnColorBack.addEventListener('click', hideColorPicker);

btnColorApply.addEventListener('click', () => {
  const rgba = hsvToRgba(store.cpHue, store.cpSat, store.cpBri, store.cpAlpha);
  const hex  = rgbaToHex(rgba);
  if (store.cpProperty === 'text') {
    store.items[store.cpItemIndex].textColor = { hex, rgba };
  } else {
    store.items[store.cpItemIndex].bgColor = { hex, rgba };
  }
  hideColorPicker();
  renderItems();
  updateGenerateButton();
});

function cpDraw() { cpDrawCanvas(); cpDrawHue(); cpDrawAlpha(); }

function cpDrawCanvas() {
  const ctx  = cpCanvas.getContext('2d');
  const w    = cpCanvas.width;
  const h    = cpCanvas.height;
  const hueColor = `hsl(${store.cpHue}, 100%, 50%)`;
  const satGrad  = ctx.createLinearGradient(0, 0, w, 0);
  satGrad.addColorStop(0, '#fff');
  satGrad.addColorStop(1, hueColor);
  ctx.fillStyle = satGrad;
  ctx.fillRect(0, 0, w, h);
  const briGrad = ctx.createLinearGradient(0, 0, 0, h);
  briGrad.addColorStop(0, 'transparent');
  briGrad.addColorStop(1, '#000');
  ctx.fillStyle = briGrad;
  ctx.fillRect(0, 0, w, h);
  cpCursor.style.left = (store.cpSat * 100) + '%';
  cpCursor.style.top  = ((1 - store.cpBri) * 100) + '%';
}

function cpDrawHue() {
  const ctx  = cpHueCanvas.getContext('2d');
  const w    = cpHueCanvas.width;
  const h    = cpHueCanvas.height;
  const grad = ctx.createLinearGradient(0, 0, w, 0);
  for (let i = 0; i <= 6; i++) grad.addColorStop(i / 6, `hsl(${i * 60}, 100%, 50%)`);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);
  cpHueThumb.style.left = (store.cpHue / 360 * 100) + '%';
}

function cpDrawAlpha() {
  const ctx  = cpAlphaCanvas.getContext('2d');
  const w    = cpAlphaCanvas.width;
  const h    = cpAlphaCanvas.height;
  const rgba = hsvToRgba(store.cpHue, store.cpSat, store.cpBri, 1);
  const grad = ctx.createLinearGradient(0, 0, w, 0);
  grad.addColorStop(0, `rgba(${rgba.r},${rgba.g},${rgba.b},0)`);
  grad.addColorStop(1, `rgba(${rgba.r},${rgba.g},${rgba.b},1)`);
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);
  cpAlphaThumb.style.left = (store.cpAlpha * 100) + '%';
}

function cpUpdateUI() {
  const rgba = hsvToRgba(store.cpHue, store.cpSat, store.cpBri, store.cpAlpha);
  const hex  = rgbaToHex(rgba);
  let inner  = cpPreview.querySelector('.cp-preview-inner');
  if (!inner) { inner = document.createElement('div'); inner.className = 'cp-preview-inner'; cpPreview.appendChild(inner); }
  inner.style.background = `rgba(${rgba.r},${rgba.g},${rgba.b},${rgba.a})`;
  cpHexInput.value   = hex;
  cpAlphaInput.value = Math.round(rgba.a * 100);
}

function cpCanvasInteract(e) {
  const rect  = cpCanvas.getBoundingClientRect();
  store.cpSat = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  store.cpBri = 1 - Math.max(0, Math.min(1, (e.clientY - rect.top)  / rect.height));
  cpDraw(); cpUpdateUI();
}

cpCanvas.addEventListener('mousedown', (e) => {
  cpCanvasInteract(e);
  const move = (ev) => cpCanvasInteract(ev);
  const up   = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
});

function cpHueInteract(e) {
  const rect   = cpHueCanvas.getBoundingClientRect();
  store.cpHue  = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)) * 360;
  cpDraw(); cpUpdateUI();
}

cpHueCanvas.addEventListener('mousedown', (e) => {
  cpHueInteract(e);
  const move = (ev) => cpHueInteract(ev);
  const up   = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
});

function cpAlphaInteract(e) {
  const rect    = cpAlphaCanvas.getBoundingClientRect();
  store.cpAlpha = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  cpDrawAlpha(); cpUpdateUI();
}

cpAlphaCanvas.addEventListener('mousedown', (e) => {
  cpAlphaInteract(e);
  const move = (ev) => cpAlphaInteract(ev);
  const up   = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
});

cpHexInput.addEventListener('change', () => {
  const parsed  = parseColor(cpHexInput.value);
  store.cpHue = parsed.h; store.cpSat = parsed.s; store.cpBri = parsed.v;
  cpDraw(); cpUpdateUI();
});

cpAlphaInput.addEventListener('change', () => {
  store.cpAlpha = Math.max(0, Math.min(100, parseInt(cpAlphaInput.value) || 0)) / 100;
  cpDrawAlpha(); cpUpdateUI();
});

const btnEyedropper = document.getElementById('btn-eyedropper');
if ('EyeDropper' in window) {
  btnEyedropper.addEventListener('click', async () => {
    try {
      const result  = await new EyeDropper().open();
      const parsed  = parseColor(result.sRGBHex);
      store.cpHue = parsed.h; store.cpSat = parsed.s; store.cpBri = parsed.v;
      cpDraw(); cpUpdateUI();
    } catch (_) {}
  });
} else {
  btnEyedropper.style.display = 'none';
}

// ─── Initial render ──────────────────────────────────────────────────────────
renderItems();
