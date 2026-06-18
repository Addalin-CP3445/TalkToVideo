const { GoogleGenAI } = require('@google/genai');
const { GoogleAuth } = require('google-auth-library');
const fs = require('fs');
const { exec } = require('child_process');
const path = require('path');
const util = require('util');
const execPromise = util.promisify(exec);


/**
 * Get an initialized Gemini client.
 * Supports both Gemini Enterprise Agent Platform (Service Account JSON) and AI Studio (API key).
 */
function getClient() {
  const vertexProject  = process.env.VERTEX_PROJECT;
  const vertexLocation = process.env.VERTEX_LOCATION;
  const credFile       = process.env.GOOGLE_APPLICATION_CREDENTIALS;

  if (vertexProject && vertexLocation) {
    if (!credFile || !fs.existsSync(credFile)) {
      throw new Error(
        `GOOGLE_APPLICATION_CREDENTIALS is not set or file not found ("${credFile}"). ` +
        'Download your Service Account JSON from Google Cloud Console and set the path in .env.'
      );
    }
    // Explicitly pass the service account auth so oauth2 tokens are always injected.
    const auth = new GoogleAuth({
      keyFile: credFile,
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    });
    return new GoogleGenAI({
      enterprise: true,
      project: vertexProject,
      location: vertexLocation,
      auth,
    });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'your_gemini_api_key_here') {
    throw new Error(
      'Authentication not configured. For Gemini Enterprise, set GOOGLE_APPLICATION_CREDENTIALS, VERTEX_PROJECT, and VERTEX_LOCATION. For AI Studio, set GEMINI_API_KEY.'
    );
  }
  return new GoogleGenAI({ apiKey });
}

/**
 * Upload a local audio file to the Gemini File API.
 * @param {string} localPath - Absolute path to the audio file
 * @param {string} mimeType  - 'audio/mpeg' or 'audio/wav'
 * @returns {Promise<{ uri: string, name: string }>}
 */
async function uploadFile(localPath, mimeType) {
  const isVertex = process.env.VERTEX_PROJECT && process.env.VERTEX_LOCATION;
  const fileName = require('path').basename(localPath);

  if (isVertex) {
    // Vertex AI does not support ai.files.upload. We will use inline base64 instead.
    return { uri: 'VERTEX_INLINE', name: fileName };
  }

  const ai = getClient();

  const uploadedFile = await ai.files.upload({
    file: localPath,
    config: {
      mimeType,
      displayName: fileName,
    },
  });

  // Poll until the file is ACTIVE
  let file = uploadedFile;
  while (file.state === 'PROCESSING') {
    await new Promise((r) => setTimeout(r, 2000));
    file = await ai.files.get({ name: file.name });
  }

  if (file.state !== 'ACTIVE') {
    throw new Error(`File upload failed with state: ${file.state}`);
  }

  return { uri: file.uri, name: file.name };
}

/**
 * Robustly extract the first JSON array from a raw model response string.
 * This handles cases where the model adds preamble text, markdown fences,
 * or trailing explanation text around the JSON.
 * @param {string} raw
 * @returns {any[]} - parsed array
 */
function extractJsonArray(raw) {
  const start = raw.indexOf('[');
  if (start === -1) throw new Error('No JSON array found in model response.');

  let depth = 0;
  let end = -1;
  for (let i = start; i < raw.length; i++) {
    if (raw[i] === '[') depth++;
    else if (raw[i] === ']') {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end === -1) throw new Error('JSON array is not closed in model response.');

  const jsonStr = raw.slice(start, end + 1);
  return JSON.parse(jsonStr);
}

/**
 * Transcribe an audio file using local faster-whisper model.
 * @param {string} fileUri  - (Unused) The file URI from uploadFile()
 * @param {string} mimeType - (Unused) 'audio/mpeg' or 'audio/wav'
 * @param {string} localPath - Absolute path to the local audio file
 * @returns {Promise<Array<{ start: number, end: number, text: string }>>}
 */
async function transcribeAudio(fileUri, mimeType, localPath) {
  if (!localPath) {
    throw new Error('localPath is required for faster-whisper transcription.');
  }

  const pythonScript = path.join(__dirname, 'transcribe.py');
  const venvPython = path.join(__dirname, '../../venv/Scripts/python.exe');

  let stdoutRaw = '';
  try {
    const { stdout, stderr } = await execPromise(`"${venvPython}" "${pythonScript}" "${localPath}"`);
    stdoutRaw = stdout;
  } catch (e) {
    throw new Error(`faster-whisper transcription failed: ${e.message}`);
  }

  let segments;
  try {
    // We use extractJsonArray because the python script might print warnings before the JSON
    segments = extractJsonArray(stdoutRaw);
  } catch (e) {
    // Handle script errors that are printed as JSON
    try {
      const parsedErr = JSON.parse(stdoutRaw);
      if (parsedErr && parsedErr.error) {
        throw new Error(parsedErr.error);
      }
    } catch (_) {}
    throw new Error(`Failed to parse faster-whisper JSON: ${e.message}\nRaw output: ${stdoutRaw.slice(0, 400)}`);
  }

  // Validate shape
  if (!Array.isArray(segments)) throw new Error('Transcript is not an array');
  segments = segments.filter(
    (s) => typeof s.start === 'number' && typeof s.end === 'number' && typeof s.text === 'string'
  );

  return segments;
}

/**
 * Analyze transcript segments and generate thematic scenes with Pexels search queries.
 * @param {Array<{ start: number, end: number, text: string }>} segments
 * @returns {Promise<Array<{ start: number, end: number, searchQuery: string }>>}
 */
async function generateScenes(segments) {
  if (!segments || segments.length === 0) {
    return [];
  }
  
  const ai = getClient();
  const transcriptText = segments
    .map((s, idx) => `[Segment ${idx}] ${s.start.toFixed(1)}s - ${s.end.toFixed(1)}s: ${s.text}`)
    .join('\n');

const prompt = `You are a video director. Analyze the following audio transcript with Segment IDs.
Segment the transcript into a sequence of chronological "visual scenes" that flow naturally.
Each scene should represent a visual theme spanning one or more consecutive segments.
Guidelines:
1. Cover the entire duration of the audio (from Segment 0 to the last segment).
2. The duration of each scene should ideally be between 8 and 25 seconds.
3. You have TWO types of scenes you can generate: "video" and "slide".
   - Use "video" for standard B-roll footage representing the context.
   - Use "slide" when the audio discusses a formula, specific mathematical concept, an important list of bullet points, or complex definitions that the user needs to read on screen.
4. For each scene, write:
   - "startSegment": the integer ID of the first segment in this scene.
   - "endSegment": the integer ID of the last segment in this scene.
   - "type": either "video" or "slide"
   - "context": a short string containing the actual spoken words in this scene
   - If type is "video", include: "searchQuery": a 2-4 word visual search keyword in English for a looping background video on Pexels (e.g. "technology AI brain", "nature forest").
   - If type is "slide", include: "slideText": the text (like a formula, bullet points, or key phrase) to display on the slide. Use \\n for newlines. Keep it concise.

Return ONLY a raw JSON array of scenes, no markdown code fences, no explanation.

Here is the transcript:
${transcriptText}

Example Output:
[
  {"startSegment": 0, "endSegment": 4, "type": "video", "context": "Hello and welcome to this course...", "searchQuery": "technology AI brain"},
  {"startSegment": 5, "endSegment": 8, "type": "slide", "context": "The formula for energy is E equals m c squared.", "slideText": "Energy-Mass Equivalence\\n\\nE = mc²"}
]`;

  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
  });

  const raw = response.text;
  let scenesRaw;
  try {
    scenesRaw = extractJsonArray(raw);
  } catch (e) {
    throw new Error(`Failed to parse scene segmentation JSON: ${e.message}\nRaw snippet: ${raw.slice(0, 400)}`);
  }

  if (!Array.isArray(scenesRaw)) throw new Error('Scene segmentation is not an array');
  
  // Map segment indices to exact timestamps
  return scenesRaw.map((scene) => {
    // Safe-guard indices
    const startIdx = Math.max(0, Math.min(scene.startSegment || 0, segments.length - 1));
    const endIdx = Math.max(startIdx, Math.min(scene.endSegment || 0, segments.length - 1));
    
    return {
      start: segments[startIdx].start,
      end: segments[endIdx].end,
      type: scene.type || 'video',
      context: scene.context || '',
      searchQuery: scene.searchQuery || '',
      slideText: scene.slideText || ''
    };
  }).filter(s => typeof s.start === 'number' && typeof s.end === 'number');
}

/**
 * Delete a file from the Gemini File API (cleanup).
 * @param {string} fileName - The file name from uploadFile()
 */
async function deleteFile(fileName) {
  try {
    const ai = getClient();
    await ai.files.delete({ name: fileName });
  } catch (_) {
    // Non-fatal
  }
}

module.exports = { getClient, uploadFile, transcribeAudio, generateScenes, deleteFile };
