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

  // ❗ No duplicate missing handle:
  // If ANY entry exists for (handle, platform), do NOT create another.
  const existing = await Missing.findOne({ handle, platform }).lean();
  if (existing) {
    return res.status(200).json({
      status: 'exists',
      message: 'Data will come soon. Missing request already present.',
      data: {
        missingId: existing.missingId,
        handle: existing.handle,
        platform: existing.platform,
        brandId: existing.brandId,
        note: existing.note ?? null,
        isAvailable: typeof existing.isAvailable === 'number' ? existing.isAvailable : 0,
        createdAt: existing.createdAt
      }
    });
  }

  // Create new (store brandId, isAvailable defaults to 0 in schema)
  const doc = await Missing.create({ handle, platform, brandId: rawBrandId, note });
  return res.status(201).json({
    status: 'saved',
    message: 'Missing request created.',
    data: {
      missingId: doc.missingId,
      handle: doc.handle,
      platform: doc.platform,
      brandId: doc.brandId,
      note: doc.note ?? null,
      isAvailable: doc.isAvailable, // 0 by default
      createdAt: doc.createdAt
    }
  });
});

// POST /missing/list
// body: {
//   page?: number (default 1), limit?: number (default 50, max 200),
//   search?: string (searches handle, platform, missingId, brandId, note, isAvailable),
//   platform?: string (optional exact/alias filter),
//   handle?: string (optional normalized),
//   brandId?: string (optional exact brand filter),
//   isAvailable?: 0|1 (optional availability filter)
// }
exports.listMissing = asyncHandler(async (req, res) => {
  const body = req.body || {};

  // Pagination
  const page  = Math.max(1, parseInt(body.page  ?? '1', 10));
  const limit = Math.min(200, Math.max(1, parseInt(body.limit ?? '50', 10)));

  // Optional filters
  const rawSearch      = typeof body.search === 'string' ? body.search.trim() : '';
  const rawPlatform    = typeof body.platform === 'string' ? body.platform.trim() : '';
  const rawHandle      = typeof body.handle === 'string' ? body.handle.trim() : '';
  const rawBrandId     = typeof body.brandId === 'string' ? body.brandId.trim() : '';
  const rawIsAvailable = body.isAvailable; // can be 0 or 1 or undefined

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

  // isAvailable filter
  if (rawIsAvailable !== undefined && rawIsAvailable !== null && rawIsAvailable !== '') {
    const val = Number(rawIsAvailable);
    if (val !== 0 && val !== 1) {
      return res.status(400).json({
        status: 'error',
        message: 'Invalid isAvailable filter. Use 0 (not available) or 1 (available).'
      });
    }
    query.isAvailable = val;
  } else {
    // 🔹 Default: show ONLY records where isAvailable = 0
    query.isAvailable = 0;
  }

  // Base fetch
  const [total, docs] = await Promise.all([
    Missing.countDocuments(query),
    Missing.find(query)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .select({
        _id: 0,
        missingId: 1,
        handle: 1,
        platform: 1,
        brandId: 1,
        note: 1,
        isAvailable: 1,
        createdAt: 1
      })
      .lean()
  ]);

  // Universal search (server-side across fields we have)
  let items = docs;
  if (rawSearch) {
    const rx = new RegExp(escapeRegex(rawSearch), 'i');
    items = items.filter((r) =>
      rx.test(r.handle) ||
      rx.test(r.platform) ||
      rx.test(r.missingId) ||
      rx.test(r.brandId || '') ||
      rx.test(r.note || '') ||
      rx.test(String(r.isAvailable ?? ''))
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


exports.setMissingAvailable = asyncHandler(async (req, res) => {
  const rawMissingId = (req.body?.missingId ?? '').trim();

  if (!rawMissingId) {
    return res.status(400).json({
      status: 'error',
      message: 'missingId is required'
    });
  }

  // Find and update in one go
  const doc = await Missing.findOneAndUpdate(
    { missingId: rawMissingId },
    { $set: { isAvailable: 1 } },
    { new: true }
  )
    .select({
      _id: 0,
      missingId: 1,
      handle: 1,
      platform: 1,
      brandId: 1,
      note: 1,
      isAvailable: 1,
      createdAt: 1,
      updatedAt: 1
    })
    .lean();

  if (!doc) {
    return res.status(404).json({
      status: 'error',
      message: 'Missing record not found for the given missingId'
    });
  }

  return res.json({
    status: 'ok',
    message: 'Missing record marked as available.',
    data: doc
  });
});
