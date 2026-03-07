'use strict';

const axios = require('axios');
const http = require('http');
const https = require('https');

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;
const YT_TIMEOUT_MS = Number(process.env.YT_TIMEOUT_MS || 15000);

const yt = axios.create({
  baseURL: 'https://www.googleapis.com/youtube/v3',
  timeout: YT_TIMEOUT_MS,
  validateStatus: () => true,
  httpAgent: new http.Agent({ keepAlive: true }),
  httpsAgent: new https.Agent({ keepAlive: true }),
});

class MetaError extends Error {
  constructor(message, status = 500, code = 'META_ERROR', details = null) {
    super(message);
    this.name = 'MetaError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function normCategory(s) {
  return String(s || '').trim().toLowerCase();
}

function topicUrlToLabel(url) {
  const u = String(url || '').trim();
  const last = u.split('/').pop() || '';
  return normCategory(last.replace(/_/g, ' ').replace(/\(.+?\)/g, '').trim());
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function retry(fn, attempts = 2, delayMs = 800) {
  let lastErr;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;

      const status = Number(err?.status || err?.response?.status || 0);
      const code = String(err?.code || '');

      const retryable =
        code === 'ECONNABORTED' ||
        code === 'ETIMEDOUT' ||
        code === 'ECONNRESET' ||
        code === 'ENOTFOUND' ||
        status === 408 ||
        status === 429 ||
        status >= 500;

      if (!retryable || i === attempts - 1) break;
      await sleep(delayMs);
    }
  }
  throw lastErr;
}

async function fetchYouTubeByHandle(handle) {
  if (!YOUTUBE_API_KEY) {
    throw new MetaError('YOUTUBE_API_KEY missing', 500, 'YOUTUBE_KEY_MISSING');
  }

  const raw = String(handle || '').trim();
  if (!raw) {
    throw new MetaError('Handle is required', 400, 'HANDLE_REQUIRED');
  }

  const h = raw.startsWith('@') ? raw : `@${raw}`;

  const resp = await retry(
    async () => {
      try {
        return await yt.get('/channels', {
          params: {
            key: YOUTUBE_API_KEY,
            part: 'snippet,statistics,topicDetails',
            forHandle: h,
          },
        });
      } catch (err) {
        if (err.code === 'ECONNABORTED') {
          throw new MetaError('YouTube API timeout', 503, 'YOUTUBE_TIMEOUT');
        }
        throw err;
      }
    },
    2,
    1000
  );

  if (resp.status !== 200) {
    const apiErr = resp?.data?.error || {};
    const msg = apiErr?.message || `YouTube API error: HTTP ${resp.status}`;
    const apiCode = apiErr?.errors?.[0]?.reason || null;

    if (resp.status === 403) {
      throw new MetaError(msg, 503, apiCode || 'YOUTUBE_FORBIDDEN', resp?.data || null);
    }

    if (resp.status === 429) {
      throw new MetaError(msg, 503, apiCode || 'YOUTUBE_RATE_LIMIT', resp?.data || null);
    }

    if (resp.status >= 500) {
      throw new MetaError(msg, 503, apiCode || 'YOUTUBE_UPSTREAM_ERROR', resp?.data || null);
    }

    throw new MetaError(msg, 400, apiCode || 'YOUTUBE_BAD_REQUEST', resp?.data || null);
  }

  const ch = resp.data?.items?.[0];
  if (!ch) {
    throw new MetaError(`YouTube channel not found for ${h}`, 404, 'CHANNEL_NOT_FOUND');
  }

  const country = ch?.snippet?.country || null;
  const subscriberCountRaw = ch?.statistics?.subscriberCount;
  const subscriberCount = Number(subscriberCountRaw ?? NaN);
  const videoCount = Number(ch?.statistics?.videoCount ?? NaN);
  const viewCount = Number(ch?.statistics?.viewCount ?? NaN);
  const topicCats = Array.isArray(ch?.topicDetails?.topicCategories)
    ? ch.topicDetails.topicCategories
    : [];

  const categories = topicCats.map(topicUrlToLabel).filter(Boolean);

  return {
    followerCount: Number.isFinite(subscriberCount) ? subscriberCount : null,
    country,
    categories,
    youtube: {
      channelId: ch.id || null,
      title: ch?.snippet?.title || null,
      handle: h,
      urlByHandle: `https://www.youtube.com/${h}`,
      urlById: ch?.id ? `https://www.youtube.com/channel/${ch.id}` : null,
      description: ch?.snippet?.description || null,
      country,
      subscriberCount: Number.isFinite(subscriberCount) ? subscriberCount : null,
      videoCount: Number.isFinite(videoCount) ? videoCount : null,
      viewCount: Number.isFinite(viewCount) ? viewCount : null,
      topicCategories: topicCats,
      topicCategoryLabels: categories,
      fetchedAt: new Date(),
    },
  };
}

async function fetchInstagramByHandle(_handle) {
  throw new MetaError('Instagram meta service not implemented', 501, 'INSTAGRAM_NOT_IMPLEMENTED');
}

async function fetchTikTokByHandle(_handle) {
  throw new MetaError('TikTok meta service not implemented', 501, 'TIKTOK_NOT_IMPLEMENTED');
}

async function fetchInfluencerMeta(platform, handle) {
  const p = String(platform || '').toLowerCase().trim();

  if (p === 'youtube') return fetchYouTubeByHandle(handle);
  if (p === 'instagram') return fetchInstagramByHandle(handle);
  if (p === 'tiktok') return fetchTikTokByHandle(handle);

  throw new MetaError(`Unsupported platform: ${platform}`, 400, 'UNSUPPORTED_PLATFORM');
}

module.exports = { fetchInfluencerMeta, MetaError };