// ─── Constants ─────────────────────────────────────────────────────────────
export const GEMINI_MODEL    = 'gemini-3.1-flash-lite-preview';
export const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

// ─── Mutable state ─────────────────────────────────────────────────────────
export const store = {
  // Builder
  items:             [],    // [{ metadata, component, textColor, bgColor, typography, includeText, scope }]
  activeIndex:       null,
  components:        [],
  inspecting:        false,
  inspectingTabId:   null,
  generatedPrompt:   null,
  activeAnnotationId: null,
  pickerForIndex:    null,
  expandedSet:       new Set(),
  stylesExpanded:    new Set(),
  annStylesExpanded: new Set(),
  // Annotator
  annMode:           'off', // 'off' | 'inspect' | 'comment'
  annAnnotations:    [],    // [{ id, metadata, comments: [] }]
  // Color picker
  cpItemIndex: null,
  cpProperty:  null,
  cpHue:   0,
  cpSat:   1,
  cpBri:   1,
  cpAlpha: 1,
  // Font picker
  fontForIndex: null,
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
  if (store.inspecting) {
    sendToTab('STOP_INSPECTION').catch(() => {});
    store.inspecting      = false;
    store.inspectingTabId = null;
  }
  if (store.annMode !== 'off' || store.annAnnotations.length > 0) {
    sendToTab('STOP_ANNOTATOR').catch(() => {});
    store.annMode = 'off';
  }
}

// ─── Static prompt builder (Builder mode) ───────────────────────────────────
export function buildStaticPrompt(items) {
  const TEXT_TAGS = new Set([
    'p','span','h1','h2','h3','h4','h5','h6','label','a','li','td','th',
    'strong','em','b','i','u','s','del','ins','small','sub','sup','mark',
    'code','kbd','samp','pre','abbr','cite','q','time',
    'dt','dd','figcaption','caption','legend','blockquote','summary',
  ]);

  function classifyItem(item) {
    const hasComponent = !!item.component;
    const hasStyle = !!(item.textColor || item.bgColor || item.typography);
    if (hasComponent && hasStyle) return 'both';
    if (hasComponent) return 'component';
    return 'style';
  }

  function buildStyleSentence(item, tagRef) {
    const m = item.metadata;
    const isTextTag = TEXT_TAGS.has(m.tagName);
    const parts = [];
    if (isTextTag) {
      if (item.textColor) parts.push(`the text color of ${tagRef} to ${item.textColor.hex}`);
    } else {
      if (item.bgColor)                       parts.push(`the background color of ${tagRef} to ${item.bgColor.hex}`);
      if (item.includeText && item.textColor) parts.push(`the text color in the ${tagRef} to ${item.textColor.hex}`);
    }
    if ((isTextTag || item.includeText) && item.typography && Object.keys(item.typography).length > 0) {
      const t = item.typography;
      let fontDesc = '';
      if (t.family) {
        const specs = [];
        if (t.weight) specs.push(`font-weight ${t.weight}`);
        if (t.size)   specs.push(`font-size ${t.size}px`);
        fontDesc = t.family + (specs.length ? ` with ${specs.join(', ')}` : '');
      } else {
        const specs = [];
        if (t.weight) specs.push(`font-weight ${t.weight}`);
        if (t.size)   specs.push(`font-size ${t.size}px`);
        fontDesc = specs.join(', ');
      }
      parts.push(`the font of ${tagRef} to ${fontDesc}`);
    }
    if (parts.length === 0) return null;
    return `Change ${parts.join(' and ')}.`;
  }

  function formatItem(item) {
    const m = item.metadata;
    const kind    = classifyItem(item);
    const lastComp = m.componentTree?.length ? m.componentTree[m.componentTree.length - 1] : null;
    const location = lastComp ? `<${lastComp}>` : `<${m.tagName}>`;
    const text     = m.textContent ? m.textContent.replace(/\s+/g, ' ').trim() : null;
    const elementId = text
      ? `<${m.tagName}> that currently holds "${text}" inside ${location}`
      : `<${m.tagName}> inside ${location}`;
    const lines = [];
    if (kind === 'component') {
      lines.push(`Update the ${elementId} to match the ${item.component.ui_name} component.`);
    } else if (kind === 'both') {
      const styleSentence     = buildStyleSentence(item, `<${m.tagName}>`);
      const componentSentence = `Update the ${elementId} to match the ${item.component.ui_name} component.`;
      lines.push(styleSentence ? `${componentSentence} ${styleSentence}` : componentSentence);
    } else {
      const styleSentence = buildStyleSentence(item, elementId);
      if (styleSentence) lines.push(styleSentence);
    }
    const scopeLine = item.scope === 'all'
      ? 'Apply the changes globally across all instances.'
      : 'Apply these changes to this specific instance only.';
    return `${lines.join('\n')} ${scopeLine}`;
  }

  if (items.length === 1) return formatItem(items[0]);
  const blocks = items.map((item, i) => {
    const block = formatItem(item);
    const [firstLine, ...rest] = block.split('\n');
    return `${i + 1}. ${firstLine}${rest.length ? '\n' + rest.map(l => '   ' + l).join('\n') : ''}`;
  });
  return `Make the following UI updates:\n\n${blocks.join('\n\n')}`;
}

// ─── Static prompt builder (Annotator mode) ─────────────────────────────────
export function buildStaticAnnotatorPrompt(annotations) {
  const lines = [];
  let n = 0;
  lines.push('Make the following UI changes based on annotated feedback:\n');
  annotations.forEach(ann => {
    const m   = ann.metadata;
    const loc = m.componentTree?.length ? m.componentTree[m.componentTree.length - 1] : m.tagName;
    const el  = m.textContent
      ? `<${m.tagName}> "${m.textContent}" inside <${loc}>`
      : `<${m.tagName}> inside <${loc}>`;
    ann.comments.forEach(comment => {
      n++;
      lines.push(`${n}. ${el}: ${comment}`);
    });
  });
  return n > 0 ? lines.join('\n') : 'No comments to generate a prompt from.';
}

// ─── AI prompt builder (Builder mode) ───────────────────────────────────────
export function buildAIPrompt(items) {
  const changesJson = items.map((item, i) => {
    const m  = item.metadata;
    const sc = m.semanticContext;
    const context = {};
    if (sc?.landmark) {
      const lm = sc.landmark;
      context.pageRegion = [lm.tag, lm.role ? `role="${lm.role}"` : null, lm.label ? `"${lm.label}"` : null].filter(Boolean).join(' ');
    }
    if (sc?.sectionHeading)  context.sectionHeading  = sc.sectionHeading;
    if (sc?.associatedLabel) context.associatedLabel  = sc.associatedLabel;
    if (sc?.siblingPattern)  context.siblingPattern   = `item ${sc.siblingPattern.index} of ${sc.siblingPattern.total}`;
    if (sc?.formContext) {
      const fc = sc.formContext;
      context.formFields  = fc.fields.map(f => f.label ? `${f.type}(${f.label})` : f.type);
      if (fc.submitText) context.formSubmitText = fc.submitText;
    }
    return {
      change: i + 1,
      element: {
        componentTree: m.componentTree?.map(n => `<${n}>`).join(' > ') ?? 'unknown',
        tagName: `<${m.tagName}>`,
        textContent: m.textContent ?? null,
        cssFramework: m.cssFramework,
        eventHandlers: m.eventHandlers?.map(h => {
          let desc = `${h.event} (handler: ${h.handlerName})`;
          if (h.source) desc += `\n        source: ${h.source.slice(0, 200)}`;
          return desc;
        }),
        componentProps: m.componentProps || null,
        styles: m.styles,
        ...(Object.keys(context).length > 0 ? { context } : {}),
      },
      targetComponent: {
        name: item.component.ui_name,
        description: item.component.description,
      },
    };
  });

  return `You are helping someone who has a clear visual intuition but lacks technical vocabulary to describe UI changes to an AI coding tool like Cursor, Claude Code, or Windsurf.

Given ${items.length} UI change${items.length > 1 ? 's' : ''} captured from a live page, write a concise change request a developer can act on immediately.

## Changes requested
\`\`\`json
${JSON.stringify(changesJson, null, 2)}
\`\`\`

## Rules

**Identify each element exactly.**
Use the explicit html, css, javascript, or other elements such as JSON, property names, CSS selectors, component tree paths, HTML tags to identify the element selected. This removes ambiguity.

**State the outcome, not the process.**
Say what it should look like when done. Not "refactor" or "update props".

**Structure:**
${items.length > 1
  ? '- Start with one sentence summarising all changes together\n- Then a numbered list, one entry per change:\n  1. What changes and where (one line)\n  2. Visual changes (brief bullets, only what\'s different)\n  3. Keep intact (only if handlers/states could break — skip if nothing is at risk)'
  : '- One-line summary of the change\n- Visual changes: bullets of only what\'s different\n- Keep intact: only if handlers/states could break — omit if nothing is at risk'
}

Output only the final prompt. No preamble.`;
}

// ─── Claude Haiku via proxy ──────────────────────────────────────────────────
// Update PROXY_URL after deploying the Cloudflare Worker (`npm run deploy` in /worker)
export const PROXY_URL = 'https://v2c-proxy.lumiere-project.workers.dev';
export const CLAUDE_HAIKU_MODEL = 'claude-haiku-4-5';


const HAIKU_SYSTEM_PROMPT = `You are a UI change request synthesizer for Claude Code — an AI coding agent.

Your task: given annotated UI elements and user feedback comments, produce a single, precise, developer-ready prompt that Claude Code can immediately understand and execute.

Rules:
- Reference every element precisely using its component hierarchy, HTML tag, and visible text
- Translate vague or informal comments into specific, actionable implementation instructions
- Group related changes when it makes sense to read cleanly
- Be concise — no fluff, no preamble, no closing remarks
- Use imperative language ("Change X to Y", "Update X so that Y", "Replace X with Y")
- Preserve the user's design intent exactly as expressed in the comments
- Output ONLY the final prompt — nothing else`;

export async function callClaudeHaiku(annotations) {
  const annotationBlocks = annotations
    .filter(ann => ann.comments.length > 0)
    .map((ann, i) => {
      const m         = ann.metadata;
      const hierarchy = m.componentTree?.length
        ? m.componentTree.map(n => `<${n}>`).join(' › ')
        : `<${m.tagName}>`;
      const sc = m.semanticContext;
      const parts = [
        `[${i + 1}] ${hierarchy} › <${m.tagName}>${m.textContent ? ` "${m.textContent}"` : ''}`,
        `    Selector : ${m.cssSelector ?? 'n/a'}`,
      ];
      if (sc?.landmark) {
        const lm = sc.landmark;
        const lmDesc = [lm.tag, lm.role ? `role="${lm.role}"` : null, lm.label ? `"${lm.label}"` : null].filter(Boolean).join(' ');
        parts.push(`    Page region: <${lmDesc}>`);
      }
      if (sc?.sectionHeading) {
        parts.push(`    Section   : "${sc.sectionHeading}"`);
      }
      if (sc?.associatedLabel) {
        parts.push(`    Label     : ${sc.associatedLabel}`);
      }
      if (sc?.siblingPattern) {
        parts.push(`    Pattern   : item ${sc.siblingPattern.index} of ${sc.siblingPattern.total} (repeating)`);
      }
      if (sc?.formContext) {
        const fc = sc.formContext;
        const fieldSummary = fc.fields.map(f => f.label ? `${f.type}(${f.label})` : f.type).join(', ');
        parts.push(`    Form      : [${fieldSummary}]${fc.submitText ? ` → "${fc.submitText}"` : ''}`);
      }
      if (m.cssFramework && m.cssFramework !== 'unknown') {
        parts.push(`    Styling   : ${m.cssFramework}`);
      }
      if (m.componentProps?.props) {
        const propsStr = Object.entries(m.componentProps.props).slice(0, 6)
          .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(', ');
        parts.push(`    ${m.componentProps.component} props: { ${propsStr} }`);
      }
      if (m.eventHandlers?.length) {
        m.eventHandlers.forEach(h => {
          parts.push(`    Handler   : ${h.event} → ${h.handlerName}`);
          if (h.source) parts.push(`      source: ${h.source.slice(0, 150)}`);
        });
      }
      parts.push(`    Feedback  :`);
      ann.comments.forEach((c, ci) => parts.push(`      ${ci + 1}. ${c}`));
      return parts.join('\n');
    }).join('\n\n');

  const userMessage = `Annotated UI elements:\n\n${annotationBlocks}\n\nGenerate the prompt:`;

  const res = await fetch(PROXY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: CLAUDE_HAIKU_MODEL,
      max_tokens: 1024,
      system: HAIKU_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message || `HTTP ${res.status}`);
  }
  const data = await res.json();
  return data.content?.[0]?.text ?? 'No response generated.';
}

// ─── Gemini API ──────────────────────────────────────────────────────────────
export async function callGemini(apiKey, userPrompt) {
  const res = await fetch(`${GEMINI_ENDPOINT}?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: userPrompt }] }],
      generationConfig: { temperature: 0.3, maxOutputTokens: 2048 },
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message || `HTTP ${res.status}`);
  }
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text ?? 'No response generated.';
}

export async function callGeminiAnnotator(apiKey, annotations) {
  const annText = annotations.map((ann, i) => {
    const m        = ann.metadata;
    const sc       = m.semanticContext;
    const loc      = m.componentTree?.length ? m.componentTree[m.componentTree.length - 1] : m.tagName;
    const feedback = ann.comments.length
      ? ann.comments.map((c, ci) => `Comment ${ci + 1}: ${c}`).join('\n      ')
      : '(no comments)';
    const lines = [`[${i + 1}] Element: <${m.tagName}>${m.textContent ? ` — "${m.textContent}"` : ''} inside <${loc}>`, `    Selector: ${m.cssSelector}`];
    if (sc?.landmark) {
      const lm = sc.landmark;
      const lmDesc = [lm.tag, lm.role ? `role="${lm.role}"` : null, lm.label ? `"${lm.label}"` : null].filter(Boolean).join(' ');
      lines.push(`    Page region: <${lmDesc}>`);
    }
    if (sc?.sectionHeading)  lines.push(`    Section: "${sc.sectionHeading}"`);
    if (sc?.associatedLabel) lines.push(`    Label: ${sc.associatedLabel}`);
    if (sc?.siblingPattern)  lines.push(`    Pattern: item ${sc.siblingPattern.index} of ${sc.siblingPattern.total} (repeating)`);
    if (sc?.formContext) {
      const fc = sc.formContext;
      const fieldSummary = fc.fields.map(f => f.label ? `${f.type}(${f.label})` : f.type).join(', ');
      lines.push(`    Form: [${fieldSummary}]${fc.submitText ? ` → "${fc.submitText}"` : ''}`);
    }
    if (m.componentProps?.props) {
      const propsStr = Object.entries(m.componentProps.props).slice(0, 6)
        .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(', ');
      lines.push(`    ${m.componentProps.component} props: { ${propsStr} }`);
    }
    if (m.eventHandlers?.length) {
      m.eventHandlers.forEach(h => {
        lines.push(`    Handler: ${h.event} → ${h.handlerName}`);
        if (h.source) lines.push(`      source: ${h.source.slice(0, 150)}`);
      });
    }
    lines.push(`    Feedback:\n      ${feedback}`);
    return lines.join('\n');
  }).join('\n\n');

  const userPrompt = `You are a senior UI engineer. Given annotated UI elements and their feedback, write a single, structured, developer-ready prompt that a coding agent (e.g. Claude, Cursor) can act on directly.

Rules:
- Be specific and technically precise
- Group related changes together
- Preserve the design intent of the feedback
- Do not include preamble — output only the prompt itself

Annotations:
${annText}

Generate the prompt:`;

  return await callGemini(apiKey, userPrompt);
}

// ─── Color math ──────────────────────────────────────────────────────────────
export function hsvToRgba(h, s, v, a) {
  let r, g, b;
  const i = Math.floor(h / 60) % 6;
  const f = h / 60 - Math.floor(h / 60);
  const p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
  [r, g, b] = [[v,t,p],[q,v,p],[p,v,t],[p,q,v],[t,p,v],[v,p,q]][i];
  return { r: Math.round(r*255), g: Math.round(g*255), b: Math.round(b*255), a };
}

export function rgbaToHex({ r, g, b }) {
  return '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('').toUpperCase();
}

export function parseColor(str) {
  const hex = str?.replace('#', '');
  if (/^[0-9a-fA-F]{6}$/.test(hex)) {
    const r = parseInt(hex.slice(0,2),16)/255;
    const g = parseInt(hex.slice(2,4),16)/255;
    const b = parseInt(hex.slice(4,6),16)/255;
    return rgbToHsv(r, g, b, 1);
  }
  const m = str?.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
  if (m) return rgbToHsv(+m[1]/255, +m[2]/255, +m[3]/255, m[4] != null ? +m[4] : 1);
  return { h: 0, s: 0, v: 1, a: 1 };
}

export function rgbToHsv(r, g, b, a) {
  const max = Math.max(r,g,b), min = Math.min(r,g,b), d = max - min;
  let h = 0, s = max === 0 ? 0 : d / max, v = max;
  if (d !== 0) {
    if (max === r)      h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else                h = ((r - g) / d + 4) / 6;
  }
  return { h: h * 360, s, v, a: a ?? 1 };
}

// ─── Font data ───────────────────────────────────────────────────────────────
export const WEIGHT_LABELS = {
  '100':'Thin','200':'Extralight','300':'Light',
  '400':'Regular','500':'Medium','600':'Semibold',
  '700':'Bold','800':'Extrabold','900':'Black',
};
export function weightLabel(w) { return WEIGHT_LABELS[String(w)] || w; }

export const FONT_LIST = [
  'Inter','Inter Tight','Inter Display',
  'Geist','Geist Mono',
  'DM Sans','DM Mono',
  'Manrope','Plus Jakarta Sans','Sora',
  'Nunito','Nunito Sans',
  'Poppins','Lato','Raleway','Rubik',
  'Work Sans','Outfit','Figtree','Mulish',
  'Roboto','Roboto Condensed','Roboto Flex',
  'Open Sans','Noto Sans','Source Sans 3',
  'Ubuntu','Karla','Josefin Sans','Cabin',
  'Space Grotesk','Space Mono',
  'IBM Plex Sans','IBM Plex Mono','IBM Plex Serif',
  'Epilogue','Urbanist','Barlow','Barlow Condensed',
  'SF Pro','SF Pro Display','SF Pro Text','SF Mono',
  'Helvetica Neue','Arial','system-ui',
  'Playfair Display','Merriweather','Lora','PT Serif',
  'Source Serif 4','EB Garamond','Libre Baskerville',
  'Fraunces','Cormorant','Cormorant Garamond',
  'JetBrains Mono','Fira Code','Cascadia Code',
  'Source Code Pro','Inconsolata','Courier New',
  'Righteous','Pacifico','Lobster','Bungee',
].sort();
