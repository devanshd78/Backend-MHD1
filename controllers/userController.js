// controllers/userController.js
const bcrypt   = require('bcryptjs');
const User     = require('../models/User');
const Employee = require('../models/Employee');
const Link     = require('../models/Link');
const Entry    = require('../models/Entry');      // ⬅️ new – for look-ups only
const EmailTask = require('../models/EmailTask');
const EmailContact = require('../models/email');

const asyncHandler = fn => (req, res, next) => fn(req, res, next).catch(next);
const badRequest = (res, msg) => res.status(400).json({ error: msg });

function parsePageLimit(page = 1, limit = 20, maxLimit = 100) {
  const p = Math.max(1, Number(page) || 1);
  const l = Math.min(maxLimit, Math.max(1, Number(limit) || 20));
  const skip = (p - 1) * l;
  return { p, l, skip };
}

/* ------------------------------------------------------------------ */
/*  auth – register / login                                           */
/* ------------------------------------------------------------------ */
exports.register = async (req, res) => {
  try {
    const { name, phone, email, password, worksUnder, upiId } = req.body;
    if (!name || !phone || !email || !password || !worksUnder || !upiId) {
      return res.status(400).json({
        message: 'Please provide name, phone, email, password, worksUnder (employeeId), and upiId.'
      });
    }

    /* manager exists? */
    const manager = await Employee.findOne({ employeeId: worksUnder });
    if (!manager)
      return res.status(404).json({ message: 'No employee exists with the provided ID.' });

    /* phone numeric + unique checks */
    const phoneNum = Number(phone);
    if (!Number.isInteger(phoneNum))
      return res.status(400).json({ message: 'Phone number must be numeric.' });

    const exists = await User.findOne({
      $or: [{ phone: phoneNum }, { email }, { upiId }]
    });
    if (exists)
      return res.status(400).json({ message: 'User with that phone, email, or UPI ID already exists.' });

    /* hash + create */
    const hash  = await bcrypt.hash(password, await bcrypt.genSalt(10));
    const user  = await User.create({ name, phone: phoneNum, email, password: hash, worksUnder, upiId });

    res.status(201).json({ message: 'User registered successfully.', userId: user.userId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error.' });
  }
};

exports.login = async (req, res) => {
  try {
    const { phone, password } = req.body;
    if (!phone || !password)
      return res.status(400).json({ message: 'Please provide phone and password.' });

    const phoneNum = Number(phone);
    if (!Number.isInteger(phoneNum))
      return res.status(400).json({ message: 'Phone number must be numeric.' });

    const user = await User.findOne({ phone: phoneNum });
    if (!user || !(await bcrypt.compare(password, user.password)))
      return res.status(400).json({ message: 'Invalid credentials.' });

    res.status(200).json({ message: 'Login Successful', userId: user.userId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error.' });
  }
};

/* ------------------------------------------------------------------ */
/*  summaries & look-ups                                              */
/* ------------------------------------------------------------------ */
exports.getAllUsers = async (_req, res) => {
  try {
    const users = await User.find({}, '-password -__v').lean();
    res.json({ users });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error.' });
  }
};

exports.getUserById = async (req, res) => {
  try {
    const { userId } = req.params;
    if (!userId) {
      return res.status(400).json({ message: 'Please provide a userId.' });
    }

    /* base user */
    const user = await User.findOne({ userId }, '-password -__v').lean();
    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }

    /* manager name */
    const mgr = await Employee.findOne({ employeeId: user.worksUnder }, 'name').lean();
    user.worksUnderName = mgr ? mgr.name : null;

    /* pull entries from NEW collection, only those without screenshotId */
    const entries = await Entry.find({
      type: 1,
      userId,
      $or: [
        { screenshotId: { $exists: false } },
        { screenshotId: null }
      ]
    }).lean();

    /* attach link titles */
    user.entries = await Promise.all(
      entries.map(async e => {
        const l = await Link.findById(e.linkId, 'title').lean();
        return { ...e, linkTitle: l ? l.title : null };
      })
    );

    res.json({ user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error.' });
  }
};

exports.getUsersByEmployeeId = async (req, res) => {
  try {
    const { employeeId } = req.params;
    if (!employeeId)
      return res.status(400).json({ message: 'Please provide an employeeId.' });

    const users = await User.find({ worksUnder: employeeId }, '-password -__v').lean();
    res.json({ users });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error.' });
  }
};

/* show all links, plus completed flags for this user ------------------ */
exports.listLinksForUser = async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ message: 'Please provide userId.' });

    // 🚫 removed .limit(3) – now returns ALL links, newest first
    const links = await Link.find().sort({ createdAt: -1 }).lean();
    if (links.length === 0) return res.json([]);

    const completedIds = await Entry.distinct('linkId', { type: 1, userId });
    const doneSet = new Set(completedIds.map(id => id.toString()));

    // still keep a "latest" link for highlighting purposes
    const latestId = links[0]._id.toString();

    const annotated = links.map(l => ({
      ...l,
      isLatest: l._id.toString() === latestId,
      isCompleted: doneSet.has(l._id.toString()) ? 1 : 0
    }));

    res.json(annotated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error.' });
  }
};


/* ------------------------------------------------------------------ */
/*  profile update (name / upi)                                        */
/* ------------------------------------------------------------------ */
exports.updateUser = async (req, res) => {
  try {
    const { userId, name, upiId } = req.body;
    if (!userId) return res.status(400).json({ message: 'Please provide userId.' });
    if (!name && !upiId)
      return res.status(400).json({ message: 'Provide at least one of name or upiId to update.' });

    if (upiId) {
      const clash = await User.findOne({ upiId });
      if (clash && clash.userId !== userId)
        return res.status(400).json({ message: 'This UPI ID is already in use.' });
    }

    const updates = {};
    if (name)  updates.name  = name;
    if (upiId) updates.upiId = upiId;

    const updated = await User.findOneAndUpdate(
      { userId },
      { $set: updates },
      { new: true, projection: { password: 0, __v: 0 } }
    );
    if (!updated) return res.status(404).json({ message: 'User not found.' });

    res.json({
      message: 'User updated successfully.',
      user: { userId: updated.userId, name: updated.name, upiId: updated.upiId }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error.' });
  }
};


// and include expired ones instead of filtering them out by time.
exports.listActiveEmailTasks = asyncHandler(async (req, res) => {
  const { page = 1, limit = 20, userId, status = 'all' } = req.body || {};
  const { p, l, skip } = parsePageLimit(page, limit);

  const now = new Date();

  // 1) Auto-mark overdue tasks as expired (so they persist, not deleted)
  await EmailTask.updateMany(
    { status: { $ne: 'expired' }, expiresAt: { $lte: now } },
    { $set: { status: 'expired' } }
  );

  // 2) Build status filter
  const filter = {};
  const allowed = new Set(['all', 'active', 'expired', 'disabled']);
  const s = String(status || 'all').toLowerCase();
  if (!allowed.has(s)) return badRequest(res, 'status must be one of: all, active, expired, disabled');
  if (s !== 'all') filter.status = s;

  // 3) Query
  const [rows, total] = await Promise.all([
    EmailTask.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(l)
      .select('createdBy platform targetUser targetPerEmployee amountPerPerson maxEmails expireIn expiresAt status createdAt updatedAt')
      .lean(),
    EmailTask.countDocuments(filter)
  ]);

  // 4) Normalize computed fields
  const msPerHour = 3600000;
  let tasks = rows.map((t, idx) => {
    const expiresAt = t.expiresAt || new Date(new Date(t.createdAt).getTime() + Number(t.expireIn || 0) * msPerHour);
    const computedStatus = t.status || ((expiresAt && expiresAt <= now) ? 'expired' : 'active');

    return {
      ...t,
      expiresAt,
      status: computedStatus,
      isLatest: skip === 0 && idx === 0,
      isCompleted: 0,
      isPartial: 0
    };
  });

  // 5) Progress by user (counts in EmailContact for this task)
  if (userId && tasks.length > 0) {
    const taskIds = tasks.map(t => t._id);
    const progress = await EmailContact.aggregate([
      { $match: { userId: String(userId), taskId: { $in: taskIds } } },
      { $group: { _id: '$taskId', total: { $sum: 1 } } }
    ]);

    const progressMap = new Map(progress.map(p => [String(p._id), p.total]));

    tasks = tasks.map(t => {
      const done = Number(progressMap.get(String(t._id)) || 0);
      const target = Number(t.maxEmails) || 0;
      return {
        ...t,
        doneCount: done,
        isCompleted: done >= target ? 1 : 0,
        isPartial: done > 0 && done < target ? 1 : 0
      };
    });
  }

  res.json({
    tasks,
    total,
    page: p,
    pages: Math.ceil(total / l)
  });
});
