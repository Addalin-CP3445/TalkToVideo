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

/**
 * Build an FFmpeg drawtext filter expression for a single caption segment.
 * Uses `enable='between(t,start,end)'` for timed display.
 *
 * @param {Object} segment  - { start, end, text }
 * @param {Object} theme    - theme config from THEMES
 * @param {number} width    - video width (1920)
 * @param {number} height   - video height (1080)
 * @returns {string}        - FFmpeg filter fragment
 */
function buildDrawtextFilter(segment, theme, width = 1920, height = 1080) {
  // Escape FFmpeg special characters in the text
  const escaped = segment.text
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/:/g, '\\:')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]');

  const fontSizeStr = theme.fontSize.toString();
  const y = Math.round(height * 0.82); // caption band at 82% height

  let filter = `drawtext=text='${escaped}'`;
  filter += `:fontcolor=${theme.fontColor}`;
  filter += `:fontsize=${fontSizeStr}`;
  filter += `:x=(w-text_w)/2`;          // horizontally centered
  filter += `:y=${y}`;
  filter += `:shadowcolor=${theme.shadowColor}`;
  filter += `:shadowx=${theme.shadowX}`;
  filter += `:shadowy=${theme.shadowY}`;
  filter += `:box=1`;
  filter += `:boxcolor=${theme.boxColor}`;
  filter += `:boxborderw=18`;
  filter += `:enable='between(t,${segment.start},${segment.end})'`;

  if (theme.fontFile) {
    filter += `:fontfile='${theme.fontFile}'`;
  }

  return filter;
}

/**
 * Build the complete FFmpeg video_filter string for all caption segments.
 *
 * @param {Array}  segments - array of { start, end, text }
 * @param {string} themeKey - key into THEMES
 * @param {number} width
 * @param {number} height
 * @returns {string}        - comma-joined drawtext filter chain
 */
function buildCaptionFilter(segments, themeKey, width = 1920, height = 1080) {
  const theme = THEMES[themeKey] || THEMES['dark-minimal'];
  return segments
    .map((seg) => buildDrawtextFilter(seg, theme, width, height))
    .join(',');
}

module.exports = { THEMES, buildCaptionFilter };
