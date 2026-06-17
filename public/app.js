/* ── State ─────────────────────────────────────────────── */
const state = {
  file: null,
  localPath: null,
  fileUri: null,
  geminiName: null,
  mimeType: null,
  segments: [],
  scenes: [],
  selectedTheme: 'dark-minimal',
  jobId: null,
};

/* ── DOM refs ──────────────────────────────────────────── */
const $ = (id) => document.getElementById(id);

const dropZone        = $('drop-zone');
const fileInput       = $('file-input');
const filePreview     = $('file-preview');
const fileNameEl      = $('file-name');
const fileSizeEl      = $('file-size');
const removeFileBtn   = $('remove-file');
const btnUpload       = $('btn-upload');
const btnUploadLabel  = $('btn-upload-label');
const uploadSpinner   = $('upload-spinner');
const uploadError     = $('upload-error');
const transcribeStatus = $('transcribe-status');
const themeGrid       = $('theme-grid');
const transcriptScroll = $('transcript-scroll');
const showCaptionsCheckbox = $('show-captions-checkbox');
const btnRender       = $('btn-render');
const btnRenderLabel  = $('btn-render-label');
const renderSpinner   = $('render-spinner');
const renderError     = $('render-error');
const progressFill    = $('progress-fill');
const progressLabel   = $('progress-label');
const doneBox         = $('done-box');
const downloadLink    = $('download-link');
const creditsLink     = $('credits-link');
const btnRestart      = $('btn-restart');
const btnDebug        = $('btn-debug');
const btnDebugLabel   = $('btn-debug-label');
const debugSpinner    = $('debug-spinner');

/* ── Step management ───────────────────────────────────── */
const PANELS = ['upload', 'transcribe', 'theme', 'render'];

function showPanel(name) {
  PANELS.forEach((p, idx) => {
    const panel = $(`panel-${p}`);
    const indicator = $(`step-indicator-${idx + 1}`);
    const isActive = p === name;
    const isDone = PANELS.indexOf(p) < PANELS.indexOf(name);

    panel.classList.toggle('active', isActive);
    indicator.classList.toggle('active', isActive);
    indicator.classList.toggle('done', isDone);
    indicator.querySelector('.step-bubble').textContent = isDone ? '✓' : idx + 1;
  });

  // Update step connectors
  document.querySelectorAll('.step-connector').forEach((conn, idx) => {
    conn.classList.toggle('done', PANELS.indexOf(name) > idx + 1);
  });
}

/* ── Drag & drop ───────────────────────────────────────── */
dropZone.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') fileInput.click(); });

dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('dragover'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('dragover');
  const file = e.dataTransfer.files[0];
  if (file) handleFile(file);
});

fileInput.addEventListener('change', () => {
  if (fileInput.files[0]) handleFile(fileInput.files[0]);
});

removeFileBtn.addEventListener('click', () => {
  state.file = null;
  fileInput.value = '';
  filePreview.classList.add('hidden');
  dropZone.classList.remove('hidden');
  btnUpload.disabled = true;
  hideError(uploadError);
});

function handleFile(file) {
  const allowed = ['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav', 'audio/wave'];
  if (!allowed.includes(file.type) && !file.name.match(/\.(mp3|wav)$/i)) {
    showError(uploadError, 'Only MP3 and WAV files are supported.');
    return;
  }
  const maxBytes = 50 * 1024 * 1024;
  if (file.size > maxBytes) {
    showError(uploadError, 'File is too large. Maximum size is 50 MB.');
    return;
  }

  state.file = file;
  hideError(uploadError);
  fileNameEl.textContent = file.name;
  fileSizeEl.textContent = formatBytes(file.size);
  dropZone.classList.add('hidden');
  filePreview.classList.remove('hidden');
  btnUpload.disabled = false;
}

/* ── Debug Mode ────────────────────────────────────────── */
btnDebug.addEventListener('click', async () => {
  setLoading(btnDebug, debugSpinner, btnDebugLabel, true, 'Loading mock data…');
  hideError(uploadError);

  try {
    const res = await fetch('/api/debug/mock');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Debug endpoint failed');

    // Inject mock state — no Gemini API calls made
    state.localPath     = data.localPath;
    state.fileUri       = null;
    state.geminiName    = null;
    state.mimeType      = 'audio/mpeg';
    state.segments      = data.segments;
    state.scenes        = data.scenes;

    // Show fake file info in the preview (optional, cosmetic)
    fileNameEl.textContent = data.originalName;
    fileSizeEl.textContent = formatBytes(data.size);

    await loadThemes();
    renderTranscriptPreview();
    renderScenesList();
    showPanel('theme');

  } catch (err) {
    showError(uploadError, '🧪 Debug mode error: ' + err.message);
  } finally {
    setLoading(btnDebug, debugSpinner, btnDebugLabel, false, '🧪 Debug Mode (skip Gemini)');
  }
});

/* ── Upload & transcribe ───────────────────────────────── */
btnUpload.addEventListener('click', async () => {
  if (!state.file) return;

  setLoading(btnUpload, uploadSpinner, btnUploadLabel, true, 'Uploading…');
  hideError(uploadError);

  try {
    // 1. Upload file to server → Gemini File API
    const formData = new FormData();
    formData.append('audio', state.file);

    const uploadRes = await fetch('/api/upload', { method: 'POST', body: formData });
    const uploadData = await uploadRes.json();
    if (!uploadRes.ok) throw new Error(uploadData.error || 'Upload failed');

    state.localPath = uploadData.localPath;
    state.fileUri   = uploadData.fileUri;
    state.geminiName = uploadData.geminiName;
    state.mimeType  = uploadData.mimeType;

    // 2. Switch to transcribing panel
    showPanel('transcribe');
    transcribeStatus.textContent = 'Sending to Gemini for transcription…';

    // 3. Transcribe
    const transcribeRes = await fetch('/api/transcribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileUri: state.fileUri, mimeType: state.mimeType, localPath: state.localPath }),
    });
    const transcribeData = await transcribeRes.json();
    if (!transcribeRes.ok) throw new Error(transcribeData.error || 'Transcription failed');

    state.segments = transcribeData.segments;
    state.scenes   = transcribeData.scenes || [];
    transcribeStatus.textContent = `Done! Found ${state.segments.length} segments.`;

    // 4. Load themes and show theme panel
    await loadThemes();
    renderTranscriptPreview();
    renderScenesList();
    showPanel('theme');

  } catch (err) {
    showPanel('upload');
    showError(uploadError, err.message);
  } finally {
    setLoading(btnUpload, uploadSpinner, btnUploadLabel, false, 'Upload & Analyse');
  }
});

/* ── Load themes from server ───────────────────────────── */
async function loadThemes() {
  const res = await fetch('/api/render/themes');
  const themes = await res.json();
  themeGrid.innerHTML = '';

  themes.forEach((theme) => {
    const card = document.createElement('div');
    card.className = `theme-card theme-bg-${theme.key}`;
    card.setAttribute('role', 'radio');
    card.setAttribute('tabindex', '0');
    card.setAttribute('aria-checked', theme.key === state.selectedTheme ? 'true' : 'false');
    card.dataset.key = theme.key;
    card.innerHTML = `
      <span class="theme-name" style="color:${theme.fontColor}">${theme.label}</span>
      <span class="theme-caption-demo" style="color:${theme.fontColor}">Sample caption text…</span>
    `;

    if (theme.key === state.selectedTheme) card.classList.add('selected');

    card.addEventListener('click', () => selectTheme(theme.key));
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') selectTheme(theme.key);
    });

    themeGrid.appendChild(card);
  });
}

function selectTheme(key) {
  state.selectedTheme = key;
  themeGrid.querySelectorAll('.theme-card').forEach((c) => {
    const isSelected = c.dataset.key === key;
    c.classList.toggle('selected', isSelected);
    c.setAttribute('aria-checked', isSelected ? 'true' : 'false');
  });
}

/* ── Transcript preview ────────────────────────────────── */
function renderTranscriptPreview() {
  transcriptScroll.innerHTML = state.segments.map((seg) => {
    const t = formatTime(seg.start);
    return `<span class="segment-chip">${t}</span>${escapeHtml(seg.text)} `;
  }).join('');
}

/* ── Scenes preview ────────────────────────────────────── */
function renderScenesList() {
  const container = $('scenes-preview-container');
  const list = $('scenes-list');
  if (!state.scenes || state.scenes.length === 0) {
    container.classList.add('hidden');
    return;
  }
  container.classList.remove('hidden');
  list.innerHTML = state.scenes.map((scene, idx) => {
    const isSlide = scene.type === 'slide';
    const displayStr = isSlide ? `Slide: ${scene.slideText || scene.context || 'Important Point'}` : `Video: ${scene.searchQuery || 'Auto-selected'}`;
    const color = isSlide ? '#ffb86c' : '#00ffcc';
    const icon = isSlide ? '📝' : '🎬';
    
    return `
      <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid rgba(255,255,255,0.05); padding-bottom: 4px; margin-bottom: 4px; gap: 15px;">
        <span style="color: rgba(255,255,255,0.8);">${icon} Scene ${idx + 1} (${formatTime(scene.start)} - ${formatTime(scene.end)})</span>
        <span style="font-weight: 600; color: ${color}; text-align: right;">"${escapeHtml(displayStr)}"</span>
      </div>
    `;
  }).join('');
}

/* ── Helpers ───────────────────────────────────────────── */
function escapeHtml(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ── Render ────────────────────────────────────────────── */
btnRender.addEventListener('click', async () => {
  setLoading(btnRender, renderSpinner, btnRenderLabel, true, 'Starting…');
  hideError(renderError);

  try {
    const renderRes = await fetch('/api/render', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        localPath: state.localPath,
        segments: state.segments,
        theme: state.selectedTheme,
        scenes: state.scenes,
        showCaptions: showCaptionsCheckbox.checked,
      }),
    });
    const renderData = await renderRes.json();
    if (!renderRes.ok) throw new Error(renderData.error || 'Render request failed');

    state.jobId = renderData.jobId;
    showPanel('render');
    listenProgress(state.jobId);

  } catch (err) {
    showError(renderError, err.message);
  } finally {
    setLoading(btnRender, renderSpinner, btnRenderLabel, false, '🎬 Render Video');
  }
});

/* ── SSE progress ──────────────────────────────────────── */
function listenProgress(jobId) {
  const source = new EventSource(`/api/render/progress/${jobId}`);

  source.onmessage = (e) => {
    const data = JSON.parse(e.data);

    if (data.status === 'rendering' || data.status === 'queued') {
      const pct = data.progress || 0;
      progressFill.style.width = `${pct}%`;
      progressLabel.textContent = `${pct}%`;
    }

    if (data.status === 'done') {
      source.close();
      progressFill.style.width = '100%';
      progressLabel.textContent = '100%';
      downloadLink.href = `/api/download/${data.filename}`;
      downloadLink.download = data.filename;

      if (state.scenes && state.scenes.length > 0) {
        const creditsFilename = data.filename.replace('.mp4', '_credits.txt');
        creditsLink.href = `/api/download/${creditsFilename}`;
        creditsLink.download = creditsFilename;
        creditsLink.classList.remove('hidden');
      } else {
        creditsLink.classList.add('hidden');
      }

      doneBox.classList.remove('hidden');
    }

    if (data.status === 'error') {
      source.close();
      showPanel('theme');
      showError(renderError, `Render failed: ${data.error}`);
    }
  };

  source.onerror = () => {
    source.close();
    showPanel('theme');
    showError(renderError, 'Lost connection to server during rendering.');
  };
}

/* ── Restart ───────────────────────────────────────────── */
btnRestart.addEventListener('click', () => {
  Object.assign(state, {
    file: null, localPath: null, fileUri: null,
    geminiName: null, mimeType: null, segments: [],
    scenes: [], selectedTheme: 'dark-minimal', jobId: null,
  });
  fileInput.value = '';
  filePreview.classList.add('hidden');
  dropZone.classList.remove('hidden');
  btnUpload.disabled = true;
  doneBox.classList.add('hidden');
  creditsLink.classList.add('hidden');
  progressFill.style.width = '0%';
  progressLabel.textContent = '0%';
  showPanel('upload');
});

/* ── Helpers ───────────────────────────────────────────── */
function setLoading(btn, spinner, label, loading, text) {
  btn.disabled = loading;
  spinner.classList.toggle('hidden', !loading);
  label.textContent = text;
}

function showError(el, msg) {
  el.textContent = msg;
  el.classList.remove('hidden');
}

function hideError(el) {
  el.classList.add('hidden');
  el.textContent = '';
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTime(secs) {
  const m = Math.floor(secs / 60).toString().padStart(2, '0');
  const s = (secs % 60).toFixed(0).padStart(2, '0');
  return `${m}:${s}`;
}


