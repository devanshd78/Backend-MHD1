// controllers/entryController.js (Flask analyzer version) — UPDATED
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const imghash = require('imghash');
const mongoose = require('mongoose');
const { Types } = mongoose;
const Jimp = require('jimp');
const QrCode = require('qrcode-reader');
const { parse } = require('querystring');

const axios = require('axios');
const FormData = require('form-data');

const Entry = require('../models/Entry');
const Link = require('../models/Link');
const Employee = require('../models/Employee');
const User = require('../models/User');
const Screenshot = require('../models/Screenshot');

/* ------------------------ utils & helpers ------------------------ */
const asyncHandler = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const badRequest = (res, msg) => res.status(400).json({ error: msg });
const notFound = (res, msg) => res.status(404).json({ error: msg });

function isValidUpi(upi) {
  return /^[a-zA-Z0-9_.-]+@[a-zA-Z0-9.-]+$/.test(upi);
}

const clamp02 = (v, def) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.max(0, Math.min(2, Math.floor(n)));
};

function toBool(v, def = false) {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v === 1;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (['1', 'true', 'yes', 'y'].includes(s)) return true;
    if (['0', 'false', 'no', 'n'].includes(s)) return false;
  }
  return def;
}

/* -------------------- pHash + dedupe helpers -------------------- */
const NIBBLE_POP = [0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4];

function hexHamming(a, b) {
  const len = Math.max(a.length, b.length);
  a = a.padStart(len, '0');
  b = b.padStart(len, '0');
  let dist = 0;
  for (let i = 0; i < len; i++) {
    const x = (parseInt(a[i], 16) ^ parseInt(b[i], 16)) & 0xF;
    dist += NIBBLE_POP[x];
  }
  return dist;
}

function computeSha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

async function computePhash(buf) {
  // 16x16 perceptual hash, hex output
  return imghash.hash(buf, 16);
}

async function phashBundle(filesByRole, roles) {
  const out = [];
  for (const role of roles) {
    const f = filesByRole[role];
    if (!f) throw new Error(`Missing file: ${role}`);
    const phash = await computePhash(f.buffer, f.mimetype);
    const sha = computeSha256(f.buffer);
    out.push({ role, phash, sha256: sha, size: f.size, mime: f.mimetype });
  }
  return out;
}

async function isDuplicateForUser(userId, phashes, hammingThreshold = 6) {
  const prev = await Screenshot.find({ userId }).select('phashes').lean();
  const seen = prev.flatMap(p => p.phashes || []);
  if (!seen.length) return false;

  for (const h of phashes) {
    for (const old of seen) {
      if (hexHamming(h, old) <= hammingThreshold) return true;
    }
  }
  return false;
}

/* ----------------------- Flask analyzer helper ----------------------- */
const FLASK_ANALYZER_URL = process.env.FLASK_ANALYZER_URL || 'http://127.0.0.1:6000/analyze';
const FLASK_TIMEOUT_MS = Number(process.env.FLASK_TIMEOUT_MS || 45000);

function mimeToExt(mime) {
  if (mime === 'image/png') return 'png';
  if (mime === 'image/webp') return 'webp';
  return 'jpg';
}

/**
 * IMPORTANT UPDATES:
 * - Sends the "like" image too (if present) so flask can compute liked.
 * - Passes min_comments, min_replies, require_like via query string.
 * - Only sends the images you actually have (presentRoles) + required ones.
 */
async function verifyWithFlask(
  filesByRole,
  {
    debug = false,
    minComments = 2,
    minReplies = 2,
    requireLike = false,
    presentRoles = ['like', 'comment1', 'comment2', 'reply1', 'reply2']
  } = {}
) {
  const form = new FormData();

  for (const role of presentRoles) {
    const f = filesByRole[role];
    if (!f) continue;
    form.append(role, f.buffer, {
      filename: `${role}.${mimeToExt(f.mimetype)}`,
      contentType: f.mimetype,
      knownLength: f.size
    });
  }

  const contentLength = await new Promise((resolve, reject) => {
    form.getLength((err, length) => (err ? reject(err) : resolve(length)));
  });

  const qs =
    `min_comments=${encodeURIComponent(minComments)}` +
    `&min_replies=${encodeURIComponent(minReplies)}` +
    `&require_like=${requireLike ? 1 : 0}` +
    (debug ? `&debug=1` : ``);

  const url = `${FLASK_ANALYZER_URL}?${qs}`;

  const resp = await axios.post(url, form, {
    headers: { ...form.getHeaders(), 'Content-Length': contentLength },
    timeout: FLASK_TIMEOUT_MS,
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
    validateStatus: () => true
  });

  // Treat 422 as "verification failed" (normal analyzer response)
  if (resp.status === 422) {
    return resp.data || {};
  }

  if (resp.status < 200 || resp.status >= 300) {
    const msg = resp?.data?.message || resp?.data?.error || `Flask analyzer HTTP ${resp.status}`;
    const err = new Error(msg);
    err.status = resp.status;
    err.payload = resp.data;
    throw err;
  }

  return resp.data || {};
}

/* ------------------------------------------------------------------ */
/*  1) CREATE by employee (type 0)                                     */
/* ------------------------------------------------------------------ */
exports.createEmployeeEntry = asyncHandler(async (req, res) => {
  const { name, amount, employeeId, notes = '', upiId: manualUpi } = req.body;
  const { linkId } = req.body;
  if (!name || amount == null || !employeeId || !linkId)
    return badRequest(res, 'employeeId, linkId, name & amount required');

  let upiId = manualUpi?.trim();

  if (!upiId && req.file) {
    try {
      const img = await Jimp.read(req.file.buffer);
      const upiString = await new Promise((resolve, reject) => {
        const qr = new QrCode();
        let done = false;
        qr.callback = (err, value) => {
          if (done) return;
          done = true;
          if (err || !value) return reject(new Error('QR decode failed'));
          resolve(value.result);
        };
        qr.decode(img.bitmap);
        setTimeout(() => !done && reject(new Error('QR decode timeout')), 5000);
      });

      upiId = upiString.startsWith('upi://')
        ? parse(upiString.split('?')[1]).pa
        : upiString.trim();
    } catch (e) {
      return badRequest(res, 'Invalid or unreadable QR code');
    }
  }

  if (!upiId) return badRequest(res, 'UPI ID is required');
  if (!isValidUpi(upiId)) return badRequest(res, 'Invalid UPI format');

  const emp = await Employee.findOne({ employeeId });
  if (!emp) return notFound(res, 'Employee not found');
  if (emp.balance < amount) return badRequest(res, 'Insufficient balance');

  if (await Entry.exists({ linkId, upiId }))
    return badRequest(res, 'This UPI ID has already been used for this link');

  const entry = await Entry.create({
    entryId: uuidv4(),
    type: 0,
    employeeId,
    linkId,
    name: name.trim(),
    upiId,
    amount,
    notes: notes.trim()
  });

  emp.balance -= amount;
  await emp.save();

  res.status(201).json({ message: 'Employee entry submitted', entry });
});

/* ------------------------------------------------------------------ */
/*  2) CREATE by user (type 1)                                         */
/*     - verify user exists + matches UPI                              */
/*     - dedupe + flask OCR/like verify                                */
/* ------------------------------------------------------------------ */
exports.createUserEntry = asyncHandler(async (req, res) => {
  const { userId, linkId, name, worksUnder, upiId } = req.body;

  if (!userId || !linkId || !name || !worksUnder || !upiId) {
    return res.status(400).json({
      code: 'VALIDATION_ERROR',
      message: 'userId, linkId, name, worksUnder, upiId required'
    });
  }

  if (!Types.ObjectId.isValid(linkId)) {
    return res.status(400).json({
      code: 'INVALID_OBJECT_ID',
      message: 'Invalid linkId format (must be a 24-char hex ObjectId)'
    });
  }

  const link = await Link.findById(linkId).lean();
  if (!link) {
    return res.status(404).json({
      code: 'LINK_NOT_FOUND',
      message: 'Invalid linkId'
    });
  }

  const normalizedReqUpi = String(upiId).trim().toLowerCase();
  if (!isValidUpi(normalizedReqUpi)) {
    return res.status(400).json({ code: 'INVALID_UPI', message: 'Invalid UPI format' });
  }

  const user = await User.findOne({ userId }).lean();
  if (!user) {
    return res.status(404).json({ code: 'USER_NOT_FOUND', message: 'User not found' });
  }

  const normalizedUserUpi = String(user.upiId || '').trim().toLowerCase();
  if (normalizedUserUpi !== normalizedReqUpi) {
    return res.status(400).json({ code: 'UPI_MISMATCH', message: 'Provided UPI does not match your account' });
  }

  // Rules come from Link (defaults if missing)
  const minComments = clamp02(link.minComments, 2);
  const minReplies = clamp02(link.minReplies, 2);
  const requireLike = toBool(link.requireLike, false);

  if (minComments === 0 && minReplies === 0) {
    return res.status(400).json({
      code: 'INVALID_RULES',
      message: 'Link rules invalid: minComments and minReplies cannot both be 0'
    });
  }

  const requiredRoles = [];
  if (requireLike) requiredRoles.push('like');
  if (minComments >= 1) requiredRoles.push('comment1');
  if (minComments >= 2) requiredRoles.push('comment2');
  if (minReplies >= 1) requiredRoles.push('reply1');
  if (minReplies >= 2) requiredRoles.push('reply2');

  const ALL_ROLES = ['like', 'comment1', 'comment2', 'reply1', 'reply2'];
  const files = req.files || {};
  const filesByRole = Object.fromEntries(ALL_ROLES.map(r => [r, files[r]?.[0]]));

  const missing = requiredRoles.filter(r => !filesByRole[r]);
  if (missing.length) {
    return res.status(400).json({
      code: 'MISSING_IMAGES',
      message: 'Missing required images for this link rules',
      required: requiredRoles,
      missing,
      rules: { minComments, minReplies, requireLike }
    });
  }

  const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp'];
  const MAX_SIZE = 10 * 1024 * 1024;
  const typeErrors = [];
  const sizeErrors = [];

  // validate only uploaded images
  const presentRoles = ALL_ROLES.filter(r => filesByRole[r]);
  for (const r of presentRoles) {
    const f = filesByRole[r];
    if (!ALLOWED_MIME.includes(f.mimetype)) typeErrors.push({ role: r, mimetype: f.mimetype });
    if (typeof f.size === 'number' && f.size > MAX_SIZE) sizeErrors.push({ role: r, size: f.size, max: MAX_SIZE });
  }

  if (typeErrors.length || sizeErrors.length) {
    return res.status(400).json({
      code: 'INVALID_IMAGE_FILES',
      message: 'One or more images are of unsupported type or exceed size limit',
      typeErrors,
      sizeErrors,
      allowed: ALLOWED_MIME,
      maxBytes: MAX_SIZE
    });
  }

  // pHash + sha for uploaded images
  let hashed;
  try {
    hashed = await phashBundle(filesByRole, presentRoles);
  } catch (e) {
    console.error('phashBundle error:', e);
    return res.status(500).json({ code: 'PHASH_ERROR', message: 'Image processing failed. Please try again.' });
  }

  const phashes = hashed.map(h => h.phash);
  const sha256s = hashed.map(h => h.sha256);
  const bundleSig = [...phashes].sort().join('|');
  const bundleSha = [...sha256s].sort().join('|');

  // near-duplicate check
  try {
    const isDup = await isDuplicateForUser(userId, phashes, 6);
    if (isDup) {
      return res.status(409).json({
        code: 'NEAR_DUPLICATE',
        message: 'These screenshots are too similar to a previous upload. Please capture fresh screenshots.'
      });
    }
  } catch (e) {
    console.error('Duplicate check error:', e);
    return res.status(500).json({ code: 'DUP_CHECK_ERROR', message: 'Duplicate check failed. Please try again.' });
  }

  // reuse guard
  try {
    const linkObj = new mongoose.Types.ObjectId(linkId);
    const reuse = await Screenshot.aggregate([
      { $match: { userId, $or: [{ linkId }, { linkId: linkObj }] } },
      { $unwind: '$files' },
      { $match: { 'files.sha256': { $in: sha256s } } },
      { $count: 'n' }
    ]);

    const reusedCount = reuse?.[0]?.n || 0;
    const reuseThreshold = Math.max(presentRoles.length - 1, 2);

    if (reusedCount >= reuseThreshold) {
      return res.status(409).json({
        code: 'NEAR_DUPLICATE',
        message: 'These screenshots largely match a previous submission. Please capture fresh screenshots.',
        details: { reusedCount, reuseThreshold }
      });
    }
  } catch (e) {
    console.error('Reuse-count check error:', e);
    // non-fatal
  }

  // Flask verify (send present roles; rules via query params)
  let analysis;
  const debug = req.query?.debug === '1' || process.env.FLASK_DEBUG === '1';

  try {
    analysis = await verifyWithFlask(filesByRole, {
      debug,
      minComments,
      minReplies,
      requireLike,
      presentRoles
    });
  } catch (e) {
    console.error('Flask analyzer error:', e?.message || e);
    return res.status(502).json({
      code: 'ANALYZER_ERROR',
      message: 'Verification service error. Please try again.',
      details: {
        upstreamStatus: e?.status || null,
        upstream: e?.payload || null
      }
    });
  }

  const rules = analysis?.rules || { min_comments: minComments, min_replies: minReplies, require_like: requireLike };

  // IMPORTANT: do NOT force liked=true when requireLike=false; keep analyzer output for UI/debug
const analysisPayload = {
  liked: typeof analysis?.liked === 'boolean' ? analysis.liked : false,
  like_provided: !!analysis?.like_provided,
  user_id: analysis?.user_id ?? null,
  comment: Array.isArray(analysis?.comment) ? analysis.comment : [],
  replies: Array.isArray(analysis?.replies) ? analysis.replies : [],
  reasons: Array.isArray(analysis?.reasons) ? analysis.reasons : [],
  verified: typeof analysis?.verified === 'boolean' ? analysis.verified : false,
  rules: {
    min_comments: Number(rules.min_comments ?? minComments),
    min_replies: Number(rules.min_replies ?? minReplies),
    require_like: !!(rules.require_like ?? requireLike)
  }
};

  const hasHandle = typeof analysisPayload.user_id === 'string' && analysisPayload.user_id.trim().length > 0;
  const meetsCounts =
    analysisPayload.comment.length >= analysisPayload.rules.min_comments &&
    analysisPayload.replies.length >= analysisPayload.rules.min_replies;

  const meetsLike = analysisPayload.rules.require_like ? !!analysisPayload.liked : true;

  analysisPayload.verified = !!(hasHandle && meetsCounts && meetsLike);

if (!analysisPayload.verified) {
  return res.status(422).json({
    code: 'VERIFICATION_FAILED',
    message: 'Screenshot verification failed. Please upload clearer screenshots.',
    details: {
      user_id: analysisPayload.user_id,
      reasons: analysisPayload.reasons,
      analyzerMessage: analysis?.message || null,
      liked: analysisPayload.liked,
      like_provided: analysisPayload.like_provided
    },
    verification: analysisPayload
  });
}

  // persist Screenshot
  let screenshotDoc;
  try {
    screenshotDoc = await Screenshot.create({
      userId,
      linkId,
      verified: true,
      analysis: analysisPayload,
      handle: analysisPayload.user_id || null,
      comments: analysisPayload.comment,
      replies: analysisPayload.replies,
      needed: { minComments, minReplies, requireLike },
      phashes,
      bundleSig,
      bundleSha,
      files: hashed
    });
  } catch (e) {
    console.error('Screenshot.create error:', e);
    if (e && e.code === 11000) {
      const msg = String(e.message || '');
      if (msg.includes('bundleSig')) {
        return res.status(409).json({ code: 'DUPLICATE_BUNDLE_SIG', message: 'A matching screenshot bundle already exists for this link.' });
      }
      if (msg.includes('bundleSha')) {
        return res.status(409).json({ code: 'DUPLICATE_BUNDLE_SHA', message: 'This exact set of image files was already submitted for this link.' });
      }
      if (msg.includes('handle') && msg.includes('linkId')) {
        return res.status(409).json({ code: 'HANDLE_ALREADY_VERIFIED', message: 'This handle has already been verified for this video.' });
      }
      return res.status(409).json({ code: 'DUPLICATE_KEY', message: 'A similar submission already exists.' });
    }
    return res.status(500).json({ code: 'SCREENSHOT_PERSIST_ERROR', message: 'Could not persist screenshots. Please try again.' });
  }

  // amounts
  const linkAmount = Number(link.amount) || 0;
  const totalAmount = linkAmount;

  // create Entry
  let entry;
  try {
    entry = await Entry.create({
      entryId: uuidv4(),
      type: 1,
      userId,
      linkId,
      name: String(name).trim(),
      worksUnder: String(worksUnder).trim(),
      upiId: normalizedReqUpi,
      linkAmount,
      totalAmount,
      screenshotId: screenshotDoc.screenshotId
    });
  } catch (e) {
    console.error('Entry.create error:', e);
    return res.status(500).json({ code: 'ENTRY_PERSIST_ERROR', message: 'Could not save your entry. Please try again.' });
  }

  return res.status(201).json({
    message: 'User entry submitted',
    rules: { minComments, minReplies, requireLike },
    verification: analysisPayload,
    entry
  });
});

/* ------------------------------------------------------------------ */
/*  3) READ / LIST                                                     */
/* ------------------------------------------------------------------ */
exports.listEntries = asyncHandler(async (req, res) => {
  const { employeeId, page = 1, limit = 20 } = req.body;
  if (!employeeId) return badRequest(res, 'employeeId required');

  const filter = { employeeId };

  const [entries, total] = await Promise.all([
    Entry.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(Number(limit))
      .lean(),
    Entry.countDocuments(filter)
  ]);

  return res.json({
    entries,
    total,
    page: Number(page),
    pages: Math.ceil(total / limit)
  });
});

/* ------------------------------------------------------------------ */
/*  4) FETCH single by entryId                                         */
/* ------------------------------------------------------------------ */
exports.getEntryById = asyncHandler(async (req, res) => {
  const { entryId } = req.params;
  const entry = await Entry.findOne({ entryId }).lean();
  if (!entry) return notFound(res, 'Entry not found');
  res.json({ entry });
});

/* ------------------------------------------------------------------ */
/*  5) UPDATE                                                         */
/* ------------------------------------------------------------------ */
exports.updateEntry = asyncHandler(async (req, res) => {
  const { entryId, name, upiId, notes, amount, noOfPersons } = req.body;
  if (!entryId) return badRequest(res, 'entryId required');

  const entry = await Entry.findOne({ entryId });
  if (!entry) return notFound(res, 'Entry not found');

  const changes = [];

  if (entry.type === 0) {
    if (!name || !upiId || amount == null)
      return badRequest(res, 'name, upiId & amount required for employee entries');
    if (!isValidUpi(upiId.trim()))
      return badRequest(res, 'Invalid UPI format');

    const emp = await Employee.findOne({ employeeId: entry.employeeId });
    if (!emp) return notFound(res, 'Employee not found');

    const trimmedName = name.trim();
    if (entry.name !== trimmedName) {
      changes.push({ field: 'name', from: entry.name, to: trimmedName });
      entry.name = trimmedName;
    }

    const trimmedUpi = upiId.trim();
    if (entry.upiId !== trimmedUpi) {
      changes.push({ field: 'upiId', from: entry.upiId, to: trimmedUpi });
      entry.upiId = trimmedUpi;
    }

    const newNotes = (notes || '').trim();
    if (entry.notes !== newNotes) {
      changes.push({ field: 'notes', from: entry.notes, to: newNotes });
      entry.notes = newNotes;
    }

    if (entry.amount !== amount) {
      const diff = amount - entry.amount;
      if (diff > 0 && emp.balance < diff)
        return badRequest(res, 'Insufficient balance');
      changes.push({ field: 'amount', from: entry.amount, to: amount });
      entry.amount = amount;
      emp.balance -= diff;
      await emp.save();
    }
  } else {
    if (noOfPersons == null)
      return badRequest(res, 'noOfPersons required for user entries');

    const newCount = Number(noOfPersons);

    if (entry.noOfPersons !== newCount) {
      changes.push({ field: 'noOfPersons', from: entry.noOfPersons, to: newCount });
      entry.noOfPersons = newCount;
    }

    const newTotal = newCount * entry.linkAmount;
    if (entry.totalAmount !== newTotal) {
      changes.push({ field: 'totalAmount', from: entry.totalAmount, to: newTotal });
      entry.totalAmount = newTotal;
    }
  }

  if (changes.length) {
    entry.isUpdated = 1;
    const timestamp = new Date();
    changes.forEach(c => entry.history.push({ ...c, updatedAt: timestamp }));
  }

  await entry.save();
  res.json({ message: changes.length ? 'Entry updated' : 'No changes detected', entry });
});

/* ------------------------------------------------------------------ */
/*  6) APPROVE / REJECT                                               */
/* ------------------------------------------------------------------ */
exports.setEntryStatus = asyncHandler(async (req, res) => {
  const { entryId, approve } = req.body;
  if (!entryId) return badRequest(res, 'entryId required');

  const newStatus = Number(approve);
  if (![0, 1].includes(newStatus))
    return badRequest(res, 'approve must be 0 or 1');

  const entry = await Entry.findOne({ entryId });
  if (!entry) return notFound(res, 'Entry not found');

  if (entry.status === newStatus) {
    return res.json({
      message: newStatus ? 'Already approved' : 'Already rejected',
      entry: { entryId, status: entry.status }
    });
  }

  if (newStatus === 1) {
    let deduction, targetEmpId;

    if (entry.type === 0 && entry.employeeId) {
      deduction = entry.amount;
      targetEmpId = entry.employeeId;
    } else if (entry.type === 1 && entry.worksUnder) {
      deduction = entry.totalAmount;
      targetEmpId = entry.worksUnder;
    }

    if (typeof deduction !== 'number' || !targetEmpId) {
      return badRequest(res, 'Cannot determine deduction or employee');
    }

    const employee = await Employee.findOne({ employeeId: targetEmpId });
    if (!employee) return notFound(res, 'Employee to debit not found');
    if (employee.balance < deduction) {
      return badRequest(res, 'Insufficient balance. Please add funds before approval.');
    }

    await Employee.updateOne(
      { employeeId: targetEmpId },
      { $inc: { balance: -deduction } }
    );
  }

  const updatedEntry = await Entry.findOneAndUpdate(
    { entryId, status: { $ne: newStatus } },
    { status: newStatus },
    { new: true }
  );

  if (!updatedEntry) {
    return res.json({
      message: newStatus ? 'Already approved' : 'Already rejected',
      entry: { entryId, status: newStatus }
    });
  }

  const payload = {
    message: newStatus ? 'Approved' : 'Rejected',
    entry: { entryId, status: newStatus }
  };

  if (newStatus === 1) {
    const emp = await Employee.findOne({
      employeeId: entry.type === 0 ? entry.employeeId : entry.worksUnder
    }).select('balance');
    payload.newBalance = emp.balance;
  }

  res.json(payload);
});

/* ------------------------------------------------------------------ */
/*  LIST – employee + specific link, POST /entries/listByLink         */
/* ------------------------------------------------------------------ */
exports.listEntriesByLink = asyncHandler(async (req, res) => {
  const { employeeId, linkId, page = 1, limit = 20 } = req.body;
  if (!employeeId) return badRequest(res, 'employeeId required');
  if (!linkId) return badRequest(res, 'linkId required');

  const filter = {
    linkId,
    $or: [{ employeeId }, { worksUnder: employeeId }]
  };

  const [entries, total] = await Promise.all([
    Entry.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(Number(limit))
      .lean(),
    Entry.countDocuments(filter)
  ]);

  const screenshotIds = entries.map(e => e.screenshotId).filter(Boolean);
  let screenshotsById = {};
  if (screenshotIds.length) {
    const screenshots = await Screenshot.find({ screenshotId: { $in: screenshotIds } })
      .select('screenshotId userId linkId verified analysis createdAt')
      .lean();
    screenshotsById = Object.fromEntries(screenshots.map(s => [s.screenshotId, s]));
  }

  const entriesWithScreenshots = entries.map(e => {
    if (e.screenshotId && screenshotsById[e.screenshotId]) {
      return { ...e, screenshot: screenshotsById[e.screenshotId] };
    }
    return e;
  });

  const agg = await Entry.aggregate([
    { $match: filter },
    {
      $group: {
        _id: null,
        grandTotal: { $sum: { $ifNull: ['$totalAmount', '$amount'] } }
      }
    }
  ]);

  const grandTotal = agg[0]?.grandTotal ?? 0;

  return res.json({
    entries: entriesWithScreenshots,
    total,
    page: Number(page),
    pages: Math.ceil(total / limit),
    grandTotal
  });
});
