require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;

// Ensure upload and output directories exist
['uploads', 'outputs'].forEach((dir) => {
  const dirPath = path.join(__dirname, dir);
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Routes
app.use('/api/upload', require('./src/routes/upload'));
app.use('/api/transcribe', require('./src/routes/transcribe'));
app.use('/api/render', require('./src/routes/render'));
app.use('/api/fetch-media', require('./src/routes/fetchMedia'));
app.use('/api/debug', require('./src/routes/debug'));

// Download endpoint
app.get('/api/download/:filename', (req, res) => {
  const filePath = path.join(__dirname, 'outputs', req.params.filename);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found' });
  }
  res.download(filePath);
});

// Open the outputs folder in Windows Explorer
app.post('/api/open-output-folder', (req, res) => {
  const outputsDir = path.join(__dirname, 'outputs');
  // Use 'explorer' on Windows; falls back gracefully on other platforms
  const cmd = process.platform === 'darwin'
    ? `open "${outputsDir}"`
    : process.platform === 'linux'
      ? `xdg-open "${outputsDir}"`
      : `explorer "${outputsDir}"`;
  exec(cmd, (err) => {
    if (err) {
      console.warn('[open-folder] Could not open explorer:', err.message);
      return res.status(500).json({ error: err.message });
    }
    res.json({ ok: true });
  });
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`\n🎬 TalkToVideo server running at http://localhost:${PORT}\n`);
  if (!process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEY === 'your_gemini_api_key_here') {
    console.warn('⚠️  GEMINI_API_KEY is not set. Copy .env.example to .env and add your key.\n');
  }
});
