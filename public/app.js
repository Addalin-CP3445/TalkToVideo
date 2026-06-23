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
const PANELS = ['upload', 'transcribe', 'theme', 'timeline', 'render'];

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

const btnDebugEditor = $('btn-debug-editor');
if (btnDebugEditor) {
  btnDebugEditor.addEventListener('click', async () => {
    hideError(uploadError);
    btnDebugEditor.textContent = 'Loading…';
    btnDebugEditor.disabled = true;

    try {
      const res = await fetch('/api/debug/mock');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Debug endpoint failed');

      state.localPath = data.localPath;
      state.segments = data.segments;
      state.scenes = data.scenes.map(s => ({
        ...s,
        type: 'slide',
        slideText: `Debug Slide: ${s.searchQuery}`
      }));

      // Set file data for local playback
      state.file = new File([new ArrayBuffer(1)], 'mock.mp3', { type: 'audio/mpeg' }); 
      // The backend actually gives a real path for rendering, but frontend needs a blob for audioPlayer
      // To properly play it, we can fetch it, but that's slow. We'll just let audioPlayer fail or use the mock blob
      // Wait, let's just fetch it as a blob!
      const audioRes = await fetch(`/uploads/_debug_silence.mp3`);
      if (audioRes.ok) {
        state.file = await audioRes.blob();
      }

      renderTimeline();
      showPanel('timeline');
    } catch (err) {
      showError(uploadError, '🧪 Editor Debug error: ' + err.message);
    } finally {
      btnDebugEditor.textContent = '⏭ Direct to Editor (Fast)';
      btnDebugEditor.disabled = false;
    }
  });
}

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
      body: JSON.stringify({ 
        fileUri: state.fileUri, 
        mimeType: state.mimeType, 
        localPath: state.localPath,
        customPrompt: $('custom-prompt') ? $('custom-prompt').value.trim() : ''
      }),
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
    const color = isSlide ? '#ffb86c' : '#00ffcc';
    const icon = isSlide ? '📝' : '🎬';
    
    if (isSlide) {
      const currentText = scene.slideText || scene.context || 'Important Point';
      return `
        <div style="display: flex; flex-direction: column; border-bottom: 1px solid rgba(255,255,255,0.05); padding-bottom: 8px; margin-bottom: 8px; gap: 5px;">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <span style="color: rgba(255,255,255,0.8);">${icon} Scene ${idx + 1} (${formatTime(scene.start)} - ${formatTime(scene.end)})</span>
            <span style="font-weight: 600; color: ${color};">Slide Text</span>
          </div>
          <textarea class="slide-text-edit" data-idx="${idx}" rows="2" style="width: 100%; padding: 6px; border-radius: 4px; border: 1px solid rgba(255,255,255,0.2); background: rgba(0,0,0,0.3); color: white; font-family: inherit; font-size: 0.85rem; resize: vertical;">${escapeHtml(currentText)}</textarea>
        </div>
      `;
    } else {
      const displayStr = `Video: ${scene.searchQuery || 'Auto-selected'}`;
      return `
        <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid rgba(255,255,255,0.05); padding-bottom: 8px; margin-bottom: 8px; gap: 15px;">
          <span style="color: rgba(255,255,255,0.8);">${icon} Scene ${idx + 1} (${formatTime(scene.start)} - ${formatTime(scene.end)})</span>
          <span style="font-weight: 600; color: ${color}; text-align: right;">"${escapeHtml(displayStr)}"</span>
        </div>
      `;
    }
  }).join('');

  // Bind event listeners for textareas
  list.querySelectorAll('.slide-text-edit').forEach(ta => {
    ta.addEventListener('input', (e) => {
      const idx = e.target.getAttribute('data-idx');
      state.scenes[idx].slideText = e.target.value;
    });
  });
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

/* ── Fetch Media & Timeline ────────────────────────────── */
const btnFetchMedia = $('btn-fetch-media');
const fetchSpinner = $('fetch-spinner');
const btnFetchLabel = $('btn-fetch-label');
const themeError = $('theme-error');

if (btnFetchMedia) {
  btnFetchMedia.addEventListener('click', async () => {
    setLoading(btnFetchMedia, fetchSpinner, btnFetchLabel, true, 'Fetching Videos…');
    hideError(themeError);

    try {
      const res = await fetch('/api/fetch-media', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scenes: state.scenes }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Fetch request failed');

      listenFetchProgress(data.jobId);
    } catch (err) {
      showError(themeError, err.message);
      setLoading(btnFetchMedia, fetchSpinner, btnFetchLabel, false, 'Fetch Media & Review Timeline');
    }
  });
}

function listenFetchProgress(jobId) {
  const source = new EventSource(`/api/fetch-media/progress/${jobId}`);

  source.onmessage = (e) => {
    const data = JSON.parse(e.data);

    if (data.status === 'fetching') {
      btnFetchLabel.textContent = `Fetching Videos… ${data.progress}%`;
    }

    if (data.status === 'done') {
      source.close();
      state.scenes = data.scenes;
      setLoading(btnFetchMedia, fetchSpinner, btnFetchLabel, false, 'Fetch Media & Review Timeline');
      renderTimeline();
      showPanel('timeline');
    }

    if (data.status === 'error') {
      source.close();
      setLoading(btnFetchMedia, fetchSpinner, btnFetchLabel, false, 'Fetch Media & Review Timeline');
      showError(themeError, `Fetch failed: ${data.error}`);
    }
  };

  source.onerror = () => {
    source.close();
    setLoading(btnFetchMedia, fetchSpinner, btnFetchLabel, false, 'Fetch Media & Review Timeline');
    showError(themeError, 'Lost connection to server during fetch.');
  };
}

const audioPlayer = $('audio-player');
let timelineDuration = 60;
const pixelsPerSecond = 40; // Timeline scale

function renderTimeline() {
  const trackVideo = $('track-video');
  const trackAudio = $('track-audio');
  const ruler = $('timeline-ruler');
  
  if (state.file && audioPlayer) {
    if (!audioPlayer.src) {
      audioPlayer.src = URL.createObjectURL(state.file);
      audioPlayer.onloadedmetadata = () => {
        timelineDuration = Math.max(audioPlayer.duration || 60, state.scenes.length ? state.scenes[state.scenes.length-1].end : 0) + 10;
        updateTimelineWidth();
      };
    }
  }

  if (!trackVideo) return;
  timelineDuration = Math.max(
    state.scenes.length ? state.scenes[state.scenes.length-1].end : 60,
    audioPlayer.duration || 60
  ) + 10; // add 10s buffer

  updateTimelineWidth();

  trackVideo.innerHTML = state.scenes.map((scene, idx) => {
    const isSlide = scene.type === 'slide';
    const left = scene.start * pixelsPerSecond;
    const width = (scene.end - scene.start) * pixelsPerSecond;
    const cls = isSlide ? 'slide-clip' : 'video-clip';
    const label = isSlide ? 'Slide' : 'Video';
    const bg = isSlide ? '' : `<img src="${scene.previewUrl}" class="clip-thumbnail">`;
    
    return `
      <div class="timeline-clip ${cls}" id="clip-${idx}" data-idx="${idx}" style="left: ${left}px; width: ${width}px;">
        ${bg}
        <div class="clip-handle clip-handle-left" data-action="resize-left"></div>
        <div class="clip-content">${label} ${idx + 1}</div>
        <div class="clip-handle clip-handle-right" data-action="resize-right"></div>
      </div>
    `;
  }).join('');

  initTimelineInteractions();
}

function updateTimelineWidth() {
  const totalWidth = timelineDuration * pixelsPerSecond;
  const trackVideo = $('track-video');
  const trackAudio = $('track-audio');
  const ruler = $('timeline-ruler');
  
  if (trackVideo) trackVideo.style.minWidth = `${totalWidth}px`;
  if (trackAudio) trackAudio.style.minWidth = `${totalWidth}px`;
  if (ruler) {
    ruler.style.minWidth = `${totalWidth}px`;
    // Draw ruler markings
    let markings = '<div class="timeline-playhead" id="timeline-playhead"><div class="playhead-head"></div><div class="playhead-line"></div></div>';
    for (let i = 0; i < timelineDuration; i += 5) {
      markings += `<div style="position: absolute; left: ${i * pixelsPerSecond}px; bottom: 0; height: 10px; border-left: 1px solid rgba(255,255,255,0.2); padding-left: 4px; font-size: 10px; color: rgba(255,255,255,0.4); pointer-events: none;">${i}s</div>`;
    }
    ruler.innerHTML = markings;
    initPlayhead();
  }
}

function initTimelineInteractions() {
  const trackVideo = $('track-video');
  let activeDrag = null;
  let startX = 0;
  let startLeft = 0;
  let startWidth = 0;
  
  trackVideo.onmousedown = (e) => {
    const clip = e.target.closest('.timeline-clip');
    if (!clip) return;
    
    const idx = clip.getAttribute('data-idx');
    const isLeftHandle = e.target.classList.contains('clip-handle-left');
    const isRightHandle = e.target.classList.contains('clip-handle-right');
    
    activeDrag = {
      clip, idx,
      type: isLeftHandle ? 'resize-left' : (isRightHandle ? 'resize-right' : 'move')
    };
    
    startX = e.clientX;
    startLeft = parseFloat(clip.style.left);
    startWidth = parseFloat(clip.style.width);
    
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  };
  
  function onMouseMove(e) {
    if (!activeDrag) return;
    
    const dx = e.clientX - startX;
    const scene = state.scenes[activeDrag.idx];
    
    if (activeDrag.type === 'move') {
      let newLeft = startLeft + dx;
      if (newLeft < 0) newLeft = 0;
      activeDrag.clip.style.left = `${newLeft}px`;
      scene.start = newLeft / pixelsPerSecond;
      scene.end = scene.start + (startWidth / pixelsPerSecond);
    } else if (activeDrag.type === 'resize-right') {
      let newWidth = startWidth + dx;
      if (newWidth < pixelsPerSecond) newWidth = pixelsPerSecond; // min 1s
      activeDrag.clip.style.width = `${newWidth}px`;
      scene.end = scene.start + (newWidth / pixelsPerSecond);
    } else if (activeDrag.type === 'resize-left') {
      let newLeft = startLeft + dx;
      let newWidth = startWidth - dx;
      if (newLeft < 0) { newWidth += newLeft; newLeft = 0; }
      if (newWidth < pixelsPerSecond) { newLeft = startLeft + startWidth - pixelsPerSecond; newWidth = pixelsPerSecond; }
      activeDrag.clip.style.left = `${newLeft}px`;
      activeDrag.clip.style.width = `${newWidth}px`;
      scene.start = newLeft / pixelsPerSecond;
      scene.end = scene.start + (newWidth / pixelsPerSecond);
    }
  }
  
  function onMouseUp() {
    activeDrag = null;
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
  }
}

function initPlayhead() {
  const playhead = $('timeline-playhead');
  const ruler = $('timeline-ruler');
  if (!playhead || !audioPlayer) return;
  
  audioPlayer.ontimeupdate = () => {
    const left = audioPlayer.currentTime * pixelsPerSecond;
    playhead.style.left = `${left}px`;
  };
  
  ruler.onmousedown = (e) => {
    if (e.target.closest('.playhead-head')) return;
    const rect = ruler.getBoundingClientRect();
    const x = e.clientX - rect.left + ruler.parentElement.scrollLeft;
    const time = x / pixelsPerSecond;
    if (time <= audioPlayer.duration || isNaN(audioPlayer.duration)) {
      audioPlayer.currentTime = time;
    }
  };
  
  const head = playhead.querySelector('.playhead-head');
  let isDraggingPlayhead = false;
  
  if (head) {
    head.onmousedown = (e) => {
      isDraggingPlayhead = true;
      document.addEventListener('mousemove', playheadMove);
      document.addEventListener('mouseup', playheadUp);
    };
  }
  
  function playheadMove(e) {
    if (!isDraggingPlayhead) return;
    const rect = ruler.getBoundingClientRect();
    let x = e.clientX - rect.left + ruler.parentElement.scrollLeft;
    if (x < 0) x = 0;
    const time = x / pixelsPerSecond;
    if (time <= audioPlayer.duration || isNaN(audioPlayer.duration)) {
      audioPlayer.currentTime = time;
    }
  }
  
  function playheadUp() {
    isDraggingPlayhead = false;
    document.removeEventListener('mousemove', playheadMove);
    document.removeEventListener('mouseup', playheadUp);
  }
}

/* ── Render ────────────────────────────────────────────── */
if (btnRender) {
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
          showCaptions: showCaptionsCheckbox ? showCaptionsCheckbox.checked : true,
        }),
      });
      const renderData = await renderRes.json();
      if (!renderRes.ok) throw new Error(renderData.error || 'Render request failed');

      state.jobId = renderData.jobId;
      if (audioPlayer) audioPlayer.pause();
      showPanel('render');
      listenProgress(state.jobId);

    } catch (err) {
      showError(renderError, err.message);
    } finally {
      setLoading(btnRender, renderSpinner, btnRenderLabel, false, '🎬 Compile Final Video');
    }
  });
}

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


