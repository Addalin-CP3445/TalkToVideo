const fs = require('fs');
const path = require('path');
const https = require('https');

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
 * Fetch a video from Pexels API matching the query.
 * @param {string} query 
 * @returns {Promise<{ downloadUrl: string, author: string, authorUrl: string }>}
 */
async function fetchVideoForQuery(query) {
  const apiKey = process.env.PEXELS_API_KEY;

  if (!apiKey || apiKey === 'your_pexels_api_key_here') {
    console.warn(`⚠️ PEXELS_API_KEY not configured. Using fallback video for query: "${query}"`);
    const mock = FALLBACK_VIDEOS[fallbackCounter % FALLBACK_VIDEOS.length];
    fallbackCounter++;
    return {
      downloadUrl: mock.link,
      author: mock.user.name,
      authorUrl: mock.user.url
    };
  }

  try {
    const url = `https://api.pexels.com/v1/videos/search?query=${encodeURIComponent(query)}&per_page=3&orientation=landscape`;
    const response = await fetch(url, {
      headers: {
        Authorization: apiKey
      }
    });

    if (!response.ok) {
      throw new Error(`Pexels API responded with status ${response.status}`);
    }

    const data = await response.json();
    if (!data.videos || data.videos.length === 0) {
      console.warn(`No videos found on Pexels for: "${query}". Using fallback.`);
      const mock = FALLBACK_VIDEOS[fallbackCounter % FALLBACK_VIDEOS.length];
      fallbackCounter++;
      return {
        downloadUrl: mock.link,
        author: mock.user.name,
        authorUrl: mock.user.url
      };
    }

    // Try to find a good quality mp4 file (HD if possible)
    const video = data.videos[0];
    const files = video.video_files || [];
    // Prefer HD files with mp4 type
    const bestFile = files.find(f => f.quality === 'hd' && f.file_type === 'video/mp4') ||
                     files.find(f => f.file_type === 'video/mp4') ||
                     files[0];

    if (!bestFile || !bestFile.link) {
      throw new Error('No valid download link found in Pexels response');
    }

    return {
      downloadUrl: bestFile.link,
      author: video.user ? video.user.name : 'Pexels Creator',
      authorUrl: video.user ? video.user.url : 'https://pexels.com'
    };
  } catch (error) {
    console.error(`Error fetching from Pexels API: ${error.message}. Using fallback.`);
    const mock = FALLBACK_VIDEOS[fallbackCounter % FALLBACK_VIDEOS.length];
    fallbackCounter++;
    return {
      downloadUrl: mock.link,
      author: mock.user.name,
      authorUrl: mock.user.url
    };
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

module.exports = { fetchVideoForQuery, downloadVideo };
