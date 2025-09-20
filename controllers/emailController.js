// controllers/emailController.js
'use strict';

require('dotenv').config();

const fs = require('node:fs');
const path = require('node:path');
const asyncHandler = fn => (req, res, next) => fn(req, res, next).catch(next);
const crypto = require('node:crypto');
const { fetch, Agent } = require('undici');
const Employee = require('../models/Employee');
const EmailContact = require('../models/email');
const User = require('../models/User');

// ---------- HTTP agent ----------
const httpAgent = new Agent({
  keepAliveTimeout: (Number(process.env.KEEP_ALIVE_SECONDS || 60)) * 1000,
  keepAliveMaxTimeout: (Number(process.env.KEEP_ALIVE_SECONDS || 60)) * 1000,
});

// ---------- Optional fast downscale / dark-mode enhance ----------
const USE_SHARP = process.env.USE_SHARP !== '0';
let sharp = null;
if (USE_SHARP) {
  try { sharp = require('sharp'); } catch { }
}

// ---------- Optional JSON repair ----------
let jsonrepairFn = null;
try { jsonrepairFn = require('jsonrepair').jsonrepair || require('jsonrepair'); } catch { }

// ---------- Models & perf knobs ----------
const MODEL_PRIMARY = process.env.OPENAI_VISION_MODEL || process.env.OPENAI_VISION_PRIMARY || 'gpt-4o-mini';
const MODEL_FALLBACK = process.env.OPENAI_VISION_FALLBACK || 'gpt-4o';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const PRIMARY_TOKENS = Number(process.env.PRIMARY_TOKENS || 320);
const RETRY_TOKENS = Number(process.env.RETRY_TOKENS || 900);

const TEMP = Number(process.env.TEMPERATURE || 0);
const TIMEOUT_MS = Number(process.env.OPENAI_TIMEOUT_MS || 30000);
const MAX_IMG_W = Number(process.env.MAX_IMAGE_WIDTH || 1280);
const MAX_IMG_H = Number(process.env.MAX_IMAGE_HEIGHT || 1280);
const IMAGE_DETAIL = (process.env.IMAGE_DETAIL || 'low'); // 'low'|'auto'
const ENABLE_CACHE = process.env.ENABLE_CACHE !== '0';
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 5 * 60_000);
const AGGRESSIVE_RACE = process.env.AGGRESSIVE_RACE === '1';
const ENABLE_DARK_ENHANCE = process.env.ENABLE_DARK_ENHANCE !== '0'; // default ON

// ---------- YouTube API (NEW) ----------
const YT_API_KEY     = process.env.YOUTUBE_API_KEY;          // <-- set this in .env
const YT_TIMEOUT_MS  = Number(process.env.YOUTUBE_TIMEOUT_MS || 12000);
const YT_BASE        = 'https://www.googleapis.com/youtube/v3/channels';

// ---------- Regex ----------
const EMAIL_RX = /[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g;
const HANDLE_IN_TEXT = /@[A-Za-z0-9._\-]+/g;
const YT_HANDLE_RX = /\/@([A-Za-z0-9._\-]+)/i;     // used in deriveHandleFromMi
const YT_HANDLE_RE = /@([A-Za-z0-9._\-]+)/i;       // used in YouTube helpers
const IG_RX = /(?:instagram\.com|ig\.me)\/([A-Za-z0-9._\-]+)/i;
const TW_RX = /(?:twitter\.com|x\.com)\/([A-Za-z0-9._\-]+)/i;

// ---------- JSON schema (More-info only) ----------
const SECTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    emails: { type: 'array', items: { type: 'string' } },
    handles: { type: 'array', items: { type: 'string' } },
    fields: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: { key: { type: 'string' }, value: { type: 'string' } },
        required: ['key', 'value']
      }
    },
    raw_text: { type: 'string' }
  },
  required: ['emails', 'handles', 'fields', 'raw_text']
};
const RESPONSE_SCHEMA = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      has_captcha: { type: 'boolean' },
      rejection_reason: { type: ['string', 'null'] },
      more_info: SECTION_SCHEMA
    },
    required: ['has_captcha', 'rejection_reason', 'more_info']
  }
};

// ---------- Prompts ----------
const SYSTEM_MSG =
  'You extract text from a screenshot of a YouTube channel “About” popover and return strict JSON. ' +
  'If a visible reCAPTCHA checkbox (“I’m not a robot” with the reCAPTCHA logo) exists: set has_captcha=true and a brief rejection_reason. ' +
  'Otherwise: only include the content under the “More info” heading, in a `more_info` object with emails, handles, fields, raw_text. ' +
  'Return JSON only. In `handles`, include ONLY plain handles that start with "@" (no URLs). Lowercase is fine.';
const USER_INSTRUCTIONS =
  'Return only JSON. If the “More info” section is not present, set `more_info` to empty arrays/strings (no fallback to any other section).';

// ---------- Helpers ----------
const PLATFORM_MAP = new Map([
  ['youtube', 'youtube'], ['yt', 'youtube'],
  ['instagram', 'instagram'], ['ig', 'instagram'],
  ['twitter', 'twitter'], ['x', 'twitter'],
  ['tiktok', 'tiktok'], ['tt', 'tiktok'],
  ['facebook', 'facebook'], ['fb', 'facebook'],
  ['other', 'other']
]);
function normalizePlatform(p) {
  if (!p) return null;
  const key = String(p).trim().toLowerCase();
  return PLATFORM_MAP.get(key) || null;
}

function escapeRegex(str = '') {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function guessMime(p) {
  const ext = (p && path.extname(p).toLowerCase()) || '';
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  return 'image/jpeg';
}
function bufferToDataUrl(buf, mime = 'image/jpeg') {
  const b64 = Buffer.from(buf).toString('base64');
  return `data:${mime};base64,${b64}`;
}
function uniqueSorted(arr = []) {
  const seen = new Set(); const out = [];
  for (const s of arr) {
    const k = (s || '').trim(); if (!k) continue;
    const low = k.toLowerCase(); if (!seen.has(low)) { seen.add(low); out.push(k); }
  }
  return out;
}
function hashString(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }
function now() { return Date.now(); }

// cache ONLY parsed output (never DB results)
const CACHE = new Map();
function cacheGet(key) {
  if (!ENABLE_CACHE) return null;
  const v = CACHE.get(key); if (!v) return null;
  if (now() - v.ts > CACHE_TTL_MS) { CACHE.delete(key); return null; }
  return v.data;
}
function cacheSet(key, data) {
  if (!ENABLE_CACHE) return;
  CACHE.set(key, { ts: now(), data });
  if (CACHE.size > 500) { for (const k of CACHE.keys()) { CACHE.delete(k); if (CACHE.size <= 400) break; } }
}

async function enhanceIfDark(buffer) {
  if (!sharp || !ENABLE_DARK_ENHANCE) return buffer;
  try {
    const img = sharp(buffer, { failOn: 'none' });
    const stats = await img.stats();
    const means = stats.channels.slice(0, 3).map(c => c.mean || 0);
    const avg = means.reduce((a, b) => a + b, 0) / (means.length || 1);
    if (avg < 85) {
      return await sharp(buffer).modulate({ brightness: 1.35, saturation: 1.08 }).gamma(1.05).toBuffer();
    }
    return buffer;
  } catch { return buffer; }
}
async function preprocessImage(buffer, mime) {
  if (!sharp) return buffer;
  try {
    let img = sharp(buffer, { failOn: 'none' });
    const meta = await img.metadata();
    const w = meta.width || 0, h = meta.height || 0;
    if (w > MAX_IMG_W || h > MAX_IMG_H) {
      img = img.resize({ width: MAX_IMG_W, height: MAX_IMG_H, fit: 'inside', withoutEnlargement: true });
    }
    const buf = await (mime.includes('png') ? img.png({ compressionLevel: 6 }) : img.jpeg({ quality: 80 })).toBuffer();
    return await enhanceIfDark(buf);
  } catch { return await enhanceIfDark(buffer); }
}
async function imagePartFromBuffer(buffer, mimetype) {
  const mime = mimetype || 'image/jpeg';
  const buf = await preprocessImage(buffer, mime);
  return { type: 'input_image', image_url: bufferToDataUrl(buf, mime) };
}
async function imagePartFromPath(absPath) {
  if (!fs.existsSync(absPath)) throw new Error(`File not found: ${absPath}`);
  const mime = guessMime(absPath);
  const buf0 = fs.readFileSync(absPath);
  const buf = await preprocessImage(buf0, mime);
  return { type: 'input_image', image_url: bufferToDataUrl(buf, mime) };
}
function imagePartFromUrl(url) {
  return { type: 'input_image', image_url: { url: String(url), detail: IMAGE_DETAIL } };
}

// ---------- OpenAI helpers ----------
function extractOutputText(data) {
  if (data?.output && Array.isArray(data.output)) {
    for (const o of data.output) {
      if (!o?.content) continue;
      for (const c of o.content) {
        if (c?.type === 'output_json' && c?.json) return JSON.stringify(c.json);
        if (c?.json) return JSON.stringify(c.json);
        if (c?.type === 'output_text' && typeof c.text === 'string') return c.text;
        if (typeof c?.text === 'string') return c.text;
      }
    }
  }
  if (typeof data?.output_text === 'string' && data.output_text.trim()) return data.output_text;
  if (Array.isArray(data?.choices)) {
    const content = data.choices[0]?.message?.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return content.map(p => p?.text || '').join('\n').trim();
  }
  return '';
}
function safeJSONParse(input) {
  if (input && typeof input === 'object') return input;
  if (typeof input !== 'string') throw new Error('Expected JSON string');
  let t = input.trim();
  t = t.replace(/```(?:json)?/gi, '').replace(/```/g, '').replace(/^\uFEFF/, '').replace(/[\u200B-\u200D\u2060]/g, '').trim();
  const first = t.indexOf('{'); const last = t.lastIndexOf('}');
  if (first !== -1 && last !== -1 && first < last) t = t.slice(first, last + 1);
  t = t.replace(/[\u201C\u201D]/g, '"').replace(/[\u2018\u2019]/g, "'").replace(/,\s*([}\]])/g, '$1');
  try { return JSON.parse(t); }
  catch {
    if (jsonrepairFn) return JSON.parse(jsonrepairFn(t));
    throw new Error(`Invalid JSON after repair attempts. Preview: ${t.slice(0, 200)}…`);
  }
}
function makeBody(imagePart, model, maxTokens) {
  return {
    model,
    input: [
      { role: 'system', content: [{ type: 'input_text', text: SYSTEM_MSG }] },
      { role: 'user', content: [{ type: 'input_text', text: USER_INSTRUCTIONS }, imagePart] }
    ],
    text: { format: { type: 'json_schema', name: 'YouTubeAboutExtraction', schema: RESPONSE_SCHEMA.schema, strict: true } },
    temperature: TEMP,
    max_output_tokens: maxTokens
  };
}
async function callOpenAI(body, timeoutMs) {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(new Error('OpenAI timeout')), timeoutMs);
  try {
    const r = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      dispatcher: httpAgent,
      headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ac.signal
    });
    if (!r.ok) { const errText = await r.text().catch(() => ''); throw new Error(`OpenAI ${r.status}: ${errText || r.statusText}`); }
    const data = await r.json();
    const text = extractOutputText(data);
    if (!text) throw new Error('Empty output from OpenAI.');
    return text;
  } finally { clearTimeout(t); }
}
function isValidStructured(result) {
  if (!result || typeof result !== 'object') return false;
  return ['has_captcha', 'rejection_reason', 'more_info'].every(k => k in result);
}
async function tryOnce(imagePart, model, tokens) {
  const txt = await callOpenAI(makeBody(imagePart, model, tokens), TIMEOUT_MS);
  const parsed = safeJSONParse(txt);
  if (!isValidStructured(parsed)) throw new Error('Invalid structured output');
  return parsed;
}
async function callVisionFast(imagePart) {
  if (AGGRESSIVE_RACE) {
    const pPrimary = (async () => { try { return await tryOnce(imagePart, MODEL_PRIMARY, PRIMARY_TOKENS); } catch { return await tryOnce(imagePart, MODEL_PRIMARY, RETRY_TOKENS); } })();
    const pFallback = tryOnce(imagePart, MODEL_FALLBACK, RETRY_TOKENS).catch(() => null);
    const winner = await Promise.any([pPrimary, pFallback].map(p => p.catch(() => Promise.reject())));
    return winner;
  } else {
    try { return await tryOnce(imagePart, MODEL_PRIMARY, PRIMARY_TOKENS); }
    catch {
      try { return await tryOnce(imagePart, MODEL_PRIMARY, RETRY_TOKENS); }
      catch { return await tryOnce(imagePart, MODEL_FALLBACK, RETRY_TOKENS); }
    }
  }
}

// ---------- Post-processing & normalization ----------
function extractYouTube(fieldsArray = [], raw = '') {
  for (const kv of fieldsArray) {
    const k = (kv?.key || '').toLowerCase();
    if (k === 'youtube' && typeof kv.value === 'string' && kv.value.trim()) {
      return kv.value.trim();
    }
  }
  const m = raw.match(/(https?:\/\/)?(www\.)?youtube\.com\/@[A-Za-z0-9._\-]+/i);
  return m ? (m[0].replace(/^https?:\/\//i, '').replace(/^www\./i, 'www.')) : null;
}
function firstValidEmail(emailsArr = [], raw = '') {
  const norm = (emailsArr || []).flatMap(s => (String(s || '').match(EMAIL_RX) || []));
  if (norm.length) return norm[0].toLowerCase();
  const fromRaw = (raw || '').match(EMAIL_RX);
  return fromRaw ? fromRaw[0].toLowerCase() : null;
}
function deriveHandleFromMi(mi = {}) {
  for (const h of (mi.handles || [])) {
    const s = String(h || '');
    const m = s.match(HANDLE_IN_TEXT);
    if (m && m[0]) return m[0].toLowerCase();
    const my = s.match(YT_HANDLE_RX);
    if (my && my[1]) return `@${my[1].toLowerCase()}`;
  }
  if (mi.YouTube) {
    const my = String(mi.YouTube).match(YT_HANDLE_RX);
    if (my && my[1]) return `@${my[1].toLowerCase()}`;
  }
  const r = String(mi.raw_text || '').match(HANDLE_IN_TEXT);
  if (r && r[0]) return r[0].toLowerCase();
  const big = [...((mi.fields || []).map(kv => `${kv.key}: ${kv.value}`)), String(mi.raw_text || '')].join('\n');
  let m = big.match(IG_RX); if (m && m[1]) return `@${m[1].toLowerCase()}`;
  m = big.match(TW_RX); if (m && m[1]) return `@${m[1].toLowerCase()}`;
  return null;
}
function shapeForClient(parsed) {
  const has_captcha = !!parsed?.has_captcha;
  const mi = parsed?.more_info || {};
  const cleaned = {
    emails: uniqueSorted(mi.emails || []),
    handles: uniqueSorted(mi.handles || []),
    YouTube: extractYouTube(mi.fields || [], mi.raw_text || '') || null,
    raw_text: mi.raw_text || '',
    fields: mi.fields || []
  };
  const email = firstValidEmail(cleaned.emails, cleaned.raw_text);
  const handle = deriveHandleFromMi({ ...cleaned });
  return {
    has_captcha,
    more_info: { emails: cleaned.emails, handles: cleaned.handles, YouTube: cleaned.YouTube },
    normalized: { email, handle }
  };
}

// ---------- YouTube helpers (NEW) ----------
function normalizeHandle(h) {
  if (!h) return null;
  const t = String(h).trim();
  return t.startsWith('@') ? t : `@${t}`;
}
function handleFromYouTubeUrl(urlOrHost) {
  if (!urlOrHost) return null;
  const m = String(urlOrHost).match(YT_HANDLE_RE);
  return m ? `@${m[1]}` : null;
}
function pickYouTubeHandle(more_info) {
  // Prefer explicit YouTube link; else take the first '@handle' found.
  const fromUrl = handleFromYouTubeUrl(more_info?.YouTube);
  if (fromUrl) return fromUrl;
  const arr = Array.isArray(more_info?.handles) ? more_info.handles : [];
  for (const h of arr) {
    if (typeof h === 'string' && h.trim().startsWith('@')) return h.trim();
  }
  return null;
}
function labelFromWikiUrl(url) {
  try {
    const last = decodeURIComponent(String(url).split('/').pop() || '');
    return last.replace(/_/g, ' ');
  } catch { return url; }
}

async function fetchYouTubeChannelByHandle(ytHandle) {
  if (!YT_API_KEY) throw new Error('Missing YOUTUBE_API_KEY');
  if (!ytHandle) throw new Error('Missing YouTube handle');

  const forHandle = normalizeHandle(ytHandle);
  const params = new URLSearchParams({
    part: 'snippet,statistics,topicDetails',
    forHandle,
    key: YT_API_KEY
  });

  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(new Error('YouTube API timeout')), YT_TIMEOUT_MS);
  try {
    const r = await fetch(`${YT_BASE}?${params.toString()}`, { dispatcher: httpAgent, signal: ac.signal });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      throw new Error(`YouTube API ${r.status}: ${txt || r.statusText}`);
    }
    const data = await r.json();
    const item = data?.items?.[0];
    if (!item) return null;

    const { id: channelId, snippet = {}, statistics = {}, topicDetails = {} } = item;
    const hidden = !!statistics.hiddenSubscriberCount;
    const topicCategories = Array.isArray(topicDetails.topicCategories) ? topicDetails.topicCategories : [];

    return {
      channelId,
      title: snippet.title || '',
      handle: forHandle,
      urlByHandle: `https://www.youtube.com/${forHandle}`,
      urlById: channelId ? `https://www.youtube.com/channel/${channelId}` : null,
      description: snippet.description || '',
      country: snippet.country || null, // "channel location" (country)
      subscriberCount: hidden ? null : Number(statistics.subscriberCount ?? 0),
      videoCount: Number(statistics.videoCount ?? 0),
      viewCount: Number(statistics.viewCount ?? 0),
      topicCategories,
      topicCategoryLabels: topicCategories.map(labelFromWikiUrl),
      fetchedAt: new Date()
    };
  } finally {
    clearTimeout(to);
  }
}

async function enrichYouTubeForContact(more_info, persistResult) {
  // If no API key, skip quietly (non-fatal)
  if (!YT_API_KEY) return { saved: false, message: 'YouTube enrichment skipped: Missing YOUTUBE_API_KEY.' };

  // Decide which doc to update
  const email  = persistResult?.email  ?? (Array.isArray(more_info?.emails)  ? more_info.emails[0]?.toLowerCase()?.trim()  : null);
  const handle = persistResult?.handle ?? (Array.isArray(more_info?.handles) ? more_info.handles[0]?.toLowerCase()?.trim() : null);

  const ytHandle = pickYouTubeHandle(more_info);
  if (!ytHandle) return { saved: false, message: 'No YouTube handle found.' };

  const cacheKey = `yt1|${ytHandle}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const yt = await fetchYouTubeChannelByHandle(ytHandle);
  if (!yt) {
    const out = { saved: false, message: `No YouTube channel found for ${ytHandle}.` };
    cacheSet(cacheKey, out);
    return out;
  }

  // Determine target doc _id
  const id = persistResult?.id || persistResult?.emailId || persistResult?.handleId;
  let targetId = id;
  if (!targetId) {
    const q = email && handle ? { email, handle: normalizeHandle(handle) } : (email ? { email } : (handle ? { handle: normalizeHandle(handle) } : null));
    if (q) {
      const doc = await EmailContact.findOne(q, { _id: 1 }).lean();
      if (doc?._id) targetId = doc._id;
    }
  }
  if (!targetId) {
    const out = { saved: false, message: 'Could not locate a single record to update with YouTube data.', youtube: yt };
    cacheSet(cacheKey, out);
    return out;
  }

  // Save YouTube under youtube subdocument
  await EmailContact.updateOne(
    { _id: targetId },
    { $set: { youtube: yt } },
    { upsert: false }
  );

  const out = { saved: true, id: String(targetId), youtube: yt };
  cacheSet(cacheKey, out);
  return out;
}

// ---------- Persistence (returns outcome so caller can mark errors) ----------
async function persistMoreInfo(normalized, platform, userId) {
  const email = normalized?.email ? normalized.email.toLowerCase().trim() : null;
  const handle = normalized?.handle ? normalized.handle.toLowerCase().trim() : null;

  if (!userId || typeof userId !== 'string' || !userId.trim()) {
    return { outcome: 'invalid', message: 'userId is required.' };
  }
  if (!platform) {
    return { outcome: 'invalid', message: 'Platform is required.' };
  }
  if (!email || !handle || !/^@[A-Za-z0-9._\-]+$/.test(handle)) {
    return { outcome: 'invalid', message: 'No valid email or @handle found under more_info.' };
  }

  // ensure user exists
  const user = await User.findOne({ userId: userId.trim() }).select({ _id: 1, userId: 1 }).lean();
  if (!user) {
    return { outcome: 'invalid', message: 'Invalid userId (no such user).' };
  }

  // Global duplicate checks
  const [byEmail, byHandle] = await Promise.all([
    EmailContact.findOne({ email }).lean(),
    EmailContact.findOne({ handle }).lean()
  ]);

  if (byEmail && byHandle) {
    if (byEmail._id?.toString() === byHandle._id?.toString()) {
      return { outcome: 'duplicate', message: 'User handle and email are already present in the database.', id: byEmail._id, existingUserId: byEmail.userId };
    }
    return { outcome: 'duplicate', message: 'Email and handle already exist (in different records).', emailId: byEmail._id, handleId: byHandle._id, emailUserId: byEmail.userId, handleUserId: byHandle.userId };
  }
  if (byEmail) return { outcome: 'duplicate', message: 'Email is already present in the database.', emailId: byEmail._id, emailUserId: byEmail.userId };
  if (byHandle) return { outcome: 'duplicate', message: 'User handle is already present in the database.', handleId: byHandle._id, handleUserId: byHandle.userId };

  const doc = await EmailContact.create({ email, handle, platform, userId: user.userId });
  return { outcome: 'saved', id: doc._id };
}

// ---------- Batch ONLY (up to 5 images) ----------
exports.extractEmailsAndHandlesBatch=asyncHandler(async (req, res)=> {
  try {
    if (!OPENAI_API_KEY) throw new Error('Missing OPENAI_API_KEY');

    // platform + userId apply to ALL screenshots in this request
    const platform = normalizePlatform(req.body?.platform) || 'other';
    const userId = (req.body?.userId || '').trim();

    const tasks = [];

    // 1) multipart files
    const files = Array.isArray(req.files) ? req.files : [];
    const selectedFiles = files.filter(f => /^image\/(png|jpe?g|webp)$/i.test(f.mimetype || '')).slice(0, 5);

    for (const f of selectedFiles) {
      tasks.push((async () => {
        try {
          const imagePart = await imagePartFromBuffer(f.buffer, f.mimetype);
          const cacheKey = hashString(`p|${f.originalname}|${f.size}|${MODEL_PRIMARY}|${MODEL_FALLBACK}|${PRIMARY_TOKENS}|${RETRY_TOKENS}|${IMAGE_DETAIL}|darkenhance`);
          let shaped = cacheGet(cacheKey);
          if (!shaped) {
            const parsed = await callVisionFast(imagePart);
            shaped = shapeForClient(parsed);
            cacheSet(cacheKey, shaped); // cache ONLY parsed shape
          }

          if (shaped.has_captcha) {
            return { error: 'Captcha detected. Skipping database save.', has_captcha: true };
          }

          const dbRes = await persistMoreInfo(shaped.normalized, platform, userId);

          // Attempt YouTube enrichment for both 'saved' and 'duplicate' outcomes
          let ytRes = null;
          try {
            const persistCtx = {
              id: dbRes?.id,
              emailId: dbRes?.emailId,
              handleId: dbRes?.handleId,
              email: shaped?.normalized?.email || null,
              handle: shaped?.normalized?.handle || null
            };
            ytRes = await enrichYouTubeForContact(shaped.more_info, persistCtx);
          } catch (e) {
            ytRes = { saved: false, message: e?.message || 'YouTube enrichment failed.' };
          }

          if (dbRes.outcome === 'saved') {
            return {
              has_captcha: false,
              platform,
              more_info: shaped.more_info,
              db: { saved: true, id: dbRes.id },
              youtube: ytRes?.youtube || null,
              youtubeSaved: !!ytRes?.saved,
              youtubeMessage: ytRes?.message || null
            };
          } else {
            return {
              error: dbRes.message,
              has_captcha: false,
              platform,
              more_info: shaped.more_info,
              normalized: shaped.normalized,
              details: dbRes,
              youtube: ytRes?.youtube || null,
              youtubeSaved: !!ytRes?.saved,
              youtubeMessage: ytRes?.message || null
            };
          }
        } catch (e) {
          return { error: e?.message || 'Failed to process this image.' };
        }
      })());
    }

    // 2) JSON: imageUrl(s)
    const urls = Array.isArray(req.body?.imageUrl) ? req.body.imageUrl : (req.body?.imageUrls || []);
    if (Array.isArray(urls)) {
      for (const u of urls.slice(0, Math.max(0, 5 - tasks.length))) {
        tasks.push((async () => {
          try {
            const imagePart = imagePartFromUrl(u);
            const cacheKey = hashString(`purl|${u}|${MODEL_PRIMARY}|${MODEL_FALLBACK}|${PRIMARY_TOKENS}|${RETRY_TOKENS}|${IMAGE_DETAIL}|darkenhance`);
            let shaped = cacheGet(cacheKey);
            if (!shaped) {
              const parsed = await callVisionFast(imagePart);
              shaped = shapeForClient(parsed);
              cacheSet(cacheKey, shaped);
            }
            if (shaped.has_captcha) {
              return { error: 'Captcha detected. Skipping database save.', has_captcha: true };
            }
            const dbRes = await persistMoreInfo(shaped.normalized, platform, userId);

            // YouTube enrichment
            let ytRes = null;
            try {
              const persistCtx = {
                id: dbRes?.id,
                emailId: dbRes?.emailId,
                handleId: dbRes?.handleId,
                email: shaped?.normalized?.email || null,
                handle: shaped?.normalized?.handle || null
              };
              ytRes = await enrichYouTubeForContact(shaped.more_info, persistCtx);
            } catch (e) {
              ytRes = { saved: false, message: e?.message || 'YouTube enrichment failed.' };
            }

            if (dbRes.outcome === 'saved') {
              return {
                has_captcha: false,
                platform,
                more_info: shaped.more_info,
                db: { saved: true, id: dbRes.id },
                youtube: ytRes?.youtube || null,
                youtubeSaved: !!ytRes?.saved,
                youtubeMessage: ytRes?.message || null
              };
            } else {
              return {
                error: dbRes.message,
                has_captcha: false,
                platform,
                more_info: shaped.more_info,
                normalized: shaped.normalized,
                details: dbRes,
                youtube: ytRes?.youtube || null,
                youtubeSaved: !!ytRes?.saved,
                youtubeMessage: ytRes?.message || null
              };
            }
          } catch (e) {
            return { error: e?.message || 'Failed to process this image URL.' };
          }
        })());
      }
    }

    // 3) JSON: imagePath(s)
    const paths = Array.isArray(req.body?.imagePath) ? req.body.imagePath : (req.body?.imagePaths || []);
    if (Array.isArray(paths)) {
      for (const pth of paths.slice(0, Math.max(0, 5 - tasks.length))) {
        tasks.push((async () => {
          try {
            const imagePart = await imagePartFromPath(path.resolve(String(pth)));
            const cacheKey = hashString(`ppath|${pth}|${MODEL_PRIMARY}|${MODEL_FALLBACK}|${PRIMARY_TOKENS}|${RETRY_TOKENS}|${IMAGE_DETAIL}|darkenhance`);
            let shaped = cacheGet(cacheKey);
            if (!shaped) {
              const parsed = await callVisionFast(imagePart);
              shaped = shapeForClient(parsed);
              cacheSet(cacheKey, shaped);
            }
            if (shaped.has_captcha) {
              return { error: 'Captcha detected. Skipping database save.', has_captcha: true };
            }
            const dbRes = await persistMoreInfo(shaped.normalized, platform, userId);

            // YouTube enrichment
            let ytRes = null;
            try {
              const persistCtx = {
                id: dbRes?.id,
                emailId: dbRes?.emailId,
                handleId: dbRes?.handleId,
                email: shaped?.normalized?.email || null,
                handle: shaped?.normalized?.handle || null
              };
              ytRes = await enrichYouTubeForContact(shaped.more_info, persistCtx);
            } catch (e) {
              ytRes = { saved: false, message: e?.message || 'YouTube enrichment failed.' };
            }

            if (dbRes.outcome === 'saved') {
              return {
                has_captcha: false,
                platform,
                more_info: shaped.more_info,
                db: { saved: true, id: dbRes.id },
                youtube: ytRes?.youtube || null,
                youtubeSaved: !!ytRes?.saved,
                youtubeMessage: ytRes?.message || null
              };
            } else {
              return {
                error: dbRes.message,
                has_captcha: false,
                platform,
                more_info: shaped.more_info,
                normalized: shaped.normalized,
                details: dbRes,
                youtube: ytRes?.youtube || null,
                youtubeSaved: !!ytRes?.saved,
                youtubeMessage: ytRes?.message || null
              };
            }
          } catch (e) {
            return { error: e?.message || 'Failed to process this image path.' };
          }
        })());
      }
    }

    if (tasks.length === 0) {
      return res.status(400).json({ status: 'error', message: 'Provide up to 5 images via multipart (PNG/JPG/WEBP) or arrays imageUrls/imagePaths.' });
    }

    const results = await Promise.all(tasks);
    return res.json({ results });

  } catch (err) {
    console.error('extractEmailsAndHandlesBatch error:', err);
    return res.status(400).json({ status: 'error', message: err?.message || 'Batch processing failed.' });
  }
});


// ---------- POST /email/all (single search; returns only email, handle, platform) ----------
exports.getAllEmailContacts=asyncHandler(async (req, res)=> {
  try {
    const body = req.body || {};

    // --- tiny local fallback in case escapeRegex isn't in scope ---
    const _escapeRegex = (typeof escapeRegex === 'function')
      ? escapeRegex
      : (str = '') => String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    // --- Pagination (50/page default) ---
    const page = Math.max(1, parseInt(body.page ?? '1', 10));
    const limit = Math.min(50, Math.max(1, parseInt(body.limit ?? '50', 10)));

    // --- Filters ---
    const userId = typeof body.userId === 'string' ? body.userId.trim() : '';
    const search = typeof body.search === 'string' ? body.search.trim() : '';

    // --- Export knobs ---
    const exportType = (body.exportType || '').toLowerCase();         // 'csv' | 'xlsx' | ''
    const exportAll = String(body.exportAll ?? 'false').toLowerCase() === 'true';

    // Which fields to export (and also return for JSON list)
    // Add 'youtube' to the default visible fields
    const defaultFields = ['email', 'handle', 'platform', 'userId', 'createdAt', 'youtube'];

    // Allow explicit dot-path selection for YouTube subfields
    const YT_ALLOWED_DOT_FIELDS = [
      'youtube.channelId',
      'youtube.title',
      'youtube.handle',
      'youtube.urlByHandle',
      'youtube.urlById',
      'youtube.description',
      'youtube.country',
      'youtube.subscriberCount',
      'youtube.videoCount',
      'youtube.viewCount',
      'youtube.topicCategories',
      'youtube.topicCategoryLabels',
      'youtube.fetchedAt'
    ];

    // When user simply asks for "youtube", expand to these for CSV/XLSX
    const YT_EXPORT_DEFAULTS = [
      'youtube.channelId',
      'youtube.title',
      'youtube.handle',
      'youtube.urlByHandle',
      'youtube.urlById',
      'youtube.country',
      'youtube.subscriberCount',
      'youtube.videoCount',
      'youtube.viewCount',
      'youtube.fetchedAt'
    ];

    const allowed = new Set([...defaultFields, ...YT_ALLOWED_DOT_FIELDS]);

    // Parse requested fields
    let fields = Array.isArray(body.fields) && body.fields.length
      ? body.fields.filter(f => allowed.has(f))
      : defaultFields.slice();

    // If user passed only invalid fields, fall back to default
    if (!fields.length) fields = defaultFields.slice();

    // --- Query ---
    const query = {};
    if (userId) query.userId = userId;

    if (search) {
      const needleRaw = search;
      const needleNoAt = search.startsWith('@') ? search.slice(1) : search;

      const rxRaw = _escapeRegex(needleRaw);
      const rxNoAt = _escapeRegex(needleNoAt);

      query.$or = [
        { email: { $regex: rxNoAt, $options: 'i' } },
        { handle: { $regex: rxRaw.startsWith('@') ? rxRaw : `@${rxNoAt}`, $options: 'i' } },
        { platform: { $regex: rxNoAt, $options: 'i' } }
      ];
    }

    // --- Projection (include youtube whenever needed) ---
    const projection = { _id: 0 };
    const needsYouTube =
      fields.includes('youtube') || fields.some(f => f.startsWith('youtube.'));
    for (const f of fields) {
      if (f === 'youtube' || f.startsWith('youtube.')) {
        projection.youtube = 1; // select whole subdocument (simpler & future-proof)
      } else {
        projection[f] = 1;
      }
    }

    // If exporting ALL, pull more rows (set a safety cap)
    const EXPORT_CAP = 100_000;

    // --- Count for pagination / export metadata ---
    const total = await EmailContact.countDocuments(query);

    // Helper to get deep value from doc (for export flattening)
    const getDeep = (obj, path) => {
      try {
        return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
      } catch {
        return undefined;
      }
    };
    const asCell = (v) => {
      if (v == null) return '';
      if (Array.isArray(v)) return v.join('; ');
      if (v instanceof Date) return v.toISOString();
      return String(v);
    };

    // If exporting, prepare rows
    if (exportType === 'csv' || exportType === 'xlsx') {
      // Decide actual export fields: expand 'youtube' to defaults if no specific youtube.* present
      const hasYoutubeWildcard = fields.includes('youtube');
      const hasYoutubeDot = fields.some(f => f.startsWith('youtube.'));
      const ytExpanded = hasYoutubeWildcard && !hasYoutubeDot ? YT_EXPORT_DEFAULTS : fields.filter(f => f.startsWith('youtube.'));

      // Keep non-youtube fields in order, then append explicit/expanded youtube columns
      const nonYTFields = fields.filter(f => f !== 'youtube' && !f.startsWith('youtube.'));
      const exportFields = [...nonYTFields, ...ytExpanded];

      // Fetch docs
      let docs = [];
      if (exportAll) {
        const toFetch = Math.min(total, EXPORT_CAP);
        docs = await EmailContact.find(query)
          .sort({ createdAt: -1 })
          .limit(toFetch)
          .select(projection)
          .lean();
      } else {
        docs = await EmailContact.find(query)
          .sort({ createdAt: -1 })
          .skip((page - 1) * limit)
          .limit(limit)
          .select(projection)
          .lean();
      }

      // Normalize rows (ensure field order; flatten youtube)
      const rows = docs.map(d => {
        const out = {};
        for (const f of exportFields) {
          out[f] = asCell(f.startsWith('youtube.') ? getDeep(d, f) : d[f]);
        }
        return out;
      });

      // filename stamp
      const ts = new Date();
      const y = String(ts.getFullYear());
      const m = String(ts.getMonth() + 1).padStart(2, '0');
      const dd = String(ts.getDate()).padStart(2, '0');
      const hh = String(ts.getHours()).padStart(2, '0');
      const mm = String(ts.getMinutes()).padStart(2, '0');
      const ss = String(ts.getSeconds()).padStart(2, '0');
      const stamp = `${y}${m}${dd}_${hh}${mm}${ss}`;

      if (exportType === 'csv') {
        // Build CSV manually (no extra deps)
        const esc = (v) => {
          const s = String(v ?? '');
          return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        };
        const header = exportFields.map(esc).join(',');
        const lines = rows.map(r => exportFields.map(f => esc(r[f])).join(','));
        const csv = [header, ...lines].join('\n');

        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="contacts_${stamp}.csv"`);
        return res.status(200).send(csv);
      }

      if (exportType === 'xlsx') {
        const ExcelJS = require('exceljs'); // npm i exceljs
        const wb = new ExcelJS.Workbook();
        const ws = wb.addWorksheet('Contacts');

        ws.columns = exportFields.map(f => ({ header: f, key: f, width: Math.max(12, f.length + 2) }));
        ws.addRows(rows);

        const buffer = await wb.xlsx.writeBuffer();
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="contacts_${stamp}.xlsx"`);
        return res.status(200).send(Buffer.from(buffer));
      }
    }

    // --- Regular JSON listing (paginated) ---
    const items = await EmailContact.find(query)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .select(projection)
      .lean();

    // Result: keep structure as-is; youtube stays nested if selected
    // (By default, 'youtube' is included via defaultFields.)
    return res.json({
      page,
      limit,
      total,
      hasNext: page * limit < total,
      data: items
    });
  } catch (err) {
    console.error('getAllEmailContacts error:', err);
    return res.status(400).json({ status: 'error', message: err?.message || 'Failed to fetch contacts.' });
  }
});


// ---------- NEW: POST /email/by-user  (list contacts by userId) ----------
exports.getContactsByUser=asyncHandler(async (req, res)=> {
  try {
    const body = req.body || {};
    const userId = (body.userId || '').trim();
    if (!userId) return res.status(400).json({ status: 'error', message: 'userId is required.' });

    const page = Math.max(1, parseInt(body.page ?? '1', 10));
    const limit = Math.min(200, Math.max(1, parseInt(body.limit ?? '50', 10)));
    const search = typeof body.search === 'string' ? body.search.trim() : '';

    const query = { userId };

    if (search) {
      const needleRaw = search;
      const needleNoAt = search.startsWith('@') ? search.slice(1) : search;

      const rxRaw = escapeRegex(needleRaw);
      const rxNoAt = escapeRegex(needleNoAt);

      query.$or = [
        { email: { $regex: rxNoAt, $options: 'i' } },
        { handle: { $regex: rxRaw.startsWith('@') ? rxRaw : `@${rxNoAt}`, $options: 'i' } },
        { platform: { $regex: rxNoAt, $options: 'i' } }
      ];
    }

    const [items, total] = await Promise.all([
      EmailContact.find(query)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .select({ email: 1, handle: 1, platform: 1, createdAt: 1, _id: 0 })
        .lean(),
      EmailContact.countDocuments(query)
    ]);

    return res.json({
      userId,
      page,
      limit,
      total,
      hasNext: page * limit < total,
      data: items
    });
  } catch (err) {
    console.error('getContactsByUser error:', err);
    return res.status(400).json({ status: 'error', message: err?.message || 'Failed to fetch user contacts.' });
  }
});

// ---------- NEW: POST /email/list-by-employee (summaries per user; search by username; optional user detail) ----------
exports.getUserSummariesByEmployee=asyncHandler(async (req, res)=> {
  try {
    const body = req.body || {};
    const employeeId = (body.employeeId || '').trim();
    if (!employeeId) {
      return res.status(400).json({ status: 'error', message: 'employeeId is required.' });
    }

    // Pagination for the users list
    const page = Math.max(1, parseInt(body.page ?? '1', 10));
    const limit = Math.min(200, Math.max(1, parseInt(body.limit ?? '50', 10)));

    // Optional username search (User.name)
    const search = typeof body.search === 'string' ? body.search.trim() : '';

    // Optional cap on how many contact rows to include per user in influencerDetails
    const detailsLimit = Math.min(5000, Math.max(1, parseInt(body.detailsLimit ?? '1000', 10)));

    // 1) Find users under this employee (with optional username search)
    const userQuery = { worksUnder: employeeId };
    if (search) {
      userQuery.name = { $regex: escapeRegex(search), $options: 'i' };
    }

    const [totalUsers, users] = await Promise.all([
      User.countDocuments(userQuery),
      User.find(userQuery)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .select({ userId: 1, name: 1, _id: 0 })
        .lean()
    ]);

    const userIds = users.map(u => u.userId);

    // 2) Pull ALL contacts (email, handle, platform, createdAt) from EmailContact for these userIds
    let contactsByUser = new Map();
    if (userIds.length) {
      const contacts = await EmailContact.find({ userId: { $in: userIds } })
        .select({ userId: 1, email: 1, handle: 1, platform: 1, createdAt: 1, _id: 0 })
        .sort({ createdAt: -1 }) // newest first
        .lean();

      // group by userId and optionally limit per user
      contactsByUser = contacts.reduce((map, c) => {
        const list = map.get(c.userId) || [];
        if (list.length < detailsLimit) {
          list.push({
            email: c.email,
            handle: c.handle,
            platform: c.platform,
            createdAt: c.createdAt
          });
        }
        map.set(c.userId, list);
        return map;
      }, new Map());
    }

    // 3) Build response per user with influencerDetails (replaces previous "platforms" counts)
    const items = users.map(u => {
      const list = contactsByUser.get(u.userId) || [];

      // compute first/last based on the full (unlimited) set if needed
      // here we only have the limited list; still provide min/max from that list
      let firstSavedAt = null;
      let lastSavedAt = null;
      if (list.length) {
        // list is newest-first sorted
        lastSavedAt = list[list.length - 1].createdAt || null; // oldest in the limited slice
        firstSavedAt = list[0].createdAt || null;               // newest in the limited slice
      }

      return {
        userId: u.userId,
        name: u.name,
        total: list.length,            // number of contacts included in influencerDetails (capped by detailsLimit)
        firstSavedAt,
        lastSavedAt,
        influencerDetails: list        // [{ email, handle, platform, createdAt }, ...]
      };
    });

    return res.json({
      employeeId,
      page,
      limit,
      totalUsers,
      hasNext: page * limit < totalUsers,
      data: items
    });
  } catch (err) {
    console.error('getUserSummariesByEmployee error:', err);
    return res.status(400).json({ status: 'error', message: err?.message || 'Failed to fetch employee summaries.' });
  }
});

// ---------- NEW (ADMIN): POST /admin/employee-overview (search employees by name; include team + collected data) ----------
// ---------- UPDATED (ADMIN): POST /admin/employee-overview ----------
exports.getEmployeeOverviewAdmin=asyncHandler(async (req, res)=> {
  try {
    const body = req.body || {};

    // Local fallback if escapeRegex isn't globally available
    const _escapeRegex = (typeof escapeRegex === 'function')
      ? escapeRegex
      : (str = '') => String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    // Search by employee name (empty = all)
    const search = typeof body.search === 'string' ? body.search.trim() : '';

    // Pagination over employees
    const page = Math.max(1, parseInt(body.page ?? '1', 10));
    const limit = Math.min(200, Math.max(1, parseInt(body.limit ?? '50', 10)));

    // Per-collector cap
    const detailsLimit = Math.min(5000, Math.max(1, parseInt(body.detailsLimit ?? '1000', 10)));

    // 1) Find employees by name (with pagination)
    const employeeQuery = {};
    if (search) {
      employeeQuery.name = { $regex: _escapeRegex(search), $options: 'i' };
    }

    const [totalEmployees, employees] = await Promise.all([
      Employee.countDocuments(employeeQuery),
      Employee.find(employeeQuery)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .select({ employeeId: 1, name: 1, email: 1, createdAt: 1, _id: 0 })
        .lean()
    ]);

    if (!employees.length) {
      return res.json({
        page, limit, totalEmployees, hasNext: false,
        detailsLimit,
        data: []
      });
    }

    // 2) Get all users who work under any of these employees
    const employeeIds = employees.map(e => e.employeeId);
    const users = await User.find({ worksUnder: { $in: employeeIds } })
      .select({ userId: 1, name: 1, worksUnder: 1, createdAt: 1, _id: 0 })
      .lean();

    // Group users by the employee they work under
    const usersByEmployee = users.reduce((map, u) => {
      const list = map.get(u.worksUnder) || [];
      list.push(u);
      map.set(u.worksUnder, list);
      return map;
    }, new Map());

    // 3) Pull all EmailContact rows for all these users in one query
    const collectorUserIds = users.map(u => u.userId);
    let contacts = [];
    if (collectorUserIds.length) {
      contacts = await EmailContact.find({ userId: { $in: collectorUserIds } })
        .select({
          userId: 1,
          email: 1,
          handle: 1,
          platform: 1,
          createdAt: 1,
          youtube: 1,             // include full YouTube subdoc
          _id: 0
        })
        .sort({ createdAt: -1 }) // newest first
        .lean();
    }

    // Helper: include description + categories for admin view
    const summarizeYouTube = (yt) => {
      if (!yt) return undefined;
      return {
        channelId: yt.channelId || null,
        title: yt.title || null,
        handle: yt.handle || null,
        urlByHandle: yt.urlByHandle || null,
        urlById: yt.urlById || null,
        country: yt.country || null,
        subscriberCount: yt.subscriberCount ?? null,
        videoCount: yt.videoCount ?? null,
        viewCount: yt.viewCount ?? null,
        description: yt.description || null, // <--- added
        topicCategories: Array.isArray(yt.topicCategories) ? yt.topicCategories : [], // <--- added
        topicCategoryLabels: Array.isArray(yt.topicCategoryLabels) ? yt.topicCategoryLabels : [], // <--- added
        fetchedAt: yt.fetchedAt || null
      };
    };

    // 4) Group contacts by collector (userId), keep total + limited slice
    const contactsByUser = new Map();   // userId -> limited items
    const countsByUser = new Map();     // userId -> total count
    if (contacts.length) {
      const grouped = contacts.reduce((m, c) => {
        const list = m.get(c.userId) || [];
        list.push(c);
        m.set(c.userId, list);
        return m;
      }, new Map());

      for (const [uid, list] of grouped.entries()) {
        countsByUser.set(uid, list.length);
        const limited = list.slice(0, detailsLimit).map(row => ({
          email: row.email,
          handle: row.handle,
          platform: row.platform,
          createdAt: row.createdAt,
          youtube: summarizeYouTube(row.youtube)  // includes desc + categories
        }));
        contactsByUser.set(uid, limited);
      }
    }

    // 5) Build response: employee -> collectors[] -> dataCollected[]
    //    - hide collectors with empty dataCollected
    //    - drop employees with no collectors after the filter
    const items = employees.map(emp => {
      const team = usersByEmployee.get(emp.employeeId) || [];

      // Build & filter collectors (only with non-empty dataCollected)
      const collectorsAll = team.map(u => ({
        username: u.name,
        userId: u.userId,
        totalCollected: countsByUser.get(u.userId) || 0,
        dataCollected: contactsByUser.get(u.userId) || []
      }));

      const collectors = collectorsAll.filter(c => Array.isArray(c.dataCollected) && c.dataCollected.length > 0);

      // Roll-up metrics using only visible collectors
      const contactsTotal = collectors.reduce((a, c) => a + (c.totalCollected || 0), 0);

      return {
        employeeName: emp.name,
        employeeId: emp.employeeId,
        employeeEmail: emp.email,
        teamCounts: { members: collectors.length, contactsTotal },
        collectors
      };
    })
    // remove employees with no visible collectors
    .filter(empBlock => empBlock.collectors && empBlock.collectors.length > 0);

    return res.json({
      page,
      limit,
      totalEmployees, // total employees *before* filtering; keep for UI context
      hasNext: page * limit < totalEmployees,
      detailsLimit,
      search,
      data: items
    });
  } catch (err) {
    console.error('getEmployeeOverviewAdmin error:', err);
    return res.status(400).json({ status: 'error', message: err?.message || 'Failed to fetch admin employee overview.' });
  }
});


// Controller
exports.checkStatus = asyncHandler(async (req, res) => {
  try {
    const rawHandle   = (req.body?.handle ?? '').trim();
    const rawPlatform = (req.body?.platform ?? '').trim();

    if (!rawHandle)   return res.status(400).json({ status: 'error', message: 'handle is required' });
    if (!rawPlatform) return res.status(400).json({ status: 'error', message: 'platform is required' });

    // normalize to lowercase @handle
    const handle = (rawHandle.startsWith('@') ? rawHandle : `@${rawHandle}`).toLowerCase();

    // same validation pattern as your schema
    const HANDLE_RX = /^@[A-Za-z0-9._\-]+$/;
    if (!HANDLE_RX.test(handle)) {
      return res.status(400).json({ status: 'error', message: 'Invalid handle format' });
    }

    // normalize platform (accept common aliases)
    const PLATFORM_MAP = new Map([
      ['youtube', 'youtube'], ['yt', 'youtube'],
      ['instagram', 'instagram'], ['ig', 'instagram'],
      ['tiktok', 'tiktok'], ['tt', 'tiktok']
    ]);
    const platformKey = rawPlatform.toLowerCase();
    const platform = PLATFORM_MAP.get(platformKey);

    if (!platform) {
      return res.status(400).json({
        status: 'error',
        message: 'Invalid platform. Use: youtube|instagram|twitter|tiktok|facebook|other (or aliases: yt, ig, x, tt, fb)'
      });
    }

    // existence check for the (handle, platform) pair
    const exists = await EmailContact.exists({ handle, platform });

    return res.json({ status: exists ? 1 : 0 });
  } catch (err) {
    console.error('checkStatus error:', err);
    return res.status(400).json({ status: 'error', message: err?.message || 'Failed to check handle.' });
  }
});
