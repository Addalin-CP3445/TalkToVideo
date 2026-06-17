const fs = require('fs');
const path = require('path');
const https = require('https');
const { getClient } = require('./gemini');

// High-quality public fallback stock video loops if PEXELS_API_KEY is not set
const FALLBACK_VIDEOS = [
  {
    link: 'https://assets.mixkit.co/videos/preview/mixkit-stars-in-space-background-1611-large.mp4',
    user: { name: 'Mixkit Space', url: 'https://mixkit.co/' }
  },
  {
    link: 'https://assets.mixkit.co/videos/preview/mixkit-forest-stream-in-the-sunlight-529-large.mp4',
    user: { name: 'Mixkit Nature', url: 'https://mixkit.co/' }
  },
  {
    link: 'https://assets.mixkit.co/videos/preview/mixkit-abstract-laser-lights-background-27739-large.mp4',
    user: { name: 'Mixkit Abstract', url: 'https://mixkit.co/' }
  }
];

let fallbackCounter = 0;

/**
 * Takes an array of scenes that need video.
 * Fetches 5 Pexels options concurrently for each, and then sends ONE prompt to Gemini to pick the best.
 * @param {Array<{ searchQuery: string, context: string }>} scenes
 * @returns {Promise<Array<{ downloadUrl: string, author: string, authorUrl: string } | null>>}
 */
async function fetchAndValidateBatch(scenes) {
  const apiKey = process.env.PEXELS_API_KEY;

  if (!apiKey || apiKey === 'your_pexels_api_key_here') {
    console.warn(`⚠️ PEXELS_API_KEY not configured. Falling back to slides for batch.`);
    return scenes.map(() => null);
  }

  try {
    // 1. Fetch from Pexels concurrently
    const fetchPromises = scenes.map(async (scene) => {
      try {
        const url = `https://api.pexels.com/v1/videos/search?query=${encodeURIComponent(scene.searchQuery)}&per_page=5&orientation=landscape`;
        const response = await fetch(url, { headers: { Authorization: apiKey } });
        if (!response.ok) return [];
        const data = await response.json();
        return data.videos || [];
      } catch (e) {
        return [];
      }
    });

    const pexelsResults = await Promise.all(fetchPromises);

    // 2. Build Gemini Prompt
    let prompt = `I am creating a video. I have ${scenes.length} scenes that need a background stock video. For each scene, I will provide the voiceover context and up to 5 stock video options from Pexels.\n`;
    prompt += `Select the SINGLE best video that visually matches the voiceover context for each scene.\n`;
    prompt += `Return ONLY a raw JSON array of integers representing your choice for each scene (1 to 5). If NONE of the videos for a scene are a good match, return 0 for that scene.\n\n`;
    prompt += `Example Output:\n[2, 0, 1]\n\n`;

    scenes.forEach((scene, index) => {
      prompt += `--- Scene ${index + 1} ---\n`;
      prompt += `Context: "${scene.context || scene.searchQuery}"\n`;
      prompt += `Options:\n`;
      const options = pexelsResults[index];
      if (options.length === 0) {
        prompt += `(No videos found)\n`;
      } else {
        options.forEach((v, i) => {
          const slug = v.url.split('/').filter(Boolean).pop() || 'video';
          prompt += `Video ${i + 1}: ${slug.replace(/-/g, ' ')}\n`;
        });
      }
      prompt += `\n`;
    });

    // 3. Call Gemini
    const ai = getClient();
    let choices = [];
    try {
      const aiResponse = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
      });
      const match = aiResponse.text.match(/\[[\s\S]*?\]/);
      if (match) {
        choices = JSON.parse(match[0]);
      } else {
        choices = scenes.map(() => 0);
      }
    } catch (e) {
      console.error("Gemini batch validation failed", e);
      choices = scenes.map(() => 0);
    }

    // 4. Map choices to final selected video files
    return scenes.map((scene, index) => {
      const choiceNum = choices[index];
      if (!choiceNum || choiceNum <= 0) {
        console.log(`[Pexels] Gemini rejected videos for scene "${scene.searchQuery}".`);
        return null;
      }
      const options = pexelsResults[index];
      if (options.length === 0) return null;
      
      const selectedIdx = Math.max(0, Math.min(choiceNum - 1, options.length - 1));
      const video = options[selectedIdx];

      const files = video.video_files || [];
      const bestFile = files.find(f => f.quality === 'hd' && f.file_type === 'video/mp4') ||
                       files.find(f => f.file_type === 'video/mp4') ||
                       files[0];

      if (!bestFile || !bestFile.link) return null;

      console.log(`[Pexels] Gemini selected Video ${selectedIdx + 1} for scene "${scene.searchQuery}"`);
      return {
        downloadUrl: bestFile.link,
        author: video.user ? video.user.name : 'Pexels Creator',
        authorUrl: video.user ? video.user.url : 'https://pexels.com'
      };
    });
  } catch (error) {
    console.error(`Error in batch validation: ${error.message}`);
    return scenes.map(() => null);
  }
}

/**
 * Downloads a video from a URL to the specified local path.
 * Supports redirects automatically.
 * @param {string} url 
 * @param {string} targetPath 
 * @returns {Promise<void>}
 */
function downloadVideo(url, targetPath) {
  return new Promise((resolve, reject) => {
    // Check cache first
    if (fs.existsSync(targetPath)) {
      const stats = fs.statSync(targetPath);
      if (stats.size > 0) {
        return resolve();
      }
    }

    const file = fs.createWriteStream(targetPath);
    
    function getStream(targetUrl) {
      https.get(targetUrl, (response) => {
        if (response.statusCode === 301 || response.statusCode === 302) {
          getStream(response.headers.location);
          return;
        }

        if (response.statusCode !== 200) {
          reject(new Error(`Failed to download video. Status: ${response.statusCode}`));
          return;
        }

        response.pipe(file);

        file.on('finish', () => {
          file.close();
          resolve();
        });
      }).on('error', (err) => {
        fs.unlink(targetPath, () => {});
        reject(err);
      });
    }

    getStream(url);
  });
}

module.exports = { fetchAndValidateBatch, downloadVideo };
