// controllers/admin.controller.js

const bcrypt = require("bcrypt");
const nodemailer = require("nodemailer");
const { default: mongoose } = require("mongoose");
const { ObjectId } = require("mongodb");

const Admin = require("../models/Admin");
const Link = require("../models/Link");
const User = require("../models/User");
const Entry = require("../models/Entry");
const Employee = require("../models/Employee");
const BalanceHistory = require("../models/BalanceHistory");
const Screenshot = require("../models/Screenshot");
const AdminOTP = require("../models/AdminOTP");
const EmailTask = require("../models/EmailTask");
const EmailContact = require("../models/email");

const asyncHandler = (fn) => (req, res, next) => fn(req, res, next).catch(next);
const badRequest = (res, msg) => res.status(400).json({ error: msg });
const notFound = (res, msg) => res.status(404).json({ error: msg });

const VALID_STATUS = new Set(["active", "expired", "disabled"]);
const MS_PER_HOUR = 3600000;

/* ------------------------------------------------------------ */
/* Helpers for pagination + sorting                             */
/* ------------------------------------------------------------ */

const ALLOWED_SORT = new Set(["createdAt", "verified", "userId", "linkId"]);

function parseSort(sortBy = "createdAt", sortOrder = "desc") {
  const field = ALLOWED_SORT.has(sortBy) ? sortBy : "createdAt";
  const order = String(sortOrder).toLowerCase() === "asc" ? 1 : -1;
  return { [field]: order };
}

function parsePageLimit(page = 1, limit = 20, maxLimit = 100) {
  const p = Math.max(1, Number(page) || 1);
  const l = Math.min(maxLimit, Math.max(1, Number(limit) || 20));
  const skip = (p - 1) * l;
  return { p, l, skip };
}

function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function isValidObjectIdString(v) {
  return typeof v === "string" && mongoose.Types.ObjectId.isValid(v);
}

/**
 * Matches both possibilities:
 * - DB field stored as string: "6984..."
 * - DB field stored as ObjectId: ObjectId("6984...")
 */
function buildLinkIdInFilter(linkId) {
  if (!linkId) return linkId;
  if (isValidObjectIdString(linkId)) {
    return { $in: [linkId, new ObjectId(linkId)] };
  }
  return linkId;
}

/* ------------------------------------------------------------ */
/* ✅ ONLY COMMENTS & REPLIES (actions) helpers                 */
/* ------------------------------------------------------------ */

const SCREENSHOT_SELECT_COMMENTS_REPLIES =
  "screenshotId userId linkId verified videoId channelId createdAt " +
  "actions.kind actions.videoId actions.commentId actions.parentId actions.permalink " +
  "actions.text actions.authorChannelId actions.publishedAt";

function pickCommentReplyActions(actions = []) {
  if (!Array.isArray(actions)) return [];
  return actions
    .filter((a) => a && (a.kind === "comment" || a.kind === "reply"))
    .map((a) => ({
      kind: a.kind,
      videoId: a.videoId,
      commentId: a.commentId,
      parentId: a.parentId ?? null,
      permalink: a.permalink,
      text: a.text ?? null,
      authorChannelId: a.authorChannelId ?? null,
      publishedAt: a.publishedAt ?? null,
    }));
}

async function attachScreenshotsToEntries(entries = []) {
  const screenshotIds = entries.map((e) => e.screenshotId).filter(Boolean);
  if (!screenshotIds.length) {
    return entries.map((e) => ({ ...e, screenshot: null }));
  }

  const shots = await Screenshot.find({ screenshotId: { $in: screenshotIds } })
    .select(SCREENSHOT_SELECT_COMMENTS_REPLIES)
    .lean();

  const map = shots.reduce((m, s) => {
    m[s.screenshotId] = {
      screenshotId: s.screenshotId,
      userId: s.userId,
      linkId: s.linkId,
      verified: !!s.verified,
      videoId: s.videoId,
      channelId: s.channelId,
      createdAt: s.createdAt,
      // ✅ ONLY COMMENTS & REPLIES
      actions: pickCommentReplyActions(s.actions),
    };
    return m;
  }, {});

  return entries.map((e) => ({
    ...e,
    screenshot: e.screenshotId ? map[e.screenshotId] || null : null,
  }));
}

/* ------------------------------------------------------------ */
/* SMTP                                                         */
/* ------------------------------------------------------------ */

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: +process.env.SMTP_PORT,
  secure: false,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
});

/* ------------------------------------------------------------------ */
/*  AUTH                                                              */
/* ------------------------------------------------------------------ */

exports.login = asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  const admin = await Admin.findOne({ email }).select("+password");
  if (!admin || !(await bcrypt.compare(password, admin.password))) {
    return res.status(401).json({ error: "Invalid credentials" });
  }
  res.json({ message: "Admin login successful", adminId: admin.adminId });
});

// Approve a newly registered employee
exports.approveEmployee = asyncHandler(async (req, res) => {
  const { employeeId } = req.body;
  if (!employeeId) return badRequest(res, "employeeId required");

  const emp = await Employee.findOne({ employeeId });
  if (!emp) return notFound(res, "Employee not found");

  if (emp.isApproved === 1) return res.status(400).json({ error: "Already approved" });

  emp.isApproved = 1;
  await emp.save();

  res.json({ message: "Employee approved successfully" });
});

// Reject (delete) a pending employee
exports.rejectEmployee = asyncHandler(async (req, res) => {
  const { employeeId } = req.body;
  if (!employeeId) return badRequest(res, "employeeId required");

  const emp = await Employee.findOne({ employeeId });
  if (!emp) return notFound(res, "Employee not found");

  if (emp.isApproved === 1) {
    return res.status(400).json({ error: "Cannot reject an already approved employee" });
  }

  await Employee.deleteOne({ employeeId });
  res.json({ message: "Employee registration rejected and removed" });
});

exports.listPendingEmployees = asyncHandler(async (_req, res) => {
  const pending = await Employee.find({ isApproved: false })
    .select("name email employeeId createdAt")
    .lean();
  res.json(pending);
});

/* ------------------------------------------------------------------ */
/*  LINKS                                                             */
/* ------------------------------------------------------------------ */

exports.createLink = asyncHandler(async (req, res) => {
  const { title, adminId, target, amount, expireIn, minComments, minReplies, requireLike } = req.body;

  if (!adminId || target == null || amount == null || expireIn == null) {
    return badRequest(res, "adminId, target, amount, and expireIn are required");
  }
  if (!(await Admin.exists({ adminId }))) return badRequest(res, "Invalid adminId");

  const clamp02 = (v, def) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return def;
    return Math.max(0, Math.min(2, Math.floor(n)));
  };

  const c = clamp02(minComments, 2);
  const r = clamp02(minReplies, 2);
  const like = requireLike === true || requireLike === 1 || requireLike === "1";

  if (c === 0 && r === 0) return badRequest(res, "minComments and minReplies cannot both be 0");

  const link = await Link.create({
    title,
    createdBy: adminId,
    target,
    amount,
    expireIn,
    minComments: c,
    minReplies: r,
    requireLike: like,
  });

  res.json({
    link: `/employee/links/${link._id}`,
    rules: { minComments: c, minReplies: r, requireLike: like },
  });
});

exports.listLinks = asyncHandler(async (_req, res) => {
  const links = await Link.find()
    .select("title createdBy createdAt target amount expireIn minComments minReplies requireLike")
    .lean();

  const annotated = links.map((l) => {
    const expireAt = new Date(l.createdAt);
    expireAt.setHours(expireAt.getHours() + (l.expireIn || 0));
    return { ...l, expireAt };
  });

  res.json(annotated.reverse());
});

exports.deleteLink = asyncHandler(async (req, res) => {
  const { linkId } = req.body;
  if (!linkId) return badRequest(res, "linkId required");

  const link = await Link.findById(linkId);
  if (!link) return notFound(res, "Link not found");

  await Link.findByIdAndDelete(linkId);
  res.json({ message: "Link deleted successfully" });
});

/* ------------------------------------------------------------------ */
/*  EMPLOYEES                                                         */
/* ------------------------------------------------------------------ */

exports.getEmployees = asyncHandler(async (_req, res) => {
  const employees = await Employee.find().select("name email employeeId balance isApproved").lean();
  res.json(employees);
});

/* ------------------------------------------------------------------ */
/*  ENTRIES                                                           */
/* ------------------------------------------------------------------ */

// Get all entries for a given link (admin view) + attach screenshots (ONLY comments & replies)
exports.getEntries = asyncHandler(async (req, res) => {
  const { linkId } = req.body;
  if (!linkId) return badRequest(res, "linkId required");

  const linkDoc = await Link.findById(linkId).select("title").lean();
  if (!linkDoc) return notFound(res, "Link not found");

  const entries = await Entry.find({ linkId: buildLinkIdInFilter(linkId) }).lean();
  const entriesWithShots = await attachScreenshotsToEntries(entries);

  res.json({ title: linkDoc.title, entries: entriesWithShots });
});

// Get all entries for a given employee (type 0)
exports.getEmployeeEntries = asyncHandler(async (req, res) => {
  const { employeeId } = req.body;
  if (!employeeId) return badRequest(res, "employeeId required");

  const entries = await Entry.find({ employeeId }).lean();
  const entriesWithShots = await attachScreenshotsToEntries(entries);

  res.json(entriesWithShots);
});

// controllers/admin.js (or wherever getLinksByEmployee lives)
exports.getLinksByEmployee = asyncHandler(async (req, res) => {
  const { employeeId, page = 1, limit = 20 } = req.body;
  if (!employeeId) return badRequest(res, "employeeId required");

  const allIds = await Entry.distinct("linkId", {
    $or: [{ employeeId }, { worksUnder: employeeId }],
  });

  const total = allIds.length;
  if (total === 0) return res.json({ links: [], total: 0, page: 1, pages: 0 });

  const allSorted = await Link.find({ _id: { $in: allIds } })
    .sort({ createdAt: -1 })
    .select("_id createdAt")
    .lean();
  const sortedIds = allSorted.map((l) => l._id.toString());

  const start = (page - 1) * limit;
  const pagedIds = sortedIds.slice(start, start + Number(limit));

  const links = await Link.find({ _id: { $in: pagedIds } })
    .lean()
    .then((docs) => {
      const map = docs.reduce((m, d) => ((m[d._id.toString()] = d), m), {});
      return pagedIds.map((id) => map[id]);
    });

  const entries = await Entry.find({
    linkId: { $in: pagedIds },
    $or: [{ employeeId }, { worksUnder: employeeId }],
  })
    .sort({ createdAt: -1 })
    .lean();

  const byLink = entries.reduce((acc, e) => {
    const lid = e.linkId.toString();
    if (!acc[lid]) acc[lid] = { employeeEntries: [], userEntries: [] };
    if (e.employeeId) acc[lid].employeeEntries.push(e);
    if (e.worksUnder) acc[lid].userEntries.push(e);
    return acc;
  }, {});

  const linksWithEntries = links.map((link) => ({
    ...link,
    employeeEntries: byLink[link._id]?.employeeEntries || [],
    userEntries: byLink[link._id]?.userEntries || [],
  }));

  res.json({
    links: linksWithEntries,
    total,
    page: Number(page),
    pages: Math.ceil(total / limit),
  });
});

// ✅ Paginated entries for employee + link (this is your /entry/listByLink style)
// + attach screenshot.actions (ONLY comments & replies)
exports.getEntriesByEmployeeAndLink = asyncHandler(async (req, res) => {
  const { employeeId, linkId, page = 1, limit = 20 } = req.body;
  if (!employeeId || !linkId) return badRequest(res, "employeeId & linkId required");

  const filter = { employeeId, linkId: buildLinkIdInFilter(linkId) };

  const [entries, total] = await Promise.all([
    Entry.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    Entry.countDocuments(filter),
  ]);

  const grandTotal = await Entry.aggregate([
    { $match: filter },
    { $group: { _id: null, sum: { $sum: { $ifNull: ["$totalAmount", "$amount"] } } } },
  ]).then((r) => r[0]?.sum ?? 0);

  const entriesWithShots = await attachScreenshotsToEntries(entries);

  res.json({
    entries: entriesWithShots,
    total,
    grandTotal,
    page: Number(page),
    pages: Math.ceil(total / limit),
  });
});

// Link summary (totals per employee)
exports.getLinkSummary = asyncHandler(async (req, res) => {
  const { linkId } = req.body;
  if (!linkId) return badRequest(res, "linkId required");

  let linkObjectId;
  try {
    linkObjectId = new mongoose.Types.ObjectId(linkId);
  } catch {
    return badRequest(res, "Invalid linkId format");
  }

  const linkDoc = await Link.findById(linkObjectId).select("title amount").lean();
  if (!linkDoc) return notFound(res, "Link not found");
  const amountPer = linkDoc.amount;

  const rows = await Entry.aggregate([
    { $match: { linkId: linkId } }, // keep as original behavior
    {
      $group: {
        _id: "$employeeId",
        total: { $sum: { $ifNull: ["$amount", 0] } },
        linkId: { $first: "$linkId" },
      },
    },
    {
      $lookup: {
        from: "employees",
        localField: "_id",
        foreignField: "employeeId",
        as: "emp",
      },
    },
    { $unwind: "$emp" },
    {
      $project: {
        _id: 0,
        linkId: 1,
        employeeId: "$_id",
        name: "$emp.name",
        employeeTotal: "$total",
        walletBalance: "$emp.balance",
        entryCount: { $ceil: { $divide: ["$total", amountPer] } },
      },
    },
  ]);

  const grandTotal = rows.reduce((sum, r) => sum + r.employeeTotal, 0);

  res.json({
    linkId,
    title: linkDoc.title,
    rows,
    grandTotal,
  });
});

/* ------------------------------------------------------------------ */
/*  BALANCE MANAGEMENT                                                */
/* ------------------------------------------------------------------ */

exports.getBalanceHistory = asyncHandler(async (req, res) => {
  const { employeeId, page = 1, limit = 20 } = req.body;
  const filter = employeeId ? { employeeId } : {};

  const [history, total, agg] = await Promise.all([
    BalanceHistory.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    BalanceHistory.countDocuments(filter),
    BalanceHistory.aggregate([{ $match: filter }, { $group: { _id: null, totalAmount: { $sum: "$amount" } } }]),
  ]);

  const totalAmount = agg[0]?.totalAmount || 0;
  res.json({ history, total, totalAmount, page: Number(page), pages: Math.ceil(total / limit) });
});

exports.addEmployeeBalance = asyncHandler(async (req, res) => {
  const { employeeId, amount, adminId, note = "" } = req.body;
  if (!employeeId || amount == null || !adminId) {
    return badRequest(res, "employeeId, amount and adminId are required");
  }
  const emp = await Employee.findOne({ employeeId });
  if (!emp) return notFound(res, "Employee not found");

  emp.balance += amount;
  await emp.save();

  await BalanceHistory.create({ employeeId, amount, addedBy: adminId, note });
  res.json({ message: "Balance added successfully", newBalance: emp.balance });
});

exports.updateEmployeeBalance = asyncHandler(async (req, res) => {
  const { employeeId, newBalance, adminId, note = "" } = req.body;
  if (!employeeId || newBalance == null || !adminId) {
    return badRequest(res, "employeeId, newBalance and adminId are required");
  }
  const emp = await Employee.findOne({ employeeId });
  if (!emp) return notFound(res, "Employee not found");

  const oldBalance = emp.balance;
  emp.balance = newBalance;
  await emp.save();

  await BalanceHistory.create({
    employeeId,
    amount: newBalance - oldBalance,
    addedBy: adminId,
    note: `Updated from ₹${oldBalance} to ₹${newBalance}. ${note}`,
  });
  res.json({ message: "Balance updated successfully", oldBalance, newBalance });
});

exports.bulkAddEmployeeBalance = asyncHandler(async (req, res) => {
  const { employeeIds, amount, adminId, note = "" } = req.body;
  if (!Array.isArray(employeeIds) || !employeeIds.length || amount == null || !adminId) {
    return badRequest(res, "employeeIds, amount and adminId are required");
  }

  const results = await Promise.all(
    employeeIds.map(async (id) => {
      const emp = await Employee.findOne({ employeeId: id });
      if (!emp) return { employeeId: id, error: "Not found" };

      emp.balance += amount;
      await emp.save();

      await BalanceHistory.create({ employeeId: id, amount, addedBy: adminId, note });
      return { employeeId: id, newBalance: emp.balance };
    })
  );

  res.json({ message: "Bulk add complete", results });
});

exports.bulkUpdateEmployeeBalance = asyncHandler(async (req, res) => {
  const { employeeIds, newBalance, adminId, note = "" } = req.body;
  if (!Array.isArray(employeeIds) || !employeeIds.length || newBalance == null || newBalance < 0 || !adminId) {
    return badRequest(res, "employeeIds, newBalance and adminId are required");
  }

  const results = await Promise.all(
    employeeIds.map(async (id) => {
      const emp = await Employee.findOne({ employeeId: id });
      if (!emp) return { employeeId: id, error: "Not found" };

      const oldBalance = emp.balance;
      emp.balance = newBalance;
      await emp.save();

      await BalanceHistory.create({
        employeeId: id,
        amount: newBalance - oldBalance,
        addedBy: adminId,
        note: `Bulk update from ₹${oldBalance} to ₹${newBalance}. ${note}`,
      });
      return { employeeId: id, oldBalance, newBalance };
    })
  );

  res.json({ message: "Bulk update complete", results });
});

/* ------------------------------------------------------------------ */
/*  USER ENTRIES (UNDER EMPLOYEE)                                     */
/* ------------------------------------------------------------------ */

// ✅ attach screenshot.actions only (comments & replies)
exports.getUserEntriesByLinkAndEmployee = asyncHandler(async (req, res) => {
  const { linkId, employeeId } = req.body;
  if (!linkId || !employeeId) return badRequest(res, "linkId and employeeId required");

  const entries = await Entry.find({
    linkId: buildLinkIdInFilter(linkId),
    type: 1,
    worksUnder: employeeId,
  })
    .sort({ createdAt: -1 })
    .lean();

  const userIds = entries.map((e) => e.userId).filter(Boolean);
  const users = await User.find({ userId: { $in: userIds } })
    .select("userId name email phone upiId")
    .lean();
  const userMap = users.reduce((m, u) => ((m[u.userId] = u), m), {});

  const entriesWithUser = entries.map((e) => ({ ...e, user: userMap[e.userId] || null }));
  const entriesWithShots = await attachScreenshotsToEntries(entriesWithUser);

  const link = await Link.findById(linkId).select("title").lean();
  const title = link?.title || "";

  const totalUsers = entriesWithShots.length;
  const totalPersons = entriesWithShots.reduce((sum, e) => sum + (e.noOfPersons || 0), 0);
  const totalAmountPaid = entriesWithShots.reduce((sum, e) => sum + (e.totalAmount || 0), 0);

  res.json({
    title,
    entries: entriesWithShots,
    totals: { totalUsers, totalPersons, totalAmountPaid },
  });
});

/* ------------------------------------------------------------------ */
/*  ADMIN OTP FLOWS                                                   */
/* ------------------------------------------------------------------ */

// 1️⃣ Request email change → send OTP to both old + new email
exports.requestEmailChange = asyncHandler(async (req, res) => {
  const { adminId, newEmail } = req.body;
  if (!adminId || !newEmail) return badRequest(res, "adminId and newEmail required");

  const admin = await Admin.findOne({ adminId });
  if (!admin) return notFound(res, "Admin not found");

  const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

  const otpOld = generateOTP();
  await AdminOTP.create({
    admin: admin._id,
    type: "email-change-old",
    otp: otpOld,
    payload: { newEmail },
    expiresAt,
  });
  await transporter.sendMail({
    to: admin.email,
    subject: "OTP for Email Change (Current Email)",
    text: `Your OTP to confirm your email change is: ${otpOld} (expires in 15 minutes).`,
  });

  const otpNew = generateOTP();
  await AdminOTP.create({
    admin: admin._id,
    type: "email-change-new",
    otp: otpNew,
    payload: { newEmail },
    expiresAt,
  });
  await transporter.sendMail({
    to: newEmail,
    subject: "OTP for Email Change (New Email)",
    text: `Your OTP to confirm your email change is: ${otpNew} (expires in 15 minutes).`,
  });

  res.json({ message: "OTPs sent to both current and new email addresses" });
});

// 2️⃣ Confirm email change → verify both codes, then update email
exports.confirmEmailChange = asyncHandler(async (req, res) => {
  const { adminId, otpOld, otpNew } = req.body;
  if (!adminId || !otpOld || !otpNew) return badRequest(res, "adminId, otpOld and otpNew required");

  const admin = await Admin.findOne({ adminId });
  if (!admin) return notFound(res, "Admin not found");

  const now = new Date();

  const oldRec = await AdminOTP.findOne({
    admin: admin._id,
    type: "email-change-old",
    otp: otpOld,
    expiresAt: { $gt: now },
  });

  const newRec = await AdminOTP.findOne({
    admin: admin._id,
    type: "email-change-new",
    otp: otpNew,
    expiresAt: { $gt: now },
  });

  if (!oldRec || !newRec) return res.status(400).json({ error: "Invalid or expired OTP" });

  admin.email = oldRec.payload.newEmail;
  await admin.save();

  await AdminOTP.deleteMany({
    admin: admin._id,
    type: { $in: ["email-change-old", "email-change-new"] },
  });

  res.json({ message: "Email updated successfully" });
});

// 3️⃣ Request password reset → send OTP to current email
exports.requestPasswordReset = asyncHandler(async (req, res) => {
  const { adminId } = req.body;
  if (!adminId) return badRequest(res, "adminId required");

  const admin = await Admin.findOne({ adminId });
  if (!admin) return notFound(res, "Admin not found");

  const otp = generateOTP();
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

  await AdminOTP.create({
    admin: admin._id,
    type: "password-reset",
    otp,
    expiresAt,
  });

  await transporter.sendMail({
    to: admin.email,
    subject: "OTP for Password Reset",
    text: `Your OTP to reset your password is: ${otp} (expires in 15 minutes).`,
  });

  res.json({ message: "OTP sent to admin email address" });
});

// 4️⃣ Confirm password reset → verify OTP + update password
exports.confirmPasswordReset = asyncHandler(async (req, res) => {
  const { adminId, otp, newPassword } = req.body;
  if (!adminId || !otp || !newPassword) return badRequest(res, "adminId, otp and newPassword required");

  const admin = await Admin.findOne({ adminId }).select("+password");
  if (!admin) return notFound(res, "Admin not found");

  const now = new Date();
  const record = await AdminOTP.findOne({
    admin: admin._id,
    type: "password-reset",
    otp,
    expiresAt: { $gt: now },
  });
  if (!record) return res.status(400).json({ error: "Invalid or expired OTP" });

  const salt = await bcrypt.genSalt(10);
  admin.password = await bcrypt.hash(newPassword, salt);
  await admin.save();

  await AdminOTP.deleteMany({ admin: admin._id, type: "password-reset" });
  res.json({ message: "Password reset successfully" });
});

/* ------------------------------------------------------------------ */
/*  SCREENSHOTS (ADMIN) ✅ ONLY COMMENTS & REPLIES                    */
/* ------------------------------------------------------------------ */

exports.getScreenshotList = asyncHandler(async (req, res) => {
  const { page = 1, limit = 20, sortBy = "createdAt", sortOrder = "desc", verified } = req.body;

  const { p, l, skip } = parsePageLimit(page, limit);
  const sort = parseSort(sortBy, sortOrder);

  const filter = {};
  if (typeof verified === "boolean") filter.verified = verified;

  const [rows, total] = await Promise.all([
    Screenshot.find(filter)
      .sort(sort)
      .skip(skip)
      .limit(l)
      .select(SCREENSHOT_SELECT_COMMENTS_REPLIES)
      .lean(),
    Screenshot.countDocuments(filter),
  ]);

  const screenshots = rows.map((r) => ({
    screenshotId: r.screenshotId,
    userId: r.userId,
    linkId: r.linkId,
    verified: !!r.verified,
    videoId: r.videoId,
    channelId: r.channelId,
    createdAt: r.createdAt,
    actions: pickCommentReplyActions(r.actions),
  }));

  res.json({ screenshots, total, page: p, pages: Math.ceil(total / l) });
});

/**
 * POST /admin/screenshots/byUser
 * Body: { userId, page?, limit?, sortBy?, sortOrder?, verified? }
 */
exports.getScreenshotsByUserId = asyncHandler(async (req, res) => {
  const { userId, page = 1, limit = 20, sortBy = "createdAt", sortOrder = "desc", verified } = req.body;
  if (!userId) return badRequest(res, "userId required");

  const { p, l, skip } = parsePageLimit(page, limit);
  const sort = parseSort(sortBy, sortOrder);

  const filter = { userId };
  if (typeof verified === "boolean") filter.verified = verified;

  const [rows, total, entries] = await Promise.all([
    Screenshot.find(filter)
      .sort(sort)
      .skip(skip)
      .limit(l)
      .select(SCREENSHOT_SELECT_COMMENTS_REPLIES)
      .lean(),
    Screenshot.countDocuments(filter),
    Entry.find({ type: 1, userId }).lean(),
  ]);

  const screenshots = rows.map((r) => ({
    screenshotId: r.screenshotId,
    userId: r.userId,
    linkId: r.linkId,
    verified: !!r.verified,
    videoId: r.videoId,
    channelId: r.channelId,
    createdAt: r.createdAt,
    actions: pickCommentReplyActions(r.actions),
  }));

  const entriesWithTitles = await Promise.all(
    entries.map(async (e) => {
      const linkDoc = await Link.findById(e.linkId, "title").lean();
      return { ...e, linkTitle: linkDoc ? linkDoc.title : null };
    })
  );

  res.json({
    screenshots,
    totalScreenshots: total,
    page: p,
    pages: Math.ceil(total / l),
    entries: entriesWithTitles,
  });
});

/**
 * POST /admin/screenshots/byLink
 * Body: { linkId, page?, limit?, sortBy?, sortOrder?, verified? }
 */
exports.getScreenshotsByLinkId = asyncHandler(async (req, res) => {
  const { linkId, page = 1, limit = 20, sortBy = "createdAt", sortOrder = "desc", verified } = req.body;
  if (!linkId) return badRequest(res, "linkId required");

  const { p, l, skip } = parsePageLimit(page, limit);
  const sort = parseSort(sortBy, sortOrder);

  const filter = { linkId: buildLinkIdInFilter(linkId) };
  if (typeof verified === "boolean") filter.verified = verified;

  const [rows, totalScreenshots, linkDoc] = await Promise.all([
    Screenshot.find(filter)
      .sort(sort)
      .skip(skip)
      .limit(l)
      .select(SCREENSHOT_SELECT_COMMENTS_REPLIES)
      .lean(),
    Screenshot.countDocuments(filter),
    isValidObjectIdString(linkId) ? Link.findById(new ObjectId(linkId), "title").lean() : Link.findById(linkId, "title").lean(),
  ]);

  const screenshots = rows.map((r) => ({
    screenshotId: r.screenshotId,
    userId: r.userId,
    linkId: r.linkId,
    verified: !!r.verified,
    videoId: r.videoId,
    channelId: r.channelId,
    createdAt: r.createdAt,
    actions: pickCommentReplyActions(r.actions),
  }));

  const entries = await Entry.find({ linkId: buildLinkIdInFilter(linkId) }).lean();
  const linkTitle = linkDoc ? linkDoc.title : null;

  res.json({
    linkId,
    linkTitle,
    screenshots,
    totalScreenshots,
    page: p,
    pages: Math.ceil(totalScreenshots / l),
    entries: entries.map((e) => ({ ...e, linkTitle })),
    totalEntries: entries.length,
  });
});

exports.getScreenshotsByLinkAndEmployee = asyncHandler(async (req, res) => {
  const { linkId, employeeId, page = 1, limit = 20, sortBy = "createdAt", sortOrder = "desc", verified } = req.body;

  if (!linkId) return badRequest(res, "linkId required");
  if (!employeeId) return badRequest(res, "employeeId required");

  const { p, l, skip } = parsePageLimit(page, limit);
  const sort = parseSort(sortBy, sortOrder);

  // 1) Find all USER entries (type:1) for this link under this employee => gives us userIds
  const userEntries = await Entry.find({
    type: 1,
    linkId: buildLinkIdInFilter(linkId),
    worksUnder: employeeId,
  })
    .select("userId")
    .lean();

  const userIds = [...new Set(userEntries.map((e) => e.userId).filter(Boolean))];

  // if none, return empty
  const linkDoc = await (isValidObjectIdString(linkId)
    ? Link.findById(new ObjectId(linkId), "title").lean()
    : Link.findById(linkId, "title").lean());

  if (!userIds.length) {
    return res.json({
      linkId,
      linkTitle: linkDoc?.title ?? null,
      screenshots: [],
      totalScreenshots: 0,
      page: p,
      pages: 0,
      entries: [],
      totalEntries: 0,
    });
  }

  // 2) Build screenshot filter (by linkId AND userId under this employee)
  const ssFilter = { linkId: buildLinkIdInFilter(linkId), userId: { $in: userIds } };
  if (typeof verified === "boolean") ssFilter.verified = verified;

  // 3) Fetch screenshots (paginated) + total
  const [rows, totalScreenshots] = await Promise.all([
    Screenshot.find(ssFilter)
      .sort(sort)
      .skip(skip)
      .limit(l)
      .select(SCREENSHOT_SELECT_COMMENTS_REPLIES)
      .lean(),
    Screenshot.countDocuments(ssFilter),
  ]);

  const screenshots = rows.map((r) => ({
    screenshotId: r.screenshotId,
    userId: r.userId,
    linkId: r.linkId,
    verified: !!r.verified,
    videoId: r.videoId,
    channelId: r.channelId,
    createdAt: r.createdAt,
    actions: pickCommentReplyActions(r.actions),
  }));

  // 4) Fetch ALL entries for this link that belong to the employee
  const entryFilter = {
    linkId: buildLinkIdInFilter(linkId),
    $or: [{ employeeId }, { worksUnder: employeeId }],
  };
  const entries = await Entry.find(entryFilter).lean();

  res.json({
    linkId,
    linkTitle: linkDoc?.title ?? null,
    screenshots,
    totalScreenshots,
    page: p,
    pages: Math.ceil(totalScreenshots / l),
    entries: entries.map((e) => ({ ...e, linkTitle: linkDoc?.title ?? null })),
    totalEntries: entries.length,
  });
});

/* ------------------------------------------------------------------ */
/*  EMAIL TASKS                                                       */
/* ------------------------------------------------------------------ */

exports.createEmailTask = asyncHandler(async (req, res) => {
  const {
    items,
    platform,
    targetUser,
    amountPerPerson,
    expireIn,
    targetPerEmployee,
    maxEmails,
    adminId,
  } = req.body || {};

  if (!adminId) return badRequest(res, "adminId required");
  const exists = await Admin.exists({ adminId: String(adminId) });
  if (!exists) return badRequest(res, "Invalid adminId");

  const rows = Array.isArray(items)
    ? items
    : [{ platform, targetUser, amountPerPerson, expireIn, targetPerEmployee, maxEmails }];

  const toIntOrDefault = (val, def = 1) => {
    const n = Number(val);
    return Number.isFinite(n) && n >= 1 ? Math.floor(n) : def;
  };

  const docs = [];
  for (const r of rows) {
    const p = String(r?.platform || "").trim();
    const a = Number(r?.amountPerPerson);
    const e = Number(r?.expireIn);

    if (!p) return badRequest(res, "platform is required for all items");
    if (!Number.isFinite(a) || a < 0) return badRequest(res, "amountPerPerson must be a non-negative number");
    if (!Number.isFinite(e) || e < 1) return badRequest(res, "expireIn must be at least 1 hour");

    const tpe = toIntOrDefault(r?.targetPerEmployee, 1);
    const me = toIntOrDefault(r?.maxEmails, 1);

    docs.push({
      createdBy: String(adminId),
      platform: p,
      targetUser: typeof r?.targetUser === "string" ? String(r.targetUser) : undefined,
      amountPerPerson: a,
      expireIn: e,
      targetPerEmployee: tpe,
      maxEmails: me,
    });
  }

  const inserted = await EmailTask.insertMany(docs, { ordered: true });

  const now = new Date();
  const tasks = inserted.map((t) => {
    const expiresAt = new Date(t.createdAt.getTime() + t.expireIn * MS_PER_HOUR);
    return {
      _id: t._id,
      createdBy: t.createdBy,
      platform: t.platform,
      targetUser: t.targetUser ?? null,
      amountPerPerson: t.amountPerPerson,
      expireIn: t.expireIn,
      createdAt: t.createdAt,
      expiresAt,
      status: now < expiresAt ? "active" : "expired",
    };
  });

  res.json({ message: `Created ${tasks.length} email task(s)`, tasks });
});

exports.getEmailTaskList = asyncHandler(async (req, res) => {
  const {
    page = 1,
    limit = 20,
    sortBy = "createdAt",
    sortOrder = "desc",
    search,
    adminId, // eslint-disable-line no-unused-vars
    platform,
    active,
    includeCompleted = true, // eslint-disable-line no-unused-vars
    createdBy,
  } = req.body;

  const { p, l, skip } = parsePageLimit(page, limit);
  const dir = String(sortOrder).toLowerCase() === "asc" ? 1 : -1;
  const wantsExpiresAtSort = String(sortBy) === "expiresAt";

  const match = {};
  if (createdBy) match.createdBy = String(createdBy);

  if (platform) {
    const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    match.platform = { $regex: esc(platform), $options: "i" };
  }

  if (search != null && String(search).trim() !== "") {
    const term = String(search).trim();
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    const or = [
      { platform: { $regex: esc(term), $options: "i" } },
      { createdBy: { $regex: esc(term), $options: "i" } },
      { targetUser: { $regex: esc(term), $options: "i" } },
    ];

    const num = Number(term);
    if (Number.isFinite(num)) {
      or.push({ targetPerEmployee: num }, { amountPerPerson: num }, { maxEmails: num }, { expireIn: num });
    }

    try {
      if (ObjectId.isValid(term)) or.push({ _id: new ObjectId(term) });
    } catch {}

    match.$or = or;
  }

  const now = new Date();

  const pipeline = [
    { $match: match },
    { $addFields: { _expireInNum: { $toDouble: "$expireIn" } } },
    { $addFields: { expiresAt: { $add: ["$createdAt", { $multiply: ["$_expireInNum", MS_PER_HOUR] }] } } },
  ];

  if (typeof active === "boolean") {
    pipeline.push({ $match: active ? { expiresAt: { $gt: now } } : { expiresAt: { $lte: now } } });
  }

  pipeline.push(
    { $sort: wantsExpiresAtSort ? { expiresAt: dir } : { [String(sortBy) || "createdAt"]: dir } },
    {
      $facet: {
        rows: [{ $skip: skip }, { $limit: l }, { $project: { _expireInNum: 0 } }],
        meta: [{ $count: "total" }],
      },
    }
  );

  const agg = await EmailTask.aggregate(pipeline);
  const rows = agg[0]?.rows || [];
  const total = agg[0]?.meta?.[0]?.total || 0;

  const tasks = rows.map((t) => ({ ...t, status: now < t.expiresAt ? "active" : "expired" }));

  res.json({ tasks, total, page: p, pages: Math.ceil(total / l) });
});

exports.getEmailTaskDetails = asyncHandler(async (req, res) => {
  const { taskId, employeeId } = req.body || {};
  if (!taskId) return badRequest(res, "taskId is required");
  if (!ObjectId.isValid(taskId)) return badRequest(res, "Invalid taskId");

  const task = await EmailTask.findById(taskId).lean();
  if (!task) return notFound(res, "Task not found");

  const expiresAt = new Date(new Date(task.createdAt).getTime() + (Number(task.expireIn) || 0) * MS_PER_HOUR);
  const status = new Date() < expiresAt ? "active" : "expired";

  const threshold = Number(task.maxEmails || 0);
  const taskIdObj = new ObjectId(taskId);

  const pipeline = [
    { $match: { taskId: taskIdObj } },
    {
      $lookup: {
        from: "users",
        localField: "userId",
        foreignField: "userId",
        as: "user",
      },
    },
    { $unwind: "$user" },
    ...(employeeId ? [{ $match: { "user.worksUnder": String(employeeId) } }] : []),
    {
      $lookup: {
        from: "employees",
        localField: "user.worksUnder",
        foreignField: "employeeId",
        as: "employee",
      },
    },
    { $unwind: "$employee" },
    {
      $group: {
        _id: { employeeId: "$employee.employeeId", userId: "$user.userId" },
        employeeName: { $first: "$employee.name" },
        userName: { $first: "$user.name" },
        emails: {
          $push: {
            email: "$email",
            handle: "$handle",
            platform: "$platform",
            createdAt: "$createdAt",
            youtube: "$youtube",
          },
        },
        count: { $sum: 1 },
      },
    },
    {
      $addFields: {
        status: { $cond: [{ $gte: ["$count", threshold] }, "completed", "partial"] },
      },
    },
    {
      $lookup: {
        from: "payouts",
        let: { empId: "$_id.employeeId", uId: "$_id.userId" },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ["$employeeId", "$$empId"] },
                  { $eq: ["$userId", "$$uId"] },
                  { $eq: ["$taskId", taskIdObj] },
                ],
              },
            },
          },
          { $project: { _id: 1 } },
        ],
        as: "payout",
      },
    },
    { $addFields: { paid: { $gt: [{ $size: "$payout" }, 0] } } },
    {
      $group: {
        _id: "$_id.employeeId",
        employeeName: { $first: "$employeeName" },
        users: {
          $push: {
            userId: "$_id.userId",
            name: "$userName",
            doneCount: "$count",
            status: "$status",
            paid: "$paid",
            emails: "$emails",
          },
        },
        usersCount: { $sum: 1 },
        completedUsers: { $sum: { $cond: [{ $eq: ["$status", "completed"] }, 1, 0] } },
        partialUsers: { $sum: { $cond: [{ $eq: ["$status", "partial"] }, 1, 0] } },
        paidUsers: { $sum: { $cond: ["$paid", 1, 0] } },
        totalEmails: { $sum: "$count" },
      },
    },
    {
      $project: {
        _id: 0,
        employeeId: "$_id",
        name: "$employeeName",
        usersCount: 1,
        completedUsers: 1,
        partialUsers: 1,
        paidUsers: 1,
        totalEmails: 1,
        users: 1,
      },
    },
    { $sort: { totalEmails: -1 } },
  ];

  const employees = await EmailContact.aggregate(pipeline);

  const totals = employees.reduce(
    (acc, e) => {
      acc.employees += 1;
      acc.users += e.usersCount || 0;
      acc.completedUsers += e.completedUsers || 0;
      acc.partialUsers += e.partialUsers || 0;
      acc.paidUsers += e.paidUsers || 0;
      acc.totalEmails += e.totalEmails || 0;
      return acc;
    },
    { employees: 0, users: 0, completedUsers: 0, partialUsers: 0, paidUsers: 0, totalEmails: 0 }
  );

  res.json({
    task: {
      _id: task._id,
      platform: task.platform,
      targetPerEmployee: task.targetPerEmployee,
      amountPerPerson: task.amountPerPerson,
      maxEmails: task.maxEmails,
      expireIn: task.expireIn,
      createdAt: task.createdAt,
      expiresAt,
      status,
    },
    totals,
    employees,
  });
});
