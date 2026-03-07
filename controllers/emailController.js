// controllers/emailController.js
'use strict';

require('dotenv').config();

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const mongoose = require('mongoose');
const { fetch, Agent } = require('undici');

const asyncHandler = (fn) => (req, res, next) => fn(req, res, next).catch(next);

const Employee = require('../models/Employee');
const EmailContact = require('../models/email');
const User = require('../models/User');
const EmailTask = require('../models/EmailTask');

const { fetchInfluencerMeta } = require('../services/influencerMeta');

// ======================================================
// Task Filters: Followers + Country + Category
// ======================================================
const MIN_FOLLOWERS = 1000;
const MAX_FOLLOWERS = 10_000_000;

function isAnyToken(x) {
  const s = String(x || '').trim().toLowerCase();
  return s === 'any' || s === 'any country' || s === 'any category';
}

// returns ONLY specific values; if none => means "ANY"
function effectiveSpecificList(list) {
  const arr = Array.isArray(list) ? list : [];
  const cleaned = arr.map((v) => String(v || '').trim()).filter(Boolean);
  const specific = cleaned.filter((v) => !isAnyToken(v));
  return specific; // [] means ANY
}

function normalizeCountry(v) {
  return String(v || '').trim().toUpperCase();
}

function normalizeCategory(v) {
  return String(v || '').trim().toLowerCase();
}

function matchesCategory(taskCategories = [], influencerCategories = []) {
  const specific = effectiveSpecificList(taskCategories).map(normalizeCategory);
  if (!specific.length) return true; // ANY

  const want = new Set(specific);
  const got = new Set((influencerCategories || []).map(normalizeCategory));

  for (const c of want) {
    if (got.has(c)) return true;
  }
  return false;
}

function taskError(code, message, details = {}) {
  const err = new Error(message);
  err.status = 400;
  err.code = code;
  err.details = details;
  return err;
}

function ensureTaskFilters(task, meta) {
  if (!task) return;

  // 1) Followers
  const minF = Math.max(
    MIN_FOLLOWERS,
    Math.min(MAX_FOLLOWERS, Number(task.minFollowers ?? MIN_FOLLOWERS))
  );
  const maxF = Math.max(
    MIN_FOLLOWERS,
    Math.min(MAX_FOLLOWERS, Number(task.maxFollowers ?? MAX_FOLLOWERS))
  );

  const count = Number(meta?.followerCount);
  if (!Number.isFinite(count) || count < minF || count > maxF) {
    throw taskError(
      'FOLLOWERS_MISMATCH',
      "Sorry, your screenshot uploaded doesn't match the required follower range.",
      { expected: { min: minF, max: maxF }, got: count }
    );
  }

  // 2) Country
  const wantCountries = effectiveSpecificList(task.countries).map(normalizeCountry);
  if (wantCountries.length) {
    const want = new Set(wantCountries);
    const got = normalizeCountry(meta?.country);

    if (!got || !want.has(got)) {
      throw taskError(
        'COUNTRY_MISMATCH',
        "Sorry, your screenshot uploaded doesn't match the task country.",
        { expected: wantCountries, got }
      );
    }
  }

  // 3) Category
  if (!matchesCategory(task.categories, meta?.categories || [])) {
    throw taskError(
      'CATEGORY_MISMATCH',
      "Sorry, your screenshot uploaded doesn't match the task category.",
      { expected: task.categories, got: meta?.categories || [] }
    );
  }
}

// ======================================================
// HTTP Agent
// ======================================================
const httpAgent = new Agent({
  keepAliveTimeout: Number(process.env.KEEP_ALIVE_SECONDS || 60) * 1000,
  keepAliveMaxTimeout: Number(process.env.KEEP_ALIVE_SECONDS || 60) * 1000,
});

// ======================================================
// Optional Image Enhance (sharp)
// ======================================================
const USE_SHARP = process.env.USE_SHARP !== '0';
let sharp = null;
if (USE_SHARP) {
  try {
    sharp = require('sharp');
  } catch {
    // ignore
  }
}

// Optional JSON repair
let jsonrepairFn = null;
try {
  jsonrepairFn = require('jsonrepair').jsonrepair || require('jsonrepair');
} catch {
  // ignore
}

// ======================================================
// OpenAI Config
// ======================================================
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const MODEL_PRIMARY =
  process.env.OPENAI_MODEL_PRIMARY ||
  process.env.OPENAI_VISION_MODEL ||
  process.env.OPENAI_VISION_PRIMARY ||
  'gpt-5';

const MODEL_FALLBACK =
  process.env.OPENAI_MODEL_FALLBACK ||
  process.env.OPENAI_VISION_FALLBACK ||
  'gpt-5-mini';

const MODEL_PRIMARY_SNAPSHOT = process.env.OPENAI_MODEL_SNAPSHOT_PRIMARY || '';
const MODEL_FALLBACK_SNAPSHOT = process.env.OPENAI_MODEL_SNAPSHOT_FALLBACK || '';

function resolveModel(name, snapshot) {
  if (/-\d{4}-\d{2}-\d{2}$/.test(name)) return name;
  return snapshot ? `${name}-${snapshot}` : name;
}

const RESOLVED_MODEL_PRIMARY = resolveModel(MODEL_PRIMARY, MODEL_PRIMARY_SNAPSHOT);
const RESOLVED_MODEL_FALLBACK = resolveModel(MODEL_FALLBACK, MODEL_FALLBACK_SNAPSHOT);

const PRIMARY_TOKENS = Number(process.env.PRIMARY_TOKENS || 320);
const RETRY_TOKENS = Number(process.env.RETRY_TOKENS || 900);

const TIMEOUT_MS = Number(process.env.OPENAI_TIMEOUT_MS || 30000);

const MAX_IMG_W = Number(process.env.MAX_IMAGE_WIDTH || 1280);
const MAX_IMG_H = Number(process.env.MAX_IMAGE_HEIGHT || 1280);
const IMAGE_DETAIL = process.env.IMAGE_DETAIL || 'auto';

// caching & behavior toggles
const ENABLE_CACHE = process.env.ENABLE_CACHE !== '0';
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 5 * 60_000);
const AGGRESSIVE_RACE = process.env.AGGRESSIVE_RACE === '1';

// ======================================================
// YouTube API (for enrichment only)
// ======================================================
const YT_API_KEY = process.env.YOUTUBE_API_KEY;
const YT_TIMEOUT_MS = Number(process.env.YOUTUBE_TIMEOUT_MS || 12000);
const YT_BASE = 'https://www.googleapis.com/youtube/v3/channels';

// ======================================================
// Regex / Helpers
// ======================================================
const EMAIL_RX = /[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g;
const HANDLE_IN_TEXT = /@[A-Za-z0-9._\-]+/g;
const YT_HANDLE_RX = /\/@([A-Za-z0-9._\-]+)/i;
const YT_HANDLE_RE = /@([A-Za-z0-9._\-]+)/i;
const IG_RX = /(?:instagram\.com|ig\.me)\/([A-Za-z0-9._\-]+)/i;
const TW_RX = /(?:twitter\.com|x\.com)\/([A-Za-z0-9._\-]+)/i;

const CONTACT_ALLOWED_SORT = new Set(['createdAt', 'email', 'handle', 'platform', 'userId']);

const PLATFORM_MAP = new Map([
  ['youtube', 'youtube'],
  ['yt', 'youtube'],
  ['instagram', 'instagram'],
  ['ig', 'instagram'],
  ['twitter', 'twitter'],
  ['x', 'twitter'],
  ['tiktok', 'tiktok'],
  ['tt', 'tiktok'],
  ['facebook', 'facebook'],
  ['fb', 'facebook'],
  ['other', 'other'],
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

function contactParseSort(sortBy = 'createdAt', sortOrder = 'desc') {
  const field = CONTACT_ALLOWED_SORT.has(sortBy) ? sortBy : 'createdAt';
  const order = String(sortOrder).toLowerCase() === 'asc' ? 1 : -1;
  return { [field]: order };
}

function contactParsePageLimit(page = 1, limit = 20, maxLimit = 100) {
  const p = Math.max(1, Number(page) || 1);
  const l = Math.min(maxLimit, Math.max(1, Number(limit) || 20));
  const skip = (p - 1) * l;
  return { p, l, skip };
}

function uniqueSorted(arr = []) {
  const seen = new Set();
  const out = [];
  for (const s of arr) {
    const k = (s || '').trim();
    if (!k) continue;
    const low = k.toLowerCase();
    if (!seen.has(low)) {
      seen.add(low);
      out.push(k);
    }
  }
  return out;
}

function hashString(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

function now() {
  return Date.now();
}

// cache ONLY parsed output / meta (never DB results)
const CACHE = new Map();

function cacheGet(key) {
  if (!ENABLE_CACHE) return null;
  const v = CACHE.get(key);
  if (!v) return null;
  if (now() - v.ts > CACHE_TTL_MS) {
    CACHE.delete(key);
    return null;
  }
  return v.data;
}

function cacheSet(key, data) {
  if (!ENABLE_CACHE) return;
  CACHE.set(key, { ts: now(), data });
  if (CACHE.size > 500) {
    for (const k of CACHE.keys()) {
      CACHE.delete(k);
      if (CACHE.size <= 400) break;
    }
  }
}

function validOnlyFilter(extra = {}) {
  return { isValid: { $ne: false }, ...extra };
}

// ======================================================
// OpenAI Vision JSON schema
// ======================================================
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
        properties: {
          key: { type: 'string' },
          value: { type: 'string' },
        },
        required: ['key', 'value'],
      },
    },
    raw_text: { type: 'string' },
  },
  required: ['emails', 'handles', 'fields', 'raw_text'],
};

const RESPONSE_SCHEMA = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      has_captcha: { type: 'boolean' },
      rejection_reason: { type: ['string', 'null'] },
      more_info: SECTION_SCHEMA,
    },
    required: ['has_captcha', 'rejection_reason', 'more_info'],
  },
};

const SYSTEM_MSG =
  'You extract text from a screenshot of a YouTube channel “About” popover and return strict JSON. ' +
  'If a visible reCAPTCHA checkbox (“I’m not a robot” with the reCAPTCHA logo) exists: set has_captcha=true and a brief rejection_reason. ' +
  'Otherwise: only include the content under the “More info” heading, in a `more_info` object with emails, handles, fields, raw_text. ' +
  'Return JSON only. In `handles`, include ONLY plain handles that start with "@" (no URLs). Lowercase is fine.';

const USER_INSTRUCTIONS =
  'Return only JSON. If the “More info” section is not present, set `more_info` to empty arrays/strings (no fallback to any other section).';

// ======================================================
// Image preprocessing
// ======================================================
async function enhanceIfDark(buffer) {
  const darkEnhanceOn = process.env.ENABLE_DARK_ENHANCE !== '0';
  if (!sharp || !darkEnhanceOn) return buffer;

  try {
    const img = sharp(buffer, { failOn: 'none' });
    const stats = await img.stats();
    const means = stats.channels.slice(0, 3).map((c) => c.mean || 0);
    const avg = means.reduce((a, b) => a + b, 0) / (means.length || 1);

    if (avg < 85) {
      return await sharp(buffer)
        .modulate({ brightness: 1.35, saturation: 1.08 })
        .gamma(1.05)
        .toBuffer();
    }
    return buffer;
  } catch {
    return buffer;
  }
}

async function preprocessImage(buffer, mime) {
  if (!sharp) return buffer;

  try {
    let img = sharp(buffer, { failOn: 'none' });
    const meta = await img.metadata();
    const w = meta.width || 0;
    const h = meta.height || 0;

    if (w > MAX_IMG_W || h > MAX_IMG_H) {
      img = img.resize({
        width: MAX_IMG_W,
        height: MAX_IMG_H,
        fit: 'inside',
        withoutEnlargement: true,
      });
    }

    const buf = await (mime.includes('png')
      ? img.png({ compressionLevel: 6 })
      : img.jpeg({ quality: 80 })
    ).toBuffer();

    return await enhanceIfDark(buf);
  } catch {
    return await enhanceIfDark(buffer);
  }
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
  return {
    type: 'input_image',
    image_url: {
      url: String(url),
      ...(IMAGE_DETAIL ? { detail: IMAGE_DETAIL } : {}),
    },
  };
}

// ======================================================
// OpenAI helpers
// ======================================================
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

  if (typeof data?.output_text === 'string' && data.output_text.trim()) {
    return data.output_text;
  }

  if (Array.isArray(data?.choices)) {
    const content = data.choices[0]?.message?.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return content.map((p) => p?.text || '').join('\n').trim();
  }

  return '';
}

function safeJSONParse(input) {
  if (input && typeof input === 'object') return input;
  if (typeof input !== 'string') throw new Error('Expected JSON string');

  let t = input.trim();
  t = t
    .replace(/```(?:json)?/gi, '')
    .replace(/```/g, '')
    .replace(/^\uFEFF/, '')
    .replace(/[\u200B-\u200D\u2060]/g, '')
    .trim();

  const first = t.indexOf('{');
  const last = t.lastIndexOf('}');
  if (first !== -1 && last !== -1 && first < last) {
    t = t.slice(first, last + 1);
  }

  t = t
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/,\s*([}\]])/g, '$1');

  try {
    return JSON.parse(t);
  } catch {
    if (jsonrepairFn) return JSON.parse(jsonrepairFn(t));
    throw new Error(`Invalid JSON after repair attempts. Preview: ${t.slice(0, 200)}...`);
  }
}

function makeBody(imagePart, model, maxTokens) {
  return {
    model,
    input: [
      { role: 'system', content: [{ type: 'input_text', text: SYSTEM_MSG }] },
      { role: 'user', content: [{ type: 'input_text', text: USER_INSTRUCTIONS }, imagePart] },
    ],
    text: {
      format: {
        type: 'json_schema',
        name: 'YouTubeAboutExtraction',
        schema: RESPONSE_SCHEMA.schema,
        strict: true,
      },
    },
    max_output_tokens: maxTokens,
  };
}

async function callOpenAI(body, timeoutMs) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(new Error('OpenAI timeout')), timeoutMs);

  try {
    const r = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      dispatcher: httpAgent,
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: ac.signal,
    });

    if (!r.ok) {
      const errText = await r.text().catch(() => '');
      throw new Error(`OpenAI ${r.status}: ${errText || r.statusText}`);
    }

    const data = await r.json();
    const text = extractOutputText(data);
    if (!text) throw new Error('Empty output from OpenAI.');
    return text;
  } finally {
    clearTimeout(t);
  }
}

function isValidStructured(result) {
  if (!result || typeof result !== 'object') return false;
  return ['has_captcha', 'rejection_reason', 'more_info'].every((k) => k in result);
}

async function tryOnce(imagePart, model, tokens) {
  try {
    const txt = await callOpenAI(makeBody(imagePart, model, tokens), TIMEOUT_MS);
    const parsed = safeJSONParse(txt);
    if (!isValidStructured(parsed)) throw new Error('Invalid structured output');
    return parsed;
  } catch (e) {
    const msg = String(e?.message || '');
    const unsupported =
      msg.includes('text.format') ||
      msg.includes('json_schema') ||
      msg.includes('Unsupported') ||
      msg.includes('not supported with model');

    if (unsupported && model !== RESOLVED_MODEL_FALLBACK) {
      const txt2 = await callOpenAI(makeBody(imagePart, RESOLVED_MODEL_FALLBACK, tokens), TIMEOUT_MS);
      const parsed2 = safeJSONParse(txt2);
      if (!isValidStructured(parsed2)) throw new Error('Invalid structured output (fallback)');
      return parsed2;
    }

    throw e;
  }
}

async function callVisionFast(imagePart) {
  if (AGGRESSIVE_RACE) {
    const pPrimary = (async () => {
      try {
        return await tryOnce(imagePart, RESOLVED_MODEL_PRIMARY, PRIMARY_TOKENS);
      } catch {
        return await tryOnce(imagePart, RESOLVED_MODEL_PRIMARY, RETRY_TOKENS);
      }
    })();

    const pFallback = tryOnce(imagePart, RESOLVED_MODEL_FALLBACK, RETRY_TOKENS).catch(() => null);
    return Promise.any([pPrimary, pFallback].map((p) => p.catch(() => Promise.reject())));
  }

  try {
    return await tryOnce(imagePart, RESOLVED_MODEL_PRIMARY, PRIMARY_TOKENS);
  } catch {
    try {
      return await tryOnce(imagePart, RESOLVED_MODEL_PRIMARY, RETRY_TOKENS);
    } catch {
      return await tryOnce(imagePart, RESOLVED_MODEL_FALLBACK, RETRY_TOKENS);
    }
  }
}

// ======================================================
// Post-processing & normalization
// ======================================================
function extractYouTube(fieldsArray = [], raw = '') {
  for (const kv of fieldsArray) {
    const k = (kv?.key || '').toLowerCase();
    if (k === 'youtube' && typeof kv.value === 'string' && kv.value.trim()) {
      return kv.value.trim();
    }
  }

  const m = raw.match(/(https?:\/\/)?(www\.)?youtube\.com\/@[A-Za-z0-9._\-]+/i);
  return m ? m[0].replace(/^https?:\/\//i, '').replace(/^www\./i, 'www.') : null;
}

function firstValidEmail(emailsArr = [], raw = '') {
  const norm = (emailsArr || []).flatMap((s) => String(s || '').match(EMAIL_RX) || []);
  if (norm.length) return norm[0].toLowerCase();

  const fromRaw = (raw || '').match(EMAIL_RX);
  return fromRaw ? fromRaw[0].toLowerCase() : null;
}

function deriveHandleFromMi(mi = {}) {
  for (const h of mi.handles || []) {
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

  const big = [...(mi.fields || []).map((kv) => `${kv.key}: ${kv.value}`), String(mi.raw_text || '')].join('\n');

  let m = big.match(IG_RX);
  if (m && m[1]) return `@${m[1].toLowerCase()}`;

  m = big.match(TW_RX);
  if (m && m[1]) return `@${m[1].toLowerCase()}`;

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
    fields: mi.fields || [],
  };

  const email = firstValidEmail(cleaned.emails, cleaned.raw_text);
  const handle = deriveHandleFromMi({ ...cleaned });

  return {
    has_captcha,
    more_info: {
      emails: cleaned.emails,
      handles: cleaned.handles,
      YouTube: cleaned.YouTube,
    },
    normalized: { email, handle },
  };
}

// ======================================================
// YouTube helpers (enrichment)
// ======================================================
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
  } catch {
    return url;
  }
}

async function fetchYouTubeChannelByHandle(ytHandle) {
  if (!YT_API_KEY) throw new Error('Missing YOUTUBE_API_KEY');
  if (!ytHandle) throw new Error('Missing YouTube handle');

  const forHandle = normalizeHandle(ytHandle);
  const params = new URLSearchParams({
    part: 'snippet,statistics,topicDetails',
    forHandle,
    key: YT_API_KEY,
  });

  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(new Error('YouTube API timeout')), YT_TIMEOUT_MS);

  try {
    const r = await fetch(`${YT_BASE}?${params.toString()}`, {
      dispatcher: httpAgent,
      signal: ac.signal,
    });

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
      country: snippet.country || null,
      subscriberCount: hidden ? null : Number(statistics.subscriberCount ?? 0),
      videoCount: Number(statistics.videoCount ?? 0),
      viewCount: Number(statistics.viewCount ?? 0),
      topicCategories,
      topicCategoryLabels: topicCategories.map(labelFromWikiUrl),
      fetchedAt: new Date(),
    };
  } finally {
    clearTimeout(to);
  }
}

async function enrichYouTubeForContact(more_info, persistResult) {
  if (!YT_API_KEY) {
    return { saved: false, message: 'YouTube enrichment skipped: Missing YOUTUBE_API_KEY.' };
  }

  const email =
    persistResult?.email ??
    (Array.isArray(more_info?.emails) ? more_info.emails[0]?.toLowerCase()?.trim() : null);

  const handle =
    persistResult?.handle ??
    (Array.isArray(more_info?.handles) ? more_info.handles[0]?.toLowerCase()?.trim() : null);

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

  const id = persistResult?.id || persistResult?.emailId || persistResult?.handleId;
  let targetId = id;

  if (!targetId) {
    const q =
      email && handle
        ? { email, handle: normalizeHandle(handle) }
        : email
          ? { email }
          : handle
            ? { handle: normalizeHandle(handle) }
            : null;

    if (q) {
      const doc = await EmailContact.findOne(q, { _id: 1 }).lean();
      if (doc?._id) targetId = doc._id;
    }
  }

  if (!targetId) {
    const out = {
      saved: false,
      message: 'Could not locate a single record to update with YouTube data.',
      youtube: yt,
    };
    cacheSet(cacheKey, out);
    return out;
  }

  await EmailContact.updateOne({ _id: targetId }, { $set: { youtube: yt } }, { upsert: false });

  const out = { saved: true, id: String(targetId), youtube: yt };
  cacheSet(cacheKey, out);
  return out;
}

// ======================================================
// Task gating wrapper
// ======================================================
const MISMATCH_CODES = new Set(['FOLLOWERS_MISMATCH', 'COUNTRY_MISMATCH', 'CATEGORY_MISMATCH']);

async function gateByTaskFilters(task, platform, shaped) {
  const handle = shaped?.normalized?.handle || pickYouTubeHandle(shaped?.more_info);

  if (!handle) {
    const err = new Error('Handle not found in screenshot.');
    err.status = 422;
    err.code = 'HANDLE_NOT_FOUND';
    throw err;
  }

  const cacheKey = `meta|${String(platform || '').toLowerCase()}|${String(handle || '').toLowerCase()}`;
  let meta = cacheGet(cacheKey);

  if (!meta) {
    try {
      meta = await fetchInfluencerMeta(platform, handle);
      cacheSet(cacheKey, meta);
    } catch (e) {
      console.error('fetchInfluencerMeta failed:', {
        platform,
        handle,
        message: e?.message,
        status: e?.status,
        code: e?.code,
        details: e?.details || null,
        response: e?.response?.data || null,
      });

      const err = new Error(e?.message || 'Influencer verification failed.');
      err.status = Number(e?.status) || 503;
      err.code = e?.code || 'META_API_FAILED';
      err.details = e?.details || null;
      throw err;
    }
  }

  if (!meta) {
    const err = new Error('Influencer meta not found.');
    err.status = 404;
    err.code = 'META_NOT_FOUND';
    throw err;
  }

  try {
    ensureTaskFilters(task, meta);
    return { ok: true, meta, mismatch: null };
  } catch (e) {
    if (MISMATCH_CODES.has(e.code)) {
      return {
        ok: false,
        meta,
        mismatch: {
          code: e.code,
          message: e.message,
          details: e.details || null,
        },
      };
    }
    throw e;
  }
}
// ======================================================
// Persistence
// ======================================================
async function persistMoreInfo(normalized, platform, userId, taskId) {
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

  const user = await User.findOne({ userId: userId.trim() })
    .select({ _id: 1, userId: 1 })
    .lean();

  if (!user) {
    return { outcome: 'invalid', message: 'Invalid userId (no such user).' };
  }

  let taskObjectId = null;
  if (taskId) {
    try {
      taskObjectId = new mongoose.Types.ObjectId(taskId);
    } catch {
      taskObjectId = null;
    }
  }

  const [byEmail, byHandle] = await Promise.all([
    EmailContact.findOne({ email }).lean(),
    EmailContact.findOne({ handle }).lean(),
  ]);

  async function attachTaskIdIfMissing(doc) {
    if (!doc || !taskObjectId) return false;
    if (!doc.taskId) {
      await EmailContact.updateOne({ _id: doc._id }, { $set: { taskId: taskObjectId } });
      return true;
    }
    return false;
  }

  if (byEmail && byHandle) {
    if (String(byEmail._id) === String(byHandle._id)) {
      const updated = await attachTaskIdIfMissing(byEmail);
      return {
        outcome: 'duplicate',
        message: 'User handle and email are already present in the database.',
        id: byEmail._id,
        existingUserId: byEmail.userId,
        taskIdUpdated: updated,
      };
    }

    const updEmail = await attachTaskIdIfMissing(byEmail);
    const updHandle = await attachTaskIdIfMissing(byHandle);

    return {
      outcome: 'duplicate',
      message: 'Email and handle already exist (in different records).',
      emailId: byEmail._id,
      handleId: byHandle._id,
      emailUserId: byEmail.userId,
      handleUserId: byHandle.userId,
      taskIdUpdatedEmail: updEmail,
      taskIdUpdatedHandle: updHandle,
    };
  }

  if (byEmail) {
    const updated = await attachTaskIdIfMissing(byEmail);
    return {
      outcome: 'duplicate',
      message: 'Email is already present in the database.',
      emailId: byEmail._id,
      emailUserId: byEmail.userId,
      taskIdUpdated: updated,
    };
  }

  if (byHandle) {
    const updated = await attachTaskIdIfMissing(byHandle);
    return {
      outcome: 'duplicate',
      message: 'User handle is already present in the database.',
      handleId: byHandle._id,
      handleUserId: byHandle.userId,
      taskIdUpdated: updated,
    };
  }

  const doc = await EmailContact.create({
    email,
    handle,
    platform,
    userId: user.userId,
    taskId: taskObjectId,
  });

  return { outcome: 'saved', id: doc._id };
}

// ======================================================
// POST /email/extract-batch
// ======================================================
exports.extractEmailsAndHandlesBatch = asyncHandler(async (req, res) => {
  try {
    if (!OPENAI_API_KEY) throw new Error('Missing OPENAI_API_KEY');

    const taskId = String(req.body?._id || req.body?.emailTaskId || req.body?.taskId || '').trim();

    if (!taskId) {
      return res.status(400).json({
        status: 'error',
        message: 'EmailTask _id (or emailTaskId/taskId) is required.',
      });
    }

    if (!mongoose.Types.ObjectId.isValid(taskId)) {
      return res.status(400).json({
        status: 'error',
        message: 'Invalid EmailTask _id format.',
      });
    }

    const task = await EmailTask.findById(taskId).lean();
    if (!task) {
      return res.status(404).json({
        status: 'error',
        message: 'EmailTask not found.',
      });
    }

    const MS_PER_HOUR = 3600000;
    const expiresAt = task.expiresAt
      ? new Date(task.expiresAt)
      : new Date(new Date(task.createdAt).getTime() + Number(task.expireIn || 0) * MS_PER_HOUR);

    if (expiresAt.getTime() <= Date.now()) {
      return res.status(400).json({
        status: 'error',
        message: 'EmailTask has expired.',
        emailTaskId: task._id,
        expiresAt,
      });
    }

    const maxImages = Number(task.maxEmails);
    if (!Number.isFinite(maxImages) || maxImages < 1) {
      return res.status(400).json({
        status: 'error',
        message: 'EmailTask.maxEmails must be a positive number.',
        emailTaskId: task._id,
      });
    }

    const platform = normalizePlatform(task.platform) || normalizePlatform(req.body?.platform) || 'other';
    const userId = String(req.body?.userId || '').trim();

    if (!userId) {
      return res.status(400).json({
        status: 'error',
        message: 'userId is required.',
        emailTaskId: task._id,
      });
    }

    const alreadySaved = await EmailContact.countDocuments({
      taskId: task._id,
      userId,
      isValid: { $ne: false },
    });

    const remainingSlots = maxImages - alreadySaved;
    if (remainingSlots <= 0) {
      return res.status(400).json({
        status: 'error',
        message: `Task limit already reached. Max allowed is ${maxImages}.`,
        emailTaskId: task._id,
        maxImages,
        alreadySaved,
      });
    }

    // ======================================================
    // 1) Gather Inputs (files/urls/paths)
    // ======================================================
    const allFiles = Array.isArray(req.files) ? req.files : [];
    const validFiles = allFiles.filter((f) => /^image\/(png|jpe?g|webp)$/i.test(f.mimetype || ''));

    const urls = Array.isArray(req.body?.imageUrl)
      ? req.body.imageUrl
      : Array.isArray(req.body?.imageUrls)
        ? req.body.imageUrls
        : [];

    const paths = Array.isArray(req.body?.imagePath)
      ? req.body.imagePath
      : Array.isArray(req.body?.imagePaths)
        ? req.body.imagePaths
        : [];

    const totalRequested = validFiles.length + urls.length + paths.length;

    if (totalRequested === 0) {
      return res.status(400).json({
        status: 'error',
        message: `Provide up to ${remainingSlots} images via multipart (PNG/JPG/WEBP) or arrays imageUrls/imagePaths.`,
        emailTaskId: task._id,
        maxImages,
        alreadySaved,
        remainingSlots,
      });
    }

    if (totalRequested > remainingSlots) {
      return res.status(400).json({
        status: 'error',
        message: `Only ${remainingSlots} more screenshots can be submitted for this task.`,
        emailTaskId: task._id,
        maxImages,
        alreadySaved,
        remainingSlots,
        provided: totalRequested,
      });
    }

    // Build ordered inputs (files -> urls -> paths), enforce remainingSlots
    const inputs = [];
    let remaining = remainingSlots;

    for (const f of validFiles) {
      if (remaining <= 0) break;
      remaining -= 1;
      inputs.push({ kind: 'file', file: f });
    }

    for (const u of urls) {
      if (remaining <= 0) break;
      remaining -= 1;
      inputs.push({ kind: 'url', url: u });
    }

    for (const pth of paths) {
      if (remaining <= 0) break;
      remaining -= 1;
      inputs.push({ kind: 'path', pth });
    }

    if (!inputs.length) {
      return res.status(400).json({
        status: 'error',
        message: `Provide up to ${remainingSlots} images for this task via multipart (PNG/JPG/WEBP) or arrays imageUrls/imagePaths.`,
        emailTaskId: task._id,
        maxImages,
        alreadySaved,
        remainingSlots,
      });
    }

    const makePhaseError = (e) => ({
      message: e?.message || 'Failed to process this image.',
      status: Number(e?.status) || 400,
      code: e?.code || null,
      details: e?.details || null,
    });

    // ======================================================
    // 2) Phase 1: Parse + Gate (NO DB write)
    // ======================================================
    const phase1 = await Promise.all(
      inputs.map((item) =>
        (async () => {
          try {
            let imagePart;
            let cacheKey;

            if (item.kind === 'file') {
              const f = item.file;
              imagePart = await imagePartFromBuffer(f.buffer, f.mimetype);
              cacheKey = hashString(
                `p|${f.originalname}|${f.size}|${RESOLVED_MODEL_PRIMARY}|${RESOLVED_MODEL_FALLBACK}|${PRIMARY_TOKENS}|${RETRY_TOKENS}|${IMAGE_DETAIL}|darkenhance`
              );
            } else if (item.kind === 'url') {
              const u = String(item.url);
              imagePart = imagePartFromUrl(u);
              cacheKey = hashString(
                `purl|${u}|${RESOLVED_MODEL_PRIMARY}|${RESOLVED_MODEL_FALLBACK}|${PRIMARY_TOKENS}|${RETRY_TOKENS}|${IMAGE_DETAIL}|darkenhance`
              );
            } else {
              const pth = String(item.pth);
              imagePart = await imagePartFromPath(path.resolve(pth));
              cacheKey = hashString(
                `ppath|${pth}|${RESOLVED_MODEL_PRIMARY}|${RESOLVED_MODEL_FALLBACK}|${PRIMARY_TOKENS}|${RETRY_TOKENS}|${IMAGE_DETAIL}|darkenhance`
              );
            }

            let shaped = cacheGet(cacheKey);
            if (!shaped) {
              const parsed = await callVisionFast(imagePart);
              shaped = shapeForClient(parsed);
              cacheSet(cacheKey, shaped);
            }

            if (shaped?.has_captcha) {
              return {
                ok: false,
                has_captcha: true,
                status: 400,
                reason: 'CAPTCHA',
                error: 'Captcha detected. Skipping database save.',
                details: null,
                shaped,
                meta: null,
                mismatch: null,
              };
            }

            const gated = await gateByTaskFilters(task, platform, shaped);

            return {
              ok: true,
              has_captcha: false,
              shaped,
              meta: gated.meta || null,
              gateOk: !!gated.ok,
              mismatch: gated.mismatch || null,
            };
          } catch (e) {
            const pe = makePhaseError(e);
            return {
              ok: false,
              has_captcha: false,
              status: pe.status,
              reason: pe.code || 'PROCESSING_ERROR',
              error: pe.message,
              details: pe.details,
              shaped: null,
              meta: null,
              mismatch: null,
            };
          }
        })()
      )
    );

const apiFail = phase1.find(
  (r) =>
    r?.status >= 500 ||
    r?.reason === 'META_API_FAILED' ||
    r?.reason === 'YOUTUBE_TIMEOUT' ||
    r?.reason === 'YOUTUBE_FORBIDDEN' ||
    r?.reason === 'YOUTUBE_RATE_LIMIT' ||
    r?.reason === 'YOUTUBE_UPSTREAM_ERROR'
);

if (apiFail) {
  return res.status(apiFail.status || 503).json({
    status: 'error',
    message: apiFail.error || 'Influencer verification service is temporarily unavailable.',
    reason: apiFail.reason || 'META_API_FAILED',
    emailTaskId: task._id,
    platform,
    maxImages,
    alreadySaved,
    remainingSlots,
    accepted: inputs.length,
    results: phase1.map((r) => ({
      ok: !!r.ok,
      has_captcha: !!r.has_captcha,
      reason: r.reason || r.mismatch?.code || null,
      error: r.error || r.mismatch?.message || null,
    })),
  });
}

    // ======================================================
    // 3) Phase 2: Persist only VALID items
    // ======================================================
    const results = [];

    for (const r of phase1) {
      if (!r.ok) {
        results.push({
          ok: false,
          saved: false,
          mismatch: false,
          has_captcha: !!r.has_captcha,
          platform,
          reason: r.reason || 'PROCESSING_ERROR',
          error: r.error || 'Failed to process this image.',
          details: r.details || null,
        });
        continue;
      }

      const shaped = r.shaped;
      const meta = r.meta;
      const mismatch = r.mismatch;
      const isTaskMismatch = !!mismatch;

      // block save for ALL mismatches
      if (isTaskMismatch) {
        results.push({
          ok: false,
          saved: false,
          mismatch: true,
          reason: mismatch.code,
          error: mismatch.message,
          details: mismatch.details || null,
          platform,
          has_captcha: false,
          more_info: shaped.more_info,
          normalized: shaped.normalized,
          meta: {
            followerCount: meta?.followerCount ?? null,
            country: meta?.country ?? null,
            categories: meta?.categories ?? [],
          },
          youtube: meta?.youtube || null,
        });
        continue;
      }

      const dbRes = await persistMoreInfo(shaped.normalized, platform, userId, task._id);

      const idsToUpdate = new Set(
        [dbRes?.id, dbRes?.emailId, dbRes?.handleId]
          .filter(Boolean)
          .map(String)
      );

      if (meta && idsToUpdate.size) {
        for (const _id of idsToUpdate) {
          const update = {
            followerCount: meta?.followerCount ?? null,
            country: meta?.country ?? null,
            categories: Array.isArray(meta?.categories) ? meta.categories : [],
            validatedAt: new Date(),
            isValid: true,
            invalidReason: null,
            invalidDetails: null,
          };

          if (meta?.youtube) update.youtube = meta.youtube;

          await EmailContact.updateOne({ _id }, { $set: update }, { upsert: false }).catch(() => {});
        }
      }

      let ytRes = null;
      try {
        const persistCtx = {
          id: dbRes?.id || null,
          emailId: dbRes?.emailId || null,
          handleId: dbRes?.handleId || null,
          email: shaped?.normalized?.email || null,
          handle: shaped?.normalized?.handle || null,
        };
        ytRes = await enrichYouTubeForContact(shaped.more_info, persistCtx);
      } catch (e) {
        ytRes = { saved: false, message: e?.message || 'YouTube enrichment failed.' };
      }

      const savedNow = dbRes?.outcome === 'saved';
      const savedOrExists = savedNow || dbRes?.outcome === 'duplicate';

      results.push({
        ok: savedNow,
        saved: !!savedOrExists,
        mismatch: false,
        reason: savedNow ? null : 'DUPLICATE_OR_INVALID',
        error: savedNow ? null : dbRes?.message || null,
        details: savedNow ? null : dbRes || null,
        platform,
        has_captcha: false,
        more_info: shaped.more_info,
        normalized: shaped.normalized,
        db: savedNow
          ? { outcome: dbRes.outcome, id: dbRes.id }
          : { outcome: dbRes.outcome, ...dbRes },
        meta: {
          followerCount: meta?.followerCount ?? null,
          country: meta?.country ?? null,
          categories: meta?.categories ?? [],
        },
        youtube: ytRes?.youtube || meta?.youtube || null,
        youtubeSaved: !!ytRes?.saved,
        youtubeMessage: ytRes?.message || null,
      });
    }

const anyMismatch = results.some((x) => x.mismatch === true);

const anyHardFailure = results.some(
  (x) =>
    x.ok === false &&
    x.mismatch !== true
);

return res.status(200).json({
  status: anyMismatch || anyHardFailure ? 'partial' : 'ok',
  message: anyMismatch
    ? 'Some influencers did not match task filters and were not saved.'
    : anyHardFailure
      ? 'Some items failed to save.'
      : 'Saved.',
  emailTaskId: task._id,
  platform,
  maxImages,
  alreadySaved,
  remainingSlots,
  accepted: inputs.length,
  results,
});
  } catch (err) {
    console.error('extractEmailsAndHandlesBatch error:', err);
    return res.status(400).json({
      status: 'error',
      message: err?.message || 'Batch processing failed.',
    });
  }
});

// ======================================================
// POST /email/all
// ======================================================
exports.getAllEmailContacts = asyncHandler(async (req, res) => {
  try {
    const body = req.body || {};

    const _escapeRegex =
      typeof escapeRegex === 'function'
        ? escapeRegex
        : (str = '') => String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    const page = Math.max(1, parseInt(body.page ?? '1', 10));
    const limit = Math.min(50, Math.max(1, parseInt(body.limit ?? '50', 10)));

    const userId = typeof body.userId === 'string' ? body.userId.trim() : '';
    const search = typeof body.search === 'string' ? body.search.trim() : '';

    const exportType = (body.exportType || '').toLowerCase();
    const exportAll = String(body.exportAll ?? 'false').toLowerCase() === 'true';

    const defaultFields = [
      'email',
      'handle',
      'platform',
      'userId',
      'createdAt',
      'youtube',
      'followerCount',
      'country',
      'categories',
    ];

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
      'youtube.fetchedAt',
    ];

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
      'youtube.fetchedAt',
    ];

    const allowed = new Set([...defaultFields, ...YT_ALLOWED_DOT_FIELDS]);

    let fields = Array.isArray(body.fields) && body.fields.length
      ? body.fields.filter((f) => allowed.has(f))
      : defaultFields.slice();

    if (!fields.length) fields = defaultFields.slice();

    const query = validOnlyFilter();
    if (userId) query.userId = userId;

    if (search) {
      const needleRaw = search;
      const needleNoAt = search.startsWith('@') ? search.slice(1) : search;

      const rxRaw = _escapeRegex(needleRaw);
      const rxNoAt = _escapeRegex(needleNoAt);

      query.$or = [
        { email: { $regex: rxNoAt, $options: 'i' } },
        { handle: { $regex: rxRaw.startsWith('@') ? rxRaw : `@${rxNoAt}`, $options: 'i' } },
        { platform: { $regex: rxNoAt, $options: 'i' } },
      ];
    }

    const projection = { _id: 0 };
    for (const f of fields) {
      if (f === 'youtube' || f.startsWith('youtube.')) projection.youtube = 1;
      else projection[f] = 1;
    }

    const EXPORT_CAP = 100_000;
    const total = await EmailContact.countDocuments(query);

    const getDeep = (obj, pth) => {
      try {
        return pth.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
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

    if (exportType === 'csv' || exportType === 'xlsx') {
      const hasYoutubeWildcard = fields.includes('youtube');
      const hasYoutubeDot = fields.some((f) => f.startsWith('youtube.'));
      const ytExpanded =
        hasYoutubeWildcard && !hasYoutubeDot
          ? YT_EXPORT_DEFAULTS
          : fields.filter((f) => f.startsWith('youtube.'));

      const nonYTFields = fields.filter((f) => f !== 'youtube' && !f.startsWith('youtube.'));
      const exportFields = [...nonYTFields, ...ytExpanded];

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

      const rows = docs.map((d) => {
        const out = {};
        for (const f of exportFields) {
          out[f] = asCell(f.startsWith('youtube.') ? getDeep(d, f) : d[f]);
        }
        return out;
      });

      const ts = new Date();
      const y = String(ts.getFullYear());
      const m = String(ts.getMonth() + 1).padStart(2, '0');
      const dd = String(ts.getDate()).padStart(2, '0');
      const hh = String(ts.getHours()).padStart(2, '0');
      const mm = String(ts.getMinutes()).padStart(2, '0');
      const ss = String(ts.getSeconds()).padStart(2, '0');
      const stamp = `${y}${m}${dd}_${hh}${mm}${ss}`;

      if (exportType === 'csv') {
        const esc = (v) => {
          const s = String(v ?? '');
          return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        };

        const header = exportFields.map(esc).join(',');
        const lines = rows.map((r) => exportFields.map((f) => esc(r[f])).join(','));
        const csv = [header, ...lines].join('\n');

        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="contacts_${stamp}.csv"`);
        return res.status(200).send(csv);
      }

      if (exportType === 'xlsx') {
        const ExcelJS = require('exceljs');
        const wb = new ExcelJS.Workbook();
        const ws = wb.addWorksheet('Contacts');

        ws.columns = exportFields.map((f) => ({
          header: f,
          key: f,
          width: Math.max(12, f.length + 2),
        }));

        ws.addRows(rows);

        const buffer = await wb.xlsx.writeBuffer();
        res.setHeader(
          'Content-Type',
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        );
        res.setHeader('Content-Disposition', `attachment; filename="contacts_${stamp}.xlsx"`);
        return res.status(200).send(Buffer.from(buffer));
      }
    }

    const items = await EmailContact.find(query)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .select(projection)
      .lean();

    return res.json({
      page,
      limit,
      total,
      hasNext: page * limit < total,
      data: items,
    });
  } catch (err) {
    console.error('getAllEmailContacts error:', err);
    return res.status(400).json({
      status: 'error',
      message: err?.message || 'Failed to fetch contacts.',
    });
  }
});

// ======================================================
// POST /email/by-user
// ======================================================
exports.getContactsByUser = asyncHandler(async (req, res) => {
  try {
    const body = req.body || {};
    const userId = (body.userId || '').trim();
    if (!userId) {
      return res.status(400).json({ status: 'error', message: 'userId is required.' });
    }

    const page = Math.max(1, parseInt(body.page ?? '1', 10));
    const limit = Math.min(200, Math.max(1, parseInt(body.limit ?? '50', 10)));
    const search = typeof body.search === 'string' ? body.search.trim() : '';

    const query = validOnlyFilter({ userId });

    if (search) {
      const needleRaw = search;
      const needleNoAt = search.startsWith('@') ? search.slice(1) : search;

      const rxRaw = escapeRegex(needleRaw);
      const rxNoAt = escapeRegex(needleNoAt);

      query.$or = [
        { email: { $regex: rxNoAt, $options: 'i' } },
        { handle: { $regex: rxRaw.startsWith('@') ? rxRaw : `@${rxNoAt}`, $options: 'i' } },
        { platform: { $regex: rxNoAt, $options: 'i' } },
      ];
    }

    const [items, total] = await Promise.all([
      EmailContact.find(query)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .select({
          email: 1,
          handle: 1,
          platform: 1,
          createdAt: 1,
          followerCount: 1,
          country: 1,
          categories: 1,
          youtube: 1,
          _id: 0,
        })
        .lean(),
      EmailContact.countDocuments(query),
    ]);

    return res.json({
      userId,
      page,
      limit,
      total,
      hasNext: page * limit < total,
      data: items,
    });
  } catch (err) {
    console.error('getContactsByUser error:', err);
    return res.status(400).json({
      status: 'error',
      message: err?.message || 'Failed to fetch user contacts.',
    });
  }
});

// ======================================================
// POST /email/getByemployeeId
// ======================================================
exports.getUserSummariesByEmployee = asyncHandler(async (req, res) => {
  try {
    const body = req.body || {};
    const employeeId = (body.employeeId || '').trim();
    if (!employeeId) {
      return res.status(400).json({ status: 'error', message: 'employeeId is required.' });
    }

    const page = Math.max(1, parseInt(body.page ?? '1', 10));
    const limit = Math.min(200, Math.max(1, parseInt(body.limit ?? '50', 10)));
    const search = typeof body.search === 'string' ? body.search.trim() : '';
    const detailsLimit = Math.min(5000, Math.max(1, parseInt(body.detailsLimit ?? '1000', 10)));

    const userQuery = { worksUnder: employeeId };
    if (search) userQuery.name = { $regex: escapeRegex(search), $options: 'i' };

    const [totalUsers, users] = await Promise.all([
      User.countDocuments(userQuery),
      User.find(userQuery)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .select({ userId: 1, name: 1, _id: 0 })
        .lean(),
    ]);

    const userIds = users.map((u) => u.userId);

    let contactsByUser = new Map();

    if (userIds.length) {
      const contacts = await EmailContact.find({
        userId: { $in: userIds },
        isValid: { $ne: false },
      })
        .select({ userId: 1, email: 1, handle: 1, platform: 1, createdAt: 1, _id: 0 })
        .sort({ createdAt: -1 })
        .lean();

      contactsByUser = contacts.reduce((map, c) => {
        const list = map.get(c.userId) || [];
        if (list.length < detailsLimit) {
          list.push({
            email: c.email,
            handle: c.handle,
            platform: c.platform,
            createdAt: c.createdAt,
          });
        }
        map.set(c.userId, list);
        return map;
      }, new Map());
    }

    const items = users.map((u) => {
      const list = contactsByUser.get(u.userId) || [];

      let firstSavedAt = null;
      let lastSavedAt = null;

      if (list.length) {
        lastSavedAt = list[0].createdAt || null;
        firstSavedAt = list[list.length - 1].createdAt || null;
      }

      return {
        userId: u.userId,
        name: u.name,
        total: list.length,
        firstSavedAt,
        lastSavedAt,
        influencerDetails: list,
      };
    });

    return res.json({
      employeeId,
      page,
      limit,
      totalUsers,
      hasNext: page * limit < totalUsers,
      data: items,
    });
  } catch (err) {
    console.error('getUserSummariesByEmployee error:', err);
    return res.status(400).json({
      status: 'error',
      message: err?.message || 'Failed to fetch employee summaries.',
    });
  }
});

// ======================================================
// POST /admin/all (employee overview)
// ======================================================
exports.getEmployeeOverviewAdmin = asyncHandler(async (req, res) => {
  try {
    const body = req.body || {};

    const _escapeRegex =
      typeof escapeRegex === 'function'
        ? escapeRegex
        : (str = '') => String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    const search = typeof body.search === 'string' ? body.search.trim() : '';
    const page = Math.max(1, parseInt(body.page ?? '1', 10));
    const limit = Math.min(200, Math.max(1, parseInt(body.limit ?? '50', 10)));
    const detailsLimit = Math.min(5000, Math.max(1, parseInt(body.detailsLimit ?? '1000', 10)));

    const employeeQuery = {};
    if (search) employeeQuery.name = { $regex: _escapeRegex(search), $options: 'i' };

    const [totalEmployees, employees] = await Promise.all([
      Employee.countDocuments(employeeQuery),
      Employee.find(employeeQuery)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .select({ employeeId: 1, name: 1, email: 1, createdAt: 1, _id: 0 })
        .lean(),
    ]);

    if (!employees.length) {
      return res.json({
        page,
        limit,
        totalEmployees,
        hasNext: false,
        detailsLimit,
        data: [],
      });
    }

    const employeeIds = employees.map((e) => e.employeeId);

    const users = await User.find({ worksUnder: { $in: employeeIds } })
      .select({ userId: 1, name: 1, worksUnder: 1, createdAt: 1, _id: 0 })
      .lean();

    const usersByEmployee = users.reduce((map, u) => {
      const list = map.get(u.worksUnder) || [];
      list.push(u);
      map.set(u.worksUnder, list);
      return map;
    }, new Map());

    const collectorUserIds = users.map((u) => u.userId);

    let contacts = [];
    if (collectorUserIds.length) {
      contacts = await EmailContact.find({
        userId: { $in: collectorUserIds },
        isValid: { $ne: false },
      })
        .select({
          userId: 1,
          email: 1,
          handle: 1,
          platform: 1,
          createdAt: 1,
          followerCount: 1,
          country: 1,
          categories: 1,
          youtube: 1,
          _id: 0,
        })
        .sort({ createdAt: -1 })
        .lean();
    }

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
        description: yt.description || null,
        topicCategories: Array.isArray(yt.topicCategories) ? yt.topicCategories : [],
        topicCategoryLabels: Array.isArray(yt.topicCategoryLabels) ? yt.topicCategoryLabels : [],
        fetchedAt: yt.fetchedAt || null,
      };
    };

    const contactsByUser = new Map();
    const countsByUser = new Map();

    if (contacts.length) {
      const grouped = contacts.reduce((m, c) => {
        const list = m.get(c.userId) || [];
        list.push(c);
        m.set(c.userId, list);
        return m;
      }, new Map());

      for (const [uid, list] of grouped.entries()) {
        countsByUser.set(uid, list.length);

        const limited = list.slice(0, detailsLimit).map((row) => ({
          email: row.email,
          handle: row.handle,
          platform: row.platform,
          createdAt: row.createdAt,
          followerCount: row.followerCount ?? null,
          country: row.country ?? null,
          categories: Array.isArray(row.categories) ? row.categories : [],
          youtube: summarizeYouTube(row.youtube),
        }));

        contactsByUser.set(uid, limited);
      }
    }

    const items = employees
      .map((emp) => {
        const team = usersByEmployee.get(emp.employeeId) || [];

        const collectorsAll = team.map((u) => ({
          username: u.name,
          userId: u.userId,
          totalCollected: countsByUser.get(u.userId) || 0,
          dataCollected: contactsByUser.get(u.userId) || [],
        }));

        const collectors = collectorsAll.filter(
          (c) => Array.isArray(c.dataCollected) && c.dataCollected.length > 0
        );

        const contactsTotal = collectors.reduce((a, c) => a + (c.totalCollected || 0), 0);

        return {
          employeeName: emp.name,
          employeeId: emp.employeeId,
          employeeEmail: emp.email,
          teamCounts: {
            members: collectors.length,
            contactsTotal,
          },
          collectors,
        };
      })
      .filter((empBlock) => empBlock.collectors && empBlock.collectors.length > 0);

    return res.json({
      page,
      limit,
      totalEmployees,
      hasNext: page * limit < totalEmployees,
      detailsLimit,
      search,
      data: items,
    });
  } catch (err) {
    console.error('getEmployeeOverviewAdmin error:', err);
    return res.status(400).json({
      status: 'error',
      message: err?.message || 'Failed to fetch admin employee overview.',
    });
  }
});

// ======================================================
// POST /email/status
// ======================================================
exports.checkStatus = asyncHandler(async (req, res) => {
  try {
    const rawHandle = (req.body?.handle ?? '').trim();
    const rawPlatform = (req.body?.platform ?? '').trim();
    const userId = typeof req.body?.userId === 'string' ? req.body.userId.trim() : '';

    if (!rawHandle) {
      return res.status(400).json({ status: 'error', message: 'handle is required' });
    }

    if (!rawPlatform) {
      return res.status(400).json({ status: 'error', message: 'platform is required' });
    }

    const handle = (rawHandle.startsWith('@') ? rawHandle : `@${rawHandle}`).toLowerCase();
    const HANDLE_RX2 = /^@[A-Za-z0-9._\-]+$/;

    if (!HANDLE_RX2.test(handle)) {
      return res.status(400).json({ status: 'error', message: 'Invalid handle format' });
    }

    const PLATFORM_MAP2 = new Map([
      ['youtube', 'youtube'],
      ['yt', 'youtube'],
      ['instagram', 'instagram'],
      ['ig', 'instagram'],
      ['twitter', 'twitter'],
      ['x', 'twitter'],
      ['tiktok', 'tiktok'],
      ['tt', 'tiktok'],
      ['facebook', 'facebook'],
      ['fb', 'facebook'],
      ['other', 'other'],
    ]);

    const platformKey = rawPlatform.toLowerCase();
    const platform = PLATFORM_MAP2.get(platformKey);

    if (!platform) {
      return res.status(400).json({
        status: 'error',
        message:
          'Invalid platform. Use: youtube|instagram|twitter|tiktok|facebook|other (or aliases: yt, ig, x, tt, fb)',
      });
    }

    const query = validOnlyFilter({
      handle,
      platform,
      ...(userId ? { userId } : {}),
    });

    const contact = await EmailContact.findOne(query)
      .select({ email: 1, handle: 1, platform: 1, userId: 1, _id: 0 })
      .lean();

    return res.json({
      status: contact ? 1 : 0,
      email: contact ? contact.email : null,
      handle,
      platform,
    });
  } catch (err) {
    console.error('checkStatus error:', err);
    return res.status(400).json({
      status: 'error',
      message: err?.message || 'Failed to check handle.',
    });
  }
});

// ======================================================
// POST /email/entries
// ======================================================
exports.getEmailContactsByTask = asyncHandler(async (req, res) => {
  const {
    taskId,
    page = 1,
    limit = 20,
    sortBy = 'createdAt',
    sortOrder = 'desc',
    search,
    platform,
    userId,
  } = req.body || {};

  if (!taskId) return res.status(400).json({ error: 'taskId required' });
  if (!mongoose.Types.ObjectId.isValid(taskId)) {
    return res.status(400).json({ error: 'Invalid taskId format' });
  }

  const taskObjectId = new mongoose.Types.ObjectId(taskId);

  const { p, l, skip } = contactParsePageLimit(page, limit);
  const sort = contactParseSort(sortBy, sortOrder);

  const filter = validOnlyFilter({ taskId: taskObjectId });

  if (userId && typeof userId === 'string') {
    filter.userId = userId.trim();
  }

  if (platform && typeof platform === 'string') {
    filter.platform = { $regex: `^${escapeRegex(platform.trim())}$`, $options: 'i' };
  }

  if (search && String(search).trim() !== '') {
    const term = String(search).trim();
    const rx = new RegExp(escapeRegex(term), 'i');
    filter.$or = [{ email: rx }, { handle: rx }];
  }

  const [rows, total] = await Promise.all([
    EmailContact.find(filter)
      .sort(sort)
      .skip(skip)
      .limit(l)
      .select('-__v')
      .lean(),
    EmailContact.countDocuments(filter),
  ]);

  res.json({
    taskId,
    contacts: rows,
    total,
    page: p,
    pages: Math.ceil(total / l),
  });
});