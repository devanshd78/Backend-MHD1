// controllers/employee.js
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcrypt');
const mongoose = require('mongoose');
const { Types: { ObjectId }, isValidObjectId } = mongoose;

const Employee = require('../models/Employee');
const User = require('../models/User');
const Link = require('../models/Link');
const EmailTask = require('../models/EmailTask');
const EmailContact = require('../models/email');

const asyncHandler = (fn) => (req, res, next) => fn(req, res, next).catch(next);
const badRequest = (res, msg) => res.status(400).json({ error: msg });
const notFound  = (res, msg) => res.status(404).json({ error: msg });

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

exports.listEmailTasks = asyncHandler(async (_req, res) => {
  const now = new Date();

  const rows = await EmailTask.find()
    .sort({ createdAt: -1 })
    .select('createdBy platform targetUser targetPerEmployee amountPerPerson maxEmails expireIn createdAt updatedAt')
    .lean();

  if (rows.length === 0) return res.json([]);

  const tasks = rows.map((t, idx) => {
    const createdAt = new Date(t.createdAt);
    const expiresAt = new Date(createdAt.getTime() + (Number(t.expireIn) || 0) * MS_PER_HOUR);
    const status = now < expiresAt ? 'active' : 'expired';
    return {
      ...t,
      expiresAt,
      status,
      isLatest: idx === 0, // kept for legacy UI, but front-end should rely on expiry
    };
  });

  res.json(tasks);
});

exports.taskByUser = asyncHandler(async (req, res) => {
  const { taskId, employeeId } = req.body || {};
  if (!taskId || !employeeId) return badRequest(res, 'taskId and employeeId are required');
  if (!isValidObjectId(taskId)) return badRequest(res, 'Invalid taskId');

  const task = await EmailTask.findById(taskId).lean();
  if (!task) return notFound(res, 'Task not found');

  const createdAt = new Date(task.createdAt);
  const expiresAt = new Date(createdAt.getTime() + Number(task.expireIn || 0) * MS_PER_HOUR);
  const taskStatus = new Date() < expiresAt ? 'active' : 'expired';

  // all users under employee
  const users = await User.find({ worksUnder: employeeId })
    .select('userId name')
    .lean();

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
      },
      totals: { performing: 0, completed: 0, partial: 0 },
      users: [],
    });
  }

  const userIdList = users.map((u) => u.userId);

  const agg = await EmailContact.aggregate([
    {
      $match: {
        taskId: new ObjectId(taskId),
        userId: { $in: userIdList }, // userId is a String in EmailContact
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

    const doneCount = row.count;
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
        platform: e.platform, // comes from EmailContact (lowercased)
        createdAt: e.createdAt,
      })),
    });
  }

  res.json({
    task: {
      _id: task._id,
      platform: task.platform, // as stored (e.g., "YouTube")
      targetPerEmployee: task.targetPerEmployee,
      amountPerPerson: task.amountPerPerson,
      maxEmails: task.maxEmails,
      expireIn: task.expireIn,
      createdAt: task.createdAt,
      expiresAt,
      status: taskStatus,
    },
    totals: {
      performing: performing.length,
      completed: completedCount,
      partial: partialCount,
    },
    users: performing.sort((a, b) => b.doneCount - a.doneCount),
  });
});
