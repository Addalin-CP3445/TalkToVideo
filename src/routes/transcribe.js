const express = require('express');
const { transcribeAudio, generateScenes } = require('../utils/gemini');

const router = express.Router();

/**
 * POST /api/transcribe
 * Body: { fileUri: string, mimeType: string }
 * Response: { segments: Array<{ start, end, text }>, scenes: Array<{ start, end, searchQuery }> }
 */
router.post('/', async (req, res) => {
  const { fileUri, mimeType } = req.body;

  if (!fileUri || !mimeType) {
    return res.status(400).json({ error: '`fileUri` and `mimeType` are required.' });
  }

  try {
    const segments = await transcribeAudio(fileUri, mimeType);
    const scenes = await generateScenes(segments);
    res.json({ segments, scenes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
