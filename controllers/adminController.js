// controllers/admin.controller.js
const bcrypt = require('bcrypt');
const Admin = require('../models/Admin');
const Link = require('../models/Link');
const User = require('../models/User');
const Entry = require('../models/Entry');
const Employee = require('../models/Employee');
const BalanceHistory = require('../models/BalanceHistory');
const Screenshot = require('../models/Screenshot'); // ← ADD THIS
const nodemailer = require('nodemailer');
const AdminOTP = require('../models/AdminOTP');
const { default: mongoose } = require('mongoose');
const { ObjectId } = require('mongodb');
const EmailTask = require('../models/EmailTask');
const EmailContact = require('../models/email');

const asyncHandler = fn => (req, res, next) => fn(req, res, next).catch(next);
const badRequest = (res, msg) => res.status(400).json({ error: msg });
const notFound = (res, msg) => res.status(404).json({ error: msg });
const VALID_STATUS = new Set(['active', 'expired', 'disabled']);

const MS_PER_HOUR = 3600000;

/* ------------------------------------------------------------ */
/* Helpers for pagination + sorting                             */
/* ------------------------------------------------------------ */
const ALLOWED_SORT = new Set(['createdAt', 'verified', 'userId', 'linkId']);

function parseSort(sortBy = 'createdAt', sortOrder = 'desc') {
  const field = ALLOWED_SORT.has(sortBy) ? sortBy : 'createdAt';
  const order = String(sortOrder).toLowerCase() === 'asc' ? 1 : -1;
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

// configure your SMTP via env
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: +process.env.SMTP_PORT,
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

/* ------------------------------------------------------------------ */
/*  AUTH                                                              */
/* ------------------------------------------------------------------ */
exports.login = asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  const admin = await Admin.findOne({ email }).select('+password');
  if (!admin || !(await bcrypt.compare(password, admin.password))) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  res.json({ message: 'Admin login successful', adminId: admin.adminId });
});

// Approve a newly registered employee
exports.approveEmployee = asyncHandler(async (req, res) => {
  const { employeeId } = req.body;
  if (!employeeId) return badRequest(res, 'employeeId required');

  const emp = await Employee.findOne({ employeeId });
  if (!emp) return notFound(res, 'Employee not found');

  if (emp.isApproved === 1) 
    return res.status(400).json({ error: 'Already approved' });

  emp.isApproved = 1;
  await emp.save();

  res.json({ message: 'Employee approved successfully' });
});

// Reject (delete) a pending employee
exports.rejectEmployee = asyncHandler(async (req, res) => {
  const { employeeId } = req.body;
  if (!employeeId) return badRequest(res, 'employeeId required');

  const emp = await Employee.findOne({ employeeId });
  if (!emp) return notFound(res, 'Employee not found');

  if (emp.isApproved === 1) 
    return res
      .status(400)
      .json({ error: 'Cannot reject an already approved employee' });

  // Remove the record so they no longer appear in “pending”
  await Employee.deleteOne({ employeeId });

  res.json({ message: 'Employee registration rejected and removed' });
});


exports.listPendingEmployees = asyncHandler(async (_req, res) => {
  const pending = await Employee.find({ isApproved: false })
    .select('name email employeeId createdAt')
    .lean();
  res.json(pending);
});


/* ------------------------------------------------------------------ */
/*  LINKS                                                             */
/* ------------------------------------------------------------------ */
exports.createLink = asyncHandler(async (req, res) => {
  const { title, adminId, target, amount, expireIn } = req.body;
  if (!adminId || target == null || amount == null || expireIn == null) {
    return badRequest(res, 'adminId, target, amount, and expireIn are required');
  }
  if (!await Admin.exists({ adminId })) {
    return badRequest(res, 'Invalid adminId');
  }

  const link = await Link.create({
    title,
    createdBy: adminId,
    target,
    amount,
    expireIn
  });

  res.json({ link: `/employee/links/${link._id}` });
});

exports.listLinks = asyncHandler(async (_req, res) => {
  const links = await Link.find()
    .select('title createdBy createdAt target amount expireIn')
    .lean();

  const annotated = links.map(l => {
    const expireAt = new Date(l.createdAt);
    expireAt.setHours(expireAt.getHours() + (l.expireIn || 0));
    return { ...l, expireAt };
  });

  res.json(annotated.reverse());
});

exports.deleteLink = asyncHandler(async (req, res) => {
  const { linkId } = req.body;
  if (!linkId) return badRequest(res, 'linkId required');

  const link = await Link.findById(linkId);
  if (!link) return notFound(res, 'Link not found');

  await Link.findByIdAndDelete(linkId);
  res.json({ message: 'Link deleted successfully' });
});

/* ------------------------------------------------------------------ */
/*  EMPLOYEES                                                         */
/* ------------------------------------------------------------------ */
exports.getEmployees = asyncHandler(async (_req, res) => {
  const employees = await Employee.find()
    .select('name email employeeId balance isApproved')
    .lean();
  res.json(employees);
});

/* ------------------------------------------------------------------ */
/*  ENTRIES                                                           */
/* ------------------------------------------------------------------ */
// Get all entries for a given link (admin view)
exports.getEntries = asyncHandler(async (req, res) => {
  const { linkId } = req.body;
  if (!linkId) return badRequest(res, 'linkId required');

  // Fetch the link’s title
  const linkDoc = await Link
    .findById(linkId)            // Mongoose will cast the string to ObjectId
    .select('title')
    .lean();
  if (!linkDoc) return notFound(res, 'Link not found');

  // Get all entries for that linkId (stored as string)
  const entries = await Entry
    .find({ linkId })
    .lean();

  // Return title separately
  res.json({
    title:   linkDoc.title,
    entries
  });
});

// Get all entries for a given employee (type 0)
exports.getEmployeeEntries = asyncHandler(async (req, res) => {
  const { employeeId } = req.body;
  if (!employeeId) return badRequest(res, 'employeeId required');

  const entries = await Entry.find({employeeId }).lean();
  res.json(entries);
});

// controllers/admin.js (or wherever getLinksByEmployee lives)
exports.getLinksByEmployee = asyncHandler(async (req, res) => {
  const { employeeId, page = 1, limit = 20 } = req.body;
  if (!employeeId) return badRequest(res, 'employeeId required');

  // 1️⃣ Find all distinct linkIds for entries either by the employee or by users under them
  const allIds = await Entry.distinct('linkId', {
    $or: [
      { employeeId },           // employee’s own submissions (type 0 or missing)
      { worksUnder: employeeId } // user submissions under this employee (type 1)
    ]
  });

  const total = allIds.length;
  if (total === 0) {
    return res.json({ links: [], total: 0, page: 1, pages: 0 });
  }

  // 2️⃣ Sort those links by createdAt, then page
  const allSorted = await Link.find({ _id: { $in: allIds } })
    .sort({ createdAt: -1 })
    .select('_id createdAt')
    .lean();
  const sortedIds = allSorted.map(l => l._id.toString());

  const start = (page - 1) * limit;
  const pagedIds = sortedIds.slice(start, start + Number(limit));

  // 3️⃣ Fetch full Link docs in that order
  const links = await Link.find({ _id: { $in: pagedIds } })
    .lean()
    .then(docs => {
      const map = docs.reduce((m, d) => (m[d._id.toString()] = d, m), {});
      return pagedIds.map(id => map[id]);
    });

  // 4️⃣ Fetch all matching entries for these links
  const entries = await Entry.find({
    linkId: { $in: pagedIds },
    $or: [
      { employeeId },           
      { worksUnder: employeeId } 
    ]
  })
    .sort({ createdAt: -1 })
    .lean();

  // 5️⃣ Group and split entries per link
  const byLink = entries.reduce((acc, e) => {
    const lid = e.linkId.toString();
    if (!acc[lid]) acc[lid] = { employeeEntries: [], userEntries: [] };
    // any entry with employeeId set is an “employee entry”
    if (e.employeeId) acc[lid].employeeEntries.push(e);
    // any entry with worksUnder set is a “user entry” under this employee
    if (e.worksUnder)    acc[lid].userEntries.push(e);
    return acc;
  }, {});

  // 6️⃣ Attach them to each link
  const linksWithEntries = links.map(link => ({
    ...link,
    employeeEntries: byLink[link._id]?.employeeEntries || [],
    userEntries:     byLink[link._id]?.userEntries     || []
  }));

  // 7️⃣ Send back the paginated result
  res.json({
    links: linksWithEntries,
    total,
    page: Number(page),
    pages: Math.ceil(total / limit)
  });
});


// Paginated entries for employee + link
exports.getEntriesByEmployeeAndLink = asyncHandler(async (req, res) => {
  const { employeeId, linkId, page = 1, limit = 20 } = req.body;
  if (!employeeId || !linkId) return badRequest(res, 'employeeId & linkId required');

  const filter = { employeeId, linkId };

  const [entries, total] = await Promise.all([
    Entry.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    Entry.countDocuments(filter)
  ]);

  const grandTotal = await Entry.aggregate([
    { $match: filter },
    { $group: { _id: null, sum: { $sum: { $ifNull: ['$totalAmount', '$amount'] } } } }
  ]).then(r => (r[0]?.sum ?? 0));

  res.json({
    entries,
    total,
    grandTotal,
    page: Number(page),
    pages: Math.ceil(total / limit)
  });
});

// Link summary (totals per employee)
exports.getLinkSummary = asyncHandler(async (req, res) => {
  const { linkId } = req.body;
  if (!linkId) return badRequest(res, 'linkId required');

  let linkObjectId;
  try {
    linkObjectId = new mongoose.Types.ObjectId(linkId);
  } catch {
    return badRequest(res, 'Invalid linkId format');
  }

  // fetch title
  const linkDoc = await Link
    .findById(linkObjectId)
    .select('title')
    .lean();
  if (!linkDoc) return notFound(res, 'Link not found');
  const amountPer = linkDoc.amount;

  // …after you’ve validated linkId…
  const rows = await Entry.aggregate([
    { $match: { linkId } },    // OK to match the string here
    {
      $group: {
        _id: '$employeeId',
        total: { $sum: { $ifNull: ['$amount', 0] } },
        linkId: { $first: '$linkId' }   // carry the linkId forward
      }
    },
    {
      $lookup: {
        from: 'employees',
        localField: '_id',
        foreignField: 'employeeId',
        as: 'emp'
      }
    },
    { $unwind: '$emp' },
    {
      $project: {
        _id: 0,
        linkId: 1,              // now each row has linkId
        employeeId: '$_id',
        name: '$emp.name',
        employeeTotal: '$total',
        walletBalance: '$emp.balance',
        entryCount: { $ceil: { $divide: ['$total', amountPer] } }
      }
    }
  ]);


  const grandTotal = rows.reduce((sum, r) => sum + r.employeeTotal, 0);

  // include linkId in your response if you want to echo it back
  res.json({
    linkId,         // ← echo the original string
    title: linkDoc.title,
    rows,
    grandTotal
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
    BalanceHistory.aggregate([
      { $match: filter },
      { $group: { _id: null, totalAmount: { $sum: '$amount' } } }
    ])
  ]);

  const totalAmount = agg[0]?.totalAmount || 0;
  res.json({ history, total, totalAmount, page: Number(page), pages: Math.ceil(total / limit) });
});

exports.addEmployeeBalance = asyncHandler(async (req, res) => {
  const { employeeId, amount, adminId, note = '' } = req.body;
  if (!employeeId || amount == null || !adminId) {
    return badRequest(res, 'employeeId, amount and adminId are required');
  }
  const emp = await Employee.findOne({ employeeId });
  if (!emp) return notFound(res, 'Employee not found');

  emp.balance += amount;
  await emp.save();

  await BalanceHistory.create({ employeeId, amount, addedBy: adminId, note });
  res.json({ message: 'Balance added successfully', newBalance: emp.balance });
});

exports.updateEmployeeBalance = asyncHandler(async (req, res) => {
  const { employeeId, newBalance, adminId, note = '' } = req.body;
  if (!employeeId || newBalance == null || !adminId) {
    return badRequest(res, 'employeeId, newBalance and adminId are required');
  }
  const emp = await Employee.findOne({ employeeId });
  if (!emp) return notFound(res, 'Employee not found');

  const oldBalance = emp.balance;
  emp.balance = newBalance;
  await emp.save();

  await BalanceHistory.create({
    employeeId,
    amount: newBalance - oldBalance,
    addedBy: adminId,
    note: `Updated from ₹${oldBalance} to ₹${newBalance}. ${note}`
  });
  res.json({ message: 'Balance updated successfully', oldBalance, newBalance });
});

exports.bulkAddEmployeeBalance = asyncHandler(async (req, res) => {
  const { employeeIds, amount, adminId, note = '' } = req.body;
  if (!Array.isArray(employeeIds) || !employeeIds.length || amount == null || !adminId) {
    return badRequest(res, 'employeeIds, amount and adminId are required');
  }

  const results = await Promise.all(employeeIds.map(async id => {
    const emp = await Employee.findOne({ employeeId: id });
    if (!emp) return { employeeId: id, error: 'Not found' };

    emp.balance += amount;
    await emp.save();

    await BalanceHistory.create({ employeeId: id, amount, addedBy: adminId, note });
    return { employeeId: id, newBalance: emp.balance };
  }));

  res.json({ message: 'Bulk add complete', results });
});

exports.bulkUpdateEmployeeBalance = asyncHandler(async (req, res) => {
  const { employeeIds, newBalance, adminId, note = '' } = req.body;
  if (!Array.isArray(employeeIds) || !employeeIds.length || newBalance == null || newBalance < 0 || !adminId) {
    return badRequest(res, 'employeeIds, newBalance and adminId are required');
  }

  const results = await Promise.all(employeeIds.map(async id => {
    const emp = await Employee.findOne({ employeeId: id });
    if (!emp) return { employeeId: id, error: 'Not found' };

    const oldBalance = emp.balance;
    emp.balance = newBalance;
    await emp.save();

    await BalanceHistory.create({
      employeeId: id,
      amount: newBalance - oldBalance,
      addedBy: adminId,
      note: `Bulk update from ₹${oldBalance} to ₹${newBalance}. ${note}`
    });
    return { employeeId: id, oldBalance, newBalance };
  }));

  res.json({ message: 'Bulk update complete', results });
});

// controllers/adminLinks.js

exports.getUserEntriesByLinkAndEmployee = asyncHandler(async (req, res) => {
  const { linkId, employeeId } = req.body;
  if (!linkId || !employeeId) {
    return badRequest(res, 'linkId and employeeId required');
  }

  // fetch user‐type entries
  const entries = await Entry.find({
    linkId,
    type: 1,
    worksUnder: employeeId
  })
    .sort({ createdAt: -1 })
    .lean();

  // fetch associated users
  const userIds = entries.map(e => e.userId).filter(Boolean);
  const users = await User.find({ userId: { $in: userIds } })
    .select('userId name email phone upiId')
    .lean();
  const userMap = users.reduce((m, u) => (m[u.userId] = u, m), {});

  // attach user info
  const entriesWithUser = entries.map(e => ({
    ...e,
    user: userMap[e.userId] || null
  }));

  // fetch link title
  const link = await Link.findById(linkId).select('title').lean();
  const title = link?.title || '';

  // compute totals
  const totalUsers      = entriesWithUser.length;
  const totalPersons    = entriesWithUser.reduce((sum, e) => sum + (e.noOfPersons || 0), 0);
  const totalAmountPaid = entriesWithUser.reduce((sum, e) => sum + (e.totalAmount || 0), 0);

  return res.json({
    title,
    entries: entriesWithUser,
    totals: {
      totalUsers,
      totalPersons,
      totalAmountPaid
    }
  });
});

// 1️⃣ Request email change → send OTP to both old + new email
exports.requestEmailChange = asyncHandler(async (req, res) => {
  const { adminId, newEmail } = req.body;
  if (!adminId || !newEmail) return badRequest(res, 'adminId and newEmail required');

  // look up the Admin document to get its _id
  const admin = await Admin.findOne({ adminId });
  if (!admin) return notFound(res, 'Admin not found');

  const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

  // OTP → old email
  const otpOld = generateOTP();
  await AdminOTP.create({
    admin:     admin._id,
    type:      'email-change-old',
    otp:       otpOld,
    payload:   { newEmail },
    expiresAt,
  });
  await transporter.sendMail({
    to: admin.email,
    subject: 'OTP for Email Change (Current Email)',
    text:    `Your OTP to confirm your email change is: ${otpOld} (expires in 15 minutes).`
  });

  // OTP → new email
  const otpNew = generateOTP();
  await AdminOTP.create({
    admin:     admin._id,
    type:      'email-change-new',
    otp:       otpNew,
    payload:   { newEmail },
    expiresAt,
  });
  await transporter.sendMail({
    to: newEmail,
    subject: 'OTP for Email Change (New Email)',
    text:    `Your OTP to confirm your email change is: ${otpNew} (expires in 15 minutes).`
  });

  res.json({ message: 'OTPs sent to both current and new email addresses' });
});


// 2️⃣ Confirm email change → verify both codes, then update email
exports.confirmEmailChange = asyncHandler(async (req, res) => {
  const { adminId, otpOld, otpNew } = req.body;
  if (!adminId || !otpOld || !otpNew)
    return badRequest(res, 'adminId, otpOld and otpNew required');

  const admin = await Admin.findOne({ adminId });
  if (!admin) return notFound(res, 'Admin not found');

  const now = new Date();
  const oldRec = await AdminOTP.findOne({
    admin:      admin._id,
    type:       'email-change-old',
    otp:        otpOld,
    expiresAt: { $gt: now }
  });
  const newRec = await AdminOTP.findOne({
    admin:      admin._id,
    type:       'email-change-new',
    otp:        otpNew,
    expiresAt: { $gt: now }
  });

  if (!oldRec || !newRec) {
    return res.status(400).json({ error: 'Invalid or expired OTP' });
  }

  // apply the change
  admin.email = oldRec.payload.newEmail;
  await admin.save();

  // clean up both OTP records
  await AdminOTP.deleteMany({
    admin: admin._id,
    type:  { $in: ['email-change-old', 'email-change-new'] }
  });

  res.json({ message: 'Email updated successfully' });
});


// 3️⃣ Request password reset → send OTP to current email
exports.requestPasswordReset = asyncHandler(async (req, res) => {
  const { adminId } = req.body;
  if (!adminId) return badRequest(res, 'adminId required');

  const admin = await Admin.findOne({ adminId });
  if (!admin) return notFound(res, 'Admin not found');

  const otp       = generateOTP();
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

  await AdminOTP.create({
    admin:     admin._id,
    type:      'password-reset',
    otp,
    expiresAt,
  });

  await transporter.sendMail({
    to: admin.email,
    subject: 'OTP for Password Reset',
    text:    `Your OTP to reset your password is: ${otp} (expires in 15 minutes).`
  });

  res.json({ message: 'OTP sent to admin email address' });
});


// 4️⃣ Confirm password reset → verify OTP + update password
exports.confirmPasswordReset = asyncHandler(async (req, res) => {
  const { adminId, otp, newPassword } = req.body;
  if (!adminId || !otp || !newPassword)
    return badRequest(res, 'adminId, otp and newPassword required');

  // fetch the Admin (with password field)
  const admin = await Admin.findOne({ adminId }).select('+password');
  if (!admin) return notFound(res, 'Admin not found');

  const now = new Date();
  const record = await AdminOTP.findOne({
    admin:     admin._id,
    type:      'password-reset',
    otp,
    expiresAt: { $gt: now }
  });
  if (!record) {
    return res.status(400).json({ error: 'Invalid or expired OTP' });
  }

  // hash & save new password
  const salt = await bcrypt.genSalt(10);
  admin.password = await bcrypt.hash(newPassword, salt);
  await admin.save();

  // clean up the OTP
  await AdminOTP.deleteMany({
    admin: admin._id,
    type:  'password-reset'
  });

  res.json({ message: 'Password reset successfully' });
});

exports.getScreenshotList = asyncHandler(async (req, res) => {
  const { page = 1, limit = 20, sortBy = 'createdAt', sortOrder = 'desc', verified } = req.body;

  const { p, l, skip } = parsePageLimit(page, limit);
  const sort = parseSort(sortBy, sortOrder);

  const filter = {};
  if (typeof verified === 'boolean') filter.verified = verified;

  const [rows, total] = await Promise.all([
    Screenshot.find(filter)
      .sort(sort)
      .skip(skip)
      .limit(l)
      .select('screenshotId userId linkId verified phashes bundleSig analysis createdAt files.role files.phash files.sha256 files.size files.mime')
      .lean(),
    Screenshot.countDocuments(filter)
  ]);

  res.json({
    screenshots: rows,
    total,
    page: p,
    pages: Math.ceil(total / l)
  });
});

/**
 * POST /admin/screenshots/byUser
 * Body: { userId, page?, limit?, sortBy?, sortOrder?, verified? }
 * - Get screenshots for a specific userId
 */
exports.getScreenshotsByUserId = asyncHandler(async (req, res) => {
  const { userId, page = 1, limit = 20, sortBy = 'createdAt', sortOrder = 'desc', verified } = req.body;
  if (!userId) return badRequest(res, 'userId required');

  const { p, l, skip } = parsePageLimit(page, limit);
  const sort = parseSort(sortBy, sortOrder);

  const filter = { userId };
  if (typeof verified === 'boolean') filter.verified = verified;

  const [screenshots, total, entries] = await Promise.all([
    Screenshot.find(filter)
      .sort(sort)
      .skip(skip)
      .limit(l)
      .select('screenshotId userId linkId verified analysis createdAt')
      .lean(),
    Screenshot.countDocuments(filter),
    Entry.find({ type: 1, userId }).lean()
  ]);

  // Attach link titles to entries
  const entriesWithTitles = await Promise.all(
    entries.map(async e => {
      const linkDoc = await Link.findById(e.linkId, 'title').lean();
      return { ...e, linkTitle: linkDoc ? linkDoc.title : null };
    })
  );

  res.json({
    screenshots,
    totalScreenshots: total,
    page: p,
    pages: Math.ceil(total / l),
    entries: entriesWithTitles
  });
});


/**
 * POST /admin/screenshots/byLink
 * Body: { linkId, page?, limit?, sortBy?, sortOrder?, verified? }
 * - Get screenshots for a specific linkId
 */
exports.getScreenshotsByLinkId = asyncHandler(async (req, res) => {
  const { linkId, page = 1, limit = 20, sortBy = 'createdAt', sortOrder = 'desc', verified } = req.body;
  if (!linkId) return badRequest(res, 'linkId required');

  // Validate ObjectId if Screenshot/Entry.linkId are ObjectId
  if (!mongoose.Types.ObjectId.isValid(linkId)) {
    return badRequest(res, 'Invalid linkId format');
  }
  const linkObjectId = new mongoose.Types.ObjectId(linkId);

  const { p, l, skip } = parsePageLimit(page, limit);
  const sort = parseSort(sortBy, sortOrder);

  const filter = { linkId: linkObjectId };
  if (typeof verified === 'boolean') filter.verified = verified;

  // fetch screenshots (paginated) + total count
  const [screenshots, totalScreenshots, linkDoc] = await Promise.all([
    Screenshot.find(filter)
      .sort(sort)
      .skip(skip)
      .limit(l)
      .select('screenshotId userId linkId verified analysis createdAt')
      .lean(),
    Screenshot.countDocuments(filter),
    Link.findById(linkObjectId, 'title').lean()
  ]);

  // fetch ALL entries for this link (no pagination requested)
  const entries = await Entry.find({ linkId: linkObjectId }).lean();

  // (optional) attach linkTitle to each entry for convenience
  const linkTitle = linkDoc ? linkDoc.title : null;
  const entriesWithTitle = entries.map(e => ({ ...e, linkTitle }));

  res.json({
    linkId,
    linkTitle,
    screenshots,
    totalScreenshots,
    page: p,
    pages: Math.ceil(totalScreenshots / l),
    entries: entriesWithTitle,
    totalEntries: entries.length
  });
});

exports.getScreenshotsByLinkAndEmployee = asyncHandler(async (req, res) => {
  const {
    linkId,
    employeeId,
    page = 1,
    limit = 20,
    sortBy = 'createdAt',
    sortOrder = 'desc',
    verified
  } = req.body;

  if (!linkId) return badRequest(res, 'linkId required');
  if (!employeeId) return badRequest(res, 'employeeId required');

  if (!mongoose.Types.ObjectId.isValid(linkId)) {
    return badRequest(res, 'Invalid linkId format');
  }
  const linkObjectId = new mongoose.Types.ObjectId(linkId);

  const { p, l, skip } = parsePageLimit(page, limit);
  const sort = parseSort(sortBy, sortOrder);

  // 1) Find all USER entries (type:1) for this link under this employee => gives us userIds
  const userEntries = await Entry
    .find({ type: 1, linkId: linkObjectId, worksUnder: employeeId })
    .select('userId')
    .lean();

  const userIds = [...new Set(userEntries.map(e => e.userId).filter(Boolean))];

  // 2) Build screenshot filter (by linkId AND userId in those under this employee)
  const ssFilter = { linkId: linkObjectId };
  if (userIds.length) {
    ssFilter.userId = { $in: userIds };
  } else {
    // If no userIds belong to this employee for this link, quickly return empty screenshots
    return res.json({
      linkId,
      linkTitle: (await Link.findById(linkObjectId, 'title').lean())?.title ?? null,
      screenshots: [],
      totalScreenshots: 0,
      page: p,
      pages: 0,
      entries: [],
      totalEntries: 0
    });
  }
  if (typeof verified === 'boolean') ssFilter.verified = verified;

  // 3) Fetch screenshots (paginated) + total
  const [screenshots, totalScreenshots, linkDoc] = await Promise.all([
    Screenshot.find(ssFilter)
      .sort(sort)
      .skip(skip)
      .limit(l)
      .select('screenshotId userId linkId verified analysis createdAt') // no phashes/bundles/hashes
      .lean(),
    Screenshot.countDocuments(ssFilter),
    Link.findById(linkObjectId, 'title').lean()
  ]);

  // 4) Fetch ALL entries for this link that belong to the employee
  //    (type 0 via employeeId, type 1 via `worksUnder`)
  const entryFilter = {
    linkId: linkObjectId,
    $or: [
      { employeeId },           // employee entries
      { worksUnder: employeeId } // user entries created under this employee
    ]
  };
  const entries = await Entry.find(entryFilter).lean();

  const linkTitle = linkDoc ? linkDoc.title : null;
  const entriesWithTitle = entries.map(e => ({ ...e, linkTitle }));

  return res.json({
    linkId,
    linkTitle,
    screenshots,
    totalScreenshots,
    page: p,
    pages: Math.ceil(totalScreenshots / l),
    entries: entriesWithTitle,
    totalEntries: entries.length
  });
});

exports.createEmailTask = asyncHandler(async (req, res) => {
  const {
    items,                 // optional bulk: [{ platform, targetUser?, amountPerPerson, expireIn, targetPerEmployee?, maxEmails? }, ...]
    platform,              // single
    targetUser,            // single
    amountPerPerson,       // single
    expireIn,              // single
    targetPerEmployee,     // single (optional)
    maxEmails,             // single (optional)
    adminId,               // REQUIRED now
  } = req.body || {};

  if (!adminId) return badRequest(res, 'adminId required');
  const exists = await Admin.exists({ adminId: String(adminId) });
  if (!exists) return badRequest(res, 'Invalid adminId');

  // Build normalized rows (supports single or bulk)
  const rows = Array.isArray(items)
    ? items
    : [{ platform, targetUser, amountPerPerson, expireIn, targetPerEmployee, maxEmails }];

  // helpers
  const toIntOrDefault = (val, def = 1) => {
    const n = Number(val);
    return Number.isFinite(n) && n >= 1 ? Math.floor(n) : def;
  };

  const docs = [];
  for (const r of rows) {
    const p = String(r?.platform || '').trim();
    const a = Number(r?.amountPerPerson);
    const e = Number(r?.expireIn);

    if (!p) return badRequest(res, 'platform is required for all items');
    if (!Number.isFinite(a) || a < 0)
      return badRequest(res, 'amountPerPerson must be a non-negative number');
    if (!Number.isFinite(e) || e < 1)
      return badRequest(res, 'expireIn must be at least 1 hour');

    // If not value then 1, else use the value:
    const tpe = toIntOrDefault(r?.targetPerEmployee, 1);
    const me  = toIntOrDefault(r?.maxEmails, 1);

    docs.push({
      createdBy: String(adminId),
      platform: p,
      targetUser: typeof r?.targetUser === 'string' ? String(r.targetUser) : undefined,
      amountPerPerson: a,
      expireIn: e,
      targetPerEmployee: tpe,
      maxEmails: me,
    });
  }

  const inserted = await EmailTask.insertMany(docs, { ordered: true });

  const MS = 3600000;
  const now = new Date();
  const tasks = inserted.map(t => {
    const expiresAt = new Date(t.createdAt.getTime() + t.expireIn * MS);
    return {
      _id: t._id,
      createdBy: t.createdBy,
      platform: t.platform,
      targetUser: t.targetUser ?? null,
      amountPerPerson: t.amountPerPerson,
      expireIn: t.expireIn,
      createdAt: t.createdAt,
      expiresAt,
      status: now < expiresAt ? 'active' : 'expired',
    };
  });

  res.json({ message: `Created ${tasks.length} email task(s)`, tasks });
});

exports.getEmailTaskList = asyncHandler(async (req, res) => {
  const {
    page = 1,
    limit = 20,
    sortBy = 'createdAt',
    sortOrder = 'desc',
    search,
    adminId,
    platform,
    active
  } = req.body;

  const { p, l, skip } = parsePageLimit(page, limit);

  // If caller asks to sort by a computed field, we'll sort in-memory later.
  const wantsExpiresAtSort = String(sortBy) === 'expiresAt';
  const sort = wantsExpiresAtSort ? parseSort('createdAt', sortOrder) : parseSort(sortBy, sortOrder);

  const filter = {};

  if (adminId) filter.createdBy = String(adminId);

  if (platform) {
    const esc = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    filter.platform = { $regex: esc(platform), $options: 'i' };
  }

  // Active/expired using $expr on createdAt + (expireIn hours)
  if (typeof active === 'boolean') {
    const msPerHour = 3600000;
    const now = new Date();
    if (active) {
      filter.$expr = {
        $gt: [
          { $add: ['$createdAt', { $multiply: ['$expireIn', msPerHour] }] },
          now
        ]
      };
    } else {
      filter.$expr = {
        $lte: [
          { $add: ['$createdAt', { $multiply: ['$expireIn', msPerHour] }] },
          now
        ]
      };
    }
  }

  // Generic search
  if (search != null && String(search).trim() !== '') {
    const term = String(search).trim();
    const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    const or = [
      { platform:  { $regex: esc(term), $options: 'i' } },
      { createdBy: { $regex: esc(term), $options: 'i' } },
      { targetUser:{ $regex: esc(term), $options: 'i' } }
    ];

    // attempt _id match
    try {
      const { ObjectId } = require('mongodb');
      if (ObjectId.isValid(term)) {
        or.push({ _id: new ObjectId(term) });
      }
    } catch {}

    // numeric equality on numeric fields only
    const num = Number(term);
    if (Number.isFinite(num)) {
      or.push({ targetPerEmployee: num });
      or.push({ amountPerPerson: num });
      or.push({ maxEmails: num });
      or.push({ expireIn: num });
    }

    filter.$or = or;
  }

  const [rows, total] = await Promise.all([
    EmailTask.find(filter)
      .sort(sort)
      .skip(skip)
      .limit(l)
      .select(
        'createdBy platform targetUser targetPerEmployee amountPerPerson maxEmails expireIn createdAt updatedAt'
      )
      .lean(),
    EmailTask.countDocuments(filter)
  ]);

  const now = new Date();
  const msPerHour = 3600000;

  let tasks = rows.map(t => {
    const expiresAt = new Date(new Date(t.createdAt).getTime() + t.expireIn * msPerHour);
    const status = now < expiresAt ? 'active' : 'expired';
    return { ...t, expiresAt, status };
  });

  // In-memory sort if requested by expiresAt
  if (wantsExpiresAtSort) {
    const dir = String(sortOrder).toLowerCase() === 'asc' ? 1 : -1;
    tasks.sort((a, b) => (a.expiresAt - b.expiresAt) * dir);
  }

  res.json({
    tasks,
    total,
    page: p,
    pages: Math.ceil(total / l)
  });
});

exports.getEmailTaskDetails = asyncHandler(async (req, res) => {
  const { taskId, employeeId } = req.body || {};
  if (!taskId) return badRequest(res, 'taskId is required');
  if (!ObjectId.isValid(taskId)) return badRequest(res, 'Invalid taskId');

  const task = await EmailTask.findById(taskId).lean();
  if (!task) return notFound(res, 'Task not found');

  const expiresAt = new Date(new Date(task.createdAt).getTime() + (Number(task.expireIn) || 0) * MS_PER_HOUR);
  const status    = new Date() < expiresAt ? 'active' : 'expired';

  // Completion threshold (use maxEmails per your comment)
  const threshold = Number(task.maxEmails || 0);

  const taskIdObj = new ObjectId(taskId);

  // contacts -> join users -> (optional) filter by employee -> join employee -> group (per user)
  // -> mark completed/partial -> lookup payouts -> mark paid -> group (per employee)
  const pipeline = [
    { $match: { taskId: taskIdObj } },

    // Join User (collection: users) on userId (string)
    {
      $lookup: {
        from: 'users',
        localField: 'userId',
        foreignField: 'userId',
        as: 'user'
      }
    },
    { $unwind: '$user' },

    // Optional filter by employeeId (string) on User.worksUnder
    ...(employeeId ? [{ $match: { 'user.worksUnder': String(employeeId) } }] : []),

    // Join Employee (collection: employees) where user.worksUnder -> employee.employeeId (string)
    {
      $lookup: {
        from: 'employees',
        localField: 'user.worksUnder',
        foreignField: 'employeeId',
        as: 'employee'
      }
    },
    { $unwind: '$employee' },

    // Group per user (collect emails; include full youtube subdocument)
    {
      $group: {
        _id: { employeeId: '$employee.employeeId', userId: '$user.userId' },
        employeeName: { $first: '$employee.name' },
        userName:     { $first: '$user.name' },
        emails: {
          $push: {
            email: '$email',
            handle: '$handle',
            platform: '$platform',
            createdAt: '$createdAt',
            youtube: '$youtube' // may be null
          }
        },
        count: { $sum: 1 }
      }
    },

    // completed vs partial
    {
      $addFields: {
        status: {
          $cond: [{ $gte: ['$count', threshold] }, 'completed', 'partial']
        }
      }
    },

    // 🔗 NEW: lookup payouts to mark paid/unpaid for this (employeeId, userId, taskId)
    {
      $lookup: {
        from: 'payouts',
        let: { empId: '$_id.employeeId', uId: '$_id.userId' },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ['$employeeId', '$$empId'] },
                  { $eq: ['$userId', '$$uId'] },
                  { $eq: ['$taskId', taskIdObj] },
                ]
              }
            }
          },
          { $project: { _id: 1 } }
        ],
        as: 'payout'
      }
    },
    { $addFields: { paid: { $gt: [{ $size: '$payout' }, 0] } } },

    // Group per employee and carry paid flag down to each user object
    {
      $group: {
        _id: '$_id.employeeId',
        employeeName:  { $first: '$_id.employeeId' }, // fallback if name missing; corrected below
        employeeNameReal: { $first: '$employeeName' },
        users: {
          $push: {
            userId:   '$_id.userId',
            name:     '$userName',
            doneCount:'$count',
            status:   '$status',
            paid:     '$paid',
            emails:   '$emails'
          }
        },
        usersCount:     { $sum: 1 },
        completedUsers: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
        partialUsers:   { $sum: { $cond: [{ $eq: ['$status', 'partial'] },   1, 0] } },
        paidUsers:      { $sum: { $cond: ['$paid', 1, 0] } },
        totalEmails:    { $sum: '$count' }
      }
    },

    // Final employee shape
    {
      $project: {
        _id: 0,
        employeeId: '$_id',
        name: { $ifNull: ['$employeeNameReal', '$employeeName'] },
        usersCount: 1,
        completedUsers: 1,
        partialUsers: 1,
        paidUsers: 1,
        totalEmails: 1,
        users: 1
      }
    },
    { $sort: { totalEmails: -1 } }
  ];

  const employees = await EmailContact.aggregate(pipeline);

  // Top-level totals (add paidUsers)
  const totals = employees.reduce(
    (acc, e) => {
      acc.employees      += 1;
      acc.users          += e.usersCount || 0;
      acc.completedUsers += e.completedUsers || 0;
      acc.partialUsers   += e.partialUsers || 0;
      acc.paidUsers      += e.paidUsers || 0;
      acc.totalEmails    += e.totalEmails || 0;
      return acc;
    },
    { employees: 0, users: 0, completedUsers: 0, partialUsers: 0, paidUsers: 0, totalEmails: 0 }
  );

  return res.json({
    task: {
      _id: task._id,
      platform: task.platform,
      targetPerEmployee: task.targetPerEmployee,
      amountPerPerson: task.amountPerPerson,
      maxEmails: task.maxEmails,
      expireIn: task.expireIn,
      createdAt: task.createdAt,
      expiresAt,
      status
    },
    totals,
    employees
  });
});