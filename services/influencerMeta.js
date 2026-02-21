'use strict';

const axios = require('axios');

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;
const YT_TIMEOUT_MS = Number(process.env.YT_TIMEOUT_MS || 15000);

const yt = axios.create({
  baseURL: 'https://www.googleapis.com/youtube/v3',
  timeout: YT_TIMEOUT_MS,
  validateStatus: () => true,
});

function normCategory(s) {
  return String(s || '').trim().toLowerCase();
}

function topicUrlToLabel(url) {
  const u = String(url || '').trim();
  const last = u.split('/').pop() || '';
  return normCategory(last.replace(/_/g, ' ').replace(/\(.+?\)/g, '').trim());
}

async function fetchYouTubeByHandle(handle) {
  if (!YOUTUBE_API_KEY) throw new Error('YOUTUBE_API_KEY missing');

  const raw = String(handle || '').trim();
  const h = raw.startsWith('@') ? raw : `@${raw}`;

  const resp = await yt.get('/channels', {
    params: {
      key: YOUTUBE_API_KEY,
      part: 'snippet,statistics,topicDetails',
      forHandle: h, // ✅ supported by YouTube Data API
    },
  });

  if (resp.status !== 200) {
    const msg = resp?.data?.error?.message || `YouTube API error: HTTP ${resp.status}`;
    throw new Error(msg);
  }

  const ch = resp.data?.items?.[0];
  if (!ch) return null;

  const country = ch?.snippet?.country || null; // usually ISO2
  const subscriberCount = Number(ch?.statistics?.subscriberCount ?? NaN);
  const topicCats = Array.isArray(ch?.topicDetails?.topicCategories) ? ch.topicDetails.topicCategories : [];

  const categories = topicCats.map(topicUrlToLabel).filter(Boolean);

  return {
    followerCount: Number.isFinite(subscriberCount) ? subscriberCount : null,
    country,
    categories,
    youtube: {
      channelId: ch.id,
      title: ch?.snippet?.title || null,
      handle: raw.startsWith('@') ? raw : `@${raw}`,
      description: ch?.snippet?.description || null,
      country,
      subscriberCount: Number.isFinite(subscriberCount) ? subscriberCount : null,
      topicCategories: topicCats,
      topicCategoryLabels: categories,
      fetchedAt: new Date(),
    },
  };
}

// ✅ Optional: plug your IG/TikTok API here
async function fetchInstagramByHandle(_handle) {
  return null;
}

async function fetchTikTokByHandle(_handle) {
  return null;
}

async function fetchInfluencerMeta(platform, handle) {
  const p = String(platform || '').toLowerCase().trim();
  if (p === 'youtube') return fetchYouTubeByHandle(handle);
  if (p === 'instagram') return fetchInstagramByHandle(handle);
  if (p === 'tiktok') return fetchTikTokByHandle(handle);
  return null;
}

module.exports = { fetchInfluencerMeta };