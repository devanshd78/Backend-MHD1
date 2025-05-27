// controllers/admin.controller.js
const bcrypt = require('bcrypt');
const Admin = require('../models/Admin');
const Link = require('../models/Link');
const Entry = require('../models/Entry');
const Employee = require('../models/Employee');
const BalanceHistory = require('../models/BalanceHistory');
const { default: mongoose } = require('mongoose');
const { ObjectId } = require('mongodb');

const asyncHandler = fn => (req, res, next) => fn(req, res, next).catch(next);
const badRequest = (res, msg) => res.status(400).json({ error: msg });
const notFound = (res, msg) => res.status(404).json({ error: msg });

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
    .select('name email employeeId balance')
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

// Paginated distinct links for an employee
exports.getLinksByEmployee = asyncHandler(async (req, res) => {
  const { employeeId, page = 1, limit = 20 } = req.body;
  if (!employeeId) return badRequest(res, 'employeeId required');

  const allIds = await Entry.distinct('linkId', {employeeId });
  const total = allIds.length;
  if (total === 0) return res.json({ links: [], total: 0, page: 1, pages: 0 });

  const start = (page - 1) * limit;
  const pagedIds = allIds.slice(start, start + Number(limit));

  const links = await Link.find({ _id: { $in: pagedIds } })
    .sort({ createdAt: -1 })
    .lean();

  res.json({
    links,
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
