// controllers/entryController.js
const { v4: uuidv4 } = require('uuid');
const { PNG }        = require('pngjs');
const { Jimp }       = require('jimp');
const QrCode         = require('qrcode-reader');
const { parse }      = require('querystring');

const Entry     = require('../models/Entry');
const Link      = require('../models/Link');
const Employee  = require('../models/Employee');
const User      = require('../models/User');

const asyncHandler = fn => (req, res, next) => fn(req, res, next).catch(next);
const badRequest   = (res, msg) => res.status(400).json({ error: msg });
const notFound     = (res, msg) => res.status(404).json({ error: msg });

function isValidUpi(upi) {
  return /^[a-zA-Z0-9_.-]+@[a-zA-Z0-9.-]+$/.test(upi);
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

  if (!upiId)             return badRequest(res, 'UPI ID is required');
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
  const { userId, linkId, name,worksUnder, upiId, noOfPersons, telegramLink } = req.body;
  if (!userId || !linkId || !name || !worksUnder||!upiId || !noOfPersons || !telegramLink)
    return badRequest(res, 'userId, linkId, name, upiId, noOfPersons & telegramLink required');

  const user = await User.findOne({ userId });
  if (!user) return notFound(res, 'User not found');
  if (user.upiId !== upiId.trim())
    return badRequest(res, 'Provided UPI does not match your account');

  const link = await Link.findById(linkId).lean();
  if (!link) return notFound(res, 'Invalid linkId');

  // prevent duplicate by same user or reuse of UPI
  if (await Entry.exists({ type: 1, userId, linkId }))
    return badRequest(res, 'You have already submitted for this link');
  if (await Entry.exists({ linkId, upiId: upiId.trim() }))
    return badRequest(res, 'This UPI ID has already been used for this link');

  const totalAmount = link.amount * Number(noOfPersons);

  const entry = await Entry.create({
    entryId: uuidv4(),
    type: 1,
    userId,
    linkId,
    name: name.trim(),
    worksUnder: worksUnder.trim(),
    upiId: upiId.trim(),
    noOfPersons: Number(noOfPersons),
    linkAmount: link.amount,
    totalAmount,
    telegramLink: telegramLink.trim()
  });

  res.status(201).json({ message: 'User entry submitted', entry });
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
  if (![0,1].includes(newStatus))
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
/* ------------------------------------------------------------------ */
/*  LIST – employee + specific link, POST /entries/listByLink         */
/*     Body: { employeeId, linkId, page?, limit? }                    */
/* ------------------------------------------------------------------ */
exports.listEntriesByLink = asyncHandler(async (req, res) => {
  const { employeeId, linkId, page = 1, limit = 20 } = req.body;
  if (!employeeId) return badRequest(res, 'employeeId required');
  if (!linkId)    return badRequest(res, 'linkId required');

  // match either the old `worksUnder` field or the new `employeeId`
  const filter = {
    linkId,
    $or: [
      { employeeId },
      { worksUnder: employeeId }
    ]
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

  // 2) compute grandTotal across all matching docs
  const agg = await Entry.aggregate([
    { $match: filter },
    { $group: {
        _id: null,
        grandTotal: {
          $sum: { $ifNull: ["$totalAmount", "$amount"] }
        }
    }}
  ]);
  const grandTotal = agg[0]?.grandTotal ?? 0;

  // 3) return results + pagination + grandTotal
  return res.json({
    entries,          // array of entry docs
    total,            // how many matched
    page: Number(page),
    pages: Math.ceil(total / limit),
    grandTotal        // sum of totalAmount|amount across all matched entries
  });
});
