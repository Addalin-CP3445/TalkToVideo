const express = require('express');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const { buildCaptionFilter, THEMES } = require('../utils/captionFilter');

const router = express.Router();
ffmpeg.setFfmpegPath(ffmpegPath);

// In-memory job store (sufficient for single-user local app)
const jobs = {};

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
  renderVideo({ localPath, segments, themeKey, outputFile, jobId, scenes }).catch((err) => {
    jobs[jobId].status = 'error';
    jobs[jobId].error = err.message;
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

async function renderVideo({ localPath, segments, themeKey, outputFile, jobId, scenes }) {
  const pexels = require('../utils/pexels');
  const theme = THEMES[themeKey];
  const WIDTH = 1920;
  const HEIGHT = 1080;

  // Determine total duration from segments
  const totalDuration = segments.length
    ? Math.ceil(segments[segments.length - 1].end) + 1
    : 60;

  const tempFiles = [];

  try {
    let bgFilter;
    let inputFiles = [];

    // If automated multi-scene Pexels videos are to be compiled
    if (scenes && Array.isArray(scenes) && scenes.length > 0) {
      jobs[jobId].status = 'rendering';
      jobs[jobId].progress = 5;

      const downloadedScenes = [];
      const creditsList = [];

      for (let i = 0; i < scenes.length; i++) {
        const scene = scenes[i];
        
        // Fetch matching video from Pexels (or fallback)
        const videoInfo = await pexels.fetchVideoForQuery(scene.searchQuery);
        const videoFilename = `${jobId}_scene_${i}.mp4`;
        const videoLocalPath = path.join(__dirname, '../../uploads', videoFilename);

        // Download video
        await pexels.downloadVideo(videoInfo.downloadUrl, videoLocalPath);
        tempFiles.push(videoLocalPath);

        const duration = scene.end - scene.start;
        downloadedScenes.push({
          localPath: videoLocalPath,
          duration: duration > 0 ? duration : 5
        });

        creditsList.push(`Scene ${i + 1} (${scene.start.toFixed(1)}s - ${scene.end.toFixed(1)}s):
- Visual Query: "${scene.searchQuery}"
- Video Author: ${videoInfo.author}
- Author Profile: ${videoInfo.authorUrl}
- Direct Video Link: ${videoInfo.downloadUrl}
`);

        const downloadProgress = Math.round(5 + ((i + 1) / scenes.length) * 20);
        jobs[jobId].progress = downloadProgress;
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

      // Build FFmpeg inputs & complex filter graph for scenes
      // Input index 0: Audio (localPath)
      // Input index 1..N: Scene videos
      inputFiles = downloadedScenes.map(ds => ds.localPath);
      
      const filterSegments = downloadedScenes.map((ds, idx) => {
        const inputIdx = idx + 1; // index 0 is audio
        const outStream = `[v${idx}]`;
        // Scale to fill 1920x1080 (zoom/crop) and trim to exact scene duration
        return `[${inputIdx}:v]scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,trim=duration=${ds.duration.toFixed(2)},setpts=PTS-STARTPTS${outStream}`;
      });

      const concatInputs = downloadedScenes.map((_, idx) => `[v${idx}]`).join('');
      const concatFilter = `${concatInputs}concat=n=${downloadedScenes.length}:v=1:a=0[bg]`;

      // Drawtext captions
      const captionFilters = buildCaptionFilter(segments, themeKey, WIDTH, HEIGHT);
      
      // Full filter chain: processing individual inputs -> concat them -> drawtext -> output
      bgFilter = `${filterSegments.join(';')};${concatFilter};[bg]${captionFilters}[vout]`;
      
    } else {
      // Fallback to solid color / gradient theme backgrounds
      if (theme.bgGradient) {
        bgFilter =
          `color=c=${theme.bgColor}:size=${WIDTH}x${HEIGHT / 2}:d=${totalDuration},format=rgb24[top];` +
          `color=c=${theme.bgGradient}:size=${WIDTH}x${HEIGHT / 2}:d=${totalDuration},format=rgb24[bot];` +
          `[top][bot]vstack=inputs=2[bg];[bg]${buildCaptionFilter(segments, themeKey, WIDTH, HEIGHT)}[vout]`;
      } else {
        bgFilter = `color=c=${theme.bgColor}:size=${WIDTH}x${HEIGHT}:d=${totalDuration},format=rgb24[bg];[bg]${buildCaptionFilter(segments, themeKey, WIDTH, HEIGHT)}[vout]`;
      }
    }

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
        .complexFilter(bgFilter, 'vout')
        .outputOptions([
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
        .on('error', (err) => {
          // Clean up temp files
          tempFiles.forEach(file => {
            try { fs.unlinkSync(file); } catch (_) {}
          });
          jobs[jobId].status = 'error';
          jobs[jobId].error = err.message;
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
