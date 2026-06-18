/**
 * Theme presets for caption rendering.
 * Each theme maps to FFmpeg drawtext filter parameters.
 */
const THEMES = {
  'dark-minimal': {
    label: 'Dark Minimal',
    bgColor: '0x0d0d0d',         // solid fill
    bgGradient: null,
    fontColor: 'white',
    shadowColor: '0x6c63ff',
    shadowX: 3,
    shadowY: 3,
    boxColor: '0x00000088',
    fontSize: 56,
    fontFile: null,               // use default; override if bundled font available
  },
  'neon-glow': {
    label: 'Neon Glow',
    bgColor: '0x0a0a1a',
    bgGradient: null,
    fontColor: '0x00ffcc',
    shadowColor: '0xff00ff',
    shadowX: 4,
    shadowY: 4,
    boxColor: '0x0a0a1a99',
    fontSize: 58,
    fontFile: null,
  },
  'warm-sunset': {
    label: 'Warm Sunset',
    bgColor: '0x1a0533',
    bgGradient: '0xff6b35',       // used in gradient filter
    fontColor: '0xfff5e0',
    shadowColor: '0xffbe76',
    shadowX: 3,
    shadowY: 3,
    boxColor: '0x00000066',
    fontSize: 56,
    fontFile: null,
  },
  'ocean-blue': {
    label: 'Ocean Blue',
    bgColor: '0x0f2027',
    bgGradient: '0x2c5364',
    fontColor: '0xe0f7ff',
    shadowColor: '0x00b4d8',
    shadowX: 3,
    shadowY: 3,
    boxColor: '0x00000077',
    fontSize: 56,
    fontFile: null,
  },
};

const fs = require('fs');
const os = require('os');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

/** Maximum characters allowed per caption line before wrapping to the next. */
const MAX_CHARS_PER_LINE = 35;

// textfile is much safer than text for complex string escaping. We don't need this complex escaping anymore,
// but keep it around just in case.
function escapeFFmpeg(text) {
  return text; // textfile reads raw content, no escaping needed
}

/**
 * Split a text string into lines of at most MAX_CHARS_PER_LINE characters each,
 * breaking at word boundaries. Also respects explicit newlines.
 * @param {string} text
 * @param {number} maxChars
 * @returns {string[]}
 */
function wrapText(text, maxChars = MAX_CHARS_PER_LINE) {
  if (!text) return [''];
  
  const explicitLines = text.split('\n');
  const finalLines = [];
  
  for (const explicitLine of explicitLines) {
    const words = explicitLine.trim().split(/\s+/);
    if (words.length === 0 || words[0] === '') {
      finalLines.push('');
      continue;
    }
    
    let currentLine = words[0];
    for (let i = 1; i < words.length; i++) {
      const word = words[i];
      if (currentLine.length + 1 + word.length <= maxChars) {
        currentLine += ' ' + word;
      } else {
        finalLines.push(currentLine);
        currentLine = word;
      }
    }
    finalLines.push(currentLine);
  }
  
  return finalLines.length > 0 ? finalLines : [''];
}

/**
 * Build one or more FFmpeg drawtext filter expressions for a single caption segment.
 * Long text is automatically wrapped into multiple lines stacked vertically.
 *
 * @param {Object} segment  - { start, end, text }
 * @param {Object} theme    - theme config from THEMES
 * @param {number} width    - video width (1920)
 * @param {number} height   - video height (1080)
 * @param {Array} tempFiles - Array to push temp text files into for cleanup
 * @returns {string[]}      - array of FFmpeg drawtext filter strings (one per line)
 */
function buildDrawtextFilters(segment, theme, width = 1920, height = 1080, tempFiles = []) {
  const lines = wrapText(segment.text);
  const fontSize = theme.fontSize;

  // Line height includes font size + comfortable padding between lines
  const lineHeight = Math.round(fontSize * 1.35);

  // Bottom anchor: the bottom of the last line sits at 88% of height
  const bottomY = Math.round(height * 0.88);

  // Total block height for all lines
  const blockHeight = lineHeight * lines.length;

  // Top-left Y of the first line
  const topY = bottomY - blockHeight;

  const enable = `enable=between(t\\,${segment.start.toFixed(3)}\\,${segment.end.toFixed(3)})`;
  const fontSizeStr = fontSize.toString();

  return lines.map((line, idx) => {
    // Write text to a temporary file to avoid ffmpeg quoting nightmares
    const textFilePath = path.join(os.tmpdir(), `ttv_txt_${uuidv4()}.txt`);
    fs.writeFileSync(textFilePath, line, 'utf8');
    tempFiles.push(textFilePath);
    
    // Windows paths contain backslashes and colons (C:\...). FFmpeg handles forward slashes.
    // Also, inside filter arguments, colons MUST be escaped if not using quotes, but with textfile='path'
    // single quotes are safer, though we must still escape the colon after drive letter.
    let safePath = textFilePath.replace(/\\/g, '/');
    // Escape colons in the path (e.g. C:/ -> C\:/)
    safePath = safePath.replace(/:/g, '\\:');

    const y = topY + idx * lineHeight;

    let filter = `drawtext=textfile='${safePath}'`;
    filter += `:fontcolor=${theme.fontColor}`;
    filter += `:fontsize=${fontSizeStr}`;
    filter += `:x=(w-text_w)/2`;       // horizontally centered
    filter += `:y=${y}`;
    filter += `:shadowcolor=${theme.shadowColor}`;
    filter += `:shadowx=${theme.shadowX}`;
    filter += `:shadowy=${theme.shadowY}`;
    filter += `:box=1`;
    filter += `:boxcolor=${theme.boxColor}`;
    filter += `:boxborderw=18`;
    filter += `:${enable}`;

    if (theme.fontFile) {
      filter += `:fontfile='${theme.fontFile}'`;
    }

    return filter;
  });
}

/**
 * Build the complete FFmpeg video_filter string for all caption segments.
 * Each segment may produce multiple drawtext filters if the text wraps.
 *
 * @param {Array}  segments - array of { start, end, text }
 * @param {string} themeKey - key into THEMES
 * @param {number} width
 * @param {number} height
 * @param {Array} tempFiles
 * @returns {string}        - comma-joined drawtext filter chain
 */
function buildCaptionFilter(segments, themeKey, width = 1920, height = 1080, tempFiles = []) {
  const theme = THEMES[themeKey] || THEMES['dark-minimal'];
  return segments
    .flatMap((seg) => buildDrawtextFilters(seg, theme, width, height, tempFiles))
    .join(',');
}

module.exports = { THEMES, buildCaptionFilter, wrapText };
