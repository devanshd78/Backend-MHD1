// models/Screenshot.js
const mongoose = require('mongoose');

const ALLOWED_ROLES = ['like', 'comment1', 'comment2', 'reply1', 'reply2'];

const fileSchema = new mongoose.Schema(
  {
    role:   { type: String, enum: ALLOWED_ROLES, required: true },
    phash:  { type: String, required: true },   // hex
    sha256: { type: String, required: true },
    size:   { type: Number },
    mime:   { type: String },
  },
  { _id: false }
);

const screenshotSchema = new mongoose.Schema(
  {
    screenshotId: { type: String, default: () => require('uuid').v4(), unique: true },

    userId: { type: String, ref: 'User', required: true },
    linkId: { type: String, ref: 'Link', required: true },

    // outcome + raw payload for audit
    verified: { type: Boolean, required: true },
    analysis: { type: mongoose.Schema.Types.Mixed },

    // dedupe helpers
    phashes:   [{ type: String, required: true }], // expect 5 items (unique)
    bundleSig: { type: String, required: true },   // sorted join of phashes
    bundleSha: { type: String, required: true },   // sorted join of file sha256s

    // normalized identity + texts (stored distinctly)
    handle:   { type: String },        // normalized like '@someuser' (lowercase)
    comments: [{ type: String }],      // normalized + deduped
    replies:  [{ type: String }],      // normalized + deduped

    files: { type: [fileSchema], required: true },

    createdAt: { type: Date, default: Date.now },
  },
  { minimize: true }
);

// ---------- helpers ----------
function normalizeHandle(h) {
  if (!h) return h;
  h = String(h).trim();
  if (!h.startsWith('@')) h = '@' + h;
  return h.toLowerCase();
}
function normalizeText(s) {
  if (!s) return s;
  return String(s)
    .replace(/\s+/g, ' ')
    .replace(/[^\w'\s]/g, '')
    .trim()
    .toLowerCase();
}
function uniqueStrings(arr) {
  const out = [];
  const seen = new Set();
  for (const s of arr || []) {
    const t = normalizeText(s);
    if (t && !seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

// ---------- validation & derived fields ----------
screenshotSchema.pre('validate', function (next) {
  try {
    // phashes: exactly 5 and all unique
    if (!Array.isArray(this.phashes) || this.phashes.length !== 5) {
      return next(new Error('Exactly 5 phashes required'));
    }
    const phSet = new Set(this.phashes);
    if (phSet.size !== 5) {
      return next(new Error('phashes must be unique (5 distinct)'));
    }

    // files: exactly 5, one per role, unique sha256s
    if (!Array.isArray(this.files) || this.files.length !== 5) {
      return next(new Error('Exactly 5 files required'));
    }
    const roles = new Set(this.files.map((f) => f.role));
    if (roles.size !== ALLOWED_ROLES.length || !ALLOWED_ROLES.every((r) => roles.has(r))) {
      return next(new Error(`files must contain one of each role: ${ALLOWED_ROLES.join(', ')}`));
    }
    const shaSet = new Set(this.files.map((f) => f.sha256));
    if (shaSet.size !== 5) {
      return next(new Error('file sha256 values must be unique (5 distinct)'));
    }

    // compute dedupe signatures
    this.bundleSig = [...phSet].sort().join('|');
    this.bundleSha = [...shaSet].sort().join('|');

    // normalize handle/comments/replies if present
    if (this.handle) this.handle = normalizeHandle(this.handle);
    if (Array.isArray(this.comments)) this.comments = uniqueStrings(this.comments);
    if (Array.isArray(this.replies))  this.replies  = uniqueStrings(this.replies);

    return next();
  } catch (err) {
    return next(err);
  }
});

// ---------- indexes (duplicate prevention) ----------
// Prevent same perceptual bundle on same link by same user
screenshotSchema.index({ userId: 1, linkId: 1, bundleSig: 1 }, { unique: true });

// Prevent same exact files bundle (sha256) on same link by same user
screenshotSchema.index({ userId: 1, linkId: 1, bundleSha: 1 }, { unique: true });

// Prevent double-verified proofs for same handle on same link
// (only applies to documents with verified: true and a non-null handle)
screenshotSchema.index(
  { linkId: 1, handle: 1 },
  { unique: true, partialFilterExpression: { verified: true, handle: { $type: 'string' } } }
);

module.exports = mongoose.model('Screenshot', screenshotSchema);
