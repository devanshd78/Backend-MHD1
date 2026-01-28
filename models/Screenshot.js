// models/Screenshot.js
const mongoose = require('mongoose');

const ROLES_5 = ['like', 'comment1', 'comment2', 'reply1', 'reply2'];
const ROLES_4 = ['comment1', 'comment2', 'reply1', 'reply2'];

const fileSchema = new mongoose.Schema(
  {
    role:   { type: String, enum: ROLES_5, required: true },
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

    verified: { type: Boolean, required: true },
    analysis: { type: mongoose.Schema.Types.Mixed },

    phashes:   [{ type: String, required: true }], // 4 or 5 (unique)
    bundleSig: { type: String, required: true },
    bundleSha: { type: String, required: true },

    handle:   { type: String },        // '@someuser'
    comments: [{ type: String }],
    replies:  [{ type: String }],

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

screenshotSchema.pre('validate', function (next) {
  try {
    if (!Array.isArray(this.files) || this.files.length < 4) {
      return next(new Error('At least 4 files required'));
    }

    const rolesPresent = new Set(this.files.map(f => f.role));
    const hasLike = rolesPresent.has('like');
    const expectedRoles = hasLike ? ROLES_5 : ROLES_4;

    // files length must match role set
    if (this.files.length !== expectedRoles.length) {
      return next(new Error(`Exactly ${expectedRoles.length} files required`));
    }
    for (const r of expectedRoles) {
      if (!rolesPresent.has(r)) {
        return next(new Error(`Missing required role: ${r}`));
      }
    }

    // sha256 must be unique
    const shaSet = new Set(this.files.map(f => f.sha256));
    if (shaSet.size !== this.files.length) {
      return next(new Error(`file sha256 values must be unique (${this.files.length} distinct)`));
    }

    // phashes must match file count and be unique
    if (!Array.isArray(this.phashes) || this.phashes.length !== this.files.length) {
      return next(new Error(`Exactly ${this.files.length} phashes required`));
    }
    const phSet = new Set(this.phashes);
    if (phSet.size !== this.phashes.length) {
      return next(new Error(`phashes must be unique (${this.phashes.length} distinct)`));
    }

    this.bundleSig = [...phSet].sort().join('|');
    this.bundleSha = [...shaSet].sort().join('|');

    if (this.handle) this.handle = normalizeHandle(this.handle);
    if (Array.isArray(this.comments)) this.comments = uniqueStrings(this.comments);
    if (Array.isArray(this.replies))  this.replies  = uniqueStrings(this.replies);

    return next();
  } catch (err) {
    return next(err);
  }
});

screenshotSchema.index({ userId: 1, linkId: 1, bundleSig: 1 }, { unique: true });
screenshotSchema.index({ userId: 1, linkId: 1, bundleSha: 1 }, { unique: true });

screenshotSchema.index(
  { linkId: 1, handle: 1 },
  { unique: true, partialFilterExpression: { verified: true, handle: { $type: 'string' } } }
);

module.exports = mongoose.model('Screenshot', screenshotSchema);
