// controllers/entryController.js (OpenAI Vision rewrite — no Flask)
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const imghash = require('imghash');
const mongoose = require('mongoose');
const { Types } = mongoose;
const Jimp = require('jimp');
const QrCode = require('qrcode-reader');
const { parse } = require('querystring');
const OpenAI = require('openai').default; // CJS-compatible import

const Entry = require('../models/Entry');
const Link = require('../models/Link');
const Employee = require('../models/Employee');
const User = require('../models/User');
const Screenshot = require('../models/Screenshot');

/* ------------------------ utils & helpers ------------------------ */
const asyncHandler = fn => (req, res, next) => fn(req, res, next).catch(next);
const badRequest = (res, msg) => res.status(400).json({ error: msg });
const notFound = (res, msg) => res.status(404).json({ error: msg });

function isValidUpi(upi) {
  return /^[a-zA-Z0-9_.-]+@[a-zA-Z0-9.-]+$/.test(upi);
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

async function phashBundle(filesByRole) {
  const out = [];
  for (const role of ['like', 'comment1', 'comment2', 'reply1', 'reply2']) {
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

/* ----------------------- OpenAI Vision helper ----------------------- */
function toDataUrl(file) {
  // Converts multer file -> data URL for multi-modal input
  return `data:${file.mimetype};base64,${file.buffer.toString('base64')}`;
}

async function verifyWithOpenAI(filesByRole) {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const primaryModel  = process.env.OPENAI_VISION_MODEL   || 'gpt-4.1-nano';
  const fallbackModel = process.env.OPENAI_VISION_FALLBACK || 'gpt-4.1-mini';

  const roles = ['like', 'comment1', 'comment2', 'reply1', 'reply2'];
  const imgs  = roles.map(r => ({ role: r, url: toDataUrl(filesByRole[r]) }));

  const instructions = `
You are a meticulous vision + OCR analyst for YouTube screenshots.
You will receive exactly 5 images with roles: like, comment1, comment2, reply1, reply2.

Return STRICT JSON (and only JSON) with this exact shape:
{
  "liked": boolean,                        // true if the Like button/state is clearly ON/filled/highlighted
  "user_id": string | null,                // lowercase handle like "@name" if confidently visible; otherwise null
  "comments": [ { "text": string, "handle": string } ],  // ONLY items from the SAME author; set handle=user_id if you’re confident it’s the same author even if the handle text isn’t visible in that image
  "replies":  [ { "text": string, "handle": string } ]   // ONLY items from the SAME author; set handle=user_id if confident via avatar/name/thread context
}

CRITICAL RULES
- PICK ONE AUTHOR: Choose ONE handle as user_id (from any image where a handle is visible). Normalize to lowercase and keep leading "@".
- SAME AUTHOR ONLY: Include ONLY comments/replies authored by that same person. If a later image doesn’t render the handle but you can clearly tell it’s the SAME author (same avatar, same display name, same thread bubble/placement), INCLUDE it and set its handle to user_id (do NOT leave null). If not confident, exclude it.
- CONSERVATIVE OCR: Only include text you can confidently read; preserve original wording/spacing.
- LIMITS: Provide up to TWO comments and up to TWO replies by that same author across all images (pick the clearest). If fewer are visible, include what you can (0..2).
- LIKED: Determine from the 'like' image whether the post/video is clearly liked. If ambiguous, set liked=false.
- DO NOT compute any other fields. Output ONLY the JSON object above.
`;

  const messages = [
    { role: 'system', content: 'You are a precise vision/OCR and UI-state verifier.' },
    {
      role: 'user',
      content: [
        { type: 'text', text: instructions },
        { type: 'text', text: 'Role: like' },
        { type: 'image_url', image_url: { url: imgs.find(i => i.role === 'like').url } },
        { type: 'text', text: 'Role: comment1' },
        { type: 'image_url', image_url: { url: imgs.find(i => i.role === 'comment1').url } },
        { type: 'text', text: 'Role: comment2' },
        { type: 'image_url', image_url: { url: imgs.find(i => i.role === 'comment2').url } },
        { type: 'text', text: 'Role: reply1' },
        { type: 'image_url', image_url: { url: imgs.find(i => i.role === 'reply1').url } },
        { type: 'text', text: 'Role: reply2' },
        { type: 'image_url', image_url: { url: imgs.find(i => i.role === 'reply2').url } },
      ]
    }
  ];

  async function callModel(modelName) {
    const resp = await openai.chat.completions.create({
      model: modelName,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages
    });

    const raw = resp.choices?.[0]?.message?.content || '{}';
    let parsed; try { parsed = JSON.parse(raw); } catch { parsed = {}; }

    const user_id_raw = typeof parsed.user_id === 'string' ? parsed.user_id : null;
    const norm = s => (typeof s === 'string' ? s.trim().toLowerCase() : null);
    const same = (h, uid) => uid && norm(h) === uid;
    const uid = norm(user_id_raw);

    const detailedComments = Array.isArray(parsed.comments) ? parsed.comments : [];
    const detailedReplies  = Array.isArray(parsed.replies)  ? parsed.replies  : [];

    const commentsSameUser = detailedComments
      .filter(it => same(it?.handle, uid))
      .map(it => String(it.text || '').trim())
      .filter(Boolean);

    const repliesSameUser = detailedReplies
      .filter(it => same(it?.handle, uid))
      .map(it => String(it.text || '').trim())
      .filter(Boolean);

    return {
      liked: !!parsed.liked,
      user_id: uid ? user_id_raw.toLowerCase() : null,
      comment: commentsSameUser,
      replies: repliesSameUser,
      verified: false // server recomputes strictly
    };
  }

  // Try primary; if insufficient extraction, try fallback
  const first  = await callModel(primaryModel);
  const good   = first && first.liked === true && typeof first.user_id === 'string' && first.user_id.length > 0 && Array.isArray(first.comment) && first.comment.length >= 2 && Array.isArray(first.replies) && first.replies.length >= 2;
  if (good) return first;
  const second = await callModel(fallbackModel);
  return second; // may or may not be "good"; caller enforces final rules
}

/* ------------------------------------------------------------------ */
/*  1) CREATE by employee (type 0)                                     */
/*     - manual UPI or QR decode                                       */
/* ------------------------------------------------------------------ */
exports.createEmployeeEntry = asyncHandler(async (req, res) => {
  const { name, amount, employeeId, notes = '', upiId: manualUpi } = req.body;
  const { linkId } = req.body;
  if (!name || amount == null || !employeeId || !linkId)
    return badRequest(res, 'employeeId, linkId, name & amount required');

  // determine UPI
  let upiId = manualUpi?.trim();
  if (!upiId && req.file) {
    // decode QR
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

  // prevent duplicate UPI on same link
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
/*     - verify user exists + matches UPI                               */
/* ------------------------------------------------------------------ */
exports.createUserEntry = asyncHandler(async (req, res) => {
  const { userId, linkId, name, worksUnder, upiId } = req.body;

  // ── basic body validation
  if (!userId || !linkId || !name || !worksUnder || !upiId) {
    return res.status(400).json({
      code: 'VALIDATION_ERROR',
      message: 'userId, linkId, name, worksUnder, upiId required'
    });
  }

  // ── linkId format
  if (!Types.ObjectId.isValid(linkId)) {
    return res.status(400).json({
      code: 'INVALID_OBJECT_ID',
      message: 'Invalid linkId format (must be a 24-char hex ObjectId)'
    });
  }

  // ── link existence
  const link = await Link.findById(linkId).lean();
  if (!link) {
    return res.status(404).json({
      code: 'LINK_NOT_FOUND',
      message: 'Invalid linkId'
    });
  }

  // ── UPI format & match (case-insensitive)
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

  // ── files presence + type/size validation
  const roles = ['like', 'comment1', 'comment2', 'reply1', 'reply2'];
  const files = req.files || {};
  const filesByRole = Object.fromEntries(roles.map(r => [r, files[r]?.[0]]));

  const missing = roles.filter(r => !filesByRole[r]);
  if (missing.length) {
    return res.status(400).json({
      code: 'MISSING_IMAGES',
      message: 'Upload exactly 5 images: like, comment1, comment2, reply1, reply2',
      missing
    });
  }

  const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp'];
  const MAX_SIZE = 10 * 1024 * 1024; // 10MB
  const typeErrors = [];
  const sizeErrors = [];
  for (const r of roles) {
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

  // ── pHash + sha256 for the 5 images
  let hashed;
  try {
    // [{ role, phash, sha256, size, mime }]
    hashed = await phashBundle(filesByRole);
  } catch (e) {
    console.error('phashBundle error:', e);
    return res.status(500).json({ code: 'PHASH_ERROR', message: 'Image processing failed. Please try again.' });
  }
  const phashes  = hashed.map(h => h.phash);
  const sha256s  = hashed.map(h => h.sha256);
  const bundleSig = [...phashes].sort().join('|'); // perceptual signature
  const bundleSha = [...sha256s].sort().join('|'); // exact-file signature

  // ── near-duplicate (Hamming) guard for same user (t = 6)
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

  // ── quick “≥4/5 files reused” guard for same user+link
  try {
    const reuse = await Screenshot.aggregate([
      { $match: { userId, linkId } },
      { $unwind: '$files' },
      { $match: { 'files.sha256': { $in: sha256s } } },
      { $count: 'n' }
    ]);
    const reusedCount = reuse?.[0]?.n || 0;
    if (reusedCount >= 4) {
      return res.status(409).json({
        code: 'NEAR_DUPLICATE',
        message: 'These screenshots largely match a previous submission. Please capture fresh screenshots.',
        details: { reusedCount }
      });
    }
  } catch (e) {
    console.error('Reuse-count check error:', e);
    // non-fatal → continue
  }

  // ── run ChatGPT Vision analyzer (OCR + like)
  let analysis;
  try {
    analysis = await verifyWithOpenAI(filesByRole);
  } catch (e) {
    console.error('OpenAI analyzer error:', e);
    return res.status(502).json({ code: 'ANALYZER_ERROR', message: 'Verification service error. Please try again.' });
  }

  // ── stable analysis payload
  const analysisPayload = {
    liked: !!analysis.liked,
    user_id: analysis.user_id ?? null,
    comment: Array.isArray(analysis.comment) ? analysis.comment : [],
    replies: Array.isArray(analysis.replies) ? analysis.replies : [],
    verified: false // will be recomputed strictly below
  };

  // Enforce SAME-USER requirement strictly on our side too
  const hasHandle = typeof analysisPayload.user_id === 'string' && analysisPayload.user_id.trim().length > 0;
  const meetsCounts = analysisPayload.comment.length >= 2 && analysisPayload.replies.length >= 2;
  analysisPayload.verified = !!analysisPayload.liked && !!hasHandle && meetsCounts;

  if (!analysisPayload.verified) {
    return res.status(422).json({
      code: 'VERIFICATION_FAILED',
      message: 'Screenshot verification failed. Please upload clearer screenshots.',
      details: {
        liked: analysisPayload.liked,
        user_id: analysisPayload.user_id,
        commentCount: analysisPayload.comment.length,
        replyCount: analysisPayload.replies.length,
        needed: { minComments: 2, minReplies: 2, liked: true, sameUser: true, handleRequired: true }
      },
      verification: analysisPayload
    });
  }

  // ── persist Screenshot bundle
  let screenshotDoc;
  try {
    screenshotDoc = await Screenshot.create({
      userId,
      linkId,
      verified: true,
      analysis: analysisPayload,              // raw audit payload
      handle: analysisPayload.user_id || null,
      comments: analysisPayload.comment,
      replies: analysisPayload.replies,
      phashes,
      bundleSig,
      bundleSha,
      files: hashed                           // [{ role, phash, sha256, size, mime }]
    });
  } catch (e) {
    console.error('Screenshot.create error:', e);
    if (e && e.code === 11000) {
      const msg = String(e.message || '');
      if (msg.includes('bundleSig')) {
        return res.status(409).json({
          code: 'DUPLICATE_BUNDLE_SIG',
          message: 'A matching screenshot bundle (perceptual) already exists for this link.'
        });
      }
      if (msg.includes('bundleSha')) {
        return res.status(409).json({
          code: 'DUPLICATE_BUNDLE_SHA',
          message: 'This exact set of image files was already submitted for this link.'
        });
      }
      if (msg.includes('handle') && msg.includes('linkId')) {
        return res.status(409).json({
          code: 'HANDLE_ALREADY_VERIFIED',
          message: 'This handle has already been verified for this video.'
        });
      }
      return res.status(409).json({
        code: 'DUPLICATE_KEY',
        message: 'A similar submission already exists.'
      });
    }
    return res.status(500).json({
      code: 'SCREENSHOT_PERSIST_ERROR',
      message: 'Could not persist screenshots. Please try again.'
    });
  }

  // ── compute amounts
  const linkAmount  = Number(link.amount) || 0;
  const totalAmount = linkAmount;

  // ── save Entry
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
    return res.status(500).json({
      code: 'ENTRY_PERSIST_ERROR',
      message: 'Could not save your entry. Please try again.'
    });
  }

  return res.status(201).json({
    message: 'User entry submitted',
    verification: analysisPayload,
    entry
  });
});

/* ------------------------------------------------------------------ */
/*  3) READ / LIST (type-aware, optional link filter)                  */
/*     ➜ POST /entries/list                                           */
/* ------------------------------------------------------------------ */
exports.listEntries = asyncHandler(async (req, res) => {
  const { employeeId, page = 1, limit = 20 } = req.body;
  if (!employeeId) return badRequest(res, 'employeeId required');

  const filter = { employeeId };  // grabs all entries for this employee

  const [entries, total] = await Promise.all([
    Entry.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(Number(limit))
      .lean(),
    Entry.countDocuments(filter)
  ]);

  return res.json({
    entries,             // each entry still carries its `type` field
    total,               // total matches for pagination
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
/*  5) UPDATE – employee can edit name/UPI/amount/notes                */
/*             user can only change head-count                         */
/* ------------------------------------------------------------------ */
exports.updateEntry = asyncHandler(async (req, res) => {
  const { entryId, name, upiId, notes, amount, noOfPersons } = req.body;
  if (!entryId) return badRequest(res, 'entryId required');

  const entry = await Entry.findOne({ entryId });
  if (!entry) return notFound(res, 'Entry not found');

  const changes = [];

  if (entry.type === 0) {
    // Employee flow
    if (!name || !upiId || amount == null)
      return badRequest(res, 'name, upiId & amount required for employee entries');
    if (!isValidUpi(upiId.trim()))
      return badRequest(res, 'Invalid UPI format');

    const emp = await Employee.findOne({ employeeId: entry.employeeId });
    if (!emp) return notFound(res, 'Employee not found');

    // Track name change
    const trimmedName = name.trim();
    if (entry.name !== trimmedName) {
      changes.push({ field: 'name', from: entry.name, to: trimmedName });
      entry.name = trimmedName;
    }

    // Track UPI change
    const trimmedUpi = upiId.trim();
    if (entry.upiId !== trimmedUpi) {
      changes.push({ field: 'upiId', from: entry.upiId, to: trimmedUpi });
      entry.upiId = trimmedUpi;
    }

    // Track notes change
    const newNotes = (notes || '').trim();
    if (entry.notes !== newNotes) {
      changes.push({ field: 'notes', from: entry.notes, to: newNotes });
      entry.notes = newNotes;
    }

    // Track amount & adjust balance
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
    // User flow
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

  // Set update flag if any changes and record history
  if (changes.length) {
    entry.isUpdated = 1;
    const timestamp = new Date();
    changes.forEach(c => {
      entry.history.push({ ...c, updatedAt: timestamp });
    });
  }

  // Save and respond
  await entry.save();
  res.json({
    message: changes.length ? 'Entry updated' : 'No changes detected',
    entry
  });
});

/* ------------------------------------------------------------------ */
/*  6) APPROVE / REJECT                                               */
/* ------------------------------------------------------------------ */
exports.setEntryStatus = asyncHandler(async (req, res) => {
  const { entryId, approve } = req.body;
  if (!entryId)
    return badRequest(res, 'entryId required');
  const newStatus = Number(approve);
  if (![0, 1].includes(newStatus))
    return badRequest(res, 'approve must be 0 or 1');

  // 1) Load the entry once
  const entry = await Entry.findOne({ entryId });
  if (!entry)
    return notFound(res, 'Entry not found');

  // 2) If it already has that status, bail out immediately
  if (entry.status === newStatus) {
    return res.json({
      message: newStatus
        ? 'Already approved'
        : 'Already rejected',
      entry: { entryId, status: entry.status }
    });
  }

  // 3) If approving, handle deduction first
  if (newStatus === 1) {
    let deduction, targetEmpId;

    if (entry.type === 0 && entry.employeeId) {
      deduction   = entry.amount;
      targetEmpId = entry.employeeId;
    }
    else if (entry.type === 1 && entry.worksUnder) {
      deduction   = entry.totalAmount;
      targetEmpId = entry.worksUnder;
    }

    if (typeof deduction !== 'number' || !targetEmpId) {
      return badRequest(res, 'Cannot determine deduction or employee');
    }

    // 3a) Load employee and check balance
    const employee = await Employee.findOne({ employeeId: targetEmpId });
    if (!employee)
      return notFound(res, 'Employee to debit not found');
    if (employee.balance < deduction) {
      return badRequest(res, 'Insufficient balance. Please add funds before approval.');
    }

    // 3b) Deduct
    await Employee.updateOne(
      { employeeId: targetEmpId },
      { $inc: { balance: -deduction } }
    );
  }

  // 4) Now flip the entry’s status exactly once
  const updatedEntry = await Entry.findOneAndUpdate(
    { entryId, status: { $ne: newStatus } },    // only update if status is different
    { status: newStatus },
    { new: true }
  );
  // should never be null, because we already checked above, but just in case:
  if (!updatedEntry) {
    return res.json({
      message: newStatus
        ? 'Already approved'
        : 'Already rejected',
      entry: { entryId, status: newStatus }
    });
  }

  // 5) Respond
  const payload = {
    message: newStatus ? 'Approved' : 'Rejected',
    entry:   { entryId, status: newStatus }
  };

  // If we did an approval deduction, fetch the fresh balance:
  if (newStatus === 1) {
    const emp = await Employee.findOne({ employeeId:
      entry.type === 0 ? entry.employeeId : entry.worksUnder
    }).select('balance');
    payload.newBalance = emp.balance;
  }

  res.json(payload);
});

/* ------------------------------------------------------------------ */
/*  LIST – employee + specific link, POST /entries/listByLink         */
/*     Body: { employeeId, linkId, page?, limit? }                    */
/* ------------------------------------------------------------------ */
exports.listEntriesByLink = asyncHandler(async (req, res) => {
  const { employeeId, linkId, page = 1, limit = 20 } = req.body;
  if (!employeeId) return badRequest(res, 'employeeId required');
  if (!linkId)    return badRequest(res, 'linkId required');

  // match either the old worksUnder field or the new employeeId
  const filter = {
    linkId,
    $or: [{ employeeId }, { worksUnder: employeeId }]
  };

  // 1) page of entries
  const [entries, total] = await Promise.all([
    Entry.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(Number(limit))
      .lean(),
    Entry.countDocuments(filter)
  ]);

  // 1a) fetch screenshots for entries that reference one
  const screenshotIds = entries.map(e => e.screenshotId).filter(Boolean);
  let screenshotsById = {};
  if (screenshotIds.length) {
    const screenshots = await Screenshot.find({ screenshotId: { $in: screenshotIds } })
      // SAFE projection: no pHashes, no file hashes, no bundleSig
      .select('screenshotId userId linkId verified analysis createdAt')
      .lean();
    screenshotsById = Object.fromEntries(
      screenshots.map(s => [s.screenshotId, s])
    );
  }

  // 1b) attach screenshot docs where available
  const entriesWithScreenshots = entries.map(e => {
    if (e.screenshotId && screenshotsById[e.screenshotId]) {
      return { ...e, screenshot: screenshotsById[e.screenshotId] };
    }
    return e;
  });

  // 2) compute grandTotal across all matching docs
  const agg = await Entry.aggregate([
    { $match: filter },
    {
      $group: {
        _id: null,
        grandTotal: { $sum: { $ifNull: ["$totalAmount", "$amount"] } }
      }
    }
  ]);
  const grandTotal = agg[0]?.grandTotal ?? 0;

  // 3) return results + pagination + grandTotal
  return res.json({
    entries: entriesWithScreenshots,
    total,
    page: Number(page),
    pages: Math.ceil(total / limit),
    grandTotal
  });
});
