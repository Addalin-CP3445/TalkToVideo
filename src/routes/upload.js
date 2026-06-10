const express = require('express');
const multer = require('multer');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { uploadFile } = require('../utils/gemini');

const router = express.Router();

// Allowed MIME types
const ALLOWED_MIMES = {
  'audio/mpeg': 'audio/mpeg',
  'audio/mp3': 'audio/mpeg',
  'audio/wav': 'audio/wav',
  'audio/x-wav': 'audio/wav',
  'audio/wave': 'audio/wav',
};

const storage = multer.diskStorage({
  destination: path.join(__dirname, '../../uploads'),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${uuidv4()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: (parseInt(process.env.MAX_FILE_SIZE_MB) || 50) * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_MIMES[file.mimetype]) {
      cb(null, true);
    } else {
      cb(new Error('Only MP3 and WAV files are supported.'));
    }
  },
});

/**
 * POST /api/upload
 * Body: multipart/form-data with field `audio`
 * Response: { localPath, fileUri, geminiName, mimeType, originalName, size }
 */
router.post('/', upload.single('audio'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No audio file provided.' });
  }

  const localPath = req.file.path;
  const mimeType = ALLOWED_MIMES[req.file.mimetype] || 'audio/mpeg';

  try {
    const { uri, name } = await uploadFile(localPath, mimeType);
    res.json({
      localPath,
      fileUri: uri,
      geminiName: name,
      mimeType,
      originalName: req.file.originalname,
      size: req.file.size,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Multer error handler
router.use((err, _req, res, _next) => {
  res.status(400).json({ error: err.message });
});

module.exports = router;
