const express = require('express');
const path = require('path');
const fs = require('fs');

const router = express.Router();

/**
 * GET /api/debug/mock
 * Returns fake transcript segments and scenes so the Pexels + FFmpeg pipeline
 * can be tested without calling the Gemini API or uploading a real audio file.
 */
router.get('/mock', (req, res) => {
  // Use the bundled 10-second silent WAV from ffmpeg-static's test vectors,
  // OR generate a silence file on the fly using FFmpeg.
  // We create a 60-second silent MP3 on demand and cache it in uploads/.
  const ffmpegPath = require('ffmpeg-static');
  const { execSync } = require('child_process');

  const silencePath = path.join(__dirname, '../../uploads', '_debug_silence.mp3');

  if (!fs.existsSync(silencePath)) {
    try {
      execSync(
        `"${ffmpegPath}" -f lavfi -i anullsrc=r=44100:cl=stereo -t 60 -q:a 9 -acodec libmp3lame "${silencePath}" -y`,
        { stdio: 'pipe' }
      );
    } catch (err) {
      return res.status(500).json({ error: 'Failed to generate silence audio: ' + err.message });
    }
  }

  const segments = [
    { start: 0.0,  end: 3.5,  text: 'You have probably heard of artificial intelligence.' },
    { start: 3.5,  end: 7.0,  text: 'But what exactly does machine learning mean?' },
    { start: 7.0,  end: 11.5, text: 'It all started with scientists trying to teach computers to think.' },
    { start: 11.5, end: 15.0, text: 'Imagine programming a spam filter in 1995.' },
    { start: 15.0, end: 19.0, text: 'You write a rule: if the email says free, mark it spam.' },
    { start: 19.0, end: 23.5, text: 'But then spammers catch on and write it differently.' },
    { start: 23.5, end: 28.0, text: 'Instead of updating rules manually, we let the machine learn the rules.' },
    { start: 28.0, end: 32.5, text: 'The algorithm analyzes thousands of emails and finds patterns.' },
    { start: 32.5, end: 37.0, text: 'Deep learning takes this further using neural networks.' },
    { start: 37.0, end: 42.0, text: 'These networks are loosely inspired by the human brain.' },
    { start: 42.0, end: 47.5, text: 'They can recognize faces, translate languages, and generate images.' },
    { start: 47.5, end: 52.0, text: 'Today AI is embedded in everything we use.' },
    { start: 52.0, end: 57.0, text: 'The future will be shaped by how we choose to use it.' },
    { start: 57.0, end: 60.0, text: 'The question is not if AI will change the world.' },
  ];

  const scenes = [
    { start: 0,    end: 11.5, searchQuery: 'artificial intelligence technology' },
    { start: 11.5, end: 23.5, searchQuery: 'email spam computer hacker' },
    { start: 23.5, end: 37.0, searchQuery: 'machine learning data patterns' },
    { start: 37.0, end: 52.0, searchQuery: 'neural network brain waves' },
    { start: 52.0, end: 60.0, searchQuery: 'futuristic city technology' },
  ];

  res.json({
    localPath: silencePath,
    originalName: 'debug_silence.mp3',
    size: fs.statSync(silencePath).size,
    segments,
    scenes,
  });
});

module.exports = router;
