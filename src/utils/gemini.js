const { GoogleGenAI } = require('@google/genai');
const { GoogleAuth } = require('google-auth-library');
const fs = require('fs');

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
 * Transcribe an audio file already uploaded to the Gemini File API.
 * @param {string} fileUri  - The file URI from uploadFile()
 * @param {string} mimeType - 'audio/mpeg' or 'audio/wav'
 * @param {string} [localPath] - Optional local path for Vertex AI inline upload
 * @returns {Promise<Array<{ start: number, end: number, text: string }>>}
 */
async function transcribeAudio(fileUri, mimeType, localPath) {
  const ai = getClient();

  const prompt = `You are a precise audio transcription assistant.
Listen to this audio file and return a JSON array of transcript segments.
Each segment must have:
  - "start": start time in seconds (number, e.g. 0.5)
  - "end": end time in seconds (number, e.g. 3.2)
  - "text": the spoken words in that segment (string)

Split segments at natural pauses or every 5–8 words maximum so captions are readable.
Return ONLY the raw JSON array, no markdown, no explanation.

Example:
[{"start":0,"end":2.5,"text":"Hello and welcome"},{"start":2.6,"end":5.1,"text":"to this presentation"}]`;

  // Use inline base64 for Vertex AI, otherwise use the File API URI
  let filePart;
  if (fileUri === 'VERTEX_INLINE') {
    if (!localPath) throw new Error('localPath is required for Vertex AI inline transcription.');
    const fileData = fs.readFileSync(localPath);
    filePart = {
      inlineData: {
        data: fileData.toString('base64'),
        mimeType,
      },
    };
  } else {
    filePart = {
      fileData: {
        mimeType,
        fileUri,
      },
    };
  }

  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: [
      {
        role: 'user',
        parts: [
          filePart,
          { text: prompt },
        ],
      },
    ],
  });

  const raw = response.text;
  let segments;
  try {
    segments = extractJsonArray(raw);
  } catch (e) {
    throw new Error(`Failed to parse Gemini transcript JSON: ${e.message}\nRaw snippet: ${raw.slice(0, 400)}`);
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
    .map((s) => `[${s.start.toFixed(1)}s - ${s.end.toFixed(1)}s] ${s.text}`)
    .join('\n');

  const prompt = `You are a video director. Analyze the following audio transcript with timestamps.
Segment the transcript into a sequence of chronological "visual scenes" that flow naturally.
Each scene should represent a visual theme.
Guidelines:
1. Cover the entire duration of the audio (from 0s to the end of the last segment).
2. The duration of each scene should ideally be between 8 and 25 seconds.
3. For each scene, write:
   - "start": the start time in seconds (number)
   - "end": the end time in seconds (number)
   - "searchQuery": a 2-4 word visual search keyword/phrase in English to search for a looping background video on Pexels (e.g. "technology AI brain", "nature forest sunlight", "person typing laptop", "abstract glowing background"). Use generic but descriptive search terms.

Return ONLY a raw JSON array of scenes, no markdown code fences, no explanation.

Here is the transcript:
${transcriptText}

Example Output:
[
  {"start": 0, "end": 12.5, "searchQuery": "technology AI brain"},
  {"start": 12.5, "end": 30.0, "searchQuery": "office computer typing"}
]`;

  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
  });

  const raw = response.text;
  let scenes;
  try {
    scenes = extractJsonArray(raw);
  } catch (e) {
    throw new Error(`Failed to parse scene segmentation JSON: ${e.message}\nRaw snippet: ${raw.slice(0, 400)}`);
  }

  if (!Array.isArray(scenes)) throw new Error('Scene segmentation is not an array');
  return scenes.filter(
    (s) => typeof s.start === 'number' && typeof s.end === 'number' && typeof s.searchQuery === 'string'
  );
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

module.exports = { uploadFile, transcribeAudio, generateScenes, deleteFile };
