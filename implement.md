# Claude's thought

**Overall Assessment**  
The core insight — that PMs have visual intuition but lack the vocabulary to describe UI changes to AI — is real and underserved. The workflow (capture → match → synthesize) is sound. My main concern is that the quality of the generated prompt lives entirely on the quality of the captured metadata. If the extraction is shallow, the AI gets vague instructions. If it's too noisy, the AI hallucinates. Getting that extraction layer right is the highest-leverage engineering problem in this whole project.  
---

**Rethinking Metadata Extraction**  
The four fields in the PRD are a good start but need to be redefined. Here's what I'd actually capture:  
1\. HTML — Rethink: "Component Breadcrumb" \> raw outerHTML  
outerHTML of a React component can be thousands of lines of generated HTML. It's noise. What the AI actually needs is:

* A trimmed HTML snapshot (the target node only, max 3 levels deep, with ... truncation on deeply nested children)  
* The React component tree path: \<App\> → \<PageLayout\> → \<ContentSection\> → \<SectionHeader\> — this is the "surgical address" that tells AI exactly what file and component to touch

2\. Styles — Rethink: Semantic properties \+ class names, not raw getComputedStyle  
getComputedStyle returns \~300 properties. Dumping all of them into a prompt is useless. What matters:

* CSS class names (element.className) — this is where you detect the framework (Tailwind prefixes like bg-, text-, flex-; MUI classes like MuiButton-root; Shadcn, etc.)  
* Filtered computed properties — only the semantically meaningful ones:

layout:    display, flexDirection, alignItems, justifyContent, gap, gridTemplate\*  
sizing:    width, height, minWidth, maxWidth, padding, margin  
color:     backgroundColor, color, borderColor, opacity  
type:      fontSize, fontWeight, fontFamily, lineHeight, textAlign  
border:    border, borderRadius, boxShadow, outline  
position:  position, top, left, zIndex

This gives the AI the visual fingerprint without the noise.

3\. React Context — Rethink: Full fiber traversal \+ props snapshot  
\_\_reactFiber$ alone only gives you the current node. The real value is:

* Walk up the fiber tree to get the full component ancestry and display names  
* Read \_\_reactProps$ for the full props object — this is the component's interface and tells AI what data flows through it  
* Component display name resolution: fiber.type.displayName || fiber.type.name — handles both class and function components, though this degrades in minified production builds (worth noting as a known limitation)

4\. Logic Mapping — Rethink: Semantic handler inventory, not just event detection  
Event handlers in React aren't on the DOM — they're on \_\_reactProps$. So element.onclick will be empty. Instead:

* Enumerate \_\_reactProps$ keys that are event-shaped (/^on\[A-Z\]/) and capture their names and, if available, func.name for the handler identifier  
* Capture semantic attributes: data-\*, aria-\*, role, href, type — these reveal what the element does, not just that it has a handler  
* Disabled/loading/selected states: from props, ARIA attributes, or class names — tells AI the component has multiple visual states that must be preserved

5\. New field: CSS Framework Detection  
This should be a first-class extracted field, not deferred to Phase 3\. It's deterministic from class names and fundamentally changes how the AI should write the refactored code. Propose extracting:  
{  
  "cssFramework": "tailwind" | "mantine" | "mui" | "shadcn" | "styled-components" | "css-modules" | "unknown"  
}  
---

Proposed Extraction Schema  
Putting it together, the captured metadata object would look like:  
{  
  "componentTree": "\<App\> → \<PageLayout\> → \<SectionHeader\>",  
  "htmlSnapshot": "\<div class=\\"section-header flex items-center gap-2\\"\>...\</div\>",  
  "cssFramework": "tailwind",  
  "classNames": \["flex", "items-center", "gap-2", "text-sm", "font-semibold"\],  
  "computedStyles": {  
    "display": "flex",  
    "fontSize": "14px",  
    "fontWeight": "600",  
    "backgroundColor": "transparent",  
    "padding": "8px 12px",  
    "borderRadius": "6px"  
  },  
  "props": {  
    "title": "Overview",  
    "isActive": true  
  },  
  "eventHandlers": \["onClick", "onKeyDown"\],  
  "semanticAttributes": {  
    "role": "button",  
    "aria-selected": "true",  
    "data-section-id": "overview"  
  }  
}  
This is compact, AI-readable, and contains everything needed to generate a precise prompt.  
---

**Build Approach**  
For the MVP, I'd prioritize in this order:

1. Content script \+ inspector (hover highlight, click-to-lock) — this is the UX core  
2. Metadata extraction as defined above — get this right before anything else  
3. Minimal JSON component library (flat file, no backend)  
4. Prompt template engine — straightforward string interpolation once (1) and (2) are solid  
5. Sidepanel UI — React, simple and focused

The riskiest unknown is fiber traversal reliability across different React versions and build configurations (especially minified prod builds). I'd prototype that extraction logic against a few real-world React apps early to understand the degradation modes before committing to what we promise the user.  
What's your timeline pressure for the MVP? That would affect how conservatively I'd scope the fiber traversal.

---

## **What's Straightforward (No Issues)**

These are standard DOM APIs — content scripts have full access:

| Field | API | Reliability |
| :---- | :---- | :---- |
| outerHTML / trimmed HTML | element.outerHTML | ✅ Always works |
| CSS class names | element.classList | ✅ Always works |
| Computed styles | window.getComputedStyle(element) | ✅ Always works |
| data-\* attributes | element.dataset | ✅ Always works |
| aria-\*, role | element.getAttribute(...) | ✅ Always works |
| CSS framework detection | Inferred from class names | ✅ Always works |

---

## **What Works — But With Caveats**

### **React Fiber (\_\_reactFiber$)**

This is the critical one. Here's the honest picture:

React attaches the fiber directly to the DOM node as a property — and DOM node properties are shared between the page and content script. So you can access it.

But there's a catch: the key isn't literally \_\_reactFiber$ — it's \_\_reactFiber$ \+ a random suffix generated at runtime (e.g., \_\_reactFiber$abc123k). You have to find it like this:  
const fiberKey \= Object.keys(element).find(k \=\> k.startsWith('\_\_reactFiber$'));  
const fiber \= element\[fiberKey\];

Once you have the fiber, you can traverse .return to walk up the tree and read .type.displayName || .type.name for component names. This works reliably in development builds.

In minified production builds, component names become single characters (t, n, e). The component tree degrades to garbage like \<t\> → \<n\> → \<e\>. This is a real limitation we need to be upfront about.

### **React Props (\_\_reactProps$)**

Same mechanism — \_\_reactProps$ \+ random suffix is also on the DOM node. This gives you the actual props object including all onClick, onChange, etc. handlers:  
const propsKey \= Object.keys(element).find(k \=\> k.startsWith('\_\_reactProps$'));  
const props \= element\[propsKey\]; // { onClick: f(), title: "Overview", ... }

Event handler *names* are readable (props.onClick.name → "handleSectionClick"). The function body is not accessible this way — but you don't need it for the prompt.  
---

## **What Doesn't Work**

### **Native DOM event listeners**

element.onclick is always null in React — React uses a synthetic event system delegated to the root. There's no JavaScript API to read addEventListener\-registered handlers. This is a hard browser limitation. The \_\_reactProps$ approach above is the correct workaround.  
---

## **The Tricky Part: Isolated World**

Content scripts run in an isolated JavaScript world — they share the DOM but not the window object or JS heap with the page. This means:

* Reading DOM node properties (like \_\_reactFiber$) → works because DOM nodes are shared  
* Reading window.React or window.\_\_REDUX\_STORE\_\_ → does NOT work

For our purposes this is fine, since everything we need hangs off DOM nodes. But if we ever want deeper access (e.g., reading a component's closure state), we'd need to inject a \<script\> tag into the page that runs in the page's JS context and postMessages data back to the content script. Worth knowing as an escape hatch.  
---

## **Summary: What We Can Actually Extract**

✅ Reliable (any build):  
  \- outerHTML (trimmed)  
  \- className / classList  
  \- getComputedStyle (filtered)  
  \- data-\*, aria-\*, role attributes  
  \- CSS framework detection from class names

✅ Works in dev, degrades in prod:  
  \- React component tree (fiber traversal)  
  \- Component display names  
  \- Props snapshot (\_\_reactProps$)  
  \- Event handler names

❌ Not accessible:  
  \- addEventListener handlers (browser limitation)  
  \- Component source code / closure state

---

## **My Recommendation**

The target users are PMs using tools like Cursor or Windsurf, where the preview is typically running in development mode. That's where React fiber traversal works perfectly. I'd scope the MVP to dev-mode reliability and call it out clearly in the UI — something like "Inspection works best on development builds." That's honest and doesn't block the product from being useful.

# Requirements V2

# **PRD: Visual-to-Code Bridge (V2C Bridge)**

## **1\. Executive Summary**

**Goal:** To build a Chrome Extension that acts as a "Visual-to-Prompt" bridge to enable users to work with AI coding tools more easily. It enables users to select an unsatisfactory UI element in the inspection window and map it to a professional UI component from a library, automatically generating a high-quality prompt.

**Target User:** Product Managers or non-frontend developers who have a clear "visual intuition" but lack the technical vocabulary to describe complex UI changes to AI.

---

## **2\. Core Workflow**

1. **Capture (The "From"):** User clicks an element in the inspection mode. The extension extracts the DOM snippet, computed styles, and necessary component context.  
2. **Match (The "To"):** User selects a target component from a visual "Metadata-based" library (e.g., changing a basic list to a "Segmented Control").  
3. **Synthesize:** The extension combines the "From" and "To" data to generate a structured, "surgical" prompt for the AI coding tool to execute.

---

## **3\. Functional Requirements**

### **A. Smart Inspector (Content Script)**

* **Element Selection:** Implement a "point-and-click" inspector that highlights elements on hover and locks them on click.  
* **Metadata Extraction:** \* **HTML:** Capture the outerHTML of the target node.  
  * **Styles:** Use getComputedStyle to get exact dimensions, colors, and spacing.  
  * **React Context:** Access the \_\_reactFiber$ property to identify the React component name (e.g., \<SectionHeader /\>).  
  * **Logic Mapping:** Identify event handlers like onClick or onChange to ensure the AI doesn't break business logic during the UI refactor.

### **B. Metadata-based UI Library (Sidepanel)**

* **Visual Gallery:** Display a searchable list of components based on the ui-components.json file.  
* **Component Metadata:** Each item must include:  
  * ui\_name: Technical name of the component.  
  * description: Visual and functional behavior.  
  * style\_hints (Future): Tailwind classes or design tokens associated with the style.

### **C. Prompt Generation Engine**

* **Template Logic:** Create a template that translates visual differences into technical instructions.  
* **Drafting the Prompt:**  
  "Refactor the selected \[Source\_Component\] into a \[Target\_Name\].  
  **Visual Reference:** \[Target\_Description\].  
  **Constraints:** Maintain the existing \[Logic\_Handlers\]. Use the project's current CSS framework."  
* Enable multiple elements

---

## **4\. Technical Architecture**

* **Content Script:** Responsible for the overlay UI and DOM sniffing on the preview page.  
* **Sidepanel API:** The primary interface for the UI library and prompt preview. This allows the tool to stay open while the user interacts with the main coding environment.  
* **Prompt Synthesizer:** A utility function that merges the captured DOM state with the selected JSON metadata.

---

## **5\. UI/UX Design**

* **Source View (Top):** Shows a "Code Snippet" of what was captured (e.g., \<App\> \<SectionHeader /\> ... \</App\>).  
* **Library View (Middle):** A searchable list of UI components with their descriptions.  
* **Action View (Bottom):** A "Copy Prompt" button that becomes active once both a Source and Target are selected.

---

## **6\. Development Roadmap**

* **Phase 1 (MVP):** Enable DOM capture \+ list-based UI library \+ basic clipboard copy of the prompt.  
* **Phase 2 (Visuals):** Add image thumbnails to the UI library for "pick-by-sight" interaction.  
* **Phase 3 (Context Awareness):** Automatically detect if the project uses Tailwind, Mantine, or Shadcn and adjust the generated prompt accordingly.

# Requirements V1

## **Project Title: Visual-to-Code Bridge (V2C Bridge)**

### **1\. High-Level Architecture**

The system consists of three main layers:

* **The UI Gallery (Frontend):** A custom Webview in the Antigravity Sidebar where you browse and select components.  
* **The Context Bridge:** A middleware that captures the "currently inspected element" from the Preview pane.  
* **The Prompt Orchestrator (MCP Server):** A RAG-enabled server that fetches the "Ideal UI" metadata and constructs the prompt for the LLM.

---

### **2\. Implementation Modules**

#### **Module A: The UI Gallery Sidebar (VS Code Extension)**

Because you cannot directly modify the built-in "Inspect" popup, you will build a side-by-side workflow.

* **Tech Stack:** TypeScript, React (inside VS Code Webview).  
* **Functionality:**  
  * Fetch and display your UI library (e.g., from component.gallery or a local JSON/Storybook).  
  * Provide a "Replace Selected with This" button for each component.  
  * **Action:** When a component is clicked, it sends a message to the IDE containing the **reference metadata** (CSS specs, HTML structure, or a screenshot URL).

#### **Module B: The UI Reference MCP Server (RAG Layer)**

This is where your PM expertise in RAG comes in. Instead of just sending a link, you send structured knowledge.

* **Feature:** **Component Metadata Retrieval.**  
* **Logic:**  
  1. Store your UI library as a set of Markdown/JSON files.  
  2. Each entry contains: Visual Description, Core CSS Logic (e.g., Tailwind classes), and Design Principles.  
  3. The MCP tool get\_ui\_reference(component\_id) retrieves this structured data to "prime" the LLM.

#### **Module C: The Prompt Orchestration Engine**

This module automatically constructs the "Perfect Prompt" by merging the two contexts.

| Data Source | Content Captured |
| :---- | :---- |
| **Antigravity Inspector** | The "Bad" Code \+ DOM Structure \+ Current Style |
| **Your UI Gallery** | The "Ideal" Reference Metadata \+ Design Rules |
| **System Prompt** | Refactoring instructions (e.g., "Maintain props, swap styles") |

---

### **3\. Step-by-Step User Workflow**

1. **Identify:** You enter "Inspect Mode" in the Antigravity Preview window and click the component you want to change. (Antigravity now "knows" what code you are looking at).  
2. **Select:** In the **V2C Bridge Sidebar**, you find the component you like (e.g., a specific "Glassmorphism Card" from your library) and click **"Apply to Selection"**.  
3. **Synthesize:** The extension triggers a background command:  
   agent.applyRefactor(currentTarget, libraryReference)  
4. **Execute:** The system generates the prompt automatically:  
   "Refactor the currently selected React component. **Source:** \[Captured Code\]. **Target Style:** \[Library Metadata\]. **Constraint:** Use Tailwind v4, maintain all existing onClick handlers, and match the padding-ratio of the target reference."  
5. **Review:** Antigravity shows the diff. You click **Accept**.

---

### **4\. Technical Roadmap**

* **Phase 1 (MVP):** Build a basic VS Code Sidebar that hardcodes a few Prompt templates. You manually copy-paste the "Reference ID."  
* **Phase 2 (Integration):** Use the vscode.window.registerWebviewViewProvider to host the gallery. Implement the postMessage API to communicate between the Gallery and the Antigravity Agent.  
* **Phase 3 (Agentic):** Connect the Gallery to an **MCP Server**. This allows the Agent to "ask" the gallery for suggestions if you describe a vibe (e.g., "Show me something more minimalist").

### **5\. Why this works for you (The PM Perspective)**

This setup eliminates the **"Semantic Gap"**. Instead of trying to find the words for "that specific type of rounded shadow," you are using **structured data as a proxy for visual intent**.

By building this as an **MCP tool**, you make your UI library "discoverable" by the AI, turning your personal taste into a queryable database.

---

**Next Step Recommendation:**

Would you like a boilerplate mcp\_config.json and a basic schema for how to structure your UI library components so the LLM understands them best?

# UI Styles

Entering animation

- Fade in  
- Slide in from bottom  
- Scale up from center  
- Stagger

Spring physics  
Ease out cubic  
Overshoot  
Snappy

操作等待  
Hover lift  
Press feedback  
Ripple  
Glow pulse

流程感  
Progress fill  
Counter animation  
Skeleton loading  
Page transition crossfade

文字动效  
Scramble effect  
Wave effect  
Color shift

等待动效  
Stroke ring  
Liquid fill  
Pulse bars  
Morph spinner  
Progress scan

# Prompt Generation

Next step:

- Introduce claude Haiku to generate the prompt for user for the annotator mode  
- When the generate prompt should be enabled:  
  - Element selected, at least one comment of the selected element has been made  
- Input:  
  - The extracted data of the selected elements  
  - User’s comments of each selected element  
  - No hallucination   
- Output:  
  - An synthesized prompt that can help user better articulate the change request to LLM (coding agent, claude code specifically) in a conciser and cleaner way. So the LLM (coding agent, claude code specifically) can understand and execute better

# Landing page

I built a tool to save my own sanity (and my tokens). Meet Lumiere, a Chrome extension that bridges the gap between design vision and AI execution. 

I’ve been doing a lot of vibe coding recently, but the "vibe" breaks down when it comes to precise UI. 

**The problem:** Vibe coding is fast, but UI iteration is a grind. I was tired of:

* 📸 Taking 20+ screenshots for a single component.  
* 📝 Writing "manual" change requests from scratch.  
* 💸 Wasting tokens on vague prompts that the agent didn't understand.

**The solution:** Lumiere turns your live-site annotations into developer-ready prompts. You describe what you see; it generates the technical language AI agents need. No more screenshot-bloat, no more prompt-guessing. Point, annotate, and ship.

# Tab 7

# **Privacy Policy for Lumiere**

Effective date: April 12, 2026

## **What Lumiere does**

Lumiere is a Chrome extension that lets you select UI elements on any webpage and generate AI-powered refactoring prompts based on those elements.

## **Data we collect**

Lumiere does not collect, store, or transmit any personal information.

When you use the prompt generation feature, Lumiere sends the following data to our server:

* CSS properties and computed styles of the selected element  
* The element's tag name, class names, and visible text content  
* Any annotation comments you have typed in the extension panel

This data is sent solely to generate a refactoring prompt and is not logged, stored, or used for any other purpose.

## **Data we do not collect**

* We do not collect your name, email address, or any account information  
* We do not track your browsing history or which websites you visit  
* We do not store the content of pages you visit  
* We do not use cookies or any tracking technologies  
* We do not sell or share any data with third parties

## **Third-party services**

Lumiere uses the Anthropic Claude API to generate prompts. Element metadata is forwarded through our proxy server to Anthropic's API. Anthropic's own privacy policy applies to data processed by their API. We do not share any additional user information with Anthropic beyond what is described above.

## **Local storage**

Lumiere uses Chrome's storage.sync API to save your in-extension settings (such as scope preferences) locally to your browser. This data never leaves your device except through Chrome's built-in sync mechanism if you have Chrome Sync enabled.

## **Changes to this policy**

We may update this policy as the extension evolves. The effective date at the top of this page will reflect any changes.

## **Contact**

If you have questions about this privacy policy, contact us at: jy126c@gmail.com\]

# Tab 8

Goal  
Add a new mode where you:

1. pick an element or area on the page,  
2. record the tab visually as video,  
3. track that area during the recording,  
4. extract key frames after stop,  
5. send frames \+ structural metadata to a model,  
6. generate a developer-ready prompt describing the interaction.

Architecture  
Keep the current extension split and add one new pipeline:

* extension/page\_script.js  
  Own area selection, region tracking, and lightweight DOM metadata capture.  
* extension/content\_script.js  
  Relay recording commands and tracked-region updates between page and extension.  
* extension/background.js  
  Own tab capture lifecycle and recording session state.  
* extension/sidepanel/panel.js  
  Add UI for Pick Area, Start Recording, Stop, Generate Prompt, and preview.  
* extension/sidepanel/store.js  
  Add recording session state and a new prompt builder for interaction/video sessions.  
* worker/index.js  
  Add a server endpoint that accepts extracted frames \+ metadata and calls a vision model.

Phase 1: Data Model  
Add a session shape first so the rest stays clean.

In store.js, add something like:

recording: {  
  mode: 'idle', // idle | picking | ready | recording | processing  
  tabId: null,  
  sessionId: null,  
  selectedRegion: null, // selector, initialRect, page metadata  
  trackedRects: \[\], // \[{ ts, rect, scrollX, scrollY }\]  
  events: \[\], // optional lightweight DOM events  
  videoBlobUrl: null,  
  extractedFrames: \[\], // \[{ ts, dataUrl or uploadRef, rect }\]  
  generatedPrompt: null,  
}

On the page-script side, define:

{  
  selector,  
  metadata,  
  initialRect,  
  viewport,  
  pageUrl,  
  pageTitle  
}

Phase 2: Area Selection  
Reuse your current inspector instead of inventing a new picker.

Implementation:

* Add START\_REGION\_PICK and STOP\_REGION\_PICK.  
* In page\_script.js, when clicked, capture:  
  * stable selector  
  * element metadata  
  * bounding rect  
  * nearby context  
* Post back V2C\_REGION\_SELECTED.

Deliverable:

* The sidepanel can show “Selected area: \<button\> in \<Toolbar\>”.

Phase 3: Region Tracking During Recording  
This is the most important piece for making video useful.

In page\_script.js:

* Keep a reference to the selected root element.  
* Start a tracker loop while recording:  
  * sample every 150-250ms  
  * read getBoundingClientRect()  
  * include scrollX, scrollY, viewport size  
* Also listen for:  
  * scroll  
  * resize  
  * subtree mutations that may replace the node  
* If the node is replaced, re-resolve using selector or nearest fallback heuristic.

Send periodic messages like:

{  
  type: 'V2C\_REGION\_TRACK',  
  data: {  
    ts,  
    rect: { x, y, width, height },  
    scrollX,  
    scrollY,  
    visible: true  
  }  
}

Why this matters:

* You’ll record the whole tab, but crop analysis to the tracked area later.  
* If the page scrolls or rerenders, your crop still follows the right UI.

Phase 4: Tab Recording  
Do this in the background/service-worker layer.

Use:

* chrome.tabCapture if you want Chrome-extension-native tab capture.  
* Fallback: offscreen document \+ media plumbing if needed later.

Recommended first pass:

* start capture from the current tab only  
* record video/webm via MediaRecorder  
* chunk every 1 second  
* store chunks in memory for short sessions

Flow:

* sidepanel sends START\_RECORDING  
* background starts capture for active tab  
* background returns RECORDING\_STARTED  
* sidepanel tells page script START\_REGION\_TRACKING  
* on stop:  
  * background stops MediaRecorder  
  * assembles final Blob  
  * returns session complete event

You’ll likely need manifest updates for capture permissions.

Phase 5: Lightweight Interaction Hints  
Even if video is primary, keep cheap metadata to improve summarization.

In page\_script.js, while recording:

* log sparse events inside the selected subtree:  
  * click  
  * input  
  * change  
  * submit  
* log them as hints, not the source of truth

This gives the model anchors like:

* “click on ‘Filter’ at 1.2s”  
* “input changed at 2.0s”

These hints help align frames with what likely happened.

Phase 6: Frame Extraction  
Do not send raw video to the model first. Extract key frames.

Best first version:

* after recording stops, load the blob into a hidden video element  
* sample frames every 500ms  
* also sample around hint events:  
  * eventTs \- 200ms  
  * eventTs  
  * eventTs \+ 400ms

For each sampled frame:

* draw full frame to canvas  
* crop to:  
  * selected region plus padding  
  * optionally one wider-context crop too  
* save as compressed JPEG or WebP

For each frame, keep:

{  
  ts,  
  crop: 'focused' | 'context',  
  image,  
  rect,  
  eventHint,  
}

Phase 7: Vision Summarization  
Send only the useful frames plus metadata to your worker.

Payload:

* page URL/title  
* selected element metadata  
* tracked rect timeline  
* event hints  
* 8-20 key frames max  
* optionally “before” and “after” DOM snapshots of the selected subtree

Ask the model for structured output like:

{  
  "summary": "User opened the sort menu and changed sorting to Price: Low to High.",  
  "steps": \[  
    "Initial state shows the sort trigger closed.",  
    "User activates the sort control.",  
    "A dropdown menu appears below the trigger.",  
    "User selects 'Price: Low to High'.",  
    "The menu closes and the product list updates."  
  \],  
  "ui\_changes": \[  
    "Dropdown visibility toggles closed \-\> open \-\> closed",  
    "Selected sort label changes",  
    "Product ordering changes"  
  \],  
  "prompt": "..."  
}

Phase 8: Prompt Generator  
In store.js, add buildInteractionPrompt(sessionAnalysis).

Prompt format should include:

* where the interaction happened  
* what the user did  
* what changed visually  
* what behavior/state transition should be preserved or recreated

Example output:  
“Within the product toolbar sort control, implement the interaction where activating the trigger opens a dropdown anchored below it, selecting ‘Price: Low to High’ updates the trigger label, closes the menu, and reorders the product grid.”

Phase 9: Sidepanel UI  
Add a dedicated “Record Interaction” mode in panel.js.

UI flow:

* Pick Area  
* show selected area summary  
* Start Recording  
* live status: recording timer \+ tracked status  
* Stop  
* processing state  
* result cards:  
  * key frames  
  * summary  
  * generated prompt  
  * copy button

Keep this separate from your current inspect/annotate flow so it doesn’t get messy.

Phase 10: Worker API  
Extend worker/index.js with an endpoint like /analyze-interaction.

Responsibilities:

* validate frame payload size/count  
* call the vision-capable model  
* return structured JSON  
* optionally store nothing by default for privacy

Keep the prompt strict:

* describe only observed behavior  
* avoid guessing hidden implementation details  
* mention uncertainty when needed

Manifest / Permissions  
You’ll likely need to expand extension/manifest.json for tab capture-related permissions and any offscreen flow you choose. This is the one place to verify carefully during implementation because Chrome capture permissions are picky.

MVP Scope  
Build this first:

* pick area  
* record current tab  
* track region rect  
* extract 10-12 cropped frames  
* send frames \+ metadata to model  
* generate prompt

Skip for v1:

* audio  
* full-screen desktop capture  
* cross-tab sessions  
* long recordings  
* fancy automatic event segmentation  
* persistent storage

Big Risks

* Recording permissions and service-worker capture lifecycle are the trickiest browser pieces.  
* Region tracking can break if the selected node gets replaced during rerender.  
* Too many frames will make model calls slow and expensive.  
* Vision-only inference can hallucinate intent, so keep DOM metadata in the payload.

Recommended Build Order

1. Add region selection and tracked-rect messages.  
2. Add start/stop recording in the background.  
3. Save a local video blob and prove recording works.  
4. Extract frames from the finished video.  
5. Crop frames using tracked rect timeline.  
6. Add worker endpoint for vision summarization.  
7. Add prompt generation and sidepanel polish.

If you want, I can turn this into a file-by-file implementation checklist next, with the exact message types and state transitions for this codebase.

