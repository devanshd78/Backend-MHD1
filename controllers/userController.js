// controllers/userController.js
'use strict';

const bcrypt = require('bcryptjs');
const User = require('../models/User');
const Employee = require('../models/Employee');
const Link = require('../models/Link');
const Entry = require('../models/Entry');
const EmailTask = require('../models/EmailTask');
const EmailContact = require('../models/email');
const countryList = require('../services/countryList');

const asyncHandler = (fn) => (req, res, next) => fn(req, res, next).catch(next);
const badRequest = (res, msg) => res.status(400).json({ error: msg });

function parsePageLimit(page = 1, limit = 20, maxLimit = 100) {
  const p = Math.max(1, Number(page) || 1);
  const l = Math.min(maxLimit, Math.max(1, Number(limit) || 20));
  const skip = (p - 1) * l;
  return { p, l, skip };
}

/* ------------------------------------------------------------------ */
/* Country helpers                                                     */
/* ------------------------------------------------------------------ */
const COUNTRY_BY_A2 = new Map(
  (Array.isArray(countryList) ? countryList : []).map((c) => [
    String(c.alpha2 || '').toUpperCase(),
    String(c.name || '').trim(),
  ])
);

// ✅ UI expects: ANY => {value:'ANY', label:'Any Country'}, US => {value:'US', label:'United States'}
function countryOptionFromCode(code) {
  const c = String(code || '').trim().toUpperCase();
  if (!c || c === 'ANY') return { value: 'ANY', label: 'Any Country' };
  return { value: c, label: COUNTRY_BY_A2.get(c) || c };
}

// returns array of {value,label}
function countryOptionsFromCodes(codes) {
  const arr = Array.isArray(codes) && codes.length ? codes : ['ANY'];
  return arr.map(countryOptionFromCode);
}

// dropdown options: include ANY + all countries
const ALL_COUNTRY_OPTIONS = [
  { value: 'ANY', label: 'Any Country' },
  ...(Array.isArray(countryList) ? countryList : [])
    .slice()
    .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')))
    .map((c) => ({ value: String(c.alpha2 || '').toUpperCase(), label: String(c.name || '').trim() })),
];

/* ------------------------------------------------------------------ */
/* Auth – register / login                                            */
/* ------------------------------------------------------------------ */
exports.register = async (req, res) => {
  try {
    const { name, phone, email, password, worksUnder, upiId } = req.body;
    if (!name || !phone || !email || !password || !worksUnder || !upiId) {
      return res.status(400).json({
        message: 'Please provide name, phone, email, password, worksUnder (employeeId), and upiId.',
      });
    }

    const manager = await Employee.findOne({ employeeId: worksUnder });
    if (!manager) return res.status(404).json({ message: 'No employee exists with the provided ID.' });

    const phoneNum = Number(phone);
    if (!Number.isInteger(phoneNum)) return res.status(400).json({ message: 'Phone number must be numeric.' });

    const exists = await User.findOne({ $or: [{ phone: phoneNum }, { email }, { upiId }] });
    if (exists) return res.status(400).json({ message: 'User with that phone, email, or UPI ID already exists.' });

    const hash = await bcrypt.hash(password, await bcrypt.genSalt(10));
    const user = await User.create({ name, phone: phoneNum, email, password: hash, worksUnder, upiId });

    return res.status(201).json({ message: 'User registered successfully.', userId: user.userId });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: 'Server error.' });
  }
};

exports.login = async (req, res) => {
  try {
    const { phone, password } = req.body;
    if (!phone || !password) return res.status(400).json({ message: 'Please provide phone and password.' });

    const phoneNum = Number(phone);
    if (!Number.isInteger(phoneNum)) return res.status(400).json({ message: 'Phone number must be numeric.' });

    const user = await User.findOne({ phone: phoneNum });
    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.status(400).json({ message: 'Invalid credentials.' });
    }

    return res.status(200).json({ message: 'Login Successful', userId: user.userId });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: 'Server error.' });
  }
};

/* ------------------------------------------------------------------ */
/* Users                                                              */
/* ------------------------------------------------------------------ */
exports.getAllUsers = async (_req, res) => {
  try {
    const users = await User.find({}, '-password -__v').lean();
    return res.json({ users });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: 'Server error.' });
  }
};

exports.getUserById = async (req, res) => {
  try {
    const { userId } = req.params;
    if (!userId) return res.status(400).json({ message: 'Please provide a userId.' });

    const user = await User.findOne({ userId }, '-password -__v').lean();
    if (!user) return res.status(404).json({ message: 'User not found.' });

    const mgr = await Employee.findOne({ employeeId: user.worksUnder }, 'name').lean();
    user.worksUnderName = mgr ? mgr.name : null;

    const entries = await Entry.find({
      type: 1,
      userId,
      $or: [{ screenshotId: { $exists: false } }, { screenshotId: null }],
    }).lean();

    user.entries = await Promise.all(
      entries.map(async (e) => {
        const l = await Link.findById(e.linkId, 'title').lean();
        return { ...e, linkTitle: l ? l.title : null };
      })
    );

    return res.json({ user });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: 'Server error.' });
  }
};

exports.getUsersByEmployeeId = async (req, res) => {
  try {
    const { employeeId } = req.params;
    if (!employeeId) return res.status(400).json({ message: 'Please provide an employeeId.' });

    const users = await User.find({ worksUnder: employeeId }, '-password -__v').lean();
    return res.json({ users });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: 'Server error.' });
  }
};

/* ------------------------------------------------------------------ */
/* Links                                                              */
/* ------------------------------------------------------------------ */
exports.listLinksForUser = async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ message: 'Please provide userId.' });

    const links = await Link.find().sort({ createdAt: -1 }).lean();
    if (!links.length) return res.json([]);

    const completedIds = await Entry.distinct('linkId', { type: 1, userId });
    const doneSet = new Set(completedIds.map((id) => id.toString()));

    const latestId = links[0]._id.toString();

    const annotated = links.map((l) => ({
      ...l,
      isLatest: l._id.toString() === latestId,
      isCompleted: doneSet.has(l._id.toString()) ? 1 : 0,
    }));

    return res.json(annotated);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: 'Server error.' });
  }
};

/* ------------------------------------------------------------------ */
/* Profile update                                                     */
/* ------------------------------------------------------------------ */
exports.updateUser = async (req, res) => {
  try {
    const { userId, name, upiId } = req.body;
    if (!userId) return res.status(400).json({ message: 'Please provide userId.' });
    if (!name && !upiId) return res.status(400).json({ message: 'Provide at least one of name or upiId to update.' });

    if (upiId) {
      const clash = await User.findOne({ upiId });
      if (clash && clash.userId !== userId) return res.status(400).json({ message: 'This UPI ID is already in use.' });
    }

    const updates = {};
    if (name) updates.name = name;
    if (upiId) updates.upiId = upiId;

    const updated = await User.findOneAndUpdate(
      { userId },
      { $set: updates },
      { new: true, projection: { password: 0, __v: 0 } }
    );

    if (!updated) return res.status(404).json({ message: 'User not found.' });

    return res.json({
      message: 'User updated successfully.',
      user: { userId: updated.userId, name: updated.name, upiId: updated.upiId },
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: 'Server error.' });
  }
};

/* ------------------------------------------------------------------ */
/* Email Tasks (User view)                                            */
/*  - includes expired tasks                                           */
/*  - returns countries as [{value,label}]                              */
/*  - provides full dropdown list: countryOptions                        */
/*  - progress counts ONLY EmailContact where isValid != false          */
/* ------------------------------------------------------------------ */
exports.listActiveEmailTasks = asyncHandler(async (req, res) => {
  const { page = 1, limit = 20, userId, status = 'all' } = req.body || {};
  const { p, l, skip } = parsePageLimit(page, limit);

  const MS_PER_HOUR = 3600000;

  // 1) Ensure expiresAt/status are up to date (no time filtering)
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

  // 2) Filter by status (all/active/expired/disabled)
  const allowed = new Set(['all', 'active', 'expired', 'disabled']);
  const s = String(status || 'all').toLowerCase();
  if (!allowed.has(s)) return badRequest(res, 'status must be one of: all, active, expired, disabled');

  const filter = {};
  if (s !== 'all') filter.status = s;

  // 3) Fetch tasks (include filters fields)
  const selectFields =
    'createdBy platform targetUser targetPerEmployee amountPerPerson maxEmails expireIn expiresAt status createdAt updatedAt ' +
    'minFollowers maxFollowers countries categories';

  const [rows, total] = await Promise.all([
    EmailTask.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(l)
      .select(selectFields)
      .lean(),
    EmailTask.countDocuments(filter),
  ]);

  const now = new Date();

  // 4) Normalize tasks + map country codes -> {value,label}
  let tasks = rows.map((t, idx) => {
    const exp =
      t.expiresAt ||
      new Date(new Date(t.createdAt).getTime() + Number(t.expireIn || 0) * MS_PER_HOUR);

    const computedStatus = t.status || (exp && exp <= now ? 'expired' : 'active');

    const countryCodes = Array.isArray(t.countries) && t.countries.length ? t.countries : ['ANY'];
    const countries = countryOptionsFromCodes(countryCodes);

    return {
      ...t,
      expiresAt: exp,
      status: computedStatus,
      isLatest: skip === 0 && idx === 0,

      // ensure always present
      minFollowers: Number(t.minFollowers ?? 1000),
      maxFollowers: Number(t.maxFollowers ?? 10_000_000),
      countries, // ✅ [{value:'ANY',label:'Any Country'}] or [{value:'US',label:'United States'}]
      categories: Array.isArray(t.categories) && t.categories.length ? t.categories : ['ANY'],

      // progress defaults
      doneCount: 0,
      isCompleted: 0,
      isPartial: 0,
    };
  });

  // 5) Progress counts: ONLY valid contacts
  if (userId && tasks.length) {
    const taskIds = tasks.map((t) => t._id);

    const progress = await EmailContact.aggregate([
      {
        $match: {
          userId: String(userId),
          taskId: { $in: taskIds },
          isValid: { $ne: false }, // ✅ ignore invalid
        },
      },
      { $group: { _id: '$taskId', total: { $sum: 1 } } },
    ]);

    const progressMap = new Map(progress.map((x) => [String(x._id), Number(x.total || 0)]));

    tasks = tasks.map((t) => {
      const done = Number(progressMap.get(String(t._id)) || 0);
      const target = Number(t.maxEmails) || 0;

      return {
        ...t,
        doneCount: done,
        isCompleted: target > 0 && done >= target ? 1 : 0,
        isPartial: done > 0 && target > 0 && done < target ? 1 : 0,
      };
    });
  }

  return res.json({
    tasks,
    total,
    page: p,
    pages: Math.ceil(total / l),
  });
});