// controllers/employee.js
'use strict';

const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcrypt');
const mongoose = require('mongoose');
const { Types: { ObjectId }, isValidObjectId } = mongoose;

const Employee = require('../models/Employee');
const User = require('../models/User');
const Link = require('../models/Link');
const EmailTask = require('../models/EmailTask');
const EmailContact = require('../models/email');
const BalanceHistory = require('../models/BalanceHistory');
const Payout = require('../models/Payout');

const countryList = require('../services/countryList');

const asyncHandler = (fn) => (req, res, next) => fn(req, res, next).catch(next);
const badRequest = (res, msg) => res.status(400).json({ error: msg });
const notFound = (res, msg) => res.status(404).json({ error: msg });

const MS_PER_HOUR = 3600000;

/* ====================== helpers ====================== */

function maskEmail(email = '') {
  try {
    const [local = '', domainAll = ''] = String(email).split('@');
    const domainParts = domainAll.split('.');
    const domainName = domainParts.shift() || '';
    const domainRest = domainParts.join('.') || '';

    const maskedLocal =
      local.length <= 2
        ? (local[0] || '') + (local.length === 2 ? '*' : '')
        : local[0] + '*'.repeat(Math.max(1, local.length - 2)) + local.slice(-1);

    const maskedDomainName =
      domainName.length <= 2
        ? (domainName[0] || '') + (domainName.length === 2 ? '*' : '')
        : domainName[0] + '*'.repeat(Math.max(1, domainName.length - 2)) + domainName.slice(-1);

    return `${maskedLocal}@${maskedDomainName}${domainRest ? '.' + domainRest : ''}`;
  } catch {
    return '***@***';
  }
}

/* ====================== country mapping ====================== */
// ✅ ANY => {value:'ANY',label:'Any Country'}, US => {value:'US',label:'United States'}
const COUNTRY_BY_A2 = new Map(
  (Array.isArray(countryList) ? countryList : []).map((c) => [
    String(c.alpha2 || '').toUpperCase(),
    String(c.name || '').trim(),
  ])
);

function countryOptionFromCode(code) {
  const c = String(code || '').trim().toUpperCase();
  if (!c || c === 'ANY') return { value: 'ANY', label: 'Any Country' };
  return { value: c, label: COUNTRY_BY_A2.get(c) || c };
}

function countryOptionsFromCodes(codes) {
  const arr = Array.isArray(codes) && codes.length ? codes : ['ANY'];
  return arr.map(countryOptionFromCode);
}

/* ====================== auth ====================== */

exports.register = asyncHandler(async (req, res) => {
  const { email, password, name } = req.body;
  if (!email || !password || !name) return badRequest(res, 'Name, email and password required');

  if (await Employee.exists({ email })) {
    return res.status(409).json({ error: 'Email already in use' });
  }

  const employee = await Employee.create({
    employeeId: uuidv4(),
    email,
    password,
    name,
  });

  res.json({
    message: 'Registration successful – pending admin approval',
    employeeId: employee.employeeId,
  });
});

exports.login = asyncHandler(async (req, res) => {
  const { email, password } = req.body;

  const employee = await Employee.findOne({ email }).select('+password');
  if (!employee || !(await bcrypt.compare(password, employee.password))) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  if (employee.isApproved === 0) {
    return res.status(403).json({ error: 'Account not approved yet' });
  }

  res.json({
    message: 'Login successful',
    userId: employee._id,
    employeeId: employee.employeeId,
    name: employee.name,
  });
});

/* ====================== balance ====================== */

exports.getBalance = asyncHandler(async (req, res) => {
  const { employeeId } = req.query;
  if (!employeeId) return badRequest(res, 'Employee ID is required');

  const employee = await Employee.findOne({ employeeId });
  if (!employee) return notFound(res, 'Employee not found');

  res.json({ balance: employee.balance });
});

/* ====================== links ====================== */

exports.listLinks = asyncHandler(async (_req, res) => {
  const links = await Link.find().lean();
  if (links.length === 0) return res.json([]);

  const latest = links.reduce((a, b) => (a.createdAt > b.createdAt ? a : b));
  const latestId = latest._id.toString();

  const annotated = links.map((l) => ({
    ...l,
    isLatest: l._id.toString() === latestId,
  }));

  res.json(annotated.reverse());
});

exports.getLink = asyncHandler(async (req, res) => {
  const link = await Link.findById(req.params.linkId);
  if (!link) return notFound(res, 'Link not found');
  res.json(link);
});

/* ====================== email tasks list ====================== */
/* - include expired
   - show minFollowers/maxFollowers + countries(codes->label) + categories
*/
exports.listEmailTasks = asyncHandler(async (_req, res) => {
  // keep status/expiresAt in sync (do NOT filter out)
  await EmailTask.updateMany(
    {},
    [
      {
        $set: {
          expiresAt: {
            $ifNull: [
              '$expiresAt',
              { $add: ['$createdAt', { $multiply: [{ $toDouble: '$expireIn' }, MS_PER_HOUR] }] },
            ],
          },
        },
      },
      {
        $set: {
          status: {
            $cond: [
              { $eq: ['$status', 'disabled'] },
              'disabled',
              { $cond: [{ $lte: ['$expiresAt', '$$NOW'] }, 'expired', 'active'] },
            ],
          },
        },
      },
    ],
    { strict: false }
  );

  const rows = await EmailTask.find()
    .sort({ createdAt: -1 })
    .select(
      'createdBy platform targetUser targetPerEmployee amountPerPerson maxEmails expireIn expiresAt status createdAt updatedAt ' +
      'minFollowers maxFollowers countries categories'
    )
    .lean();

  if (!rows.length) return res.json([]);

  const tasks = rows.map((t, idx) => ({
    ...t,
    expiresAt:
      t.expiresAt ||
      new Date(new Date(t.createdAt).getTime() + (Number(t.expireIn) || 0) * MS_PER_HOUR),

    status: t.status || 'active',
    isLatest: idx === 0,

    minFollowers: Number(t.minFollowers ?? 1000),
    maxFollowers: Number(t.maxFollowers ?? 10_000_000),

    // ✅ requested format
    countries: countryOptionsFromCodes(t.countries),
    categories: Array.isArray(t.categories) && t.categories.length ? t.categories : ['ANY'],
  }));

  res.json(tasks);
});

/* ====================== task by user under employee ====================== */
/* ✅ do NOT show EmailContact where isValid === false
   ✅ show meta details: followerCount/country/categories + task min/max + countries label
*/
exports.taskByUser = asyncHandler(async (req, res) => {
  const { taskId, employeeId } = req.body || {};
  if (!taskId || !employeeId) return badRequest(res, 'taskId and employeeId are required');
  if (!isValidObjectId(taskId)) return badRequest(res, 'Invalid taskId');

  const task = await EmailTask.findById(taskId)
    .select(
      'platform targetPerEmployee amountPerPerson maxEmails expireIn createdAt expiresAt status ' +
      'minFollowers maxFollowers countries categories'
    )
    .lean();
  if (!task) return notFound(res, 'Task not found');

  const expiresAt =
    task.expiresAt ||
    new Date(new Date(task.createdAt).getTime() + Number(task.expireIn || 0) * MS_PER_HOUR);

  const taskStatus =
    task.status || (new Date() < expiresAt ? 'active' : 'expired');

  // users under employee
  const users = await User.find({ worksUnder: employeeId }).select('userId name').lean();

  if (!users.length) {
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
        status: taskStatus,

        minFollowers: Number(task.minFollowers ?? 1000),
        maxFollowers: Number(task.maxFollowers ?? 10_000_000),
        countries: countryOptionsFromCodes(task.countries),
        categories: Array.isArray(task.categories) && task.categories.length ? task.categories : ['ANY'],
      },
      totals: { performing: 0, completed: 0, partial: 0 },
      users: [],
    });
  }

  const userIdList = users.map((u) => u.userId);

  // ✅ aggregate only valid contacts
  const agg = await EmailContact.aggregate([
    {
      $match: {
        taskId: new ObjectId(taskId),
        userId: { $in: userIdList },
        isValid: { $ne: false }, // ✅ hide invalid
      },
    },
    {
      $group: {
        _id: '$userId',
        count: { $sum: 1 },
        emails: {
          $push: {
            email: '$email',
            handle: '$handle',
            platform: '$platform',
            createdAt: '$createdAt',

            // ✅ include meta details per influencer (saved in EmailContact)
            followerCount: '$followerCount',
            country: '$country',
            categories: '$categories',
            youtube: '$youtube',
          },
        },
      },
    },
  ]);

  const byUserId = new Map(agg.map((row) => [row._id, row]));

  const performing = [];
  let completedCount = 0;
  let partialCount = 0;

  for (const u of users) {
    const row = byUserId.get(u.userId);
    if (!row || !row.count) continue;

    const doneCount = Number(row.count || 0);
    const status = doneCount >= Number(task.maxEmails || 0) ? 'completed' : 'partial';

    if (status === 'completed') completedCount += 1;
    else partialCount += 1;

    performing.push({
      userId: u.userId,
      name: u.name || null,
      doneCount,
      status,
      emails: (row.emails || []).map((e) => ({
        emailMasked: maskEmail(e.email),
        handle: e.handle,
        platform: e.platform,
        createdAt: e.createdAt,

        // ✅ include details
        followerCount: e.followerCount ?? null,
        country: e.country ?? null,
        categories: Array.isArray(e.categories) ? e.categories : [],
        youtube: e.youtube || null,
      })),
    });
  }

  // paid set
  const paidRows = await Payout.find({
    employeeId,
    taskId,
    userId: { $in: performing.map((u) => u.userId) },
  })
    .select('userId')
    .lean();

  const paidSet = new Set(paidRows.map((p) => p.userId));
  const performingWithPaid = performing.map((u) => ({ ...u, paid: paidSet.has(u.userId) }));

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
      status: taskStatus,

      // ✅ show task filters too
      minFollowers: Number(task.minFollowers ?? 1000),
      maxFollowers: Number(task.maxFollowers ?? 10_000_000),
      countries: countryOptionsFromCodes(task.countries),
      categories: Array.isArray(task.categories) && task.categories.length ? task.categories : ['ANY'],
    },
    totals: {
      performing: performingWithPaid.length,
      completed: completedCount,
      partial: partialCount,
    },
    users: performingWithPaid.sort((a, b) => b.doneCount - a.doneCount),
  });
});

/* ====================== payout deduction ====================== */

exports.deductEmployeeBalanceForTask = asyncHandler(async (req, res) => {
  const { employeeId, userId, taskId } = req.body || {};
  if (!employeeId || !userId || !taskId) {
    return badRequest(res, 'employeeId, userId and taskId are required');
  }
  if (!isValidObjectId(taskId)) {
    return badRequest(res, 'Invalid taskId');
  }

  const task = await EmailTask.findById(taskId)
    .select('amountPerPerson expireIn createdAt status expiresAt platform')
    .lean();
  if (!task) return notFound(res, 'Task not found');

  const expiresAt =
    task.expiresAt ||
    new Date(new Date(task.createdAt).getTime() + Number(task.expireIn || 0) * MS_PER_HOUR);

  const amount = Number(task.amountPerPerson);
  if (!Number.isFinite(amount) || amount <= 0) {
    return badRequest(res, 'Invalid task amountPerPerson');
  }

  const user = await User.findOne({ userId: String(userId) })
    .select('_id userId name')
    .lean();
  if (!user) return notFound(res, 'User not found');

  const existing = await Payout.findOne({ employeeId, userId: user.userId, taskId }).lean();
  if (existing) {
    return res.json({
      message: 'Already paid',
      employeeId,
      userId: user.userId,
      taskId,
      paid: true,
      alreadyPaid: true,
      amountDeducted: existing.amount,
      expiresAt,
      taskStatus: 'active',
    });
  }

  const session = await mongoose.startSession();
  try {
    let updatedEmp = null;

    await session.withTransaction(async () => {
      const emp = await Employee.findOneAndUpdate(
        { employeeId, balance: { $gte: amount } },
        { $inc: { balance: -amount } },
        { new: true, session }
      );

      if (!emp) {
        const exists = await Employee.exists({ employeeId }).session(session);
        if (!exists) throw new Error('EMPLOYEE_NOT_FOUND');
        throw new Error('INSUFFICIENT_FUNDS');
      }
      updatedEmp = emp;

      await BalanceHistory.create(
        [
          {
            employeeId,
            amount: -amount,
            addedBy: user.userId,
            note: `Deducted ₹${amount} for task ${taskId} (${task.platform || 'task'})`,
          },
        ],
        { session }
      );

      await Payout.create(
        [
          {
            employeeId,
            userId: user.userId,
            taskId,
            amount,
          },
        ],
        { session }
      );
    });

    session.endSession();

    return res.json({
      message: 'Amount deducted successfully',
      employeeId,
      userId: user.userId,
      taskId,
      amountDeducted: amount,
      newBalance: updatedEmp.balance,
      expiresAt,
      taskStatus: 'active',
      paid: true,
      alreadyPaid: false,
    });
  } catch (e) {
    session.endSession();

    if (e?.code === 11000) {
      return res.json({
        message: 'Already paid',
        employeeId,
        userId,
        taskId,
        paid: true,
        alreadyPaid: true,
      });
    }
    if (e.message === 'EMPLOYEE_NOT_FOUND') {
      return notFound(res, 'Employee not found');
    }
    if (e.message === 'INSUFFICIENT_FUNDS') {
      return res.status(400).json({ error: 'Insufficient balance' });
    }
    throw e;
  }
});