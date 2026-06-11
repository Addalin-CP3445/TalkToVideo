const { GoogleGenAI } = require('@google/genai');
const fs = require('fs');

/**
 * Get an initialized Gemini client.
 * Throws a descriptive error if the API key is missing.
 */
function getClient() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'your_gemini_api_key_here') {
    throw new Error(
      'GEMINI_API_KEY is not configured. Copy .env.example to .env and set your key.'
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
  const ai = getClient();
  const fileName = require('path').basename(localPath);

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
 * Transcribe an audio file already uploaded to the Gemini File API.
 * @param {string} fileUri  - The file URI from uploadFile()
 * @param {string} mimeType - 'audio/mpeg' or 'audio/wav'
 * @returns {Promise<Array<{ start: number, end: number, text: string }>>}
 */
async function transcribeAudio(fileUri, mimeType) {
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

  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: [
      {
        role: 'user',
        parts: [
          {
            fileData: {
              mimeType,
              fileUri,
            },
          },
          { text: prompt },
        ],
      },
    ],
  });

  const raw = response.text.trim();

  // Strip markdown code fences if model wraps in them
  const clean = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

  let segments;
  try {
    segments = JSON.parse(clean);
  } catch (e) {
    throw new Error(`Failed to parse Gemini transcript JSON: ${e.message}\nRaw: ${raw.slice(0, 300)}`);
  }

  // Validate shape
  if (!Array.isArray(segments)) throw new Error('Transcript is not an array');
  segments = segments.filter(
    (s) => typeof s.start === 'number' && typeof s.end === 'number' && typeof s.text === 'string'
  );

  return segments;
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

module.exports = { uploadFile, transcribeAudio, deleteFile };
