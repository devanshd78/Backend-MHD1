// controllers/missingController.js
'use strict';

const asyncHandler = require('express-async-handler');
const Missing = require('../models/Missing');

const HANDLE_RX = /^@[A-Za-z0-9._\-]+$/;
const PLATFORM_MAP = new Map([
  ['youtube', 'youtube'], ['yt', 'youtube'],
  ['instagram', 'instagram'], ['ig', 'instagram'],
  ['tiktok', 'tiktok'], ['tt', 'tiktok']
]);

function escapeRegex(str = '') {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// POST /missing/create
// body: { handle: "@name", platform: "youtube"|"yt"|"instagram"|"ig"|"tiktok"|"tt", brandId: "BR123", note?: "optional" }
exports.createMissing = asyncHandler(async (req, res) => {
  const rawHandle   = (req.body?.handle ?? '').trim();
  const rawPlatform = (req.body?.platform ?? '').trim();
  const rawBrandId  = (req.body?.brandId ?? '').trim();
  const note        = typeof req.body?.note === 'string' ? req.body.note.trim() : undefined;

  if (!rawHandle)   return res.status(400).json({ status: 'error', message: 'handle is required' });
  if (!rawPlatform) return res.status(400).json({ status: 'error', message: 'platform is required' });
  if (!rawBrandId)  return res.status(400).json({ status: 'error', message: 'brandId is required' });

  // normalize handle
  const handle = (rawHandle.startsWith('@') ? rawHandle : `@${rawHandle}`).toLowerCase();
  if (!HANDLE_RX.test(handle)) {
    return res.status(400).json({ status: 'error', message: 'Invalid handle format' });
  }

  // normalize platform (limited to youtube|instagram|tiktok)
  const platform = PLATFORM_MAP.get(rawPlatform.toLowerCase());
  if (!platform) {
    return res.status(400).json({
      status: 'error',
      message: 'Invalid platform. Use: youtube|instagram|tiktok (aliases: yt, ig, tt)'
    });
  }

  // If the same (handle, platform, brandId) already exists, return it
  const existing = await Missing.findOne({ handle, platform, brandId: rawBrandId }).lean();
  if (existing) {
    return res.json({
      status: 'exists',
      data: {
        missingId: existing.missingId,
        handle: existing.handle,
        platform: existing.platform,
        brandId: existing.brandId,
        note: existing.note ?? null,
        createdAt: existing.createdAt
      }
    });
  }

  // Create new (just store brandId; no Brand lookup)
  const doc = await Missing.create({ handle, platform, brandId: rawBrandId, note });
  return res.status(201).json({
    status: 'saved',
    data: {
      missingId: doc.missingId,
      handle: doc.handle,
      platform: doc.platform,
      brandId: doc.brandId,
      note: doc.note ?? null,
      createdAt: doc.createdAt
    }
  });
});

// POST /missing/list
// body: {
//   page?: number (default 1), limit?: number (default 50, max 200),
//   search?: string (searches handle, platform, missingId, brandId, note),
//   platform?: string (optional exact/alias filter),
//   handle?: string (optional normalized),
//   brandId?: string (optional exact brand filter)
// }
exports.listMissing = asyncHandler(async (req, res) => {
  const body = req.body || {};

  // Pagination
  const page  = Math.max(1, parseInt(body.page  ?? '1', 10));
  const limit = Math.min(200, Math.max(1, parseInt(body.limit ?? '50', 10)));

  // Optional filters
  const rawSearch   = typeof body.search === 'string' ? body.search.trim() : '';
  const rawPlatform = typeof body.platform === 'string' ? body.platform.trim() : '';
  const rawHandle   = typeof body.handle === 'string' ? body.handle.trim() : '';
  const rawBrandId  = typeof body.brandId === 'string' ? body.brandId.trim() : '';

  const query = {};

  // platform filter
  if (rawPlatform) {
    const p = PLATFORM_MAP.get(rawPlatform.toLowerCase());
    if (!p) {
      return res.status(400).json({
        status: 'error',
        message: 'Invalid platform filter. Use: youtube|instagram|tiktok (aliases: yt, ig, tt)'
      });
    }
    query.platform = p;
  }

  // handle filter
  if (rawHandle) {
    const handle = (rawHandle.startsWith('@') ? rawHandle : `@${rawHandle}`).toLowerCase();
    if (!HANDLE_RX.test(handle)) {
      return res.status(400).json({ status: 'error', message: 'Invalid handle format in filter' });
    }
    query.handle = handle;
  }

  // brand filter
  if (rawBrandId) {
    query.brandId = rawBrandId;
  }

  // Base fetch
  const [total, docs] = await Promise.all([
    Missing.countDocuments(query),
    Missing.find(query)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .select({ _id: 0, missingId: 1, handle: 1, platform: 1, brandId: 1, note: 1, createdAt: 1 })
      .lean()
  ]);

  // Universal search (server-side across fields we have)
  let items = docs;
  if (rawSearch) {
    const rx = new RegExp(escapeRegex(rawSearch), 'i');
    items = items.filter(r =>
      rx.test(r.handle) ||
      rx.test(r.platform) ||
      rx.test(r.missingId) ||
      rx.test(r.brandId || '') ||
      rx.test(r.note || '')
    );
  }

  return res.json({
    page,
    limit,
    total,
    hasNext: page * limit < total,
    data: items
  });
});
