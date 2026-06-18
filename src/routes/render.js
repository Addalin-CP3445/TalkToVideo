const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { v4: uuidv4 } = require('uuid');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const ffprobePath = require('ffprobe-static').path;
const { buildCaptionFilter, THEMES, wrapText } = require('../utils/captionFilter');

const router = express.Router();
ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

// Helper to reliably get real duration of an audio file
function getAudioDuration(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) return reject(err);
      if (metadata && metadata.format && metadata.format.duration) {
        resolve(metadata.format.duration);
      } else {
        reject(new Error('Could not read duration from audio file.'));
      }
    });
  });
}

// In-memory job store (sufficient for single-user local app)
const jobs = require('../utils/jobs');

/**
 * POST /api/render
 * Body: { localPath, segments, theme, duration? }
 * Response: { jobId }
 * Then stream progress via GET /api/render/progress/:jobId (SSE)
 */
router.post('/', async (req, res) => {
  const { localPath, segments, theme, scenes } = req.body;

  if (!localPath || !segments || !Array.isArray(segments)) {
    return res.status(400).json({ error: '`localPath` and `segments` array are required.' });
  }
  if (!fs.existsSync(localPath)) {
    return res.status(400).json({ error: 'Audio file not found on server.' });
  }

  const themeKey = theme || 'dark-minimal';
  if (!THEMES[themeKey]) {
    return res.status(400).json({ error: `Unknown theme: ${themeKey}` });
  }

  const jobId = uuidv4();
  const outputFile = path.join(__dirname, '../../outputs', `${jobId}.mp4`);

  jobs[jobId] = { status: 'queued', progress: 0, outputFile, error: null };
  res.json({ jobId });

  // Start render asynchronously
  renderVideo({ localPath, segments, themeKey, outputFile, jobId, scenes, showCaptions: req.body.showCaptions }).catch((err) => {
    console.error('[render] Job', jobId, 'failed:', err);
    jobs[jobId].status = 'error';
    jobs[jobId].error = err?.message || String(err) || 'Unknown render error';
  });
});

/**
 * GET /api/render/progress/:jobId  (Server-Sent Events)
 * Streams { status, progress, filename? } events until done or error.
 */
router.get('/progress/:jobId', (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: 'Job not found.' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  const interval = setInterval(() => {
    send({ status: job.status, progress: job.progress });

    if (job.status === 'done') {
      send({ status: 'done', progress: 100, filename: path.basename(job.outputFile) });
      clearInterval(interval);
      res.end();
    } else if (job.status === 'error') {
      send({ status: 'error', error: job.error });
      clearInterval(interval);
      res.end();
    }
  }, 500);

  req.on('close', () => clearInterval(interval));
});

/**
 * GET /api/render/themes
 * Returns available theme metadata for the frontend.
 */
router.get('/themes', (_req, res) => {
  const list = Object.entries(THEMES).map(([key, t]) => ({
    key,
    label: t.label,
    bgColor: t.bgColor,
    bgGradient: t.bgGradient,
    fontColor: t.fontColor,
    shadowColor: t.shadowColor,
  }));
  res.json(list);
});

// ---------------------------------------------------------------------------
// Core render function
// ---------------------------------------------------------------------------

async function renderVideo({ localPath, segments, themeKey, outputFile, jobId, scenes, showCaptions }) {
  const pexels = require('../utils/pexels');
  const theme = THEMES[themeKey];
  const WIDTH = 1920;
  const HEIGHT = 1080;

  // Determine true total duration from the audio file itself to prevent video cutoff
  // if the LLM transcript falls short of the end.
  let totalDuration;
  try {
    totalDuration = await getAudioDuration(localPath);
    totalDuration = Math.ceil(totalDuration) + 1; // Add 1s buffer
  } catch (e) {
    console.warn('[render] Failed to probe audio duration, falling back to transcript end time:', e.message);
    totalDuration = segments.length
      ? Math.ceil(segments[segments.length - 1].end) + 1
      : 60;
  }

  const tempFiles = [];

  try {
    let bgFilter;
    let inputFiles = [];

    // If automated multi-scene Pexels videos are to be compiled
    if (scenes && Array.isArray(scenes) && scenes.length > 0) {
      jobs[jobId].status = 'rendering';
      jobs[jobId].progress = 10;

      const downloadedScenes = [];
      const creditsList = [];

      for (let i = 0; i < scenes.length; i++) {
        const scene = scenes[i];
        
        let duration = scene.end - scene.start;
        if (duration <= 0) duration = 5;

        if (scene.type === 'slide' || !scene.localPath) {
          downloadedScenes.push({
            type: 'slide',
            slideText: scene.slideText || scene.context || "Important Point",
            duration: duration
          });
        } else {
          // The UI has already fetched and downloaded the video, and passed the localPath
          tempFiles.push(scene.localPath); // Keep track for cleanup if needed (though it might be shared)
          
          downloadedScenes.push({
            type: 'video',
            localPath: scene.localPath,
            duration: duration
          });

          if (scene.videoInfo) {
            creditsList.push(`Scene ${i + 1} (${scene.start.toFixed(1)}s - ${scene.end.toFixed(1)}s):
- Visual Query: "${scene.searchQuery}"
- Video Author: ${scene.videoInfo.author}
- Author Profile: ${scene.videoInfo.authorUrl}
- Direct Video Link: ${scene.videoInfo.downloadUrl}
`);
          }
        }
      }

      // Write credits text file
      const creditsFilePath = path.join(__dirname, '../../outputs', `${jobId}_credits.txt`);
      const creditsContent = `TalkToVideo Attribution Credits:
===============================
Audio File: ${path.basename(localPath)}

Background Stock Videos Used:
-----------------------------
${creditsList.join('\n')}
Generated by TalkToVideo utilizing Pexels Video API.
`;
      fs.writeFileSync(creditsFilePath, creditsContent, 'utf8');

      // Ensure the total video duration accurately covers the audio duration.
      let runningSum = 0;
      for (let i = 0; i < downloadedScenes.length - 1; i++) {
        runningSum += downloadedScenes[i].duration;
      }
      if (downloadedScenes.length > 0) {
        const lastScene = downloadedScenes[downloadedScenes.length - 1];
        if (runningSum + lastScene.duration < totalDuration) {
          lastScene.duration = totalDuration - runningSum;
        }
      }

      let inputIdxCounter = 1; // 0 is audio
      const filterSegments = downloadedScenes.map((ds, idx) => {
        const outStream = `[v${idx}]`;
        if (ds.type === 'video') {
          const inputIdx = inputIdxCounter++;
          // Scale to fill 1920x1080 (zoom/crop), FORCE framerate to 30fps to prevent concat drift, and trim to exact scene duration
          return `[${inputIdx}:v]scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,fps=30,trim=duration=${ds.duration.toFixed(2)},setpts=PTS-STARTPTS${outStream}`;
        } else {
          // Slide
          const bgColor = theme.bgColor || '0x222222';
          const colorFilter = `color=c=${bgColor}:size=1920x1080:d=${ds.duration.toFixed(2)}:r=30`;
          
          const textFilePath = path.join(os.tmpdir(), `ttv_slide_${uuidv4()}.txt`);
          
          // Wrap text so it doesn't overflow horizontally
          const wrappedText = wrapText(ds.slideText, 35).join('\n');
          fs.writeFileSync(textFilePath, wrappedText, 'utf8');
          tempFiles.push(textFilePath);
          let safePath = textFilePath.replace(/\\/g, '/').replace(/:/g, '\\:');
          
          const fontColor = theme.fontColor || 'white';
          const shadowColor = theme.shadowColor || 'black';
          return `${colorFilter},drawtext=textfile='${safePath}':fontcolor=${fontColor}:fontsize=90:x=(w-text_w)/2:y=(h-text_h)/2:shadowcolor=${shadowColor}:shadowx=4:shadowy=4:box=1:boxcolor=0x00000088:boxborderw=20,setpts=PTS-STARTPTS${outStream}`;
        }
      });

      inputFiles = downloadedScenes.filter(ds => ds.type === 'video').map(ds => ds.localPath);
      const concatInputs = downloadedScenes.map((_, idx) => `[v${idx}]`).join('');
      const concatFilter = `${concatInputs}concat=n=${downloadedScenes.length}:v=1:a=0[bg]`;

      // Drawtext captions
      const captionFilters = showCaptions !== false ? buildCaptionFilter(segments, themeKey, WIDTH, HEIGHT, tempFiles) : '';
      
      // Full filter chain: processing individual inputs -> concat them -> drawtext -> output
      bgFilter = `${filterSegments.join(';')};${concatFilter};[bg]${captionFilters ? captionFilters + '[vout]' : 'null[vout]'}`;
      
    } else {
      // Fallback to solid color / gradient theme backgrounds
      const captionFilters = showCaptions !== false ? buildCaptionFilter(segments, themeKey, WIDTH, HEIGHT, tempFiles) : '';
      if (theme.bgGradient) {
        bgFilter =
          `color=c=${theme.bgColor}:size=${WIDTH}x${HEIGHT / 2}:d=${totalDuration},format=rgb24[top];` +
          `color=c=${theme.bgGradient}:size=${WIDTH}x${HEIGHT / 2}:d=${totalDuration},format=rgb24[bot];` +
          `[top][bot]vstack=inputs=2[bg];[bg]${captionFilters ? captionFilters + '[vout]' : 'null[vout]'}`;
      } else {
        bgFilter = `color=c=${theme.bgColor}:size=${WIDTH}x${HEIGHT}:d=${totalDuration},format=rgb24[bg];[bg]${captionFilters ? captionFilters + '[vout]' : 'null[vout]'}`;
      }
    }

    // Write the complex filter to a temp file to avoid ENAMETOOLONG on Windows
    const filterScriptPath = path.join(os.tmpdir(), `ttv_filter_${jobId}.txt`);
    fs.writeFileSync(filterScriptPath, bgFilter, 'utf8');
    tempFiles.push(filterScriptPath);
    // Use forward slashes — FFmpeg handles them on Windows; avoids backslash escaping issues
    const filterScriptArg = filterScriptPath.replace(/\\/g, '/');

    return new Promise((resolve, reject) => {
      jobs[jobId].status = 'rendering';

      let proc = ffmpeg()
        .input(localPath) // input 0: audio
        .inputOptions(['-stream_loop -1']);

      // Add downloaded scene video inputs if any
      for (const file of inputFiles) {
        proc = proc.input(file).inputOptions(['-stream_loop -1']); // loop each video indefinitely
      }

      proc
        .outputOptions([
          `-filter_complex_script ${filterScriptArg}`,
          '-map [vout]',
          '-map 0:a',
          '-c:v libx264',
          '-preset fast',
          '-crf 22',
          '-c:a aac',
          '-b:a 192k',
          '-shortest', // trim to the shortest stream (which will be total duration/audio)
          `-t ${totalDuration}`,
          '-pix_fmt yuv420p',
          '-movflags +faststart',
        ])
        .output(outputFile)
        .on('start', (cmd) => console.log('[ffmpeg] Command:', cmd))
        .on('stderr', (line) => { if (line.includes('Error') || line.includes('Invalid')) console.error('[ffmpeg]', line); })
        .on('progress', (prog) => {
          const basePct = inputFiles.length > 0 ? 25 : 0;
          const remainingFactor = inputFiles.length > 0 ? 0.75 : 1.0;
          const procPct = prog.percent ? Math.min(Math.round(prog.percent), 99) : 0;
          const totalPct = Math.round(basePct + procPct * remainingFactor);
          jobs[jobId].progress = Math.min(totalPct, 99);
        })
        .on('end', () => {
          // Clean up temp files
          tempFiles.forEach(file => {
            try { fs.unlinkSync(file); } catch (_) {}
          });
          jobs[jobId].status = 'done';
          jobs[jobId].progress = 100;
          resolve();
        })
        .on('error', (err, stdout, stderr) => {
          console.error('[ffmpeg] Render error:', err?.message || err);
          if (stderr) console.error('[ffmpeg] stderr:', stderr.slice(-2000));
          // Clean up temp files
          tempFiles.forEach(file => {
            try { fs.unlinkSync(file); } catch (_) {}
          });
          jobs[jobId].status = 'error';
          jobs[jobId].error = err?.message || String(err) || 'FFmpeg render failed';
          reject(err);
        })
        .run();
    });
  } catch (err) {
    // Clean up temp files
    tempFiles.forEach(file => {
      try { fs.unlinkSync(file); } catch (_) {}
    });
    jobs[jobId].status = 'error';
    jobs[jobId].error = err.message;
    throw err;
  }
}

module.exports = router;
