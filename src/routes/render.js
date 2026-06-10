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
  const { localPath, segments, theme } = req.body;

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
  renderVideo({ localPath, segments, themeKey, outputFile, jobId }).catch((err) => {
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

async function renderVideo({ localPath, segments, themeKey, outputFile, jobId }) {
  return new Promise((resolve, reject) => {
    jobs[jobId].status = 'rendering';

    const theme = THEMES[themeKey];
    const WIDTH = 1920;
    const HEIGHT = 1080;

    // Determine total duration from segments for the color source
    const totalDuration = segments.length
      ? Math.ceil(segments[segments.length - 1].end) + 1
      : 60;

    // Build background video filter
    // For gradient themes we use two color sources blended with overlay
    let bgFilter;
    if (theme.bgGradient) {
      // Gradient: top = bgColor, bottom = bgGradient color
      bgFilter =
        `color=c=${theme.bgColor}:size=${WIDTH}x${HEIGHT / 2}:d=${totalDuration},format=rgb24[top];` +
        `color=c=${theme.bgGradient}:size=${WIDTH}x${HEIGHT / 2}:d=${totalDuration},format=rgb24[bot];` +
        `[top][bot]vstack=inputs=2[bg]`;
    } else {
      bgFilter = `color=c=${theme.bgColor}:size=${WIDTH}x${HEIGHT}:d=${totalDuration},format=rgb24[bg]`;
    }

    // Build caption filter chain
    const captionFilters = buildCaptionFilter(segments, themeKey, WIDTH, HEIGHT);

    // Compose full filter: [bg] → captions → [vout]
    const videoFilter = `${bgFilter};[bg]${captionFilters}[vout]`;

    ffmpeg()
      .input(localPath)               // audio input
      .inputOptions(['-stream_loop -1']) // loop audio if needed (won't happen normally)
      .complexFilter(videoFilter, 'vout')
      .outputOptions([
        '-map [vout]',
        '-map 0:a',
        '-c:v libx264',
        '-preset fast',
        '-crf 22',
        '-c:a aac',
        '-b:a 192k',
        '-shortest',                   // trim to audio length
        `-t ${totalDuration}`,
        '-pix_fmt yuv420p',
        '-movflags +faststart',
      ])
      .output(outputFile)
      .on('progress', (prog) => {
        const pct = prog.percent ? Math.min(Math.round(prog.percent), 99) : 0;
        jobs[jobId].progress = pct;
      })
      .on('end', () => {
        jobs[jobId].status = 'done';
        jobs[jobId].progress = 100;
        resolve();
      })
      .on('error', (err) => {
        jobs[jobId].status = 'error';
        jobs[jobId].error = err.message;
        reject(err);
      })
      .run();
  });
}

module.exports = router;
