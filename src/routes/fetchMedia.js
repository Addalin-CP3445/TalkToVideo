const express = require('express');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const pexels = require('../utils/pexels');
const jobs = require('../utils/jobs');

const router = express.Router();

router.post('/', async (req, res) => {
  const { scenes } = req.body;
  
  if (!scenes || !Array.isArray(scenes)) {
    return res.status(400).json({ error: 'scenes array is required.' });
  }

  const jobId = uuidv4();
  jobs[jobId] = { status: 'fetching', progress: 0, scenes: [], error: null };
  res.json({ jobId });

  // Async process
  fetchAndDownloadMedia(scenes, jobId).catch(err => {
    console.error('Fetch Media Error:', err);
    jobs[jobId].status = 'error';
    jobs[jobId].error = err.message;
  });
});

router.get('/progress/:jobId', (req, res) => {
  const { jobId } = req.params;
  const job = jobs[jobId];

  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const interval = setInterval(() => {
    if (job.status === 'done' || job.status === 'error') {
      res.write(`data: ${JSON.stringify(job)}\n\n`);
      clearInterval(interval);
      res.end();
    } else {
      res.write(`data: ${JSON.stringify(job)}\n\n`);
    }
  }, 1000);

  req.on('close', () => {
    clearInterval(interval);
  });
});

async function fetchAndDownloadMedia(scenes, jobId) {
  const videoScenes = scenes.filter(s => s.type !== 'slide');
  
  jobs[jobId].progress = 10;
  
  let validatedVideos = [];
  if (videoScenes.length > 0) {
    validatedVideos = await pexels.fetchAndValidateBatch(videoScenes);
  }

  jobs[jobId].progress = 40;

  // Process all scenes
  const finalizedScenes = [];
  let videoIdx = 0;
  
  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i];
    
    if (scene.type === 'slide') {
      finalizedScenes.push(scene);
    } else {
      const videoInfo = validatedVideos[videoIdx++];
      if (videoInfo) {
        const videoFilename = `${jobId}_fetched_${i}.mp4`;
        const videoLocalPath = path.join(__dirname, '../../uploads', videoFilename);

        await pexels.downloadVideo(videoInfo.downloadUrl, videoLocalPath);
        
        finalizedScenes.push({
          ...scene,
          localPath: videoLocalPath, 
          previewUrl: `/uploads/${videoFilename}`, 
          videoInfo: videoInfo
        });
      } else {
        // Fallback to slide if no video found
        finalizedScenes.push({
          ...scene,
          type: 'slide',
          slideText: scene.context || scene.searchQuery || "Information"
        });
      }
    }
    
    jobs[jobId].progress = Math.round(40 + ((i + 1) / scenes.length) * 60);
  }

  jobs[jobId].scenes = finalizedScenes;
  jobs[jobId].status = 'done';
}

module.exports = router;
