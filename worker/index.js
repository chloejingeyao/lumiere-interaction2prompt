/**
 * V2C Bridge — Anthropic proxy
 *
 * Environment variables (set via `wrangler secret put`):
 *   ANTHROPIC_API_KEY      — your Anthropic API key
 *   ALLOWED_EXTENSION_IDS  — comma-separated Chrome extension IDs allowed to call this worker
 *                            e.g. "abcdefghijklmnopabcdefghijklmnop"
 *                            Find yours at chrome://extensions (enable Developer mode)
 */

const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

// ─── /analyze-interaction ────────────────────────────────────────────────────
async function handleAnalyzeInteraction(request, env, origin) {
  let body;
  try {
    body = await request.json();
  } catch {
    return new Response('Bad Request', { status: 400, headers: corsHeaders(origin) });
  }

  const { frames = [], metadata = {}, interactionHints = [] } = body;

  const m = metadata;
  const location = Array.isArray(m.componentTree) && m.componentTree.length
    ? m.componentTree.map(n => `<${n}>`).join(' > ')
    : `<${m.tagName || 'element'}>`;

  // Build the vision message
  const contentParts = [];

  // Map each frame timestamp to nearby events (within ±300ms)
  const recordingStart = interactionHints.length > 0 ? interactionHints[0].ts : null;
  const framesSlice = frames.slice(0, 12);

  function eventsNearFrame(frameTs) {
    if (!recordingStart || interactionHints.length === 0) return [];
    return interactionHints.filter(h => {
      const hTs = (h.ts - recordingStart) / 1000;
      return Math.abs(hTs - frameTs) <= 0.3;
    });
  }

  function describeEvent(h) {
    const label = h.target?.textContent
      ? `"${h.target.textContent}" <${h.target.tagName}>`
      : `<${h.target?.tagName || 'element'}>`;
    const val = h.value ? ` → "${h.value}"` : '';
    return `${h.type} on ${label}${val}`;
  }

  contentParts.push({
    type: 'text',
    text: `You are an expert UI interaction analyst. From the chronological key frames, write a developer-ready implementation note for the highlighted target element.

Goal: capture the interaction behavior and generate prompts for the coding agents to replicate for high-fidelity implementation.

Context:
- ${framesSlice.length} key frames are shown in chronological order.
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
- Use direct verbs such as reveals, expands, collapses, persists, resets, anchors, crossfades, slides, snaps, locks.`,
  });

  // Add frames interleaved with their nearby events
  for (const frame of framesSlice) {
    if (!frame.dataUrl) continue;
    const comma = frame.dataUrl.indexOf(',');
    if (comma === -1) continue;
    const mediaType = frame.dataUrl.slice(0, comma).match(/:(.*?);/)?.[1] || 'image/jpeg';
    const data = frame.dataUrl.slice(comma + 1);

    // Label above the frame with timestamp + any nearby events
    const nearbyEvents = eventsNearFrame(frame.ts);
    const eventAnnotation = nearbyEvents.length > 0
      ? ' — ' + nearbyEvents.map(describeEvent).join(' | ')
      : '';
    contentParts.push({
      type: 'text',
      text: `Frame at t=${frame.ts.toFixed(1)}s${eventAnnotation}`,
    });
    contentParts.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data } });
  }

  const anthropicRes = await fetch(ANTHROPIC_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5',
      max_tokens: 1024,
      messages: [{ role: 'user', content: contentParts }],
    }),
  });

  const raw  = await anthropicRes.json();
  const text = raw.content?.[0]?.text || '';
  // Model returns free-form text — surface it directly as the prompt
  const analysis = { prompt: text };

  return new Response(JSON.stringify(analysis), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
}

// ─── Main handler ────────────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') ?? '';

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    // Only allow requests from our Chrome extension
    const allowedOrigins = (env.ALLOWED_EXTENSION_IDS ?? '')
      .split(',')
      .map(id => `chrome-extension://${id.trim()}`)
      .filter(Boolean);

    if (!allowedOrigins.includes(origin)) {
      return new Response('Forbidden', { status: 403 });
    }

    // Route by path
    const url = new URL(request.url);

    if (url.pathname === '/analyze-interaction') {
      return handleAnalyzeInteraction(request, env, origin);
    }

    // Default: forward to Anthropic messages API
    let body;
    try {
      body = await request.json();
    } catch {
      return new Response('Bad Request', { status: 400 });
    }

    const anthropicRes = await fetch(ANTHROPIC_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });

    const data = await anthropicRes.json();

    return new Response(JSON.stringify(data), {
      status: anthropicRes.status,
      headers: {
        'Content-Type': 'application/json',
        ...corsHeaders(origin),
      },
    });
  },
};
