// services/ytShortsAnalyzer.js
// Node analyzer that mirrors the Flask logic (Sauvola + Tesseract + like detection)
// Fixed: robust "liked vs. unliked" detection (no false positives from digit OCR)

const sharp = require('sharp');
const Tesseract = require('tesseract.js');

// ─────────────── Like-icon & count constants ───────────────
// Tighter crop around the thumbs-up glyph so we don't pull video/background pixels.
// These were tuned on your samples; they work much more reliably than the wider box.
const ICON_X1 = 0.085, ICON_X2 = 0.105;
const ICON_Y1 = 0.49,  ICON_Y2 = 0.53;

// Darkness threshold for "is this pixel dark?"
const DARK_THRESHOLD    = 80;

// Whole-icon darkness quick check (kept for fast-path & extreme cases)
const LIKE_FILLED_MIN   = 0.035; // if ≥ this in the whole icon crop → definitely liked
const LIKE_OUTLINE_MAX  = 0.020; // if ≤ this in the whole icon crop → definitely unliked

// Fallback: measure how dark the CENTER of the icon is.
// For filled icons the center is dark; for outline icons the center is light.
const CENTER_BOX_START  = 0.35;  // 35% inside from each edge of the icon crop
const CENTER_BOX_END    = 0.65;  // 65% inside from each edge of the icon crop
const CENTER_DARK_MIN   = 0.25;  // if ≥ this → liked, else unliked

// ─────────────── Comment / reply constants ───────────────
const HANDLE_RE_INLINE = /@([A-Za-z0-9_.-]{2,})/;
const UNICODE_JUNK     = '•·●○▶►«»▪–—|>_';
const STOP_PHRASES     = [
  'adda reply','add a reply','add reply','add a comment','adda comment',
  'add comment','add a reply…','replies','reply','share','download','remix'
];
const SINGLE_LETTER_RE = /\b[A-Za-z]\b/g;
const ISOLATED_NUM_RE  = /\b\d+\b/g;

// ─────────────── Helpers ───────────────
const stripChars = (s, chars) => {
  let a = 0, b = s.length - 1;
  while (a <= b && chars.includes(s[a])) a++;
  while (b >= a && chars.includes(s[b])) b--;
  return s.slice(a, b + 1);
};
const cleanToken = (tok) => stripChars(tok, UNICODE_JUNK + ' \t\n.:,;()[]{}');

function cleanText(text) {
  text = text.replace(ISOLATED_NUM_RE, '');
  text = text.replace(SINGLE_LETTER_RE, '');
  return text.replace(/\s+/g, ' ').trim();
}
function refineText(text) {
  text = text.replace(/^[^\w']+|[^\w']+$/g, '');
  const lower = text.toLowerCase();
  let cut = text.length;
  for (const p of STOP_PHRASES) {
    const idx = lower.indexOf(p);
    if (idx >= 0 && idx < cut) cut = idx;
  }
  text = text.slice(0, cut);
  text = text.replace(/[^\w'\s]/g, '');
  const toks = text.split(/\s+/).filter(Boolean);
  while (toks.length && toks[toks.length - 1].length <= 2) toks.pop();
  return toks.join(' ');
}

async function toGrayRaw(buffer) {
  const { data, info } = await sharp(buffer)
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data: new Uint8Array(data), info };
}

// Sauvola threshold (window=25, k=0.2, R=128) ~ skimage.filters.threshold_sauvola
function sauvolaBinarize(gray, width, height, windowSize = 25, k = 0.2, R = 128) {
  const r = Math.floor(windowSize / 2);
  const W = width, H = height, N = (W + 1) * (H + 1);
  const I = new Float64Array(N), I2 = new Float64Array(N);
  const idxI = (x, y) => y * (W + 1) + x;

  for (let y = 1; y <= H; y++) {
    let s = 0, s2 = 0;
    for (let x = 1; x <= W; x++) {
      const g = gray[(y - 1) * W + (x - 1)];
      s += g; s2 += g * g;
      I[idxI(x, y)]  = I[idxI(x, y - 1)]  + s;
      I2[idxI(x, y)] = I2[idxI(x, y - 1)] + s2;
    }
  }
  const rectSum = (A, x1, y1, x2, y2) =>
    A[idxI(x2, y2)] - A[idxI(x2, y1 - 1)] - A[idxI(x1 - 1, y2)] + A[idxI(x1 - 1, y1 - 1)];

  const out = new Uint8Array(W * H);
  for (let y = 1; y <= H; y++) {
    const y1 = Math.max(1, y - r), y2 = Math.min(H, y + r);
    for (let x = 1; x <= W; x++) {
      const x1 = Math.max(1, x - r), x2 = Math.min(W, x + r);
      const area = (x2 - x1 + 1) * (y2 - y1 + 1);
      const sum  = rectSum(I,  x1, y1, x2, y2);
      const sum2 = rectSum(I2, x1, y1, x2, y2);
      const mean = sum / area;
      const std  = Math.sqrt(Math.max(0, (sum2 / area) - mean * mean));
      const T = mean * (1 + k * ((std / R) - 1));
      const g = gray[(y - 1) * W + (x - 1)];
      out[(y - 1) * W + (x - 1)] = g > T ? 255 : 0;
    }
  }
  return out;
}

async function sauvolaImageToPNG(buffer) {
  const { data, info } = await toGrayRaw(buffer);
  const bw = sauvolaBinarize(data, info.width, info.height, 25, 0.2, 128);
  return sharp(Buffer.from(bw), { raw: { width: info.width, height: info.height, channels: 1 } })
    .png()
    .toBuffer();
}

async function ocrLines(buffer) {
  const png = await sauvolaImageToPNG(buffer);
  const { data: { text } } = await Tesseract.recognize(png, 'eng', {
    oem: 3,
    tessedit_pageseg_mode: 6,
    user_defined_dpi: '300',
  });
  return text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
}

function joinHandle(lineIdx, lines) {
  const line = lines[lineIdx];
  const m = line.match(HANDLE_RE_INLINE);
  if (m) return { handle: '@' + cleanToken(m[1]), newIdx: lineIdx };
  if (line.trim() === '@') {
    let i = lineIdx + 1;
    while (i < lines.length && !lines[i].trim()) i++;
    if (i < lines.length) {
      const nxt = cleanToken((lines[i].split(/\s+/)[0] || ''));
      if (nxt) return { handle: '@' + nxt, newIdx: i };
    }
  }
  return { handle: null, newIdx: lineIdx };
}

function extractUserTexts(lines) {
  const byUser = new Map();
  let i = 0, n = lines.length;
  const startsWithStop = (s) => {
    const low = s.toLowerCase();
    return STOP_PHRASES.some(p => low.startsWith(p));
  };
  while (i < n) {
    const { handle, newIdx } = joinHandle(i, lines);
    if (handle) {
      const buf = [];
      i = newIdx + 1;
      while (i < n) {
        const ln = lines[i];
        if (HANDLE_RE_INLINE.test(ln) || ln.trim().toLowerCase() === '@') break;
        if (startsWithStop(ln)) break;
        buf.push(ln); i++;
      }
      const raw = buf.join(' ').trim();
      const cleaned = cleanText(raw);
      if (cleaned) {
        if (!byUser.has(handle)) byUser.set(handle, []);
        byUser.get(handle).push(cleaned);
      }
    } else i++;
  }
  return byUser;
}

function pickUser(commentsMap, repliesMap) {
  for (const uid of commentsMap.keys()) if (repliesMap.has(uid)) return uid;
  return null;
}

// ─────────────── Like detection (robust) ───────────────
async function detectLike(buffer) {
  if (!buffer) return false;

  const meta = await sharp(buffer).metadata();
  const w = meta.width, h = meta.height;
  if (!w || !h) return false;

  // 1) Crop around the like icon
  const x1 = Math.floor(w * ICON_X1), x2 = Math.floor(w * ICON_X2);
  const y1 = Math.floor(h * ICON_Y1), y2 = Math.floor(h * ICON_Y2);
  const width = Math.max(1, x2 - x1);
  const height = Math.max(1, y2 - y1);

  const iconRaw = await sharp(buffer)
    .extract({ left: x1, top: y1, width, height })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const gray = iconRaw.data;

  // Whole-icon dark ratio (fast path)
  let dark = 0;
  for (let i = 0; i < gray.length; i++) if (gray[i] < DARK_THRESHOLD) dark++;
  const darkRatio = dark / gray.length;

  if (darkRatio >= LIKE_FILLED_MIN) return true;   // clearly filled
  if (darkRatio <= LIKE_OUTLINE_MAX) return false; // clearly outline

  // 2) Fallback: center-of-icon darkness
  const cx1 = Math.floor(x1 + width  * CENTER_BOX_START);
  const cx2 = Math.floor(x1 + width  * CENTER_BOX_END);
  const cy1 = Math.floor(y1 + height * CENTER_BOX_START);
  const cy2 = Math.floor(y1 + height * CENTER_BOX_END);

  const center = await sharp(buffer)
    .extract({ left: cx1, top: cy1, width: Math.max(1, cx2 - cx1), height: Math.max(1, cy2 - cy1) })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  let centerDark = 0;
  for (let i = 0; i < center.data.length; i++) if (center.data[i] < DARK_THRESHOLD) centerDark++;
  const centerDarkRatio = centerDark / center.data.length;

  return centerDarkRatio >= CENTER_DARK_MIN;
}

function getBuf(fileOrBuf) {
  return Buffer.isBuffer(fileOrBuf) ? fileOrBuf : (fileOrBuf?.buffer || null);
}

/**
 * Analyze the 5-image bundle and return the same shape the Flask service returns.
 * @param {{like:any, comment1:any, comment2:any, reply1:any, reply2:any}} filesByRole
 * @returns {Promise<{liked:boolean, user_id:string|null, comment:string[], replies:string[], verified:boolean}>}
 */
async function analyzeBundle(filesByRole) {
  const likeBuf = getBuf(filesByRole.like);
  const c1Buf   = getBuf(filesByRole.comment1);
  const c2Buf   = getBuf(filesByRole.comment2);
  const r1Buf   = getBuf(filesByRole.reply1);
  const r2Buf   = getBuf(filesByRole.reply2);

  const liked = await detectLike(likeBuf);

  const commentsRaw = [
    ...(await ocrLines(c1Buf)),
    ...(await ocrLines(c2Buf)),
  ];
  const repliesRaw = [
    ...(await ocrLines(r1Buf)),
    ...(await ocrLines(r2Buf)),
  ];

  const commentMap = extractUserTexts(commentsRaw);
  const replyMap   = extractUserTexts(repliesRaw);
  const uid        = pickUser(commentMap, replyMap);

  const comments = (uid && commentMap.get(uid) ? commentMap.get(uid) : []).map(refineText);
  const replies  = (uid && replyMap.get(uid)   ? replyMap.get(uid)   : []).map(refineText);

  const verified = Boolean(liked && comments.length >= 2 && replies.length >= 2);

  return {
    liked,
    user_id: uid || null,
    comment: comments,
    replies: replies,
    verified,
  };
}

module.exports = { analyzeBundle };
