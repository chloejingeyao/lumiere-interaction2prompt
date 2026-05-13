// Offscreen document for tab capture (MV3).
// Records a cropped region of the active tab as a playable video AND captures
// periodic JPEG frames for AI vision analysis.

const cropCanvas  = document.createElement('canvas');
const cropCtx     = cropCanvas.getContext('2d');

let mediaStream     = null;
let mediaRecorder   = null;
let recordedChunks  = [];
let frameInterval   = null;
let drawInterval    = null;
let capturedFrames  = [];
let videoEl         = null;
let regionRect      = null;   // {x, y, width, height} in CSS px
let viewportSize    = null;   // {width, height} in CSS px

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.target !== 'offscreen') return false;

  if (message.type === 'START_RECORDING') {
    startRecording(message.streamId, message.region, message.viewport)
      .then(() => sendResponse({ ok: true }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.type === 'STOP_RECORDING') {
    stopRecording()
      .then(result => sendResponse({ ok: true, ...result }))
      .catch(err   => sendResponse({ ok: false, error: err.message, frames: [], videoDataUrl: null }));
    return true;
  }

  return false;
});

async function startRecording(streamId, region, viewport) {
  await cleanup();
  capturedFrames = [];
  recordedChunks = [];
  regionRect     = region   || null;
  viewportSize   = viewport || null;

  console.log('[offscreen] startRecording region:', JSON.stringify(regionRect));
  console.log('[offscreen] startRecording viewport:', JSON.stringify(viewportSize));

  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource:   'tab',
        chromeMediaSourceId: streamId,
      },
    },
  });

  // ── Live video element (source for cropping) ──────────────────────────────
  videoEl = document.createElement('video');
  videoEl.srcObject = mediaStream;
  videoEl.muted     = true;
  await videoEl.play();

  // Video stream dimensions (device pixels)
  const track    = mediaStream.getVideoTracks()[0];
  const settings = track.getSettings();
  const vidW     = settings.width  || 1280;
  const vidH     = settings.height || 720;

  // Viewport in CSS px — used to map region rect to video pixels
  const vpW  = viewportSize?.width  || vidW;
  const vpH  = viewportSize?.height || vidH;
  const dprX = vidW / vpW;
  const dprY = vidH / vpH;

  console.log('[offscreen] video:', vidW, 'x', vidH, 'viewport:', vpW, 'x', vpH, 'dpr:', dprX.toFixed(2), dprY.toFixed(2));

  // ── Compute crop rectangle in video-pixel space ───────────────────────────
  let sx, sy, sw, sh;
  if (regionRect && regionRect.width > 0 && regionRect.height > 0) {
    sx = Math.round(regionRect.x * dprX);
    sy = Math.round(regionRect.y * dprY);
    sw = Math.round(regionRect.width  * dprX);
    sh = Math.round(regionRect.height * dprY);
    // Clamp to video bounds
    sx = Math.max(0, Math.min(sx, vidW - 1));
    sy = Math.max(0, Math.min(sy, vidH - 1));
    sw = Math.min(sw, vidW - sx);
    sh = Math.min(sh, vidH - sy);
    console.log('[offscreen] crop:', sx, sy, sw, sh);
  } else {
    sx = 0; sy = 0; sw = vidW; sh = vidH;
    console.log('[offscreen] no region — capturing full tab');
  }

  // Output canvas — cap to 640 px wide
  const outScale = Math.min(1, 640 / (sw || 1));
  cropCanvas.width  = Math.max(1, Math.round(sw * outScale));
  cropCanvas.height = Math.max(1, Math.round(sh * outScale));

  const crop = { sx, sy, sw, sh };

  // Helper to draw the cropped frame
  function drawCropped() {
    if (!videoEl || videoEl.readyState < 2) return;
    cropCtx.drawImage(
      videoEl,
      crop.sx, crop.sy, crop.sw, crop.sh,
      0, 0, cropCanvas.width, cropCanvas.height,
    );
  }

  // ── MediaRecorder — record the cropped canvas stream ──────────────────────
  // Draw one frame first so the recorder doesn't start with a blank canvas
  drawCropped();

  const canvasStream = cropCanvas.captureStream(10);
  const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
    ? 'video/webm;codecs=vp9'
    : 'video/webm';
  mediaRecorder = new MediaRecorder(canvasStream, { mimeType });
  mediaRecorder.ondataavailable = (e) => {
    if (e.data.size > 0) recordedChunks.push(e.data);
  };
  mediaRecorder.start(250);

  // ── Draw loop (~10 fps) feeds the canvas stream ───────────────────────────
  drawInterval = setInterval(drawCropped, 100);

  // ── JPEG frame capture (every 500 ms for vision AI) ───────────────────────
  const startedAt = Date.now();
  frameInterval = setInterval(() => {
    if (!videoEl || videoEl.readyState < 2) return;
    capturedFrames.push({
      dataUrl: cropCanvas.toDataURL('image/jpeg', 0.55),
      ts:      (Date.now() - startedAt) / 1000,
    });
    if (capturedFrames.length > 30) capturedFrames.shift();
  }, 500);
}

async function stopRecording() {
  // Stop intervals
  if (drawInterval)  { clearInterval(drawInterval);  drawInterval  = null; }
  if (frameInterval) { clearInterval(frameInterval); frameInterval = null; }

  // Grab one last JPEG
  if (videoEl && videoEl.readyState >= 2) {
    capturedFrames.push({
      dataUrl: cropCanvas.toDataURL('image/jpeg', 0.55),
      ts: capturedFrames.length > 0 ? capturedFrames[capturedFrames.length - 1].ts + 0.5 : 0,
    });
  }

  // ── Stop MediaRecorder and build the video blob ───────────────────────────
  let videoDataUrl = null;
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    const blob = await new Promise((resolve) => {
      mediaRecorder.onstop = () => resolve(new Blob(recordedChunks, { type: mediaRecorder.mimeType }));
      mediaRecorder.stop();
    });
    videoDataUrl = await blobToDataUrl(blob);
  }

  await cleanup();

  const frames = sampleFrames(capturedFrames, 12);
  capturedFrames = [];
  recordedChunks = [];

  console.log('[offscreen] stopRecording — frames:', frames.length, 'video:', videoDataUrl ? 'yes' : 'no');
  return { frames, videoDataUrl };
}

async function cleanup() {
  if (drawInterval)  { clearInterval(drawInterval);  drawInterval  = null; }
  if (frameInterval) { clearInterval(frameInterval); frameInterval = null; }
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    try { mediaRecorder.stop(); } catch (_) {}
  }
  mediaRecorder = null;
  if (videoEl) { videoEl.srcObject = null; videoEl = null; }
  if (mediaStream) { mediaStream.getTracks().forEach(t => t.stop()); mediaStream = null; }
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.onerror   = reject;
    reader.readAsDataURL(blob);
  });
}

function sampleFrames(frames, max) {
  if (frames.length === 0) return [];
  if (frames.length <= max) return frames;
  const result = [];
  for (let i = 0; i < max; i++) {
    const idx = Math.round((i / (max - 1)) * (frames.length - 1));
    result.push(frames[idx]);
  }
  return result;
}
